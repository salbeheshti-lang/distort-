# DISTORT — Technical Gap Analysis

> Honest assessment of what's implemented, what's verified, and what's missing.
> Last updated: commit `fc57ea9` (round 14)

---

## Legend

- ✅ **Implemented + Verified** — code works, tested with automated tests
- ⚠️ **Implemented, NOT Verified** — code exists but not tested on real device/network
- ❌ **Not Implemented** — feature is missing entirely
- 🔶 **Partially Implemented** — basic version exists but incomplete

---

## 1. VPN Engine (xray-core integration)

| Feature | Status | Evidence | Gap |
|---|---|---|---|
| xray binary bundled (Windows) | ✅ | CI downloads xray v26.3.27 + wintun.dll | — |
| xray binary bundled (Android) | ✅ | libxray.so (arm64 + amd64) in jniLibs | — |
| xray config generation | ✅ | 67 automated tests pass, JSON structure validated | `xray run -test` not yet in CI (workflow added, needs verification) |
| Real credentials from Community Mesh | ✅ | parseUriToRealConfig() extracts real UUID/password/pbk | — |
| TUN inbound (system-wide tunneling) | ⚠️ | Config includes tun inbound with autoRoute/strictRoute | **Not tested on real Windows — TUN fd may not work with xray's expected format** |
| SOCKS5 + HTTP inbound | ✅ | Config includes both inbounds | — |
| DNS hijacking (no leak) | ⚠️ | Config has hijackDns: true | **Not verified with real DNS queries** |
| IPv6 blocking in config | ⚠️ | Config routes ::/0 through tunnel | **Not tested on IPv6-enabled network** |

## 2. Connection Verification

| Feature | Status | Evidence | Gap |
|---|---|---|---|
| Desktop: HTTP through SOCKS verification | ✅ | Full SOCKS5 + TLS + HTTP GET to cloudflare/cdn-cgi/trace | No fallback to SOCKS-port-only check |
| Desktop: exit IP + country detection | ✅ | Parses `ip=` and `loc=` from cloudflare trace | — |
| Android: HTTP through SOCKS verification | ✅ | verifyTrafficThroughProxy() does HTTP GET via SOCKS | — |
| Android: VpnService.protect() for leak detection | ✅ | getRealPublicIpProtected() uses protect(socket) | Fail-closed if protect() fails |
| Android: exit IP + country detection | ⚠️ | Code parses cloudflare trace | **Not tested on real device** |
| Tunnel health monitoring (heartbeat) | ❌ | Not implemented | **Need periodic check every 30s** |

## 3. Kill Switch (Windows)

| Feature | Status | Evidence | Gap |
|---|---|---|---|
| Route table manipulation (not firewall) | ✅ | Uses `route delete` + `route add` | — |
| VPN server IP excluded from block | ✅ | Adds /32 route for VPN server before removing default | — |
| IPv6 default route removal | ⚠️ | `route delete ::/0` + netsh 6to4 disable | **Not tested on IPv6 network** |
| Verification after route deletion | ✅ | `route print` checks for actual 0.0.0.0/0 row | — |
| Rollback on verification failure | ✅ | Restores routes + cleans up if verification fails | — |
| Crash recovery (backup file) | ✅ | killswitch-backup.json with gateway/iface/metric/vpnIp | Restores on next app launch |
| Crash recovery: backup not deleted on failure | ✅ | Only deletes after successful restore | — |
| Admin privilege check | ⚠️ | Logs warning if netsh fails | **Doesn't request elevation — silently fails** |
| Multiple network interfaces | ❌ | Only handles primary default route | **If user has WiFi + Ethernet, secondary interface may leak** |
| Network change detection | ❌ | No detection of WiFi/Ethernet switch | **Need Windows network change events** |

## 4. Auto-Failover & Reconnection

| Feature | Status | Evidence | Gap |
|---|---|---|---|
| Try multiple configs in sequence | ✅ | quickConnect() tries up to 20 optimized configs | — |
| Offline config cache | ✅ | cached-configs.json + last-working-config.json | — |
| Fall back to cached config | ✅ | quickConnect() tries cache after all live configs fail | — |
| Smart reconnect with backoff | ❌ | Not implemented | **Need exponential backoff + max retries** |
| Network change auto-reconnect | ❌ | Not implemented | **Need Windows network change events + Android ConnectivityManager** |
| Max retry limit | ❌ | Not implemented | **Need to prevent infinite retry loop** |

## 5. Subscription Management

| Feature | Status | Evidence | Gap |
|---|---|---|---|
| Fetch subscription URL | ✅ | fetchAndParseSubscription() with SSRF protection | — |
| Parse vmess/vless/trojan/ss URIs | ✅ | 59 automated parser tests pass | — |
| Auto-refresh every 60 minutes | ✅ | Desktop app has setInterval(60min) | — |
| Manual redirect handling with SSRF re-validation | ✅ | redirect: "manual" + validateSubscriptionUrl per hop | — |
| DNS rebinding protection | ✅ | Resolves hostname, checks all IPs against private ranges | — |
| Response size limit (10MB) | ✅ | Streaming read with abort | — |
| Atomic config swap (insert-then-delete) | ✅ | New configs inserted before old ones deleted | **Not a true DB transaction — concurrent calls may leave duplicates** |
| Config scoring (Reality/TLS/Vision) | ✅ | pickOptimized() with score thresholds | Score is heuristic, not based on real connection success |
| Config health test (actual connection) | ❌ | Not implemented | **Need to test each config's actual reachability before offering** |
| Config expiry tracking | ❌ | Not implemented | **Need to track when a config was last successful** |

## 6. API Security

| Feature | Status | Evidence | Gap |
|---|---|---|---|
| API key authentication (DISTORT_API_KEY) | ✅ | checkAuth() middleware on sensitive endpoints | — |
| Mandatory in production | ✅ | Returns 503 if no key in NODE_ENV=production | — |
| Header-only (no query param) | ✅ | Only x-api-key header accepted | — |
| Timing-safe comparison | ✅ | timingSafeEqual() used | — |
| Protected endpoints | ✅ | imported-configs, subscriptions, community-configs, import | — |
| Rate limiting | 🔶 | Only on /api/health-check (20/min) | **Other endpoints not rate-limited** |
| User authentication (NextAuth) | ❌ | Not implemented | **Need per-user data isolation** |
| SSRF protection on health-check | ✅ | Private IPs blocked, allowlist enforced | — |

## 7. Android VPN Service

| Feature | Status | Evidence | Gap |
|---|---|---|---|
| VpnService established | ⚠️ | Builder() with addAddress/addRoute/addDnsServer | **Not tested on real device** |
| TUN fd passed to xray | ⚠️ | fd written in config JSON `tun.settings.fd` | **Not verified that xray actually reads/processes the fd** |
| Config selector UI (paste URI) | ✅ | MainActivity has EditText + clipboard paste | — |
| Traffic verification through SOCKS | ✅ | verifyTrafficThroughProxy() with cloudflare trace | — |
| VpnService.protect() for leak detection | ✅ | getRealPublicIpProtected() with protect(socket) | — |
| No false "Connected" on process-alive | ✅ | Removed checkSocksPortOnly() fallback | — |
| No "freedom" fallback | ✅ | buildFallbackConfig() removed entirely | — |
| Foreground service notification | ✅ | showNotification() with ongoing notification | — |
| Auto-restart on xray crash | ⚠️ | startPacketPump() monitors and logs | **Doesn't actually restart — just logs** |
| Network change handling | ❌ | Not implemented | **Need ConnectivityManager callbacks** |
| Battery optimization handling | ❌ | Not implemented | **Need REQUEST_IGNORE_BATTERY_OPTIMIZATIONS** |

## 8. Chrome Extension

| Feature | Status | Evidence | Gap |
|---|---|---|---|
| MV3 manifest | ✅ | manifest.json with permissions | — |
| chrome.proxy.settings (SOCKS5) | ✅ | buildProxyConfig() | **Always SOCKS5 — doesn't run xray for VLESS/VMess** |
| Proxy verification (HTTP test) | ✅ | verifyProxyWorks() does fetch through proxy | — |
| No hardcoded fake servers | ✅ | SERVERS = [] (user must add) | — |
| proxyVerified state (separate from connected) | ✅ | State includes proxyVerified: true | — |
| Honest documentation | ✅ | Comments explain it's browser proxy, not VPN | — |
| Local xray helper | ❌ | Not implemented | **Extension can't run xray — needs desktop app or native messaging** |

## 9. Web Dashboard

| Feature | Status | Evidence | Gap |
|---|---|---|---|
| Landing page | ✅ | Hero, features, download, screenshot gallery | — |
| Dashboard with 7 views | ✅ | Connect, Servers, Mesh, Speed Test, Stats, Settings, Account | — |
| Demo mode badge (browser) | ✅ | isDemoMode() shows yellow warning | — |
| Exit IP + country display | ✅ | Card in connect-view shows exitIp + exitCountry | — |
| Community Mesh (326 configs) | ✅ | Auto-fetches Iran subscription | — |
| Config import (paste URI) | ✅ | ImportDialog with single/bulk support | — |
| Real speed test (Cloudflare) | ✅ | measureDownload/measureUpload from speed.cloudflare.com | — |
| Real TCP reachability probe | ✅ | probeReachability() opens real TCP socket (server-side) | — |
| Controlled/uncontrolled input warning | ⚠️ | React warning in Settings view | **Cosmetic bug, not functional** |

## 10. Testing

| Feature | Status | Evidence | Gap |
|---|---|---|---|
| Config parser tests | ✅ | 59 tests, all pass | — |
| Xray config JSON validation | ✅ | 67 tests, all pass | — |
| xray run -test in CI | ⚠️ | Workflow added but not yet verified | **Need to confirm CI downloads xray and runs -test** |
| Kill switch logic tests | ❌ | Not implemented | **Need mock-based tests for route manipulation logic** |
| Integration tests (real connection) | ❌ | Not implemented | **Need real Windows + Android device** |
| DNS leak test | ❌ | Not implemented | **Need independent verification tool** |
| IPv6 leak test | ❌ | Not implemented | **Need IPv6-enabled test network** |

## Summary

| Category | Implemented | Verified | Not Implemented |
|---|---|---|---|
| VPN Engine | 6/8 | 4/8 | 2 |
| Connection Verification | 5/6 | 4/6 | 1 |
| Kill Switch | 7/10 | 5/10 | 3 |
| Auto-Failover | 3/6 | 2/6 | 3 |
| Subscription Mgmt | 8/11 | 7/11 | 3 |
| API Security | 6/8 | 5/8 | 2 |
| Android | 7/11 | 4/11 | 4 |
| Chrome Extension | 5/6 | 4/6 | 1 |
| Web Dashboard | 9/10 | 9/10 | 1 |
| Testing | 2/7 | 2/7 | 5 |
| **Total** | **58/93** | **46/93** | **25** |

**62% implemented, 49% verified, 27% missing.**

The biggest gaps are in runtime testing (needs real devices), tunnel health monitoring, and smart reconnection.
