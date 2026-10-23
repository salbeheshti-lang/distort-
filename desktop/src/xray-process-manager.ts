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
// Port-owner detection — used BEFORE spawning a new xray to detect if the
// port is already occupied (by a stale xray from a previous run, or by an
// unrelated process). This is SAFE: it only reads the port state, never
// terminates the occupying process.
//
// Design notes:
//   - We do NOT use Get-NetTCPConnection / netstat from here because that
//     requires spawning a child process on Windows and is harder to test.
//   - Instead we do a TCP connect probe: if connect succeeds, the port is
//     in use (and we close our socket immediately without sending data).
//   - If connect fails with ECONNREFUSED, the port is free.
//   - The caller is responsible for logging the PID/path of the occupying
//     process if needed (via CIM/WMI on Windows).
// ---------------------------------------------------------------------------

export type PortOwnerCheckResult = {
  port: number;
  inUse: boolean;
  /** Time in ms spent probing (useful for logging). */
  probeMs: number;
};

/**
 * Check if a TCP port on 127.0.0.1 is currently in use (without terminating
 * the occupying process). Returns { port, inUse, probeMs }.
 *
 * Safe: never throws, never kills anything. Just probes.
 */
export async function checkPortInUse(port: number): Promise<PortOwnerCheckResult> {
  const start = Date.now();
  const inUse = await new Promise<boolean>((resolve) => {
    const s = new net.Socket();
    s.setTimeout(500);
    s.once("connect", () => {
      // Connect succeeded → port IS in use by a listening server.
      s.destroy();
      resolve(true);
    });
    s.once("error", () => {
      // ECONNREFUSED or other → port is free.
      s.destroy();
      resolve(false);
    });
    s.once("timeout", () => {
      // Timed out → treat as free (a bound port would accept faster).
      s.destroy();
      resolve(false);
    });
    s.connect(port, "127.0.0.1");
  });
  return { port, inUse, probeMs: Date.now() - start };
}

/**
 * Check BOTH xray inbound ports (SOCKS5 + HTTP proxy). Returns true if EITHER
 * is in use. Used before spawning a new xray to detect port conflicts early
 * and fail fast with a clear error instead of letting xray crash with
 * "bind: Only one usage of each socket address".
 */
export async function checkXrayPortsInUse(
  socksPort: number = DEFAULT_SOCKS_PORT,
  httpPort: number = DEFAULT_HTTP_PORT,
): Promise<{ socksInUse: boolean; httpInUse: boolean; anyInUse: boolean }> {
  const [socks, http] = await Promise.all([
    checkPortInUse(socksPort),
    checkPortInUse(httpPort),
  ]);
  return {
    socksInUse: socks.inUse,
    httpInUse: http.inUse,
    anyInUse: socks.inUse || http.inUse,
  };
}

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
  /**
   * Injectable port prober (v8 audit). When provided, replaces the default
   * TCP-based `waitForPortReleased` function. This is a TEST SEAM — it lets
   * deterministic tests control the port-probe result without relying on
   * real TCP timing.
   *
   * The function receives (port, attempts, intervalMs) and must return
   * a Promise<boolean>: true if the port is free, false if still in use.
   *
   * Production code does NOT pass this option — it uses the default
   * `waitForPortReleased` which does a real TCP connect probe.
   */
  portProber?: (port: number, attempts: number, intervalMs: number) => Promise<boolean>;
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
  // TEST SEAM (v8 audit): use the injectable portProber if provided,
  // otherwise fall back to the real TCP-based waitForPortReleased.
  const doPortProbe = opts?.portProber ?? ((port: number, attempts: number, intervalMs: number) =>
    waitForPortReleased(port, attempts, intervalMs, (m) => log("warn", m))
  );

  let didExit = false;
  let stuck = false;
  let portsReleased = false;

  // ALREADY-EXITED CHECK: if the process already exited before stopXrayProcess
  // was called (common in the bind-failure path: xray spawns, fails to bind,
  // exits with code -1 within ~100ms, and by the time the caller calls
  // stopVpnEngine → stopXrayProcess, the 'exit' event has ALREADY fired).
  //
  // Node.js ChildProcess only emits 'exit' ONCE. If we register a listener
  // after it already fired, our listener never runs, and we'd time out and
  // incorrectly declare the process "stuck".
  //
  // Fix: check proc.exitCode / proc.signalCode — if either is non-null, the
  // process has already exited. Skip directly to port probing.
  const alreadyExited = proc.exitCode !== null || proc.signalCode !== null;
  if (alreadyExited) {
    log("info", `stopXrayProcess: process already exited (code=${proc.exitCode}, signal=${proc.signalCode}) — skipping kill, probing ports`);
    didExit = true;
  }

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

  // Phase 1: SIGTERM with timeout (skip if already exited).
  const exited = await (alreadyExited
    ? Promise.resolve(true)
    : new Promise<boolean>((resolve) => {
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
      }));

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
    //
    // FIX (v1.0.38 audit v6): the onStuckCleared callback must ONLY fire
    // if BOTH ports are confirmed free after the process finally exits.
    // Previously, the callback fired unconditionally — meaning if the ports
    // were still held (TIME_WAIT or another process), xrayStuck would be
    // cleared and the next spawn would race against the held ports.
    //
    // Also: use a named listener + a `stuckClearedFired` flag to prevent
    // duplicate invocations if exit fires multiple times (shouldn't happen,
    // but defensive against Node.js internal bugs).
    let stuckClearedFired = false;
    const onStuckExit = () => {
      if (stuckClearedFired) return; // defensive: don't fire twice
      stuckClearedFired = true;
      log("warn", "stopXrayProcess: stuck xray process finally emitted 'exit' — re-checking ports before clearing stuck state");
      try { proc.removeListener("exit", onExit); } catch {}
      try { proc.removeListener("exit", onStuckExit); } catch {}
      // Re-probe BOTH ports. If either is still in use, do NOT clear the
      // stuck flag — the next spawn would hit EADDRINUSE. Log a CRITICAL
      // error so the user knows they need to restart the app.
      doPortProbe(socksPort, portProbeAttempts, portProbeIntervalMs)
        .then((socksFree) => doPortProbe(httpPort, portProbeAttempts, portProbeIntervalMs)
          .then((httpFree) => {
            if (socksFree && httpFree) {
              log("info", `stopXrayProcess: stuck process exited + ports ${socksPort}/${httpPort} now free — clearing stuck state`);
              opts?.onStuckCleared?.();
            } else {
              log("error",
                `stopXrayProcess: stuck process finally exited BUT ports still held ` +
                `(SOCKS ${socksPort} free=${socksFree}, HTTP ${httpPort} free=${httpFree}). ` +
                "NOT clearing stuck state — user must restart the app. The next spawn " +
                "would hit EADDRINUSE."
              );
              // Do NOT call onStuckCleared — xrayStuck stays true.
            }
          })
        )
        .catch((e: any) => {
          log("error", `stopXrayProcess: port re-probe threw (${e?.message}) — NOT clearing stuck state`);
          // Do NOT call onStuckCleared — be safe.
        });
    };
    proc.once("exit", onStuckExit);
  } else {
    // Phase 4: Port-release probe (only if the process actually exited).
    const socksFree = await doPortProbe(socksPort, portProbeAttempts, portProbeIntervalMs);
    const httpFree = await doPortProbe(httpPort, portProbeAttempts, portProbeIntervalMs);
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
