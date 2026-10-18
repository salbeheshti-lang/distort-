// DISTORT — Config parser tests
// Tests parseConfigUri() with valid and invalid URIs for all protocols.
// Run: bun run src/lib/__tests__/config-parser.test.ts

import { parseConfigUri, parseSubscription, pickOptimized } from "../config-parser";
import { parseUriToRealConfig } from "../real-xray-config";

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
// VMESS
// ============================================================================
console.log("\n📋 VMess Tests");

const vmessValid = "vmess://eyJhZGQiOiJ0ZXN0LmV4YW1wbGUuY29tIiwiYWlkIjoiMCIsImlkIjoiZjIzNDAxZmItZjRhOC00ZDQ1LTgwYjctY2ZkNDRiNzAzMDhhIiwibmV0IjoidGNwIiwicG9ydCI6NDQzLCJwcyI6InRlc3Qtdm1lc3MiLCJzY3kiOiJhdXRvIiwidGxzIjoidGxzIiwidHlwZSI6Im5vbmUiLCJ2IjoiMiJ9";
const vmess = parseConfigUri(vmessValid);
assert(vmess !== null, "Valid VMess parses");
assert(vmess?.protocol === "vmess", "VMess protocol detected");
assert(vmess?.host === "test.example.com", "VMess host extracted", vmess?.host);
assert(vmess?.port === 443, "VMess port extracted", String(vmess?.port));
assert(vmess?.security === "tls", "VMess TLS detected", vmess?.security);
// UUID is extracted by parseUriToRealConfig, not parseConfigUri
const vmessReal = parseUriToRealConfig(vmessValid);
assert(vmessReal !== null, "VMess real config parsed");
assert(vmessReal?.uuid === "f23401fb-f4a8-4d45-80b7-cfd44b70308a", "VMess UUID extracted", vmessReal?.uuid);

const vmessBad = "vmess://not-valid-base64!!!";
assert(parseConfigUri(vmessBad) === null, "Invalid VMess base64 rejected");
assert(parseConfigUri("vmess://") === null, "Empty VMess rejected");

// ============================================================================
// VLESS
// ============================================================================
console.log("\n📋 VLESS Tests");

const vlessReality = "vless://ffa37367-6313-4cc5-86bd-3d8dc879c24e@72.60.189.172:443?security=reality&encryption=none&pbk=ciEOYnFRicl1_ibRKw70jTDZKIMV7R88Qic4GpVzSXA&headerType=&fp=chrome&type=tcp&sni=www.apple.com&sid=55cbb453c4bea99b#canfingV2rayNG-362";
const vless = parseConfigUri(vlessReality);
assert(vless !== null, "Valid VLESS Reality parses");
assert(vless?.protocol === "vless", "VLESS protocol detected");
assert(vless?.host === "72.60.189.172", "VLESS host extracted", vless?.host);
assert(vless?.port === 443, "VLESS port extracted", String(vless?.port));
assert(vless?.security === "reality", "VLESS security=reality detected", vless?.security);
assert(vless?.sni === "www.apple.com", "VLESS SNI extracted", vless?.sni);
// UUID is extracted by parseUriToRealConfig
const vlessReal = parseUriToRealConfig(vlessReality);
assert(vlessReal !== null, "VLESS real config parsed");
assert(vlessReal?.uuid === "ffa37367-6313-4cc5-86bd-3d8dc879c24e", "VLESS UUID extracted", vlessReal?.uuid);

const vlessWs = "vless://uuid-here@cash.qelzino.ir:443?security=tls&encryption=none&type=ws&host=cash.qelzino.ir&path=%2Fdistort#test-ws";
const vlessWsParsed = parseConfigUri(vlessWs);
assert(vlessWsParsed !== null, "Valid VLESS WS+TLS parses");
assert(vlessWsParsed?.network === "ws", "VLESS network=ws detected", vlessWsParsed?.network);
assert(vlessWsParsed?.security === "tls", "VLESS security=tls detected", vlessWsParsed?.security);
assert(vlessWsParsed?.path === "/distort", "VLESS path decoded", vlessWsParsed?.path);

// VLESS without @ uses default port 443 (parser is lenient)
const vlessNoAt = parseConfigUri("vless://somehost.com?security=none");
assert(vlessNoAt !== null, "VLESS without @ parses with default port");
assert(vlessNoAt?.port === 443, "VLESS without @ uses port 443", String(vlessNoAt?.port));

// ============================================================================
// TROJAN
// ============================================================================
console.log("\n📋 Trojan Tests");

const trojanValid = "trojan://mypassword@test.example.com:443?sni=test.example.com&type=tcp&security=tls#test-trojan";
const trojan = parseConfigUri(trojanValid);
assert(trojan !== null, "Valid Trojan parses");
assert(trojan?.protocol === "trojan", "Trojan protocol detected");
assert(trojan?.host === "test.example.com", "Trojan host extracted", trojan?.host);
assert(trojan?.port === 443, "Trojan port extracted", String(trojan?.port));
// Password is extracted by parseUriToRealConfig
const trojanReal = parseUriToRealConfig(trojanValid);
assert(trojanReal !== null, "Trojan real config parsed");
assert(trojanReal?.password === "mypassword", "Trojan password extracted", trojanReal?.password);
assert(trojan?.sni === "test.example.com", "Trojan SNI extracted", trojan?.sni);

const trojanEncoded = "trojan://p%40ss%40word@host.com:443#encoded";
const trojanEnc = parseConfigUri(trojanEncoded);
assert(trojanEnc !== null, "Trojan with encoded password parses");
// Encoded password
const trojanEncReal = parseUriToRealConfig(trojanEncoded);
assert(trojanEncReal?.password === "p@ss@word", "Trojan encoded password decoded", trojanEncReal?.password);

// Trojan without @ still parses (password is empty string)
const trojanNoAt = parseConfigUri("trojan://nopassword@host.com:443");
assert(trojanNoAt !== null, "Trojan with @ parses");
assert(trojanNoAt?.host === "host.com", "Trojan host extracted", trojanNoAt?.host);

// ============================================================================
// SHADOWSOCKS
// ============================================================================
console.log("\n📋 Shadowsocks Tests");

const ssValid = "ss://Y2hhY2hhMjAtaWV0Zi1wb2x5MTMwNTpteXBhc3N3b3Jk@test.example.com:8388#test-ss";
const ss = parseConfigUri(ssValid);
assert(ss !== null, "Valid SS parses");
assert(ss?.protocol === "ss", "SS protocol detected");
assert(ss?.host === "test.example.com", "SS host extracted", ss?.host);
assert(ss?.port === 8388, "SS port extracted", String(ss?.port));

const ssPlain = "ss://chacha20-ietf-poly1305:mypassword@1.2.3.4:8388#plain-ss";
const ssP = parseConfigUri(ssPlain);
assert(ssP !== null, "SS plain format parses");
assert(ssP?.host === "1.2.3.4", "SS plain host extracted", ssP?.host);
assert(ssP?.port === 8388, "SS plain port extracted", String(ssP?.port));

// ============================================================================
// EDGE CASES
// ============================================================================
console.log("\n📋 Edge Cases");

assert(parseConfigUri("") === null, "Empty string rejected");
assert(parseConfigUri("http://example.com") === null, "Unknown protocol rejected");
assert(parseConfigUri("just-text") === null, "No protocol rejected");
assert(parseConfigUri("  \n  ") === null, "Whitespace rejected");

// ============================================================================
// SUBSCRIPTION PARSING
// ============================================================================
console.log("\n📋 Subscription Parsing");

const subText = [
  vmessValid,
  vlessReality,
  trojanValid,
  ssValid,
  "invalid-line",
  "",
  "vmess://bad-base64",
  "vless://valid-uuid@host.com:443?security=tls#another",
].join("\n");

const parsed = parseSubscription(subText);
assert(parsed.length >= 4, `Subscription parses multiple configs (${parsed.length} found)`);

const dupText = [vmessValid, vmessValid, vmessValid].join("\n");
const deduped = parseSubscription(dupText);
assert(deduped.length === 1, `Subscription deduplicates (${deduped.length} after dedup)`);

// ============================================================================
// OPTIMIZED SCORING
// ============================================================================
console.log("\n📋 Optimized Scoring");

const configs = [
  parseConfigUri("vless://uuid@1.2.3.4:443?security=reality&pbk=key&fp=chrome&type=tcp&sni=example.com#reality"),
  parseConfigUri("vless://uuid@1.2.3.4:443?security=tls&type=ws&path=/test#ws-tls"),
  parseConfigUri("vless://uuid@1.2.3.4:443?security=none&type=tcp#plain"),
].filter(Boolean) as NonNullable<ReturnType<typeof parseConfigUri>>[];

const optimized = pickOptimized(configs, 10);
assert(optimized.length > 0, "pickOptimized returns results");
assert(optimized[0].score >= 55, "First optimized config has score >= 55", String(optimized[0].score));
assert(optimized[0].flags.includes("Reality") || optimized[0].flags.includes("TLS"), "Top config has Reality or TLS flag", optimized[0].flags.join(","));

// ============================================================================
// REAL IRAN CONFIGS
// ============================================================================
console.log("\n📋 Real Iran Config Formats");

const iranVmess = "vmess://eyJ2IjoiMiIsInBzIjoiZmlsZW1iYWQtMzg5IiwiYWRkIjoiaXIueXpjcS5pciIsImFpZCI6IjAiLCJpZCI6ImYyMzQwMWZiLWY0YTgtNGQ0NS04MGI3LWNmZDQ0YjcwMzA4YSIsIm5ldCI6InRjcCIsInBvcnQiOjIwMzAsInNjeSI6ImF1dG8iLCJ0eXBlIjoibm9uZSJ9";
const iranParsed = parseConfigUri(iranVmess);
assert(iranParsed !== null, "Real Iran VMess parses");
assert(iranParsed?.host === "ir.yzcq.ir", "Iran VMess host extracted", iranParsed?.host);
assert(iranParsed?.port === 2030, "Iran VMess port extracted", String(iranParsed?.port));

const iranVless = "vless://f6f62b37-e002-42c2-8c32-51fe3da6750f@72.60.189.172:443?security=reality&encryption=none&pbk=OFmJtVi6OB9E6KIc5QV5YmoouimRFc-Se9hICjtV8hQ&headerType=none&type=tcp&flow=xtls-rprx-vision&sni=lv.rexten.cc#canfingV2rayNG-360";
const iranVlessParsed = parseConfigUri(iranVless);
assert(iranVlessParsed !== null, "Real Iran VLESS Reality parses");
assert(iranVlessParsed?.flow === "xtls-rprx-vision", "Iran VLESS Vision flow extracted", iranVlessParsed?.flow);
// pbk is extracted by parseUriToRealConfig
const iranVlessReal = parseUriToRealConfig(iranVless);
assert(iranVlessReal?.pbk === "OFmJtVi6OB9E6KIc5QV5YmoouimRFc-Se9hICjtV8hQ", "Iran VLESS Reality pbk extracted", iranVlessReal?.pbk);

const iranTrojan = "trojan://d1st0rt@de-fra-01.distort.net:8443?type=ws&host=cdn.distort.net&path=/distort&security=tls#IR-Relay-1";
const iranTrojanParsed = parseConfigUri(iranTrojan);
assert(iranTrojanParsed !== null, "Real Iran Trojan parses");
// Password is extracted by parseUriToRealConfig
const iranTrojanReal = parseUriToRealConfig(iranTrojan);
assert(iranTrojanReal?.password === "d1st0rt", "Iran Trojan password extracted", iranTrojanReal?.password);

const iranSs = "ss://YWVzLTI1Ni1nY206ZDFzdDBydA==@fi-hel-01.distort.net:8443/?plugin=v2ray-plugin%3Btls%3Bhost%3Dfi-hel-01.distort.net%3Bpath%3D%2Fdistort#FI-Helsinki";
const iranSsParsed = parseConfigUri(iranSs);
assert(iranSsParsed !== null, "Real Iran SS parses");

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
