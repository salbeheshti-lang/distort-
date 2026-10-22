// Type shim for `https-proxy-agent` v9.
// ---------------------------------------------------------------------------
// Why this exists: https-proxy-agent v9 ships its types only via the
// `exports` field in its package.json. Our tsconfig uses
// `moduleResolution: "node"` (the classic Node.js resolver, required because
// the project is built as CommonJS for Electron). The classic resolver does
// NOT consult the `exports` field, so tsc fails with TS2307 even though the
// types exist at node_modules/https-proxy-agent/dist/index.d.ts.
//
// Switching `moduleResolution` to `node16` would force us to also switch
// `module` to `node16` (which in turn forces ESM output and breaks the
// existing CommonJS build). That's too invasive a change for a single bug
// fix, so we declare the minimal public surface of the package here.
//
// The runtime import works fine — Node.js's CJS-ESM interop handles the
// dynamic `import("https-proxy-agent")` call inside tunnel-verifier.ts.
// ---------------------------------------------------------------------------

declare module "https-proxy-agent" {
  import { Agent } from "https";

  export interface HttpsProxyAgentOptions {
    [key: string]: unknown;
  }

  export class HttpsProxyAgent extends Agent {
    constructor(proxy: string | URL, opts?: HttpsProxyAgentOptions);
  }

  // Allow default-import too, in case future callers prefer
  // `import HttpsProxyAgent from "https-proxy-agent"`.
  const _default: typeof HttpsProxyAgent;
  export default _default;
}
