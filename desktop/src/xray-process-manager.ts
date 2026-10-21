// xray-process-manager.ts
// ---------------------------------------------------------------------------
// Standalone xray process lifecycle manager — NO Electron dependency.
//
// Extracted from desktop/src/main.ts's stopVpnEngine so the core logic can be
// unit-tested with bun:test WITHOUT importing Electron (which is unavailable
// in the CI test environment).
//
// The main.ts stopVpnEngine now delegates to `stopXrayProcess` from this
// module for the process-kill + exit-wait + stuck-detection + port-probe
// logic. The Electron-specific bits (kill switch, store.set, mainWindow
// IPC) remain in main.ts and are called AFTER this function returns.
//
// STUCK-PROCESS POLICY (v1.0.38 audit v4):
//   - The ONLY reliable death signal in Node.js is the 'exit' event.
//   - `proc.killed` only means "kill() was called", NOT "process is dead".
//   - If 'exit' doesn't fire within SIGKILL_TIMEOUT_MS of SIGKILL, we mark
//     the process as `stuck` and refuse to release the slot.
//   - The caller MUST NOT spawn a new xray while `stuck === true`.
//   - A persistent exit listener clears the stuck flag when the process
//     finally dies (could be seconds, minutes, or never).
//
// PORT-RELEASE POLICY (v1.0.38 audit v5):
//   - After the process exits, we probe BOTH ports 10808 (SOCKS5) and
//     10809 (HTTP) with TCP connect attempts.
//   - If EITHER port is still in use after the probe budget, we return
//     `portsReleased: false`. The caller MUST treat this as a failure
//     and refuse to spawn a new xray (fail-safe).
//   - We do NOT block forever — the probe budget is bounded.
// ---------------------------------------------------------------------------

import type { ChildProcess } from "child_process";
import * as net from "net";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StopXrayResult = {
  /** The process emitted 'exit' within the SIGTERM/SIGKILL timeout windows. */
  didExit: boolean;
  /** The process is stuck — did NOT emit 'exit' after SIGKILL + timeout. */
  stuck: boolean;
  /** Both ports 10808 + 10809 were confirmed free (only meaningful if didExit). */
  portsReleased: boolean;
  /** Human-readable summary for logging. */
  summary: string;
};

export type StopXrayOptions = {
  /** Timeout for SIGTERM before escalating to SIGKILL (default 1000ms). */
  sigtermTimeoutMs?: number;
  /** Timeout for SIGKILL before declaring the process stuck (default 2000ms). */
  sigkillTimeoutMs?: number;
  /** Port-probe budget: number of attempts per port (default 5). */
  portProbeAttempts?: number;
  /** Port-probe interval between attempts (default 100ms). */
  portProbeIntervalMs?: number;
  /** SOCKS5 port (default 10808). */
  socksPort?: number;
  /** HTTP proxy port (default 10809). */
  httpPort?: number;
  /** Optional logger (defaults to console). */
  log?: (level: "info" | "warn" | "error", msg: string) => void;
};

// ---------------------------------------------------------------------------
// Default options
// ---------------------------------------------------------------------------

const DEFAULT_SIGTERM_TIMEOUT_MS = 1000;
const DEFAULT_SIGKILL_TIMEOUT_MS = 2000;
const DEFAULT_PORT_PROBE_ATTEMPTS = 5;
const DEFAULT_PORT_PROBE_INTERVAL_MS = 100;
const DEFAULT_SOCKS_PORT = 10808;
const DEFAULT_HTTP_PORT = 10809;

// ---------------------------------------------------------------------------
// TCP port-release probe. Tries to CONNECT to (127.0.0.1:port) up to
// `maxAttempts` times. If connect succeeds, the port is STILL in use.
// If connect fails (ECONNREFUSED, timeout), the port is free.
// Returns true if the port was confirmed free within the budget.
// ---------------------------------------------------------------------------

export async function waitForPortReleased(
  port: number,
  maxAttempts: number,
  intervalMs: number,
  log?: (msg: string) => void,
): Promise<boolean> {
  let portFree = false;
  for (let i = 0; i < maxAttempts; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, intervalMs));
    const stillOpen = await new Promise<boolean>((resolve) => {
      const s = new net.Socket();
      s.setTimeout(200);
      s.once("connect", () => { s.destroy(); resolve(true); }); // port still in use
      s.once("error", () => { s.destroy(); resolve(false); }); // port free
      s.once("timeout", () => { s.destroy(); resolve(false); });
      s.connect(port, "127.0.0.1");
    });
    if (!stillOpen) {
      portFree = true;
      break;
    }
  }
  if (!portFree && log) {
    log(`port ${port} still in use after ${maxAttempts * (intervalMs + 200)}ms — next spawn may fail with EADDRINUSE`);
  }
  return portFree;
}

// ---------------------------------------------------------------------------
// Main entry point: stop an xray process safely.
//
// Returns a StopXrayResult with didExit / stuck / portsReleased / summary.
// The caller is responsible for:
//   - Refusing to spawn a new xray if `stuck === true` or `portsReleased === false`.
//   - Clearing the `vpnProcess` global ONLY if `didExit && !stuck && portsReleased`.
//   - Setting a `xrayStuck` flag if `stuck === true`, and registering a
//     persistent exit listener (via the `onStuckCleared` callback) to clear
//     it when the process finally dies.
//
// This function does NOT touch any global state — it's pure process management.
// ---------------------------------------------------------------------------

export async function stopXrayProcess(
  proc: ChildProcess,
  opts?: StopXrayOptions & {
    /** Called when a stuck process finally emits 'exit'. Caller uses this to clear the xrayStuck flag + null vpnProcess. */
    onStuckCleared?: () => void;
  },
): Promise<StopXrayResult> {
  const sigtermTimeoutMs = opts?.sigtermTimeoutMs ?? DEFAULT_SIGTERM_TIMEOUT_MS;
  const sigkillTimeoutMs = opts?.sigkillTimeoutMs ?? DEFAULT_SIGKILL_TIMEOUT_MS;
  const portProbeAttempts = opts?.portProbeAttempts ?? DEFAULT_PORT_PROBE_ATTEMPTS;
  const portProbeIntervalMs = opts?.portProbeIntervalMs ?? DEFAULT_PORT_PROBE_INTERVAL_MS;
  const socksPort = opts?.socksPort ?? DEFAULT_SOCKS_PORT;
  const httpPort = opts?.httpPort ?? DEFAULT_HTTP_PORT;
  const log = opts?.log ?? ((level, msg) => console[level](msg));

  let didExit = false;
  let stuck = false;
  let portsReleased = false;

  // Single named exit listener — avoids the listener-leak bug from v3.
  let sigtermResolved = false;
  let resolveSigterm: (v: boolean) => void = () => {};
  let resolveKill: () => void = () => {};
  let exitTimeout: NodeJS.Timeout;
  let killTimeout: NodeJS.Timeout;

  const onExit = () => {
    didExit = true;
    if (!sigtermResolved) {
      sigtermResolved = true;
      clearTimeout(exitTimeout);
      resolveSigterm(true);
    } else {
      clearTimeout(killTimeout);
      resolveKill();
    }
  };

  // Phase 1: SIGTERM with timeout.
  const exited = await new Promise<boolean>((resolve) => {
    resolveSigterm = resolve;
    exitTimeout = setTimeout(() => {
      if (sigtermResolved) return;
      sigtermResolved = true;
      resolve(false);
    }, sigtermTimeoutMs);
    proc.once("exit", onExit);
    try {
      proc.kill("SIGTERM");
    } catch (e: any) {
      log("warn", `stopXrayProcess: SIGTERM failed (${e?.message}) — trying SIGKILL directly`);
      clearTimeout(exitTimeout);
      try { proc.kill("SIGKILL"); } catch {}
      resolve(false);
    }
  });

  // Phase 2: SIGKILL if SIGTERM didn't cause exit.
  if (!exited && !didExit) {
    try { proc.kill("SIGKILL"); } catch {}
    await new Promise<void>((resolve) => {
      resolveKill = resolve;
      killTimeout = setTimeout(() => {
        log("warn", `stopXrayProcess: xray did not emit 'exit' within ${sigkillTimeoutMs}ms of SIGKILL — declaring stuck`);
        resolve();
      }, sigkillTimeoutMs);
    });
  }

  // Phase 3: Stuck detection. Use ONLY didExit (the 'exit' event tracker).
  // proc.killed / exitCode / signalCode are unreliable between signal delivery
  // and the 'exit' event firing — they're set asynchronously by libuv.
  if (!didExit) {
    log("error",
      "stopXrayProcess: CRITICAL — xray process did not emit 'exit' within " +
      `${sigkillTimeoutMs}ms of SIGKILL (stuck in uninterruptible sleep, ` +
      "unreaped zombie, or kill() signal was not delivered). NOT releasing " +
      "the process slot. Future spawn calls will be refused until the stuck " +
      "process finally emits 'exit'."
    );
    stuck = true;
    // Persistent exit listener: clears the stuck flag when the process
    // eventually dies. The caller's onStuckCleared callback handles the
    // global-state cleanup (xrayStuck flag + vpnProcess null).
    proc.once("exit", () => {
      log("warn", "stopXrayProcess: stuck xray process finally emitted 'exit' — clearing stuck state");
      try { proc.removeListener("exit", onExit); } catch {}
      opts?.onStuckCleared?.();
    });
  } else {
    // Phase 4: Port-release probe (only if the process actually exited).
    const socksFree = await waitForPortReleased(socksPort, portProbeAttempts, portProbeIntervalMs, (m) => log("warn", m));
    const httpFree = await waitForPortReleased(httpPort, portProbeAttempts, portProbeIntervalMs, (m) => log("warn", m));
    portsReleased = socksFree && httpFree;
    if (!portsReleased) {
      log("error",
        `stopXrayProcess: ports NOT fully released after process exit ` +
        `(SOCKS ${socksPort} free=${socksFree}, HTTP ${httpPort} free=${httpFree}). ` +
        "Refusing to release the process slot — next spawn would hit EADDRINUSE."
      );
    } else {
      log("info", `stopXrayProcess: process exited + ports ${socksPort}/${httpPort} released`);
    }
    // Clean up the SIGTERM-phase exit listener if it never fired.
    try { proc.removeListener("exit", onExit); } catch {}
  }

  const summary = stuck
    ? "process stuck (did not emit 'exit' after SIGKILL)"
    : !didExit
      ? "process did not exit (unknown reason)"
      : portsReleased
        ? "process exited + ports released"
        : "process exited but ports NOT released (fail-safe: refuse next spawn)";

  return { didExit, stuck, portsReleased, summary };
}
