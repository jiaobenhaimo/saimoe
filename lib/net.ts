// Bangumi egress — deliberately minimal.
//
// The container's direct TLS to api.bgm.tv is filtered by SNI (any IP gets the
// handshake reset), so DNS tricks and IP failover cannot help. The only reliable
// path is a forward proxy. Therefore:
//   • if BGM_PROXY (or HTTPS_PROXY) is set → send everything through that proxy;
//   • otherwise → a plain direct fetch (works only from an uncensored network).
import { ProxyAgent, fetch as undiciFetch } from "undici";

const PROXY_URL = (process.env.BGM_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy || "").trim();

let proxyAgent: ProxyAgent | null = null;
function getProxy(): ProxyAgent | null {
  if (!PROXY_URL) return null;
  if (!proxyAgent) proxyAgent = new ProxyAgent(PROXY_URL);
  return proxyAgent;
}

/** Whether a forward proxy is configured (for diagnostics / UI hints). */
export function usingProxy(): boolean { return !!PROXY_URL; }

/** Fetch a Bangumi URL: through the proxy if configured, else directly. */
export async function netFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const proxy = getProxy();
  if (proxy) return undiciFetch(url, { ...init, dispatcher: proxy } as any) as unknown as Response;
  return fetch(url, init);
}
