// DISTORT — Emergency Connectivity type contracts
//
// The emergency connectivity engine is a REAL recovery system, not a button.
// Its goal: detect where internet is blocked or degraded, probe stored configs,
// pick the best reachable path, and fail closed if none works.
//
// CORE PRINCIPLE: The `connected` state must ONLY be set after REAL traffic
// verification through the tunnel — never from process liveness, port open,
// or a successful API call to the Distort server.
//
// STARLINK NOTE: Starlink is NOT a dependency. It MAY appear as one of the
// candidate paths in the planner (with transport type "satellite"), reserved
// for VIP users — but the engine must work entirely without it.

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

export type RecoveryState =
  | "idle"          // Recovery not active
  | "diagnosing"    // Probing base network + reachable paths
  | "selecting"     // Choosing next config + transport
  | "connecting"    // Spawning tunnel engine (xray/wireguard)
  | "verifying"     // Real HTTP request through tunnel to verify traffic flow
  | "connected"     // Tunnel verified — traffic is actually flowing
  | "degraded"      // Connected but quality dropped (high latency/loss)
  | "recovering"    // Mid-recovery from a failed path
  | "exhausted";    // All paths tried, none worked — fail closed

export const RECOVERY_STATE_LABELS: Record<RecoveryState, { label: string; color: string; description: string }> = {
  idle:        { label: "Idle",            color: "#8aa0c4", description: "Recovery engine inactive. Click Recover to start." },
  diagnosing:  { label: "Diagnosing",      color: "#ffb020", description: "Checking base network + probing reachable configs." },
  selecting:   { label: "Selecting path",  color: "#ffb020", description: "Choosing the best candidate config based on health + history." },
  connecting:  { label: "Connecting",      color: "#00f0ff", description: "Spawning tunnel engine with the selected config." },
  verifying:   { label: "Verifying",       color: "#00f0ff", description: "Doing a real HTTP request through the tunnel — Connected only on success." },
  connected:   { label: "Connected",        color: "#10d9a0", description: "Tunnel verified — traffic is actually flowing to the destination." },
  degraded:    { label: "Degraded",        color: "#ffb020", description: "Connected but quality dropped. Will switch if a better path appears." },
  recovering:  { label: "Recovering",      color: "#ffb020", description: "Active path failed — trying next candidate." },
  exhausted:   { label: "Exhausted",        color: "#ff4d6d", description: "All paths tried, none verified. Kill switch active. No false Connected." },
};

// ---------------------------------------------------------------------------
// Network diagnostics
// ---------------------------------------------------------------------------

export type BaseNetworkStatus =
  | "online"          // Device has working local network + DNS
  | "local-only"      // Local network up, DNS broken or upstream blocked
  | "offline"         // No local network at all
  | "unknown";

export type NetworkDiagnosis = {
  baseNetwork: BaseNetworkStatus;
  // True if DNS resolves a known-good domain (e.g. cloudflare.com)
  dnsWorks: boolean;
  // True if an international destination is reachable directly (no tunnel)
  internationalReachable: boolean;
  // True if a domestic destination is reachable directly
  domesticReachable: boolean;
  // Measured RTT to a known-good anycast IP (1.1.1.1) in ms, or null if unreachable
  directLatencyMs: number | null;
  // Free-form human explanation (NO credentials, NO sensitive URLs)
  summary: string;
  // Timestamp
  checkedAt: string; // ISO
};

// ---------------------------------------------------------------------------
// Config probe results (the THREE distinct states per the design)
// ---------------------------------------------------------------------------

// Per design §4.D: a config has three INDEPENDENT states:
//   1. structurally valid (parses + has required fields)
//   2. server reachable (TCP connect to host:port succeeds)
//   3. tunnel verified (real HTTP request through the tunnel succeeds)

export type StructuralValidity =
  | "valid"           // Parses + has required fields (host, port, credentials)
  | "invalid-syntax"  // Could not parse at all
  | "missing-fields"  // Parsed but missing required fields (UUID, password, SNI, etc.)
  | "unsupported-protocol";

export type ServerReachability =
  | "reachable"       // TCP connect succeeded within timeout
  | "unreachable"     // TCP connect failed / timed out
  | "not-probed";     // Haven't tested yet

export type TunnelVerification =
  | "verified"        // Real HTTP request through tunnel succeeded + exit IP differs from real IP
  | "traffic-failed"  // Tunnel started but HTTP through proxy failed
  | "leak-detected"   // Tunnel started but exit IP == real IP (traffic not actually going through tunnel)
  | "not-attempted";

export type ProbeResult = {
  configId: string;
  // The three independent states
  structural: StructuralValidity;
  reachability: ServerReachability;
  tunnel: TunnelVerification;
  // Latency to the server (TCP connect time) in ms, or null
  latencyMs: number | null;
  // Exit IP discovered through the tunnel (only if tunnel verified)
  exitIp: string | null;
  // Country of exit IP (best-effort, may be null)
  exitCountry: string | null;
  // When this probe was run
  probedAt: string; // ISO
  // Free-form reason for failure (NO credentials, NO sensitive URLs)
  failureReason: string | null;
};

// ---------------------------------------------------------------------------
// Candidate path (what the planner picks from)
// ---------------------------------------------------------------------------

export type TransportType =
  | "wireguard"
  | "vless"
  | "vmess"
  | "trojan"
  | "shadowsocks"
  | "ssh"
  | "satellite"; // Starlink — VIP only, NOT a dependency

export type CandidatePath = {
  // Unique id within a plan (config id from ImportedConfig, or "distort-<server-code>" for managed nodes)
  id: string;
  // Display info (NO credentials here)
  label: string;
  protocol: TransportType;
  host: string;
  port: number;
  // True if this config has TLS / Reality / obfuscation
  stealth: boolean;
  // Score from the parser (0..100, higher = better anti-DPI)
  antiDpiScore: number;
  // Country of exit (if known), null if unknown
  exitCountry: string | null;
  // Whether this is a VIP-only path (e.g. satellite, premium nodes)
  vipOnly: boolean;
  // The actual config URI — passed to the tunnel engine, NEVER logged
  // (kept out of the planner's logging path)
  configUri: string;
  // Last known probe result (null if never probed)
  lastProbe: ProbeResult | null;
  // Number of consecutive successes (used by planner for ranking)
  successStreak: number;
  // Number of consecutive failures (resets on success)
  failureStreak: number;
  // Last time this path was tried (ISO), null if never
  lastTriedAt: string | null;
};

// ---------------------------------------------------------------------------
// Recovery plan (built by planner, executed by client)
// ---------------------------------------------------------------------------

export type RecoveryPlan = {
  // Unique id for this plan (for correlation with /api/emergency/report)
  planId: string;
  // The diagnosis that drove the plan
  diagnosis: NetworkDiagnosis;
  // Ordered list of candidates to try in sequence
  candidates: CandidatePath[];
  // Policy that governs execution (limits, delays, timeouts)
  policy: RecoveryPolicy;
  // Human-readable rationale (NO credentials)
  rationale: string;
  // Confidence level: how sure the planner is that at least one will work
  confidence: "high" | "medium" | "low" | "none";
  // Timestamps
  createdAt: string; // ISO
  // Tier of the user requesting the plan (affects satellite access)
  userTier: "free" | "vip" | "admin";
};

// ---------------------------------------------------------------------------
// Recovery policy (limits, delays, timeouts)
// ---------------------------------------------------------------------------

export type RecoveryPolicy = {
  // Max number of candidates to try before declaring "exhausted"
  maxAttempts: number;
  // Per-attempt timeout for the verify step (ms)
  verifyTimeoutMs: number;
  // Base delay between attempts (ms), exponentially backed off
  baseDelayMs: number;
  // Max delay cap (ms)
  maxDelayMs: number;
  // Max consecutive failures before giving up entirely (prevents infinite loops)
  maxConsecutiveFailures: number;
  // Whether to auto-retry after exhaustion (default false — user must manually recover)
  autoRetryAfterExhaustion: boolean;
  // Whether kill switch must be enforced during recovery (default true)
  enforceKillSwitch: boolean;
  // Whether DNS leak protection is required (default true)
  requireDnsLeakProtection: boolean;
};

export const DEFAULT_POLICY: RecoveryPolicy = {
  maxAttempts: 10,
  verifyTimeoutMs: 8000,
  baseDelayMs: 1500,
  maxDelayMs: 30000,
  maxConsecutiveFailures: 5,
  autoRetryAfterExhaustion: false,
  enforceKillSwitch: true,
  requireDnsLeakProtection: true,
};

// ---------------------------------------------------------------------------
// Recovery attempt (what gets logged per try)
// ---------------------------------------------------------------------------

export type RecoveryAttempt = {
  // Which plan this attempt belongs to
  planId: string;
  // Which candidate was tried
  candidateId: string;
  // Display label of the candidate (NO credentials — for log readability)
  candidateLabel?: string;
  // Index of this attempt (1-based)
  attemptNumber: number;
  // State machine state when this attempt was made
  state: RecoveryState;
  // Result of this attempt
  result: "success" | "failure" | "skipped" | "in-progress";
  // Free-form reason (NO credentials, NO sensitive URLs)
  reason: string;
  // Latency observed, if any
  latencyMs: number | null;
  // Timestamps
  startedAt: string; // ISO
  endedAt: string | null; // ISO, null if still in progress
};

// ---------------------------------------------------------------------------
// Recovery status (the aggregate state exposed via API)
// ---------------------------------------------------------------------------

export type RecoveryStatus = {
  // Current state machine state
  state: RecoveryState;
  // The plan currently being executed (null if idle)
  activePlan: RecoveryPlan | null;
  // History of recent attempts (most recent first, capped)
  attempts: RecoveryAttempt[];
  // Current active candidate (null if idle/exhausted)
  currentCandidate: CandidatePath | null;
  // Next candidate to try if current fails (null if none left)
  nextCandidate: CandidatePath | null;
  // Number of attempts made in the current recovery cycle
  attemptsThisCycle: number;
  // Timestamp of last state transition
  lastStateChangeAt: string; // ISO
  // Free-form error message if state is "exhausted" (NO credentials)
  exhaustedReason: string | null;
};

// ---------------------------------------------------------------------------
// Plan request (input to /api/emergency/plan)
// ---------------------------------------------------------------------------

export type PlanRequest = {
  // Optional: filter by preferred country
  preferredCountry?: string;
  // Optional: filter by preferred protocol
  preferredProtocol?: TransportType;
  // Whether to include satellite (Starlink) paths — requires VIP
  includeSatellite?: boolean;
  // Whether to include VIP-only nodes
  includeVip?: boolean;
  // Override the default policy
  policyOverrides?: Partial<RecoveryPolicy>;
  // User tier (free/vip/admin) — verified server-side, not trusted from client
  userTier?: "free" | "vip" | "admin";
  // User email (for VIP verification)
  userEmail?: string;
};

// ---------------------------------------------------------------------------
// Report request (input to /api/emergency/report)
// ---------------------------------------------------------------------------

export type ReportRequest = {
  planId: string;
  attempt: Omit<RecoveryAttempt, "planId">;
  // The probe result if the attempt got far enough to probe
  probeResult?: ProbeResult;
};

// ---------------------------------------------------------------------------
// Validation request (input to /api/emergency/configs/validate)
// ---------------------------------------------------------------------------

export type ValidateConfigRequest = {
  // The raw URI (vless://, vmess://, trojan://, ss://) or the config text
  input: string;
  // Whether to also probe reachability (TCP connect)
  probeReachability?: boolean;
};

export type ValidateConfigResponse = {
  // The three independent states
  structural: StructuralValidity;
  reachability: ServerReachability;
  tunnel: TunnelVerification; // always "not-attempted" for validate-only
  // Parsed fields (NO credentials — only structural info)
  parsed: {
    protocol: TransportType | "unknown";
    host: string | null;
    port: number | null;
    network: string | null;
    security: string | null;
    sni: string | null;
    hasRequiredCredentials: boolean;
    antiDpiScore: number;
    flags: string[];
  } | null;
  // Reachability info (only if probeReachability was true)
  latencyMs: number | null;
  // Human-readable summary (NO credentials)
  summary: string;
  // Warnings (e.g. "plaintext transport, likely filtered")
  warnings: string[];
};

// ---------------------------------------------------------------------------
// Provision request (input to /api/emergency/provision — VIP only)
// ---------------------------------------------------------------------------

export type ProvisionRequest = {
  // What kind of path to provision
  kind: "wireguard" | "vless-reality" | "trojan-cdn" | "satellite";
  // Preferred exit country (null = auto)
  preferredCountry?: string;
  // User email (must be VIP)
  userEmail: string;
};

export type ProvisionResponse = {
  // Whether provisioning succeeded
  ok: boolean;
  // The provisioned config URI (real credentials — returned ONLY to VIP users)
  configUri: string | null;
  // Human-readable summary
  summary: string;
  // Expiry of this provisioned config (ISO)
  expiresAt: string | null;
  // Error reason if ok=false
  error: string | null;
};

// ---------------------------------------------------------------------------
// Log scrubbing — CRITICAL for security
// ---------------------------------------------------------------------------

// Per design §8: no private keys, UUIDs, passwords, or sensitive subscription
// URLs in logs, crash reports, or telemetry. This helper scrubs a string.

const SENSITIVE_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // UUIDs (vmess/vless user ids)
  { pattern: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, replacement: "[UUID]" },
  // Base64 blobs longer than 32 chars (likely keys/tokens)
  { pattern: /[A-Za-z0-9+/=]{32,}/g, replacement: "[REDACTED]" },
  // Passwords in URIs (anything after ://user:pass@)
  { pattern: /:\/\/([^:]+):([^@]+)@/g, replacement: "://$1:[REDACTED]@" },
  // query param values for known-sensitive keys
  { pattern: /([?&](?:pbk|key|password|secret|token|sid)=)([^&]+)/gi, replacement: "$1[REDACTED]" },
  // Subscription URLs (raw.githubusercontent.com/etc with paths)
  { pattern: /(https?:\/\/[^/]+\/[^?\s]*?\?token=)[^&\s]+/gi, replacement: "$1[REDACTED]" },
];

export function scrubSensitive(input: string): string {
  let out = input;
  for (const { pattern, replacement } of SENSITIVE_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}
