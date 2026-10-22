# Task: SUBIMPORT-PING-FIX

**Agent**: SubImport-Ping-Fixer
**Task**: Add subscription URL import + clipboard paste + TLS probe + 3-state reach display

## Summary

Two critical user-reported issues after v1.0.34:

1. **Cannot import subscription URLs** — the redesigned ImportDialog (post-CONNECT-UI-REDESIGN) only accepted individual config URIs (vmess/vless/trojan/ss). The old AddSubDialog was deleted along with community-mesh-view.tsx, so subscription URL import became a REGRESSION.
2. **All pings red** — `Test all` showed every config as "unreachable" with a red ✗ badge. Root causes:
   - `/api/imported-configs/check` only probed `bucket="optimized"` configs — personal imports scoring < 55 were skipped entirely
   - The probe did TCP connect only. In Iran, DPI injects RST packets on bare TCP, so working configs got misclassified as unreachable
   - The LatencyBadge showed red ✗ for `reach="fail"` which misled users into thinking the config is dead (xray Reality might still work via TLS mimicry)

## Files Changed (4)

| File | Lines (after) | Δ |
|---|---|---|
| `src/lib/anti-censor.ts` | 248 | +130 (added `probeReachabilityTLS`, bumped TCP timeout 3s→5s) |
| `src/app/api/imported-configs/check/route.ts` | 116 | +79 (removed `bucket="optimized"` filter, switched to TLS probe, 3-state reach storage) |
| `src/components/vpn/import-config-dialog.tsx` | 666 | +439 (Tabs switcher, Clipboard button, Subscription URL mode, live URL preview, auto-refresh interval) |
| `src/components/vpn/connect-view.tsx` | 1123 | +113 (3-state LatencyBadge, new sort, Test all tooltip, updated selectedConfig display) |

## Verification

- **`bun run lint`**: 0 errors, 1 pre-existing warning (admin/page.tsx, untouched). PASS.
- **`bunx tsc --noEmit`**: 0 errors in touched files. 60 pre-existing errors in unrelated files (desktop/*, mobile/*, examples/*, skills/*, dashboard.tsx:207-208 SystemStatusButton, ip-info/route.ts header type, __tests__/*). PASS for scope.
- **agent-browser**:
  - Verified ImportDialog has two tabs: "Config URIs" and "Subscription URL"
  - Verified "Paste" button is present in both modes
  - Verified pasting/typing a subscription URL → URL preview shows green "✓ Valid · hostname" / yellow "⚠ Insecure · use https://" / red "✗ Invalid"
  - Verified "Add & Fetch" button label in Subscription URL mode, "Import" label in Config URIs mode
  - Verified Test all probed ALL 80 configs (not just optimized) — POST /api/imported-configs/check 200 in 5.4s
  - Verified LatencyBadge shows green (TLS ok, "60ms"/"521ms"), orange ("598ms?"/"658ms?" for TCP ok TLS failed), orange "?" (for TCP failed), gray "—" (untested). NO MORE RED ✗.
  - Verified Test all tooltip: "Probes TCP+TLS reachability. Orange ? means the host may be DPI-blocked but could still work via xray Reality."
  - Verified auto-select picked the best TLS-reachable config (TROJAN @ 60ms)
  - Verified no console errors during testing

## Honest Limitations

- **TLS handshake accuracy**: The probe uses `rejectUnauthorized: false` (doesn't validate cert) — we only care whether the handshake completes. This means a host presenting ANY cert (even a self-signed one) will be marked as "ok" (GREEN). Reality configs mimic legitimate TLS servers, so this is the correct behavior for our use case.
- **SNI hint**: We pass `c.sni || c.host` as the `servername` for the TLS handshake. If a config has a wrong/missing SNI, the handshake might still succeed (because the host accepts any SNI) or fail (because the host requires a specific SNI). xray will use the actual config's SNI, so this discrepancy is acceptable.
- **TCP probe still does a CONNECT then immediate DESTROY** — the host's socket never sends data, so we don't actually verify the host speaks TLS on that port. We then open a SEPARATE TLS socket for the handshake. Two connections per probe is slightly wasteful but acceptable for a 5s-budget probe.
- **Auto-refresh interval** is stored in the DB but the actual refresh job isn't running — there's no cron/scheduler in the Next.js dev server. The user can manually click "Refresh" to trigger a re-fetch. Pre-existing limitation, not introduced by this change.
- **Mixed-line pastes** (some vmess:// + some https://) keep "Config URIs" mode and the https:// lines are silently filtered out by `countConfigUris`. The user gets a count of just the URI lines. This is documented in the error message: "(Subscription URLs should be added in the 'Subscription URL' tab.)"
- **Sort order**: The new sort mixes "failed" configs in with "untested" ones by score DESC. Both end up at the bottom of the list (after reachable configs sorted by ms asc). This is intentional per the task spec, but a user expecting failed configs to bubble to the top (since they might work via xray) might be surprised — they're still below the reachable ones.
- **xray-fail tracking NOT implemented**: The task mentions "Only show RED ✗ if the config has been tried via xray and actually failed (this would come from the connect flow — when the user clicks Connect and it fails, we could update the reach to 'xray-fail')". This would require adding a side-effect to the connect flow that updates the DB when /api/tunnel/start fails. I did NOT implement this — the connect flow is unchanged from CONNECT-UI-REDESIGN. For now, all probes show green/orange/gray only.

## Key Code Locations

- **Tab switcher**: `src/components/vpn/import-config-dialog.tsx` lines 354-375 (Tabs component)
- **"📋 Paste" button (URIs mode)**: lines 392-403
- **"📋 Paste" button (Sub mode)**: lines 487-498
- **3-state LatencyBadge function**: `src/components/vpn/connect-view.tsx` lines 988-1080
- **probeReachabilityTLS**: `src/lib/anti-censor.ts` lines 142-248
- **Check endpoint (no bucket filter)**: `src/app/api/imported-configs/check/route.ts` lines 67-73
- **Test all tooltip**: `src/components/vpn/connect-view.tsx` lines 543-576

## Worklog Status

Appended to `/home/z/my-project/worklog.md` — see entry with `Task ID: SUBIMPORT-PING-FIX`.
