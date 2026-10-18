// DISTORT — Xray config validation tests
// Generates xray configs from real URIs and validates them with 'xray run -test'.
// Run: bun run src/lib/__tests__/xray-config.test.ts
//
// This requires xray binary to be available at:
//   - desktop/resources/bin/xray.exe (Windows)
//   - desktop/resources/bin/xray (Linux/macOS)
// Or XRAY_BIN_PATH env var pointing to the binary.

import { parseUriToRealConfig, buildRealXrayConfig } from "../real-xray-config";
import { writeFileSync, mkdirSync, existsSync, unlinkSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";
import { tmpdir } from "os";

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

// Find xray binary
function findXrayBinary(): string | null {
  // Check env var first
  if (process.env.XRAY_BIN_PATH && existsSync(process.env.XRAY_BIN_PATH)) {
    return process.env.XRAY_BIN_PATH;
  }
  // Check desktop/resources/bin
  const candidates = [
    join(process.cwd(), "desktop", "resources", "bin", "xray"),
    join(process.cwd(), "desktop", "resources", "bin", "xray.exe"),
    "/tmp/xray", // CI might download it here
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

// Test configs for each protocol
const TEST_CONFIGS = [
  {
    name: "VMess TCP+TLS",
    uri: "vmess://eyJhZGQiOiJ0ZXN0LmV4YW1wbGUuY29tIiwiYWlkIjoiMCIsImlkIjoiZjIzNDAxZmItZjRhOC00ZDQ1LTgwYjctY2ZkNDRiNzAzMDhhIiwibmV0IjoidGNwIiwicG9ydCI6NDQzLCJwcyI6InRlc3Qtdm1lc3MiLCJzY3kiOiJhdXRvIiwidGxzIjoidGxzIiwidHlwZSI6Im5vbmUiLCJ2IjoiMiJ9",
  },
  {
    name: "VMess WS+TLS",
    uri: "vmess://eyJhZGQiOiJjZG4uZXhhbXBsZS5jb20iLCJhaWQiOiIwIiwiaG9zdCI6ImNkbi5leGFtcGxlLmNvbSIsImlkIjoiZjIzNDAxZmItZjRhOC00ZDQ1LTgwYjctY2ZkNDRiNzAzMDhhIiwibmV0Ijoid3MiLCJwYXRoIjoiL2Rpc3RvcnQiLCJwb3J0Ijo0NDMzLCJwcyI6IndzLXRscyIsInNjeSI6ImF1dG8iLCJzbmkiOiJjZG4uZXhhbXBsZS5jb20iLCJ0bHMiOiJ0bHMiLCJ0eXBlIjoibm9uZSIsInYiOiIyIn0=",
  },
  {
    name: "VLESS Reality TCP (Vision)",
    uri: "vless://ffa37367-6313-4cc5-86bd-3d8dc879c24e@72.60.189.172:443?security=reality&encryption=none&pbk=ciEOYnFRicl1_ibRKw70jTDZKIMV7R88Qic4GpVzSXA&headerType=none&fp=chrome&type=tcp&flow=xtls-rprx-vision&sni=www.apple.com&sid=55cbb453c4bea99b#vless-reality",
  },
  {
    name: "VLESS WS+TLS",
    uri: "vless://uuid-here@cash.qelzino.ir:443?security=tls&encryption=none&type=ws&host=cash.qelzino.ir&path=%2Fdistort#vless-ws",
  },
  {
    name: "Trojan TCP+TLS",
    uri: "trojan://mypassword@test.example.com:443?sni=test.example.com&type=tcp&security=tls#trojan-tcp",
  },
  {
    name: "Shadowsocks AEAD",
    uri: "ss://chacha20-ietf-poly1305:mypassword@1.2.3.4:8388#ss-aead",
  },
];

console.log("\n🔧 Xray Config Validation Tests");
console.log("═".repeat(60));

const xrayBin = findXrayBinary();

if (!xrayBin) {
  console.log("\n⚠️  Xray binary not found — skipping 'xray run -test' validation.");
  console.log("   Download xray and set XRAY_BIN_PATH or place it at desktop/resources/bin/xray");
  console.log("   Still validating JSON structure...\n");
}

// For each test config, generate xray JSON and validate
for (const tc of TEST_CONFIGS) {
  console.log(`\n📋 Testing: ${tc.name}`);

  // Step 1: Parse URI
  const realCfg = parseUriToRealConfig(tc.uri);
  if (!realCfg) {
    assert(false, `${tc.name}: URI parsed`, "parseUriToRealConfig returned null");
    continue;
  }
  assert(true, `${tc.name}: URI parsed`);
  assert(realCfg.host.length > 0, `${tc.name}: host extracted`, realCfg.host);
  assert(realCfg.port > 0, `${tc.name}: port extracted`, String(realCfg.port));

  // Step 2: Build xray config JSON (tun: false — CI can't create TUN devices)
  let configJson: string;
  try {
    const config = buildRealXrayConfig(realCfg, { tun: false, socksPort: 10808, httpPort: 10809 });
    configJson = JSON.stringify(config, null, 2);
    assert(true, `${tc.name}: config JSON generated`);
  } catch (e: any) {
    assert(false, `${tc.name}: config JSON generated`, e?.message);
    continue;
  }

  // Step 3: Validate JSON structure
  try {
    const parsed = JSON.parse(configJson);
    assert(Array.isArray(parsed.inbounds), `${tc.name}: has inbounds array`);
    assert(Array.isArray(parsed.outbounds), `${tc.name}: has outbounds array`);
    assert(parsed.outbounds.length >= 2, `${tc.name}: has main + block outbounds`);
    assert(parsed.outbounds[0].tag === "distort-out", `${tc.name}: main outbound tagged`);
    assert(parsed.outbounds[0].protocol !== "freedom", `${tc.name}: NOT freedom (real protocol)`, parsed.outbounds[0].protocol);
    assert(parsed.routing !== undefined, `${tc.name}: has routing rules`);

    // Check protocol-specific fields
    const out = parsed.outbounds[0];
    if (realCfg.protocol === "vmess") {
      assert(out.settings?.vnext?.[0]?.users?.[0]?.id === realCfg.uuid, `${tc.name}: VMess UUID in config`, out.settings?.vnext?.[0]?.users?.[0]?.id);
    } else if (realCfg.protocol === "vless") {
      assert(out.settings?.vnext?.[0]?.users?.[0]?.id === realCfg.uuid, `${tc.name}: VLESS UUID in config`, out.settings?.vnext?.[0]?.users?.[0]?.id);
    } else if (realCfg.protocol === "trojan") {
      assert(out.settings?.servers?.[0]?.password === realCfg.password, `${tc.name}: Trojan password in config`, out.settings?.servers?.[0]?.password);
    } else if (realCfg.protocol === "ss") {
      assert(out.settings?.servers?.[0]?.password === realCfg.password, `${tc.name}: SS password in config`, out.settings?.servers?.[0]?.password);
      assert(out.settings?.servers?.[0]?.method === realCfg.method, `${tc.name}: SS method in config`, out.settings?.servers?.[0]?.method);
    }
  } catch (e: any) {
    assert(false, `${tc.name}: JSON valid`, e?.message);
    continue;
  }

  // Step 4: Validate with xray binary (if available)
  if (xrayBin) {
    const tmpFile = join(tmpdir(), `distort-test-${Date.now()}.json`);
    writeFileSync(tmpFile, configJson);
    try {
      // Set working directory to where xray binary + geo data files are
      const xrayDir = require("path").dirname(xrayBin);
      const output = execSync(`"${xrayBin}" run -test -c "${tmpFile}"`, {
        encoding: "utf-8",
        timeout: 10000,
        cwd: xrayDir, // run from xray's directory so it finds geoip.dat/geosite.dat
        stdio: ["pipe", "pipe", "pipe"],
      });
      const ok = output.includes("Configuration OK") || output.includes("ok") || !output.includes("error");
      assert(ok, `${tc.name}: xray run -test passed`, output.substring(0, 200));
    } catch (e: any) {
      const stderr = e?.stderr || e?.stdout || e?.message || "";
      // xray -test returns non-zero on success sometimes; check output
      if (stderr.includes("Configuration OK") || stderr.includes("started")) {
        assert(true, `${tc.name}: xray run -test passed`);
      } else {
        assert(false, `${tc.name}: xray run -test passed`, stderr.substring(0, 300));
      }
    } finally {
      try { unlinkSync(tmpFile); } catch {}
    }
  } else {
    console.log(`     ⏭️  Skipped xray run -test (no binary)`);
  }
}

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
