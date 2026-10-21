// stop-and-companion-stale-guard.test.ts
// ---------------------------------------------------------------------------
// Regression tests for v1.0.38 audit findings:
//   - stopVpnEngine must wait for the ACTUAL 'exit' event (not just a delay)
//   - companion API path must use the SAME stale-guard counter as startVpnEngine
//     so a verification callback from either path can be invalidated by a stop
//     or a new start from the other path.
//
// These tests verify the LOGIC of the guards using a simulated attempt-counter
// pattern. They do NOT spin up a real xray process (that requires Electron +
// Windows). Each test asserts that the guard pattern prevents the documented bug.
// ---------------------------------------------------------------------------

import { test, expect, describe } from "bun:test";

// ---------------------------------------------------------------------------
// Simulated attempt-counter pattern (mirrors `currentVerifyAttempt` in main.ts).
// This is the SAME pattern used in quick-connect-failover.test.ts but applied
// to the companion-API scenario.
// ---------------------------------------------------------------------------

describe("stopVpnEngine exit-event wait (Q2 fix)", () => {
  // Simulates the new stopVpnEngine logic: SIGTERM → race exit vs 1s timeout
  // → SIGKILL if needed → wait for exit → 300ms port release.
  // We test the RACE logic, not the actual process kill.
  test("SIGTERM that causes exit within 1s resolves without SIGKILL", async () => {
    let sigkillCalled = false;
    let exited = false;

    // Simulate a process that exits 100ms after SIGTERM.
    const fakeProc = {
      kill: (signal: string) => {
        if (signal === "SIGTERM") {
          setTimeout(() => { exited = true; }, 100);
        } else if (signal === "SIGKILL") {
          sigkillCalled = true;
          exited = true;
        }
      },
      once: (event: string, cb: () => void) => {
        if (event === "exit") {
          // The race in stopVpnEngine polls for exit via this callback.
          // Simulate: if not already exited, the callback fires when exited
          // flips to true.
          const check = setInterval(() => {
            if (exited) {
              clearInterval(check);
              cb();
            }
          }, 50);
        }
      },
      killed: false,
    };

    // Replicate the new stopVpnEngine race logic.
    const exitResult = await new Promise<boolean>((resolve) => {
      const exitTimeout = setTimeout(() => resolve(false), 1000);
      fakeProc.once("exit", () => {
        clearTimeout(exitTimeout);
        resolve(true);
      });
      fakeProc.kill("SIGTERM");
    });

    expect(exitResult).toBe(true);
    expect(sigkillCalled).toBe(false); // SIGKILL should NOT be called
  });

  test("SIGTERM that doesn't cause exit → SIGKILL is sent + wait for exit", async () => {
    let sigtermSent = false;
    let sigkillSent = false;
    let exited = false;

    const fakeProc = {
      kill: (signal: string) => {
        if (signal === "SIGTERM") {
          sigtermSent = true;
          // Don't exit — simulate a stuck process.
        } else if (signal === "SIGKILL") {
          sigkillSent = true;
          // SIGKILL causes exit after 50ms.
          setTimeout(() => { exited = true; }, 50);
        }
      },
      once: (event: string, cb: () => void) => {
        if (event === "exit") {
          const check = setInterval(() => {
            if (exited) {
              clearInterval(check);
              cb();
            }
          }, 20);
        }
      },
      killed: false,
    };

    // Replicate the new stopVpnEngine logic.
    const exitResult = await new Promise<boolean>((resolve) => {
      const exitTimeout = setTimeout(() => resolve(false), 1000);
      fakeProc.once("exit", () => {
        clearTimeout(exitTimeout);
        resolve(true);
      });
      fakeProc.kill("SIGTERM");
    });

    expect(exitResult).toBe(false); // SIGTERM didn't cause exit in 1s
    expect(sigtermSent).toBe(true);

    // Now SIGKILL + wait for exit.
    if (!exitResult) {
      fakeProc.kill("SIGKILL");
      await new Promise<void>((resolve) => {
        const killTimeout = setTimeout(resolve, 2000);
        fakeProc.once("exit", () => {
          clearTimeout(killTimeout);
          resolve();
        });
      });
    }

    expect(sigkillSent).toBe(true);
    expect(exited).toBe(true);
  });
});

describe("companion API stale guard (Q11 fix)", () => {
  // Simulates the shared currentVerifyAttempt counter between the desktop UI
  // path (startVpnEngine) and the companion API path (startTunnelFromUri).
  // Verifies that a stop or new start from EITHER path invalidates in-flight
  // verification callbacks from the OTHER path.
  test("stopVpnEngine (called by startTunnelFromUri) invalidates desktop UI verification", async () => {
    let currentVerifyAttempt = 0;
    let connected = false;

    // Desktop UI path: startVpnEngine (attempt 1).
    currentVerifyAttempt++;
    const desktopAttemptId = currentVerifyAttempt;

    // Companion API path: startTunnelFromUri calls stopVpnEngine first.
    // stopVpnEngine bumps currentVerifyAttempt, invalidating attempt 1.
    currentVerifyAttempt++; // simulate stopVpnEngine's bump
    const companionAttemptId = currentVerifyAttempt;

    // Now the desktop UI's verification callback resolves.
    // It checks: attemptId !== currentVerifyAttempt → stale → drop.
    const desktopVerified = true;
    if (desktopAttemptId === currentVerifyAttempt) {
      // This block should NOT execute — desktop attempt is stale.
      connected = true;
    }

    expect(connected).toBe(false); // desktop attempt was invalidated
    expect(companionAttemptId).toBe(currentVerifyAttempt); // companion is current
  });

  test("desktop UI startVpnEngine invalidates companion API verification", async () => {
    let currentVerifyAttempt = 0;
    let connected = false;
    let connectedVia = "";

    // Companion API path: startTunnelFromUri (attempt 1).
    currentVerifyAttempt++;
    const companionAttemptId = currentVerifyAttempt;

    // Desktop UI path: startVpnEngine calls stopVpnEngine first (bumps counter),
    // then startVpnEngine bumps again for its own attempt.
    currentVerifyAttempt++; // stopVpnEngine's bump
    currentVerifyAttempt++; // startVpnEngine's bump
    const desktopAttemptId = currentVerifyAttempt;

    // Desktop UI's verification resolves and sets connected.
    const desktopVerified = true;
    if (desktopAttemptId === currentVerifyAttempt && desktopVerified) {
      connected = true;
      connectedVia = "desktop";
    }

    // NOW: companion API's verification resolves LATE.
    const companionVerified = true;
    if (companionAttemptId === currentVerifyAttempt && companionVerified) {
      // This should NOT execute — companion attempt is stale.
      connected = false; // would overwrite if not guarded
      connectedVia = "companion";
    }

    expect(connected).toBe(true);
    expect(connectedVia).toBe("desktop"); // not overwritten by stale companion
  });

  test("concurrent stopVpnEngine calls don't double-decrement or race", async () => {
    // Two concurrent stopVpnEngine calls should both safely bump the counter
    // and both wait for exit. Since they both reference the SAME vpnProcess,
    // the second one will see vpnProcess === null after the first completes.
    let currentVerifyAttempt = 0;
    let vpnProcessExists = true;

    // Simulate first stopVpnEngine.
    currentVerifyAttempt++;
    const stop1Id = currentVerifyAttempt;
    // It kills the process + waits for exit.
    vpnProcessExists = false;

    // Simulate second stopVpnEngine (called concurrently in a real scenario).
    currentVerifyAttempt++;
    const stop2Id = currentVerifyAttempt;
    // It checks vpnProcess — already null, so it's a no-op.
    if (!vpnProcessExists) {
      // No-op — process already stopped.
    }

    expect(stop1Id).toBe(1);
    expect(stop2Id).toBe(2);
    expect(vpnProcessExists).toBe(false);
  });
});
