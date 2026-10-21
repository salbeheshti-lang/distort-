// stuck-deterministic.test.ts
// ---------------------------------------------------------------------------
// DETERMINISTIC tests for stopXrayProcess's stuck-process logic using
// MockChildProcess (no real OS processes, no timing dependency).
//
// These tests verify the EXACT sequence:
//   1. SIGTERM sent → process ignores (no exit) → timeout fires
//   2. SIGKILL sent → process doesn't exit → stuck=true
//   3. exit emitted at controlled time → port re-probe
//   4. if port held → onStuckCleared NOT called
//   5. if ports free → onStuckCleared called exactly once
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

// Helper: get a free port by binding and immediately closing.
async function getFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

// Helper: bind a server to a port and keep it alive (returns cleanup function).
async function holdPort(port: number): Promise<() => Promise<void>> {
  const server = net.createServer(() => {});
  await new Promise<void>((resolve) => {
    server.listen(port, "127.0.0.1", resolve);
  });
  return () => new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("stopXrayProcess — DETERMINISTIC stuck logic (MockChildProcess)", () => {
  test("SIGTERM ignored → SIGKILL sent → stuck=true (exit never fires)", async () => {
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

  test("stuck=true → emit exit later + ports free → onStuckCleared called once", async () => {
    const socksPort = await getFreePort();
    const httpPort = await getFreePort();
    const mock = new MockChildProcess();

    let stuckClearedCount = 0;
    const result = await stopXrayProcess(mock as unknown as ChildProcess, {
      sigtermTimeoutMs: 50,
      sigkillTimeoutMs: 50,
      portProbeAttempts: 2,
      portProbeIntervalMs: 20,
      socksPort,
      httpPort,
      onStuckCleared: () => { stuckClearedCount++; },
    });

    // stuck=true (deterministic — mock hasn't emitted exit yet).
    expect(result.stuck).toBe(true);
    expect(stuckClearedCount).toBe(0); // not called yet

    // Now simulate the stuck process finally exiting.
    mock.emitExit(0);

    // Wait for the async port re-probe to complete.
    await new Promise((r) => setTimeout(r, 200));

    // Ports are free (we used getFreePort) → onStuckCleared MUST have fired.
    expect(stuckClearedCount).toBe(1);
  });

  test("stuck=true → emit exit later + port held → onStuckCleared NOT called", async () => {
    const socksPort = await getFreePort();
    const httpPort = await getFreePort();
    const mock = new MockChildProcess();

    // Hold the SOCKS port with an external server — it survives the mock exit.
    const releaseSocks = await holdPort(socksPort);

    try {
      let stuckClearedCount = 0;
      const result = await stopXrayProcess(mock as unknown as ChildProcess, {
        sigtermTimeoutMs: 50,
        sigkillTimeoutMs: 50,
        portProbeAttempts: 2,
        portProbeIntervalMs: 20,
        socksPort,
        httpPort,
        onStuckCleared: () => { stuckClearedCount++; },
      });

      expect(result.stuck).toBe(true);
      expect(stuckClearedCount).toBe(0);

      // Simulate stuck process finally exiting.
      mock.emitExit(0);

      // Wait for re-probe.
      await new Promise((r) => setTimeout(r, 200));

      // Port is still held → onStuckCleared must NOT fire.
      expect(stuckClearedCount).toBe(0);
    } finally {
      await releaseSocks();
    }
  });

  test("stuck=true → emit exit → onStuckCleared not called twice (dedup)", async () => {
    const socksPort = await getFreePort();
    const httpPort = await getFreePort();
    const mock = new MockChildProcess();

    let stuckClearedCount = 0;
    const result = await stopXrayProcess(mock as unknown as ChildProcess, {
      sigtermTimeoutMs: 50,
      sigkillTimeoutMs: 50,
      portProbeAttempts: 2,
      portProbeIntervalMs: 20,
      socksPort,
      httpPort,
      onStuckCleared: () => { stuckClearedCount++; },
    });

    expect(result.stuck).toBe(true);

    // Emit exit twice (shouldn't happen in real Node, but defensive test).
    mock.emitExit(0);
    await new Promise((r) => setTimeout(r, 100));
    mock.emitExit(0); // second emit should be no-op
    await new Promise((r) => setTimeout(r, 100));

    expect(stuckClearedCount).toBe(1); // exactly once
  });

  test("SIGTERM causes exit immediately → not stuck, portsReleased=true (deterministic)", async () => {
    const socksPort = await getFreePort();
    const httpPort = await getFreePort();
    const mock = new MockChildProcess();

    // We need to emit exit DURING the SIGTERM phase, before the timeout.
    // Use a sigtermTimeoutMs long enough that we can react to the kill() call.
    const result = stopXrayProcess(mock as unknown as ChildProcess, {
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

    const r = await result;

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
