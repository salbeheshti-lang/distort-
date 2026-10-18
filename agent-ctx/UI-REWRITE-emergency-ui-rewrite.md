# Task: UI-REWRITE — Emergency UI rewrite to use real client-side recovery engine

Owner agent: Emergency-ui-rewrite
Status: COMPLETE

## Goal
Rewrite `src/components/vpn/emergency-connectivity-view.tsx` so it actually drives
the real `RecoveryEngine` from `src/lib/emergency-connectivity/recovery-engine.ts`
instead of just rendering a server-built plan.

## What changed

### Files touched
1. **src/components/vpn/emergency-connectivity-view.tsx** — full rewrite (1377 → 1591 lines).
   Removed: server-built `/api/emergency/plan` fetch + VIP/satellite card + tier check
   (Phase-5 features unused by the engine in its current form).
   Added:
   - Engine platform badge (browser-only red / browser-with-companion green) via
     `detectCompanion()` on mount, with local-config count from `getAllConfigs()`.
   - Honest "Web dashboard = diagnosis + validation only" banner pointing to
     `127.0.0.1:10809` for real tunneling.
   - REAL client-side `diagnoseClientSide()` network diagnosis card (base network,
     DNS, International, Domestic, latency, checked-at) with "Re-diagnose" button.
   - Action bar wired to real engine: Recover / Abort (conditional) / Disconnect
     (conditional) / Import Config / Reset.
   - Candidate paths card: rank, protocol badge, host:port (NO configUri), STRUCT /
     REACH / TUNNEL badges, anti-DPI score, source (local vs remote), streak
     counters, live attempt badge, Remove button (local only).
   - Recovery log card: every attempt from `status.attempts` with timestamp,
     candidate label, result badge, reason (scrubbed), latency. "NO CREDENTIALS
     LOGGED" badge always visible.
   - Danger zone: "Wipe all local configs" with confirm flow → `wipeAllConfigs()`.
   - Import dialog wired to `addConfig()` from local-config-store.ts so imported
     configs land in IndexedDB and the engine picks them up offline.
   - The `RecoveryEngine` instance is created per click of Recover, with
     `onStatusChange` mirroring into React state. `setStatus(next)` from React.
     `cycleRunning` tracks whether `engine.recover()` is still resolving.

2. **src/lib/emergency-connectivity/types.ts** — added `candidateLabel?: string`
   to `RecoveryAttempt`. The engine (recovery-engine.ts:328 etc.) and
   `/api/emergency/report` route both already use this field; the type was lagging
   behind.

3. **src/lib/emergency-connectivity/state-machine.ts** — added defensive
   `diagnosing → exhausted` transition on `no-candidates-left` event. Previously
   the engine emitted `no-candidates-left` while still in `diagnosing` (when
   `gatherCandidates()` returned empty), but the state machine only allowed that
   event from `selecting`/`recovering` — so the transition was a no-op and the UI
   stayed stuck on "Diagnosing" forever. The fix matches the design intent: if
   the diagnosis reveals there are no candidates to try, fail closed immediately.

## Verification

### `bun run lint`
Exit 0. 0 errors. 3 pre-existing warnings in other files (admin/page.tsx,
screenshot-gallery.tsx — not touched).

### agent-browser E2E
Path: http://localhost:3000/ → LAUNCH → EMERGENCY → Recover Connection.

Initial state (no local configs):
- Engine platform badge: "browser-only" + "0 LOCAL CONFIGS" + "No desktop
  companion — browser can diagnose but cannot connect."
- Honesty banner: "WEB DASHBOARD = DIAGNOSIS + VALIDATION ONLY"
- Network diagnosis (real client-side probes, no external internet in sandbox):
  base=local-only, DNS=broken, International=blocked, Domestic=blocked,
  latency=unreachable.
- Clicked Recover → engine diagnoses → 0 candidates → state → "Exhausted" with
  reason "No VPN configs available. Import a config from the Community Mesh tab
  or paste your own. Without at least one config, the recovery engine has nothing
  to try."
- Recovery log: "Candidate gathering FAILURE #1 No candidates available locally
  or remotely."

Then imported a sample VLESS config:
- Pasted `vless://[UUID]@203.0.113.42:443?security=reality&sni=www.cloudflare.com&flow=xtls-rprx-vision&pbk=...`
- Validation returned: STRUCT=valid, REACH=not-probed, TUNNEL=not-attempted,
  anti-DPI=85, flags=[REALITY,SNI,VISION].
- Clicked "Save to local store" → engine platform badge now shows "1 LOCAL CONFIG".

Second Recover click (with 1 local config):
- Engine diagnoses → gathers 1 candidate → tries it → engine.canConnect=false
  (browser-only) → emits engine-failed → logs attempt with reason "Engine
  'browser-only' cannot establish tunnels in this context." → marks failed →
  no next candidate → emits no-candidates-left → state → "Exhausted" with
  reason "All 1 candidates tried. Engine 'browser-only' cannot establish
  tunnels. Install the Distort Desktop or Android app for real connectivity."
- Candidate row shows the VLESS config with FAILURE badge + scrubbed reason.
- Recovery log shows the attempt with timestamp + label + FAILURE badge + reason.

### Screenshot
`/home/z/my-project/upload/EMERGENCY-NEW-01-diagnosis.png` captures the full
state: engine-platform badge (browser-only red), honesty banner, real diagnosis
(local-only / DNS broken / International blocked / Domestic blocked / latency
unreachable), exhausted state with reason, candidate paths (1 VLESS local
candidate with FAILURE badge + STRUCT/REACH/TUNNEL), recovery log (1 attempt
with scrubbed reason + NO CREDENTIALS LOGGED badge), danger zone.

## Honesty verification
The new UI is genuinely engine-driven:
- Every state transition comes from the real `RecoveryEngine`'s `onStatusChange`
  callback — no faked transitions.
- The "Connected" state is NEVER shown unless the engine's real traffic
  verification succeeds (which requires the desktop companion — absent in
  browser-only mode).
- The "Exhausted" state is reached honestly with a clear, actionable reason
  whenever no path works (no candidates, or all candidates failed because
  browser-only engine can't tunnel).
- Every attempt logged by the engine appears in the recovery log with the
  scrubbed reason — no raw configUri or credentials ever shown.

## Next steps for downstream agents
Ship a minimal Electron desktop companion that exposes:
- `GET 127.0.0.1:10809/api/health` → `{ ok: true }`
- `POST 127.0.0.1:10809/api/tunnel/start` `{ configUri }` → spawns xray-core,
  returns `{ ok: true }`
- `POST 127.0.0.1:10809/api/tunnel/verify` → fetches an exit-IP endpoint through
  the SOCKS5 proxy at `127.0.0.1:10808`, returns `{ trafficVerified, exitIp,
  realIp, latencyMs }`
- `POST 127.0.0.1:10809/api/tunnel/stop` → kills xray

Once that exists, the existing UI will automatically flip to
"browser-with-companion" (via `detectCompanion()` on mount) and the engine will
actually verify tunnel traffic — no UI changes required.
