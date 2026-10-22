// mock-child-process.ts
// ---------------------------------------------------------------------------
// A test-only MockChildProcess that implements the MINIMAL interface
// required by stopXrayProcess (from xray-process-manager.ts).
//
// Why: the real Node ChildProcess's exit timing depends on OS scheduling
// and signal delivery — making "stuck after SIGKILL" tests inherently
// flaky. This mock lets us control EXACTLY when 'exit' fires, so we can
// deterministically test:
//   1. SIGTERM sent → process ignores → timeout fires
//   2. SIGKILL sent → process doesn't exit immediately → stuck=true
//   3. exit emitted later (at our control) → port re-probe → callback decision
//
// The mock uses Node's EventEmitter under the hood, so `proc.once("exit", cb)`
// and `proc.removeListener("exit", cb)` work exactly like a real ChildProcess.
//
// `kill(signal)` records the signal but does NOT cause 'exit' to fire —
// the test must explicitly call `mock.emitExit()` to simulate the process
// finally dying.
//
// This mock does NOT claim to simulate real OS signal behavior. It only
// tests the LOGIC of stopXrayProcess's decision-making.
// ---------------------------------------------------------------------------

import { EventEmitter } from "events";

export class MockChildProcess extends EventEmitter {
  public killed: boolean = false;
  public exitCode: number | null = null;
  public signalCode: string | null = null;
  public pid: number = Math.floor(Math.random() * 100000) + 1000;

  /** Signals received, in order. */
  public signalsReceived: string[] = [];

  /** Whether kill() should throw (simulates EPERM on a zombie). */
  public killShouldThrow: boolean = false;

  /**
   * Internal resolvers for each signal. When kill(signal) is called,
   * the corresponding resolver is set so the test can await it.
   * This eliminates the need for setTimeout(r, 30) to "wait for SIGTERM delivery".
   */
  private signalResolvers: Map<string, () => void> = new Map();

  /**
   * Simulates sending a signal to the process. Records the signal.
   * Sets `killed = true` (matches Node ChildProcess behavior — kill() sets
   * killed=true even if the process hasn't exited yet).
   * Does NOT cause 'exit' to fire — the test must call emitExit() explicitly.
   *
   * After kill() returns, the test can `await mock.waitForSignal("SIGTERM")`
   * to deterministically know the signal was received.
   */
  kill(signal?: string): boolean {
    const sig = signal || "SIGTERM";
    if (this.killShouldThrow) {
      throw new Error(`EPERM: kill ${sig} failed`);
    }
    this.signalsReceived.push(sig);
    this.killed = true;
    // Resolve any pending waitForSignal for this signal.
    const resolver = this.signalResolvers.get(sig);
    if (resolver) {
      this.signalResolvers.delete(sig);
      // Schedule on next microtask so kill() returns first.
      Promise.resolve().then(() => resolver());
    }
    return true;
  }

  /**
   * Returns a Promise that resolves when kill(signal) is called with the
   * given signal. This lets tests deterministically wait for signal delivery
   * WITHOUT setTimeout.
   *
   * Usage:
   *   const sigtermPromise = mock.waitForSignal("SIGTERM");
   *   // ... start stopXrayProcess ...
   *   await sigtermPromise;  // SIGTERM has been sent
   *   mock.emitExit(0);      // now simulate exit
   */
  waitForSignal(signal: string): Promise<void> {
    // If the signal was already received, resolve immediately.
    if (this.signalsReceived.includes(signal)) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.signalResolvers.set(signal, resolve);
    });
  }

  /**
   * Simulates the process finally emitting 'exit'. Sets exitCode/signalCode
   * and fires the 'exit' event so all registered listeners run.
   */
  emitExit(code: number = 0, signal: string | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }

  /** Alias for emitExit — reads more naturally in test code. */
  simulateExit(code: number = 0): void {
    this.emitExit(code);
  }
}
