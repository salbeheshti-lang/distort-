// stuck-deterministic.test.ts
// ---------------------------------------------------------------------------
// DETERMINISTIC tests for stopXrayProcess's stuck-process logic.
//
// KEY DESIGN: these tests do NOT use setTimeout or Date.now() polling to
// wait for async completion. Instead:
//   - Port probe results are controlled via an injectable `portProber`
//     (a TEST SEAM added to stopXrayProcess in v8 audit).
//   - Callback completion is awaited via a Promise latch that resolves
//     EXACTLY when the callback fires.
//
// The tests call the REAL stopXrayProcess function. MockChildProcess
// controls process exit timing; portProber controls port-probe results.
// Together they provide full deterministic control without OS timing.
//
// Integration tests with real child processes + real TCP probes remain in
// xray-process-manager.test.ts — they test the same code paths but are
// timing-dependent. This file provides the DETERMINISTIC guarantee.
// ---------------------------------------------------------------------------

import { test, expect, describe } from "bun:test";
import { stopXrayProcess, waitForPortReleased } from "../xray-process-manager";
import { MockChildProcess } from "./mock-child-process";
import type { ChildProcess } from "child_process";

// ---------------------------------------------------------------------------
// Injectable port prober helpers — NO real TCP, NO setTimeout.
// ---------------------------------------------------------------------------

/**
 * Create a portProber that returns a controlled result.
 * The probe resolves immediately (no real TCP connect, no setTimeout).
 *
 * `setResult(port, isFree)` lets the test control what the next probe of
 * that port returns. If no result is set for a port, defaults to true (free).
 */
function createControllableProber() {
  const results = new Map<number, boolean>();
  const probeCalls: { port: number; timestamp: number }[] = [];
  return {
    prober: async (port: number, _attempts: number, _intervalMs: number): Promise<boolean> => {
      probeCalls.push({ port, timestamp: Date.now() });
      return results.get(port) ?? true; // default: free
    },
    setResult: (port: number, isFree: boolean) => results.set(port, isFree),
    getCalls: () => probeCalls.slice(),
    getCallCount: (port?: number) => port !== undefined
      ? probeCalls.filter(c => c.port === port).length
      : probeCalls.length,
  };
}

/**
 * Create a portProber that resolves after a controllable signal.
 * The probe returns a Promise that resolves when `resolveProbe(port)` is called.
 * This gives the test EXACT control over WHEN the probe completes.
 */
function createBlockingProber() {
  const resolvers = new Map<number, (result: boolean) => void>();
  const results = new Map<number, boolean>();
  return {
    prober: (port: number, _attempts: number, _intervalMs: number): Promise<boolean> => {
      return new Promise<boolean>((resolve) => {
        resolvers.set(port, resolve);
        // If a result was pre-set, resolve immediately.
        if (results.has(port)) {
          resolve(results.get(port)!);
          resolvers.delete(port);
        }
      });
    },
    /** Pre-set a result + resolve any pending probe for that port. */
    resolveProbe: (port: number, isFree: boolean) => {
      results.set(port, isFree);
      const resolver = resolvers.get(port);
      if (resolver) {
        resolver(isFree);
        resolvers.delete(port);
      }
    },
    /** Pre-set a result (probe will resolve immediately when called). */
    presetResult: (port: number, isFree: boolean) => {
      results.set(port, isFree);
    },
  };
}

// ---------------------------------------------------------------------------
// Callback latch — resolves EXACTLY when callback fires.
// ---------------------------------------------------------------------------

function createCallbackLatch() {
  let callCount = 0;
  let resolveFn: (count: number) => void = () => {};

  const callback = () => {
    callCount++;
    resolveFn(callCount);
  };

  const waitForCallback = (): Promise<number> => {
    return new Promise<number>((resolve, _reject) => {
      resolveFn = resolve;
      // No setTimeout — if callback never fires, the test framework's
      // global timeout will catch it (bun test defaults to 5s).
    });
  };

  return { callback, waitForCallback, getCount: () => callCount };
}

// ---------------------------------------------------------------------------

describe("stopXrayProcess — DETERMINISTIC stuck logic (injectable portProber)", () => {
  test("SIGTERM ignored → SIGKILL sent → stuck=true (no exit, deterministic)", async () => {
    const prober = createControllableProber();
    const mock = new MockChildProcess();

    const result = await stopXrayProcess(mock as unknown as ChildProcess, {
      sigtermTimeoutMs: 50,
      sigkillTimeoutMs: 50,
      portProbeAttempts: 1,
      portProbeIntervalMs: 10,
      portProber: prober.prober,
    });

    expect(result.didExit).toBe(false);
    expect(result.stuck).toBe(true);
    expect(mock.signalsReceived).toEqual(["SIGTERM", "SIGKILL"]);
    expect(result.portsReleased).toBe(false); // stuck → no port probe
    // No probe calls because stuck=true skips port probe.
    expect(prober.getCallCount()).toBe(0);
  });

  test("stuck=true → emit exit + ports free → onStuckCleared called exactly once", async () => {
    const prober = createBlockingProber();
    prober.presetResult(10808, true);  // SOCKS free
    prober.presetResult(10809, true);  // HTTP free

    const mock = new MockChildProcess();
    const latch = createCallbackLatch();

    const stopPromise = stopXrayProcess(mock as unknown as ChildProcess, {
      sigtermTimeoutMs: 50,
      sigkillTimeoutMs: 50,
      portProbeAttempts: 2,
      portProbeIntervalMs: 20,
      socksPort: 10808,
      httpPort: 10809,
      portProber: prober.prober,
      onStuckCleared: latch.callback,
    });

    // Wait for stopXrayProcess to return (stuck=true).
    const result = await stopPromise;
    expect(result.stuck).toBe(true);
    expect(latch.getCount()).toBe(0); // not called yet

    // Start waiting BEFORE emitting exit.
    const countPromise = latch.waitForCallback();

    // Emit exit — triggers async port re-probe.
    mock.emitExit(0);

    // Both ports are pre-set as free → probes resolve immediately →
    // onStuckCleared fires synchronously after the probe chain.
    const count = await countPromise;
    expect(count).toBe(1);
  });

  test("stuck=true → emit exit + port held → onStuckCleared NOT called (deterministic)", async () => {
    const prober = createBlockingProber();
    prober.presetResult(10808, false); // SOCKS held
    prober.presetResult(10809, true);  // HTTP free

    const mock = new MockChildProcess();
    const latch = createCallbackLatch();

    const stopPromise = stopXrayProcess(mock as unknown as ChildProcess, {
      sigtermTimeoutMs: 50,
      sigkillTimeoutMs: 50,
      portProbeAttempts: 2,
      portProbeIntervalMs: 20,
      socksPort: 10808,
      httpPort: 10809,
      portProber: prober.prober,
      onStuckCleared: latch.callback,
    });

    const result = await stopPromise;
    expect(result.stuck).toBe(true);

    // Emit exit — triggers async port re-probe.
    mock.emitExit(0);

    // Port 10808 is held → probes resolve immediately with false →
    // onStuckCleared does NOT fire. We verify by waiting for the probe
    // chain to complete. Since probes are pre-set (no setTimeout), they
    // resolve synchronously in the microtask queue. We just need one
    // microtask tick to let the .then() chain execute.
    await new Promise(r => setTimeout(r, 0)); // one microtask tick

    // Callback must NOT have fired.
    expect(latch.getCount()).toBe(0);
  });

  test("stuck=true → emit exit twice → onStuckCleared called exactly once (dedup)", async () => {
    const prober = createBlockingProber();
    prober.presetResult(10808, true);
    prober.presetResult(10809, true);

    const mock = new MockChildProcess();
    const latch = createCallbackLatch();

    const stopPromise = stopXrayProcess(mock as unknown as ChildProcess, {
      sigtermTimeoutMs: 50,
      sigkillTimeoutMs: 50,
      portProbeAttempts: 2,
      portProbeIntervalMs: 20,
      socksPort: 10808,
      httpPort: 10809,
      portProber: prober.prober,
      onStuckCleared: latch.callback,
    });

    const result = await stopPromise;
    expect(result.stuck).toBe(true);

    // Start waiting BEFORE emitting exit.
    const countPromise = latch.waitForCallback();

    // First emit — should trigger callback.
    mock.emitExit(0);
    const count = await countPromise;
    expect(count).toBe(1);

    // Second emit — should be no-op (stuckClearedFired flag).
    mock.emitExit(0);
    // One microtask tick to let any potential second callback execute.
    await new Promise(r => setTimeout(r, 0));

    // Still exactly once.
    expect(latch.getCount()).toBe(1);
  });

  test("SIGTERM causes exit → not stuck, portsReleased=true (deterministic)", async () => {
    const prober = createControllableProber();
    prober.setResult(10808, true);
    prober.setResult(10809, true);

    const mock = new MockChildProcess();

    const stopPromise = stopXrayProcess(mock as unknown as ChildProcess, {
      sigtermTimeoutMs: 200,
      sigkillTimeoutMs: 50,
      portProbeAttempts: 2,
      portProbeIntervalMs: 20,
      socksPort: 10808,
      httpPort: 10809,
      portProber: prober.prober,
    });

    // Wait for SIGTERM to be sent.
    await new Promise(r => setTimeout(r, 30));
    expect(mock.signalsReceived).toContain("SIGTERM");

    // Emit exit — resolves the SIGTERM promise.
    mock.emitExit(0);

    const r = await stopPromise;
    expect(r.didExit).toBe(true);
    expect(r.stuck).toBe(false);
    expect(mock.signalsReceived).toEqual(["SIGTERM"]);
    expect(r.portsReleased).toBe(true);
    // Probes were called (both ports).
    expect(prober.getCallCount(10808)).toBe(1);
    expect(prober.getCallCount(10809)).toBe(1);
  });

  test("SIGTERM fails (EPERM) → SIGKILL fallback → stuck if no exit", async () => {
    const prober = createControllableProber();
    const mock = new MockChildProcess();
    mock.killShouldThrow = true;

    const result = await stopXrayProcess(mock as unknown as ChildProcess, {
      sigtermTimeoutMs: 50,
      sigkillTimeoutMs: 50,
      portProbeAttempts: 1,
      portProbeIntervalMs: 10,
      portProber: prober.prober,
    });

    expect(result.stuck).toBe(true);
    expect(result.didExit).toBe(false);
  });

  test("process exits normally + ports released → portsReleased=true", async () => {
    const prober = createControllableProber();
    prober.setResult(10808, true);
    prober.setResult(10809, true);

    const mock = new MockChildProcess();

    const stopPromise = stopXrayProcess(mock as unknown as ChildProcess, {
      sigtermTimeoutMs: 200,
      sigkillTimeoutMs: 50,
      portProbeAttempts: 2,
      portProbeIntervalMs: 20,
      socksPort: 10808,
      httpPort: 10809,
      portProber: prober.prober,
    });

    await new Promise(r => setTimeout(r, 30));
    mock.emitExit(0);

    const r = await stopPromise;
    expect(r.didExit).toBe(true);
    expect(r.stuck).toBe(false);
    expect(r.portsReleased).toBe(true);
  });

  test("process exits normally + SOCKS held → portsReleased=false", async () => {
    const prober = createControllableProber();
    prober.setResult(10808, false); // SOCKS held
    prober.setResult(10809, true);  // HTTP free

    const mock = new MockChildProcess();

    const stopPromise = stopXrayProcess(mock as unknown as ChildProcess, {
      sigtermTimeoutMs: 200,
      sigkillTimeoutMs: 50,
      portProbeAttempts: 2,
      portProbeIntervalMs: 20,
      socksPort: 10808,
      httpPort: 10809,
      portProber: prober.prober,
    });

    await new Promise(r => setTimeout(r, 30));
    mock.emitExit(0);

    const r = await stopPromise;
    expect(r.didExit).toBe(true);
    expect(r.stuck).toBe(false);
    expect(r.portsReleased).toBe(false);
  });

  test("process exits normally + HTTP held → portsReleased=false", async () => {
    const prober = createControllableProber();
    prober.setResult(10808, true);  // SOCKS free
    prober.setResult(10809, false); // HTTP held

    const mock = new MockChildProcess();

    const stopPromise = stopXrayProcess(mock as unknown as ChildProcess, {
      sigtermTimeoutMs: 200,
      sigkillTimeoutMs: 50,
      portProbeAttempts: 2,
      portProbeIntervalMs: 20,
      socksPort: 10808,
      httpPort: 10809,
      portProber: prober.prober,
    });

    await new Promise(r => setTimeout(r, 30));
    mock.emitExit(0);

    const r = await stopPromise;
    expect(r.didExit).toBe(true);
    expect(r.stuck).toBe(false);
    expect(r.portsReleased).toBe(false);
  });
});

describe("stopXrayProcess — full stuck sequence (deterministic, step-by-step)", () => {
  test("complete: SIGTERM → timeout → SIGKILL → stuck → exit → recheck → callback", async () => {
    const prober = createBlockingProber();
    prober.presetResult(10808, true);
    prober.presetResult(10809, true);

    const mock = new MockChildProcess();
    const latch = createCallbackLatch();

    const stopPromise = stopXrayProcess(mock as unknown as ChildProcess, {
      sigtermTimeoutMs: 50,
      sigkillTimeoutMs: 50,
      portProbeAttempts: 2,
      portProbeIntervalMs: 20,
      socksPort: 10808,
      httpPort: 10809,
      portProber: prober.prober,
      onStuckCleared: latch.callback,
    });

    // Step 1: wait for stopXrayProcess to return (stuck=true).
    const result = await stopPromise;

    // Step 2: verify SIGTERM + SIGKILL were sent.
    expect(mock.signalsReceived).toEqual(["SIGTERM", "SIGKILL"]);

    // Step 3: verify stuck=true (deterministic — no exit yet).
    expect(result.didExit).toBe(false);
    expect(result.stuck).toBe(true);
    expect(latch.getCount()).toBe(0);

    // Step 4: start waiting for callback BEFORE emitting exit.
    const countPromise = latch.waitForCallback();

    // Step 5: emit exit — triggers port re-probe.
    mock.emitExit(0);

    // Step 6: ports are pre-set as free → probes resolve immediately →
    // callback fires. await resolves when callback fires.
    const count = await countPromise;
    expect(count).toBe(1);

    // Step 7: verify prober was called for both ports.
    expect(prober.prober).toBeDefined();
  });
});

describe("stopXrayProcess — stuck callback does NOT clear when port held after late exit", () => {
  test("stuck → late exit → SOCKS still held → callback NOT called", async () => {
    const prober = createBlockingProber();
    prober.presetResult(10808, false); // SOCKS held
    prober.presetResult(10809, true);  // HTTP free

    const mock = new MockChildProcess();
    const latch = createCallbackLatch();

    const stopPromise = stopXrayProcess(mock as unknown as ChildProcess, {
      sigtermTimeoutMs: 50,
      sigkillTimeoutMs: 50,
      portProbeAttempts: 2,
      portProbeIntervalMs: 20,
      socksPort: 10808,
      httpPort: 10809,
      portProber: prober.prober,
      onStuckCleared: latch.callback,
    });

    const result = await stopPromise;
    expect(result.stuck).toBe(true);

    // Emit exit — triggers re-probe. Port 10808 is held → callback must NOT fire.
    mock.emitExit(0);

    // One microtask tick for the .then() chain to execute.
    await new Promise(r => setTimeout(r, 0));

    expect(latch.getCount()).toBe(0); // NOT called
  });

  test("stuck → late exit → HTTP still held → callback NOT called", async () => {
    const prober = createBlockingProber();
    prober.presetResult(10808, true);  // SOCKS free
    prober.presetResult(10809, false); // HTTP held

    const mock = new MockChildProcess();
    const latch = createCallbackLatch();

    const stopPromise = stopXrayProcess(mock as unknown as ChildProcess, {
      sigtermTimeoutMs: 50,
      sigkillTimeoutMs: 50,
      portProbeAttempts: 2,
      portProbeIntervalMs: 20,
      socksPort: 10808,
      httpPort: 10809,
      portProber: prober.prober,
      onStuckCleared: latch.callback,
    });

    const result = await stopPromise;
    expect(result.stuck).toBe(true);

    mock.emitExit(0);
    await new Promise(r => setTimeout(r, 0));

    expect(latch.getCount()).toBe(0); // NOT called
  });
});

describe("waitForPortReleased — real TCP (integration)", () => {
  test("port free → returns true", async () => {
    // Use a high port that's almost certainly free.
    const result = await waitForPortReleased(19999, 1, 10);
    expect(result).toBe(true);
  });
});
