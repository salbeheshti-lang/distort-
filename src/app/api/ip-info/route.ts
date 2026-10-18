// DISTORT — /api/ip-info
// Fetches IP info server-side (avoids CORS issues from browser).

import { NextResponse } from "next/server";

export async function GET() {
  // Try multiple providers in order
  const providers = [
    {
      name: "ipapi.co",
      url: "https://ipapi.co/json/",
      headers: { "User-Agent": "DISTORT/1.0" },
      map: (d: any) => ({
        ip: d.ip, country: d.country_name, countryCode: d.country_code,
        city: d.city, isp: d.org,
      }),
    },
    {
      name: "ipwho.is",
      url: "https://ipwho.is/",
      headers: {},
      map: (d: any) => ({
        ip: d.ip, country: d.country, countryCode: d.country_code,
        city: d.city, isp: d.connection?.isp || d.connection?.org,
      }),
    },
    {
      name: "ipify",
      url: "https://api.ipify.org?format=json",
      headers: {},
      map: (d: any) => ({ ip: d.ip, country: null, countryCode: null, city: null, isp: null }),
    },
  ];

  for (const provider of providers) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6000);
      const resp = await fetch(provider.url, {
        signal: controller.signal,
        headers: provider.headers,
      });
      clearTimeout(timeout);

      if (!resp.ok) continue;
      const data = await resp.json();
      const mapped = provider.map(data);

      if (mapped.ip) {
        return NextResponse.json({ ...mapped, provider: provider.name });
      }
    } catch {
      // try next provider
    }
  }

  return NextResponse.json(
    { error: "Could not fetch IP info — check your internet connection" },
    { status: 502 }
  );
}
