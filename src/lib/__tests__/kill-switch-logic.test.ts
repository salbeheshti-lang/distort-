// DISTORT — Kill switch logic tests
// Tests the kill switch decision logic without needing real Windows.
// Run: bun run src/lib/__tests__/kill-switch-logic.test.ts

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string, detail?: string) {
  if (condition) {
    console.log(`  ✅ ${name}`);
    passed++;
  } else {
    console.error(`  ❌ ${name}${detail ? " — " + detail : ""}`);
    failed++;
  }
}

// ============================================================================
// Mock kill switch state machine (mirrors desktop/src/main.ts logic)
// ============================================================================

class MockKillSwitch {
  active = false;
  gateway = "";
  iface = 0;
  metric = 25;
  vpnIp = "";
  backupFileExists = false;
  vpnRouteAdded = false;
  defaultRouteDeleted = false;
  ipv6RouteDeleted = false;

  // Simulates enableKillSwitch() — returns true if all steps succeeded
  async enable(gateway: string, iface: number, metric: number, vpnIp: string): Promise<boolean> {
    if (this.active) return true;
    if (!gateway || iface === 0) return false; // can't find route
    if (!vpnIp) return false; // can't resolve VPN IP

    this.gateway = gateway;
    this.iface = iface;
    this.metric = metric;
    this.vpnIp = vpnIp;

    // Step 1: Write backup file
    this.backupFileExists = true;

    // Step 2: Add VPN server route (ABORT if fails)
    this.vpnRouteAdded = true; // simulate success
    if (!this.vpnRouteAdded) {
      this.backupFileExists = false; // cleanup
      return false;
    }

    // Step 3: Remove IPv4 default route
    this.defaultRouteDeleted = true;

    // Step 4: Remove IPv6 default route
    this.ipv6RouteDeleted = true;

    // Step 5: Verify (simulate success)
    const verified = true;

    if (!verified) {
      // Rollback
      this.defaultRouteDeleted = false;
      this.ipv6RouteDeleted = false;
      this.vpnRouteAdded = false;
      this.backupFileExists = false;
      this.active = false;
      return false;
    }

    this.active = true;
    return true;
  }

  // Simulates disableKillSwitch()
  async disable(): Promise<boolean> {
    if (!this.active) return true;

    // Restore IPv4 default route
    this.defaultRouteDeleted = false;

    // Restore IPv6
    this.ipv6RouteDeleted = false;

    // Remove VPN server route
    this.vpnRouteAdded = false;

    // Delete backup file (only after successful restore)
    this.backupFileExists = false;

    this.active = false;
    return true;
  }

  // Simulates crash recovery
  async recoverFromCrash(): Promise<boolean> {
    if (!this.backupFileExists) return false; // no backup, nothing to recover

    // Try to restore default route
    this.defaultRouteDeleted = false;
    this.ipv6RouteDeleted = false;

    // If restore succeeds, delete backup
    this.backupFileExists = false;
    this.active = false;
    return true;
  }
}

// ============================================================================
// TESTS
// ============================================================================

console.log("\n🛡️ Kill Switch Logic Tests");
console.log("═".repeat(60));

// Test 1: Normal enable/disable cycle
console.log("\n📋 Normal Enable/Disable Cycle");
const ks1 = new MockKillSwitch();
const enabled1 = await ks1.enable("192.168.1.1", 12, 25, "1.2.3.4");
assert(enabled1 === true, "Kill switch enables successfully");
assert(ks1.active === true, "Kill switch is active after enable");
assert(ks1.vpnRouteAdded === true, "VPN server route was added");
assert(ks1.defaultRouteDeleted === true, "Default route was deleted");
assert(ks1.ipv6RouteDeleted === true, "IPv6 default route was deleted");
assert(ks1.backupFileExists === true, "Backup file was created");

const disabled1 = await ks1.disable();
assert(disabled1 === true, "Kill switch disables successfully");
assert(ks1.active === false, "Kill switch is inactive after disable");
assert(ks1.defaultRouteDeleted === false, "Default route was restored");
assert(ks1.ipv6RouteDeleted === false, "IPv6 route was restored");
assert(ks1.vpnRouteAdded === false, "VPN server route was removed");
assert(ks1.backupFileExists === false, "Backup file was deleted after successful disable");

// Test 2: ABORT if VPN IP can't be resolved
console.log("\n📋 Abort if VPN IP Missing");
const ks2 = new MockKillSwitch();
const enabled2 = await ks2.enable("192.168.1.1", 12, 25, "");
assert(enabled2 === false, "Kill switch aborts when VPN IP is empty");
assert(ks2.active === false, "Kill switch is NOT active");
assert(ks2.defaultRouteDeleted === false, "Default route was NOT deleted (abort)");
assert(ks2.vpnRouteAdded === false, "VPN route was NOT added (abort)");

// Test 3: ABORT if gateway can't be found
console.log("\n📋 Abort if Gateway Missing");
const ks3 = new MockKillSwitch();
const enabled3 = await ks3.enable("", 0, 25, "1.2.3.4");
assert(enabled3 === false, "Kill switch aborts when gateway is missing");
assert(ks3.active === false, "Kill switch is NOT active");
assert(ks3.defaultRouteDeleted === false, "Default route was NOT deleted (abort)");

// Test 4: Crash recovery — backup file exists
console.log("\n📋 Crash Recovery");
const ks4 = new MockKillSwitch();
// Simulate: app crashed while kill switch was active
ks4.backupFileExists = true;
ks4.defaultRouteDeleted = true;
ks4.ipv6RouteDeleted = true;

const recovered = await ks4.recoverFromCrash();
assert(recovered === true, "Crash recovery succeeds");
assert(ks4.defaultRouteDeleted === false, "Default route was restored after crash");
assert(ks4.ipv6RouteDeleted === false, "IPv6 route was restored after crash");
assert(ks4.backupFileExists === false, "Backup file was deleted after successful recovery");

// Test 5: Crash recovery — no backup file
console.log("\n📋 Crash Recovery — No Backup");
const ks5 = new MockKillSwitch();
const recovered5 = await ks5.recoverFromCrash();
assert(recovered5 === false, "Crash recovery returns false when no backup exists");
assert(ks5.active === false, "Kill switch stays inactive");

// Test 6: Double-enable is no-op
console.log("\n📋 Double Enable");
const ks6 = new MockKillSwitch();
await ks6.enable("192.168.1.1", 12, 25, "1.2.3.4");
const enabled6 = await ks6.enable("192.168.1.1", 12, 25, "1.2.3.4");
assert(enabled6 === true, "Second enable returns true (no-op)");
assert(ks6.active === true, "Kill switch stays active");

// Test 7: Double-disable is no-op
console.log("\n📋 Double Disable");
const ks7 = new MockKillSwitch();
const disabled7 = await ks7.disable();
assert(disabled7 === true, "Disable when not active returns true (no-op)");

// Test 8: Metric is saved and restored
console.log("\n📋 Metric Preservation");
const ks8 = new MockKillSwitch();
await ks8.enable("10.0.0.1", 5, 35, "1.2.3.4");
assert(ks8.metric === 35, "Metric was saved correctly (35)");
await ks8.disable();
assert(ks8.metric === 35, "Metric preserved after disable");

// Test 9: VPN IP is saved in backup
console.log("\n📋 VPN IP in Backup");
const ks9 = new MockKillSwitch();
await ks9.enable("192.168.1.1", 12, 25, "5.6.7.8");
assert(ks9.vpnIp === "5.6.7.8", "VPN IP was stored in kill switch state");

// Test 10: Full lifecycle — enable, crash, recover
console.log("\n📋 Full Lifecycle (enable → crash → recover)");
const ks10 = new MockKillSwitch();

// Enable
const en = await ks10.enable("192.168.1.1", 12, 25, "1.2.3.4");
assert(en === true, "1. Enable succeeded");
assert(ks10.active === true, "2. Kill switch active");
assert(ks10.backupFileExists === true, "3. Backup file created");

// Simulate crash — app dies, routes stay deleted, backup file stays
// (kill switch state is lost in memory, but backup file persists on disk)
const ks10_after_crash = new MockKillSwitch();
ks10_after_crash.backupFileExists = true; // backup survived
ks10_after_crash.defaultRouteDeleted = true; // routes still deleted

// Recover
const rec = await ks10_after_crash.recoverFromCrash();
assert(rec === true, "4. Crash recovery succeeded");
assert(ks10_after_crash.defaultRouteDeleted === false, "5. Default route restored");
assert(ks10_after_crash.backupFileExists === false, "6. Backup file cleaned up");

// ============================================================================
// SUMMARY
// ============================================================================
console.log("\n" + "═".repeat(60));
console.log(`📊 Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log("═".repeat(60));

if (failed > 0) {
  console.error(`\n❌ ${failed} test(s) FAILED`);
  process.exit(1);
} else {
  console.log(`\n✅ All ${passed} tests PASSED`);
  process.exit(0);
}
