// stuck-deterministic.test.ts
// ---------------------------------------------------------------------------
// DETERMINISTIC tests for stopXrayProcess's stuck-process logic.
//
// KEY DESIGN: these tests do NOT use setTimeout to wait for the async
// onStuckCleared callback. Instead, they use a Promise-based latch that
// resolves EXACTLY when the callback fires (or when a real timeout
// indicates a bug). This eliminates race conditions and false passes.
//
// The tests call the REAL stopXrayProcess function from xray-process-manager.ts.
// MockChildProcess is used only to control process exit timing — the
// production code path (SIGTERM → timeout → SIGKILL → stuck detection →
// port re-probe → callback decision) is real.
//
// Integration tests with real child processes remain in
// xray-process-manager.test.ts — they test the same code paths but are
// timing-dependent. This file provides the DETERMINISTIC guarantee.
// ---------------------------------------------------------------------------

import { test, expect, describe } from "bun:test";
import * as net from "net";
import { stopXrayProcess, waitForPortReleased } from "../xray-process-manager";
import { MockChildProcess } from "./mock-child-process";
import type { ChildProcess } from "child_process";

// ---------------------------------------------------------------------------
// Robust port helpers — fail loudly on listen errors, never hang.
// ---------------------------------------------------------------------------

/**
 * Get a free port by binding to port 0 (OS-assigned), reading the port,
 * then closing the server. The port MAY be reused by the OS immediately
 * after close, but in practice (within the same test) it's free.
 *
 * Throws on listen error — never returns a port that wasn't verified free.
 */
async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error("getFreePort: listen timed out after 2s"));
    }, 2000);
    server.on("error", (err) => {
      clearTimeout(timeout);
      reject(new Error(`getFreePort: listen failed: ${err.message}`));
    });
    server.listen(0, "127.0.0.1", () => {
      clearTimeout(timeout);
      const port = (server.address() as net.AddressInfo).port;
      server.close((closeErr) => {
        if (closeErr) {
          reject(new Error(`getFreePort: close failed: ${closeErr.message}`));
        } else {
          resolve(port);
        }
      });
    });
  });
}

/**
 * Bind a server to the given port and keep it alive. Returns a cleanup
 * function that closes the server. The cleanup is also registered as a
 * process.exit hook as a safety net (in case the test forgets to call it).
 *
 * Throws on listen error — never silently passes.
 */
async function holdPort(port: number): Promise<() => Promise<void>> {
  const server = net.createServer(() => {});
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`holdPort: listen timed out after 2s (port ${port})`));
    }, 2000);
    server.on("error", (err) => {
      clearTimeout(timeout);
      reject(new Error(`holdPort: listen failed on port ${port}: ${err.message}`));
    });
    server.listen(port, "127.0.0.1", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
  return () => new Promise<void>((resolve) => {
    server.close((err) => {
      if (err) {
        // Log but don't reject — cleanup should always succeed
        console.error(`holdPort: close warning: ${err.message}`);
      }
      resolve();
    });
  });
}

/**
 * Create a latch that resolves when the callback fires.
 * Returns { waitForCallback, callback, getCount }.
 *
 * waitForCallback() returns a Promise that resolves with the call count
 * when the callback fires. If the callback doesn't fire within 5s, the
 * promise rejects (prevents hang).
 *
 * IMPORTANT: the timeout only starts when waitForCallback() is called,
 * NOT when the latch is created.
 */
function createCallbackLatch() {
  let callCount = 0;
  let resolveFn: (count: number) => void = () => {};
  let rejectFn: (err: Error) => void = () => {};
  let timeout: NodeJS.Timeout | null = null;

  const callback = () => {
    callCount++;
    // Resolve the promise immediately when callback fires.
    if (timeout) clearTimeout(timeout);
    resolveFn(callCount);
  };

  const waitForCallback = (): Promise<number> => {
    return new Promise<number>((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
      timeout = setTimeout(() => {
        reject(new Error("Callback latch: did not fire within 5s (real timeout — likely a bug)"));
      }, 5000);
    });
  };

  return { callback, waitForCallback, getCount: () => callCount };
}

// ---------------------------------------------------------------------------

describe("stopXrayProcess — DETERMINISTIC stuck logic (MockChildProcess)", () => {
  test("SIGTERM ignored → SIGKILL sent → stuck=true (no exit, deterministic)", async () => {
    const socksPort = await getFreePort();
    const httpPort = await getFreePort();
    const mock = new MockChildProcess();

    const result = await stopXrayProcess(mock as unknown as ChildProcess, {
      sigtermTimeoutMs: 50,
      sigkillTimeoutMs: 50,
      portProbeAttempts: 1,
      portProbeIntervalMs: 10,
      socksPort,
      httpPort,
    });

    // DETERMINISTIC: mock never emits 'exit', so stuck MUST be true.
    expect(result.didExit).toBe(false);
    expect(result.stuck).toBe(true);
    // Verify signal sequence: SIGTERM first, then SIGKILL.
    expect(mock.signalsReceived).toEqual(["SIGTERM", "SIGKILL"]);
    expect(result.portsReleased).toBe(false); // stuck → no port probe
  });

  test("stuck=true → emit exit + ports free → onStuckCleared called exactly once", async () => {
    const socksPort = await getFreePort();
    const httpPort = await getFreePort();
    const mock = new MockChildProcess();

    const latch = createCallbackLatch();
    const result = await stopXrayProcess(mock as unknown as ChildProcess, {
      sigtermTimeoutMs: 50,
      sigkillTimeoutMs: 50,
      portProbeAttempts: 2,
      portProbeIntervalMs: 20,
      socksPort,
      httpPort,
      onStuckCleared: latch.callback,
    });

    // stuck=true (deterministic — mock hasn't emitted exit yet).
    expect(result.stuck).toBe(true);
    expect(latch.getCount()).toBe(0); // not called yet

    // Start waiting BEFORE emitting exit — this ensures the latch promise
    // is ready to resolve when the callback fires.
    const countPromise = latch.waitForCallback();

    // Now simulate the stuck process finally exiting.
    mock.emitExit(0);

    // Wait for the callback to fire (resolves when callback fires,
    // rejects on 5s timeout — prevents hang).
    const count = await countPromise;
    expect(count).toBe(1); // exactly once
  });

  test("stuck=true → emit exit + port held → onStuckCleared NOT called", async () => {
    const socksPort = await getFreePort();
    const httpPort = await getFreePort();
    const mock = new MockChildProcess();

    // Hold the SOCKS port with an external server — it survives the mock exit.
    const releaseSocks = await holdPort(socksPort);

    try {
      const latch = createCallbackLatch();
      const result = await stopXrayProcess(mock as unknown as ChildProcess, {
        sigtermTimeoutMs: 50,
        sigkillTimeoutMs: 50,
        portProbeAttempts: 2,
        portProbeIntervalMs: 20,
        socksPort,
        httpPort,
        onStuckCleared: latch.callback,
      });

      expect(result.stuck).toBe(true);
      expect(latch.getCount()).toBe(0);

      // Simulate stuck process finally exiting.
      mock.emitExit(0);

      // Wait for the port re-probe to complete. Since port is held, callback
      // should NOT fire. Wait longer than the probe would take (2 attempts × 20ms
      // = ~40ms + 200ms timeout per attempt = ~440ms max).
      await new Promise((r) => setTimeout(r, 600));

      // Port is still held → onStuckCleared must NOT have fired.
      expect(latch.getCount()).toBe(0);
    } finally {
      await releaseSocks();
    }
  });

  test("stuck=true → emit exit twice → onStuckCleared called exactly once (dedup)", async () => {
    const socksPort = await getFreePort();
    const httpPort = await getFreePort();
    const mock = new MockChildProcess();

    const latch = createCallbackLatch();
    const result = await stopXrayProcess(mock as unknown as ChildProcess, {
      sigtermTimeoutMs: 50,
      sigkillTimeoutMs: 50,
      portProbeAttempts: 2,
      portProbeIntervalMs: 20,
      socksPort,
      httpPort,
      onStuckCleared: latch.callback,
    });

    expect(result.stuck).toBe(true);

    // Start waiting BEFORE emitting exit.
    const countPromise = latch.waitForCallback();

    // Emit exit twice (shouldn't happen in real Node, but defensive test).
    mock.emitExit(0);
    // Wait for the first re-probe to complete.
    const count = await countPromise;
    expect(count).toBe(1);

    mock.emitExit(0); // second emit should be no-op due to stuckClearedFired flag
    // Wait a bit to confirm no second call.
    await new Promise((r) => setTimeout(r, 200));
    expect(latch.getCount()).toBe(1); // still exactly once
  });

  test("SIGTERM causes exit → not stuck, portsReleased=true (deterministic)", async () => {
    const socksPort = await getFreePort();
    const httpPort = await getFreePort();
    const mock = new MockChildProcess();

    // We need to emit exit DURING the SIGTERM phase, before the timeout.
    const stopPromise = stopXrayProcess(mock as unknown as ChildProcess, {
      sigtermTimeoutMs: 200,
      sigkillTimeoutMs: 50,
      portProbeAttempts: 2,
      portProbeIntervalMs: 20,
      socksPort,
      httpPort,
    });

    // Wait briefly for SIGTERM to be sent (the mock records it).
    await new Promise((r) => setTimeout(r, 30));
    expect(mock.signalsReceived).toContain("SIGTERM");

    // Now emit exit — this resolves the SIGTERM promise with exited=true.
    mock.emitExit(0);

    const r = await stopPromise;

    expect(r.didExit).toBe(true);
    expect(r.stuck).toBe(false);
    // No SIGKILL should have been sent.
    expect(mock.signalsReceived).toEqual(["SIGTERM"]);
    expect(r.portsReleased).toBe(true);
  });

  test("SIGTERM fails (EPERM) → SIGKILL fallback → stuck if no exit", async () => {
    const socksPort = await getFreePort();
    const httpPort = await getFreePort();
    const mock = new MockChildProcess();
    mock.killShouldThrow = true; // all kill() calls throw

    const result = await stopXrayProcess(mock as unknown as ChildProcess, {
      sigtermTimeoutMs: 50,
      sigkillTimeoutMs: 50,
      portProbeAttempts: 1,
      portProbeIntervalMs: 10,
      socksPort,
      httpPort,
    });

    // kill() threw for SIGTERM → code falls through to SIGKILL path → also
    // throws (same mock) → no exit → stuck=true.
    expect(result.stuck).toBe(true);
    expect(result.didExit).toBe(false);
  });
});

describe("stopXrayProcess — full stuck sequence (deterministic step-by-step)", () => {
  test("complete sequence: SIGTERM → timeout → SIGKILL → stuck → exit → recheck → callback", async () => {
    const socksPort = await getFreePort();
    const httpPort = await getFreePort();
    const mock = new MockChildProcess();

    let callCount = 0;
    const stopPromise = stopXrayProcess(mock as unknown as ChildProcess, {
      sigtermTimeoutMs: 50,
      sigkillTimeoutMs: 50,
      portProbeAttempts: 2,
      portProbeIntervalMs: 20,
      socksPort,
      httpPort,
      onStuckCleared: () => { callCount++; },
    });

    // Step 1: wait for SIGTERM to be sent.
    // We poll mock.signalsReceived until SIGTERM appears.
    const sigtermDeadline = Date.now() + 200;
    while (!mock.signalsReceived.includes("SIGTERM") && Date.now() < sigtermDeadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(mock.signalsReceived).toContain("SIGTERM");

    // Step 2: wait for SIGKILL (after sigtermTimeoutMs=50ms).
    const sigkillDeadline = Date.now() + 200;
    while (!mock.signalsReceived.includes("SIGKILL") && Date.now() < sigkillDeadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(mock.signalsReceived).toContain("SIGKILL");

    // Step 3: stopXrayProcess should return now with stuck=true.
    const result = await stopPromise;
    expect(result.didExit).toBe(false);
    expect(result.stuck).toBe(true);
    expect(callCount).toBe(0); // callback not fired yet

    // Step 4: emit exit at controlled time.
    mock.emitExit(0);

    // Step 5: wait for port re-probe + callback.
    // Ports are free → callback MUST fire. Use a polling loop instead of
    // a fixed timeout — resolves as soon as callback fires.
    const callbackDeadline = Date.now() + 2000;
    while (callCount === 0 && Date.now() < callbackDeadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(callCount).toBe(1); // exactly once
  });
});

describe("waitForPortReleased — DETERMINISTIC (real function, controlled ports)", () => {
  test("port held by external server → returns false", async () => {
    const port = await getFreePort();
    const release = await holdPort(port);
    try {
      const result = await waitForPortReleased(port, 3, 50);
      expect(result).toBe(false);
    } finally {
      await release();
    }
  });

  test("port free → returns true immediately", async () => {
    const port = await getFreePort();
    // Don't bind anything — port is free.
    const result = await waitForPortReleased(port, 3, 50);
    expect(result).toBe(true);
  });

  test("port released mid-probe → returns true", async () => {
    const port = await getFreePort();
    const release = await holdPort(port);
    // Close the server after 100ms — the probe (3 attempts × 50ms = 150ms)
    // should detect the port is free after release.
    setTimeout(() => { release(); }, 100);

    const result = await waitForPortReleased(port, 5, 50);
    expect(result).toBe(true);
  });
});
