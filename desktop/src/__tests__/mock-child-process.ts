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
   * Simulates sending a signal to the process. Records the signal.
   * Sets `killed = true` (matches Node ChildProcess behavior — kill() sets
   * killed=true even if the process hasn't exited yet).
   * Does NOT cause 'exit' to fire — the test must call emitExit() explicitly.
   */
  kill(signal?: string): boolean {
    if (this.killShouldThrow) {
      throw new Error(`EPERM: kill ${signal} failed`);
    }
    this.signalsReceived.push(signal || "SIGTERM");
    this.killed = true;
    return true;
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
