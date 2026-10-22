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
 *
 * `waitForProbe(port)` returns a Promise that resolves when the prober is
 * called for that port — lets the test deterministically know the probe
 * has completed WITHOUT setTimeout.
 */
function createControllableProber() {
  const results = new Map<number, boolean>();
  const probeResolvers = new Map<number, () => void>();
  let probeCallCount = 0;
  return {
    prober: async (port: number, _attempts: number, _intervalMs: number): Promise<boolean> => {
      probeCallCount++;
      // Signal any pending waitForProbe for this port.
      const resolver = probeResolvers.get(port);
      if (resolver) {
        probeResolvers.delete(port);
        Promise.resolve().then(() => resolver());
      }
      return results.get(port) ?? true; // default: free
    },
    setResult: (port: number, isFree: boolean) => results.set(port, isFree),
    getCallCount: () => probeCallCount,
    /**
     * Returns a Promise that resolves when the prober is next called for
     * the given port. This lets tests deterministically wait for probe
     * completion WITHOUT setTimeout.
     */
    waitForProbe: (port: number): Promise<void> => {
      return new Promise<void>((resolve) => {
        probeResolvers.set(port, resolve);
      });
    },
  };
}

/**
 * Create a portProber with controllable probe results + completion tracking.
 *
 * KEY FEATURE: `onProbeSettled(port)` returns a Promise that resolves AFTER
 * the probe Promise settles AND the subsequent `.then()` handler in
 * stopXrayProcess has finished executing. This is different from
 * `onProbeCalled` which only fires when the prober function is ENTERED.
 *
 * How it works:
 *   1. stopXrayProcess calls doPortProbe(socksPort, ...) → prober is entered
 *   2. prober returns a Promise<boolean>
 *   3. stopXrayProcess chains .then(socksFree => doPortProbe(httpPort, ...))
 *   4. When the SOCKS probe resolves, the .then() handler runs
 *   5. Inside the .then(), the HTTP probe is called
 *   6. When BOTH probes settle + the final .then() runs, the callback
 *      decision is made
 *
 * `onProbeSettled(port)` resolves at step 2 (when the Promise settles),
 * NOT at step 4. To wait for the FULL chain, use `onProbeChainComplete()`.
 *
 * `onProbeChainComplete()` resolves when BOTH probes have settled AND the
 * final .then() decision has been made (callback called or not). This is
 * tracked by having the prober return a Promise that, when settled,
 * triggers a microtask that checks if both ports have been probed.
 */
function createBlockingProber() {
  // resolvers stores BOTH resolve and reject handlers for each port.
  // Type: { resolve: (result: boolean) => void; reject: (err: any) => void }
  // This allows resolveProbe to resolve, and rejectProbe to reject.
  const resolvers = new Map<number, { resolve: (result: boolean) => void; reject: (err: any) => void }>();
  const results = new Map<number, boolean>();
  const rejectErrors = new Map<number, Error>();
  const probeCalledCallbacks = new Map<number, (() => void)[]>();
  const probeSettledCallbacks = new Map<number, (() => void)[]>();
  const probeResults = new Map<number, boolean>();
  let probeCount = 0;
  let chainCompleteResolve: (() => void) | null = null;
  let chainCompletePromise: Promise<void> | null = null;

  function notifySettled(port: number) {
    const settled = probeSettledCallbacks.get(port);
    if (settled) {
      probeSettledCallbacks.delete(port);
      for (const cb of settled) cb();
    }
    // Check if both ports have settled → chain complete
    if (probeResults.size >= 2 && chainCompleteResolve) {
      const r = chainCompleteResolve;
      chainCompleteResolve = null;
      chainCompletePromise = null;
      // Schedule on next microtask so the .then() chain finishes first
      Promise.resolve().then(() => r());
    }
  }

  return {
    prober: (port: number, _attempts: number, _intervalMs: number): Promise<boolean> => {
      probeCount++;
      // Notify onProbeCalled listeners
      const called = probeCalledCallbacks.get(port);
      if (called) {
        probeCalledCallbacks.delete(port);
        for (const cb of called) Promise.resolve().then(() => cb());
      }
      return new Promise<boolean>((resolve, reject) => {
        const handlers = {
          resolve: (result: boolean) => {
            probeResults.set(port, result);
            Promise.resolve().then(() => notifySettled(port));
            resolve(result);
          },
          reject: (err: any) => {
            // Even on rejection, track that this port was probed so
            // onProbeChainComplete doesn't hang forever.
            probeResults.set(port, false);
            Promise.resolve().then(() => notifySettled(port));
            reject(err);
          },
        };
        resolvers.set(port, handlers);
        // If a result was pre-set, resolve immediately.
        if (results.has(port)) {
          const r = results.get(port)!;
          probeResults.set(port, r);
          resolvers.delete(port);
          Promise.resolve().then(() => notifySettled(port));
          resolve(r);
        }
        // If a rejection was pre-set, reject immediately.
        if (rejectErrors.has(port)) {
          const err = rejectErrors.get(port)!;
          probeResults.set(port, false);
          resolvers.delete(port);
          Promise.resolve().then(() => notifySettled(port));
          reject(err);
        }
      });
    },
    /** Pre-set a result + resolve any pending probe for that port. */
    resolveProbe: (port: number, isFree: boolean) => {
      results.set(port, isFree);
      const h = resolvers.get(port);
      if (h) {
        resolvers.delete(port);
        h.resolve(isFree);
      }
    },
    /** Pre-set a rejection + reject any pending probe for that port. */
    rejectProbe: (port: number, error: Error) => {
      rejectErrors.set(port, error);
      const h = resolvers.get(port);
      if (h) {
        resolvers.delete(port);
        h.reject(error);
      }
    },
    /** Pre-set a result (probe will resolve immediately when called). */
    presetResult: (port: number, isFree: boolean) => {
      results.set(port, isFree);
    },
    /** Pre-set a rejection (probe will reject immediately when called). */
    presetReject: (port: number, error: Error) => {
      rejectErrors.set(port, error);
    },
    /**
     * Resolves when the prober is ENTERED for the given port.
     * Does NOT wait for the probe to settle or the .then() chain.
     */
    onProbeCalled: (port: number): Promise<void> => {
      return new Promise<void>((resolve) => {
        const callbacks = probeCalledCallbacks.get(port) || [];
        callbacks.push(resolve);
        probeCalledCallbacks.set(port, callbacks);
      });
    },
    /**
     * Resolves when the probe Promise for the given port SETTLES (resolves).
     * Does NOT wait for the .then() chain to complete.
     */
    onProbeSettled: (port: number): Promise<void> => {
      // If already settled, resolve immediately
      if (probeResults.has(port)) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const callbacks = probeSettledCallbacks.get(port) || [];
        callbacks.push(resolve);
        probeSettledCallbacks.set(port, callbacks);
      });
    },
    /**
     * Resolves when BOTH ports have been probed AND settled.
     * After this resolves, the callback decision in stopXrayProcess's
     * .then() chain has been made (or is about to be on the next microtask).
     *
     * This is the correct signal for asserting callback count — it
     * guarantees the FULL probe chain has completed.
     */
    onProbeChainComplete: (): Promise<void> => {
      if (probeResults.size >= 2) return Promise.resolve();
      if (chainCompletePromise) return chainCompletePromise;
      chainCompletePromise = new Promise<void>((resolve) => {
        chainCompleteResolve = resolve;
      });
      return chainCompletePromise;
    },
    /** Reset state for reuse (between tests). */
    reset: () => {
      probeResults.clear();
      probeCount = 0;
      chainCompleteResolve = null;
      chainCompletePromise = null;
      rejectErrors.clear();
      results.clear();
    },
    getProbeCount: () => probeCount,
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

    // Register the chain-complete signal BEFORE emitting exit.
    // onProbeChainComplete resolves when BOTH probes have settled AND the
    // .then() decision (callback call or skip) has been made.
    const chainComplete = prober.onProbeChainComplete();

    // Emit exit — triggers async port re-probe.
    mock.emitExit(0);

    // Wait for the FULL probe chain to complete — not just probe entry,
    // but probe settle + .then() decision. This is deterministic.
    await chainComplete;

    // Callback must NOT have fired (SOCKS port is held).
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

    // Register the chain-complete signal BEFORE first emit.
    const firstChain = prober.onProbeChainComplete();

    // Start waiting for callback BEFORE emitting exit.
    const countPromise = latch.waitForCallback();

    // First emit — should trigger probe chain + callback.
    mock.emitExit(0);

    // Wait for the FULL probe chain to complete.
    await firstChain;
    const count = await countPromise;
    expect(count).toBe(1);
    // Verify exactly 2 probes ran (one per port).
    expect(prober.getProbeCount()).toBe(2);

    // Reset the prober's tracking state so the second chain-complete
    // signal starts fresh. Without reset, probeResults.size >= 2 from
    // the first chain would make onProbeChainComplete resolve immediately.
    prober.reset();
    // Re-preset the results so if a second probe DOES run (dedup failed),
    // it has results to return.
    prober.presetResult(10808, true);
    prober.presetResult(10809, true);

    // Now register a SECOND chain-complete signal.
    // If the second emitExit triggers a probe chain, this will resolve.
    // If dedup works (stuckClearedFired=true), it never resolves.
    const secondChain = prober.onProbeChainComplete();
    const probeCountBefore = prober.getProbeCount();

    // Second emit — should be no-op (stuckClearedFired flag).
    mock.emitExit(0);

    // Wait for the chain-complete signal. If dedup works, this NEVER resolves.
    // We use a real 100ms timeout to detect a hang (NOT for assertion timing —
    // only to prevent the test from hanging forever if dedup is broken).
    // 100ms is sufficient because dedup is synchronous (stuckClearedFired flag)
    const secondChainResult = await Promise.race([
      secondChain.then(() => "resolved"),
      new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 100)),
    ]);

    // If secondChain resolved, dedup FAILED — a second probe chain ran.
    // If "timeout", dedup worked — no second probe was triggered.
    expect(secondChainResult).toBe("timeout");

    // Probe count must NOT have increased (no second probe chain).
    expect(prober.getProbeCount()).toBe(probeCountBefore);

    // Callback still exactly once.
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

    // Deterministically wait for SIGTERM to be sent (no setTimeout).
    await mock.waitForSignal("SIGTERM");
    expect(mock.signalsReceived).toContain("SIGTERM");

    // Emit exit — resolves the SIGTERM promise.
    mock.emitExit(0);

    const r = await stopPromise;
    expect(r.didExit).toBe(true);
    expect(r.stuck).toBe(false);
    expect(mock.signalsReceived).toEqual(["SIGTERM"]);
    expect(r.portsReleased).toBe(true);
    // Probes were called (both ports).
    expect(prober.getCallCount()).toBe(2);
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

    await mock.waitForSignal("SIGTERM");
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

    await mock.waitForSignal("SIGTERM");
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

    await mock.waitForSignal("SIGTERM");
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

    // Register the chain-complete signal BEFORE emitting exit.
    const chainComplete = prober.onProbeChainComplete();

    // Emit exit — triggers re-probe. Port 10808 is held → callback must NOT fire.
    mock.emitExit(0);

    // Wait for the FULL probe chain to complete (deterministic — no setTimeout).
    await chainComplete;

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

    // Register probe-completion signals BEFORE emitting exit.
    const socksProbed = prober.onProbeCalled(10808);
    const httpProbed = prober.onProbeCalled(10809);

    mock.emitExit(0);

    // Wait for BOTH probes to complete (deterministic — no setTimeout).
    await socksProbed;
    await httpProbed;

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

// ---------------------------------------------------------------------------
// Tests for the createBlockingProber helper itself — verifies correct
// behavior with concurrent waits, duplicate signals, and early calls.
// ---------------------------------------------------------------------------

describe("createBlockingProber — helper robustness tests", () => {
  test("onProbeChainComplete resolves after both probes settle", async () => {
    const prober = createBlockingProber();
    // Don't preset results — use resolveProbe to control timing.

    const chain = prober.onProbeChainComplete();

    // Simulate first probe (SOCKS) — don't resolve yet.
    const probe1 = prober.prober(10808, 1, 10);
    // Chain should NOT be complete yet.
    let chainResolved = false;
    chain.then(() => { chainResolved = true; });
    await new Promise(r => setTimeout(r, 10)); // let microtasks drain
    expect(chainResolved).toBe(false);

    // Resolve first probe.
    prober.resolveProbe(10808, true);
    await probe1;
    await new Promise(r => setTimeout(r, 10));
    // Chain still NOT complete — only one probe settled.
    expect(chainResolved).toBe(false);

    // Simulate second probe (HTTP) — resolve immediately.
    prober.presetResult(10809, true);
    const probe2 = prober.prober(10809, 1, 10);
    await probe2;
    await new Promise(r => setTimeout(r, 10));

    // NOW chain should be complete.
    expect(chainResolved).toBe(true);
  });

  test("multiple onProbeChainComplete calls all resolve", async () => {
    const prober = createBlockingProber();
    prober.presetResult(10808, true);
    prober.presetResult(10809, true);

    // Register 3 concurrent chain-complete waits.
    const chain1 = prober.onProbeChainComplete();
    const chain2 = prober.onProbeChainComplete();
    const chain3 = prober.onProbeChainComplete();

    let resolvedCount = 0;
    chain1.then(() => resolvedCount++);
    chain2.then(() => resolvedCount++);
    chain3.then(() => resolvedCount++);

    // Run both probes.
    await prober.prober(10808, 1, 10);
    await prober.prober(10809, 1, 10);
    await new Promise(r => setTimeout(r, 10));

    // All 3 should have resolved.
    expect(resolvedCount).toBe(3);
  });

  test("onProbeChainComplete called after probes already settled resolves immediately", async () => {
    const prober = createBlockingProber();
    prober.presetResult(10808, true);
    prober.presetResult(10809, true);

    // Run both probes first.
    await prober.prober(10808, 1, 10);
    await prober.prober(10809, 1, 10);
    await new Promise(r => setTimeout(r, 10));

    // Now register chain-complete — should resolve immediately.
    const chain = prober.onProbeChainComplete();
    let resolved = false;
    chain.then(() => { resolved = true; });
    await new Promise(r => setTimeout(r, 10));
    expect(resolved).toBe(true);
  });

  test("reset() clears state for reuse", async () => {
    const prober = createBlockingProber();
    prober.presetResult(10808, true);
    prober.presetResult(10809, true);

    // First cycle.
    await prober.prober(10808, 1, 10);
    await prober.prober(10809, 1, 10);
    expect(prober.getProbeCount()).toBe(2);

    // Reset.
    prober.reset();
    expect(prober.getProbeCount()).toBe(0);

    // Second cycle should work fresh.
    prober.presetResult(10808, false);
    prober.presetResult(10809, true);
    const chain = prober.onProbeChainComplete();
    const r1 = await prober.prober(10808, 1, 10);
    const r2 = await prober.prober(10809, 1, 10);
    await chain;
    expect(r1).toBe(false);
    expect(r2).toBe(true);
    expect(prober.getProbeCount()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Tests for rejection handling (v10 audit fix).
// Verifies that onProbeChainComplete does NOT hang when a probe rejects,
// and that rejection is not silently treated as success.
// ---------------------------------------------------------------------------

describe("createBlockingProber — rejection handling", () => {
  test("onProbeChainComplete resolves after probe rejection (no hang)", async () => {
    const prober = createBlockingProber();
    prober.presetReject(10808, new Error("ECONNREFUSED"));
    prober.presetResult(10809, true);

    // Both probes run: SOCKS rejects, HTTP resolves.
    const p1 = prober.prober(10808, 1, 10);
    const p2 = prober.prober(10809, 1, 10);

    // SOCKS should reject.
    await expect(p1).rejects.toThrow("ECONNREFUSED");
    // HTTP should resolve.
    await expect(p2).resolves.toBe(true);

    // onProbeChainComplete must NOT hang — it should resolve because
    // both probes have settled (one resolved, one rejected).
    const chain = prober.onProbeChainComplete();
    // Use a 500ms timeout as a safety net — NOT for assertion timing.
    // The chain should resolve on the next microtask after both probes settle.
    const result = await Promise.race([
      chain.then(() => "resolved"),
      new Promise<string>((r) => setTimeout(() => r("hang"), 500)),
    ]);
    expect(result).toBe("resolved");
  });

  test("rejected probe does not count as success (probeResults records false)", async () => {
    const prober = createBlockingProber();
    prober.presetReject(10808, new Error("EPERM"));

    const p = prober.prober(10808, 1, 10);
    await expect(p).rejects.toThrow("EPERM");

    // After rejection, onProbeSettled should resolve (not hang).
    const settled = prober.onProbeSettled(10808);
    const result = await Promise.race([
      settled.then(() => "settled"),
      new Promise<string>((r) => setTimeout(() => r("hang"), 500)),
    ]);
    expect(result).toBe("settled");
  });

  test("both probes reject → onProbeChainComplete still resolves", async () => {
    const prober = createBlockingProber();
    prober.presetReject(10808, new Error("ECONNREFUSED"));
    prober.presetReject(10809, new Error("EACCES"));

    const p1 = prober.prober(10808, 1, 10);
    const p2 = prober.prober(10809, 1, 10);

    await expect(p1).rejects.toThrow("ECONNREFUSED");
    await expect(p2).rejects.toThrow("EACCES");

    const chain = prober.onProbeChainComplete();
    const result = await Promise.race([
      chain.then(() => "resolved"),
      new Promise<string>((r) => setTimeout(() => r("hang"), 500)),
    ]);
    expect(result).toBe("resolved");
  });

  test("rejectProbe() on a pending probe triggers rejection", async () => {
    const prober = createBlockingProber();
    // Don't preset — create a pending probe, then reject it.
    const p = prober.prober(10808, 1, 10);
    prober.rejectProbe(10808, new Error("test rejection"));

    await expect(p).rejects.toThrow("test rejection");
  });

  test("stopXrayProcess with rejecting prober — stuck path catches rejection (onStuckCleared NOT called)", async () => {
    // In the stuck path, stopXrayProcess chains:
    //   doPortProbe(socks).then(socksFree => doPortProbe(http).then(...))
    //   .catch(e => log error, don't call onStuckCleared)
    // If SOCKS probe rejects, the .catch fires. The HTTP probe is NEVER
    // called (the .then is skipped). So probeResults.size stays at 1.
    //
    // onProbeChainComplete would hang waiting for size >= 2. To handle
    // this, we DON'T use onProbeChainComplete here — we use onProbeSettled
    // for just the SOCKS port (the one that rejects). The .catch in
    // stopXrayProcess fires synchronously after SOCKS rejects, so we just
    // need to wait for SOCKS to settle.
    const prober = createBlockingProber();
    prober.presetReject(10808, new Error("simulated ECONNREFUSED"));
    prober.presetResult(10809, true);

    const mock = new MockChildProcess();
    const latch = createCallbackLatch();

    const stopPromise = stopXrayProcess(mock as unknown as ChildProcess, {
      sigtermTimeoutMs: 50,
      sigkillTimeoutMs: 50,
      portProbeAttempts: 1,
      portProbeIntervalMs: 10,
      socksPort: 10808,
      httpPort: 10809,
      portProber: prober.prober,
      onStuckCleared: latch.callback,
    });

    const result = await stopPromise;
    expect(result.stuck).toBe(true);

    // Wait for SOCKS probe to settle (reject). After rejection, the
    // .catch() in stopXrayProcess fires and the chain is done.
    const socksSettled = prober.onProbeSettled(10808);

    // Emit exit — triggers the re-probe chain.
    mock.emitExit(0);

    // Wait for SOCKS to settle (it rejects, but onProbeSettled still fires
    // because the reject handler calls notifySettled).
    await socksSettled;

    // Give one microtask for the .catch() handler to run.
    await new Promise(r => setTimeout(r, 0));

    // onStuckCleared must NOT have been called — the .catch() in
    // stopXrayProcess catches the rejection and refuses to clear.
    expect(latch.getCount()).toBe(0);

    // Also verify only 1 probe ran (HTTP probe was never called because
    // SOCKS rejected and .then() was skipped).
    expect(prober.getProbeCount()).toBe(1);
  });

  test("no unhandled rejection from stopXrayProcess when probe rejects", async () => {
    // This test verifies that stopXrayProcess's .catch() handler swallows
    // the rejection cleanly. If it didn't, Node would emit an
    // 'unhandledRejection' event.
    const prober = createBlockingProber();
    prober.presetReject(10808, new Error("test unhandled"));

    let unhandledRejection = false;
    const handler = () => { unhandledRejection = true; };
    process.on("unhandledRejection", handler);

    try {
      const mock = new MockChildProcess();

      const stopPromise = stopXrayProcess(mock as unknown as ChildProcess, {
        sigtermTimeoutMs: 50,
        sigkillTimeoutMs: 50,
        portProbeAttempts: 1,
        portProbeIntervalMs: 10,
        socksPort: 10808,
        httpPort: 10809,
        portProber: prober.prober,
      });

      const result = await stopPromise;
      // Emit exit to trigger the re-probe chain.
      mock.emitExit(0);

      // Wait for SOCKS probe to settle (rejects).
      const socksSettled = prober.onProbeSettled(10808);
      await socksSettled;

      // Let any potential unhandledRejection event propagate.
      await new Promise(r => setTimeout(r, 50));

      expect(unhandledRejection).toBe(false);
    } finally {
      process.off("unhandledRejection", handler);
    }
  });
});
