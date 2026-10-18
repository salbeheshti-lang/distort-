// DISTORT — /api/emergency/status
// GET: return the recovery policy + managed server list + capability flags
//
// Public, read-only, no rate limit (cached on client for ~30s).
//
// Returns:
//   - policy: DEFAULT_POLICY (governs client-side recovery execution)
//   - managedServers: live view of VpnServer rows (id, code, country, city,
//     flag, host, port, online, ping, load, stealth)
//   - capabilities: { satelliteAvailable: false, provisioningAvailable: false }
//   - notice: "Emergency Connectivity is in beta. The server cannot verify
//     reachability from your device — the client must probe each candidate."
//
// NOTE: This endpoint does NOT return any user-specific recovery state —
// that lives client-side (state machine is per-device). The server has no
// way to know whether the user's local network is up.

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { DEFAULT_POLICY } from "@/lib/emergency-connectivity/types";

export async function GET() {
  let managedServers: Array<{
    id: string;
    code: string;
    country: string;
    city: string;
    flag: string;
    host: string;
    port: number;
    online: boolean;
    ping: number;
    load: number;
    stealth: boolean;
  }> = [];

  try {
    const rows = await db.vpnServer.findMany({
      orderBy: [{ online: "desc" }, { stealth: "desc" }, { ping: "asc" }],
      select: {
        id: true,
        code: true,
        country: true,
        city: true,
        flag: true,
        host: true,
        port: true,
        online: true,
        ping: true,
        load: true,
        stealth: true,
      },
      take: 60,
    });
    managedServers = rows;
  } catch {
    // DB unavailable — return empty list, the client should fall back to
    // community-mesh candidates only.
    managedServers = [];
  }

  return NextResponse.json({
    policy: DEFAULT_POLICY,
    managedServers,
    capabilities: {
      // Starlink is NOT a dependency. The satellite path appears in the
      // planner for VIP users as a stub — the client must reject it at the
      // "connecting" stage until real Starlink infra exists.
      satelliteAvailable: false,
      // Provisioning infra (auto-spin a new VLESS-Reality node) is Phase 5.
      provisioningAvailable: false,
    },
    notice:
      "Emergency Connectivity is in beta. The server cannot verify reachability from your device — the client must probe each candidate.",
  });
}
