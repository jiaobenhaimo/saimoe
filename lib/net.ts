// 绕过被污染/被劫持的 DNS，并在多个候选 IP 间做故障转移，让对 Bangumi 的请求
// 能连到真正可用的服务器。
//
// 背景（由 /api/diag 实测确认）：
//   1) 容器系统 DNS 把 api.bgm.tv 污染解析成 Facebook/Twitter 的 IP；
//   2) 走 DoH 拿到的是 Cloudflare 边缘 IP，但从境内连接会被 ECONNRESET 重置；
//   3) undici 默认只连列表第一个地址、不会自动切换。
// 因此这里：
//   - 用可信 DoH（阿里 / DNSPod）解析并过滤污染 IP；
//   - 候选 IP 里把已知可用的非 Cloudflare 源站 IP 排在最前，其余（含 DoH 结果）垫后；
//   - netFetch 逐个候选 IP 尝试，遇到连接层错误就换下一个（应用层故障转移）；
//   - 可选 BGM_PROXY / HTTPS_PROXY 走正向代理（用于按 SNI 封锁、所有 IP 都不通的情况）；
//   - 可选 BGM_API_IP / BGM_IMG_IP 直接固定 IP。
import { Agent, ProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";
import dns from "node:dns/promises";

const PROBE_UA = process.env.BGM_USER_AGENT || "jiaobenhaimo/saimoe (https://github.com/jiaobenhaimo/saimoe)";

// ── 固定 IP（可选）──────────────────────────────────────────────
const PINNED: Record<string, string> = {};
const apiIp = (process.env.BGM_API_IP || "").trim();
if (apiIp) PINNED["api.bgm.tv"] = apiIp;
const imgIp = (process.env.BGM_IMG_IP || "").trim();
if (imgIp) PINNED["_img"] = imgIp;
function pinnedFor(hostname: string): string | null {
  if (PINNED[hostname]) return PINNED[hostname];
  if (PINNED["_img"] && (hostname === "bgm.tv" || hostname.endsWith(".bgm.tv"))) return PINNED["_img"];
  return null;
}

// ── DNS 污染识别：丢弃命中 Facebook/Twitter 等被墙段的地址 ─────────
const FB4 = [
  [104, 244, 0, 0, 16], [157, 240, 0, 0, 16], [31, 13, 0, 0, 16],
  [69, 171, 0, 0, 16], [69, 63, 0, 0, 16], [66, 220, 0, 0, 16], [179, 60, 0, 0, 16],
  [199, 59, 148, 0, 22], // Twitter
] as const;
function ip4InNet(a: string, net: readonly [number, number, number, number, number]): boolean {
  const p = a.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;
  const addr = ((p[0] * 256 + p[1]) * 256 + p[2]) * 256 + p[3];
  const base = ((net[0] * 256 + net[1]) * 256 + net[2]) * 256 + net[3];
  const mask = net[4] === 0 ? 0 : (0xffffffff << (32 - net[4])) >>> 0;
  return (addr & mask) === (base & mask);
}
function isBlocked(ip: string): boolean {
  if (ip.includes(":")) return ip.startsWith("2a03:2880"); // Facebook IPv6 前缀（face:b00c）
  return FB4.some((net) => ip4InNet(ip, net));
}
const clean = (addrs: string[]): string[] => [...new Set(addrs.filter((a) => !isBlocked(a)))];
const dedup = (a: string[]): string[] => [...new Set(a)];

// ── DoH 解析（带缓存）──────────────────────────────────────────
const dohCache = new Map<string, { at: number; addrs: string[] }>();
const DOH_TTL = 5 * 60_000;
const DOH_PROVIDERS: ReadonlyArray<{ url: (h: string) => string; accept: string }> = [
  { url: (h) => `https://dns.alidns.com/resolve?name=${encodeURIComponent(h)}&type=A`, accept: "application/dns-json" },
  { url: (h) => `https://doh.pub/dns-query?name=${encodeURIComponent(h)}&type=A`, accept: "application/dns-json" },
];
async function dohResolve(hostname: string): Promise<string[]> {
  const cached = dohCache.get(hostname);
  if (cached && Date.now() - cached.at < DOH_TTL) return cached.addrs;
  const merged: string[] = [];
  for (const p of DOH_PROVIDERS) {
    try {
      const r = await fetch(p.url(hostname), { headers: { Accept: p.accept }, signal: AbortSignal.timeout(8_000) });
      if (!r.ok) continue;
      const j: any = await r.json();
      const addrs = (Array.isArray(j?.Answer) ? j.Answer : [])
        .filter((a: any) => a?.type === 1 && typeof a?.data === "string")
        .map((a: any) => a.data as string);
      merged.push(...addrs);
    } catch { /* try next provider */ }
  }
  const ok = clean(merged);
  if (ok.length) dohCache.set(hostname, { at: Date.now(), addrs: ok });
  return ok;
}

// 已知可用 IP：非 Cloudflare 的源站排最前（Cloudflare 边缘在境内会被 reset），其余垫后。
const FALLBACK_API_IPS = ["199.193.116.105", "104.26.8.23", "104.26.9.23", "172.67.73.67"];

async function systemResolve4(hostname: string): Promise<string[]> {
  try {
    const a = await dns.lookup(hostname, { all: true, family: 4 });
    return clean(a.map((x) => x.address));
  } catch { return []; }
}

/** 返回该域名的候选 IPv4 列表（按尝试优先级排序）。 */
export async function candidateIps(hostname: string): Promise<string[]> {
  const pinned = pinnedFor(hostname);
  if (pinned) return [pinned];
  const doh = await dohResolve(hostname);
  if (hostname === "api.bgm.tv") return dedup([...FALLBACK_API_IPS, ...doh]);
  if (doh.length) return doh;
  return systemResolve4(hostname);
}

// ── 每个 IP 一个复用的 Agent（固定解析到该 IP）────────────────────
const agents = new Map<string, Dispatcher>();
function agentForIp(ip: string): Dispatcher {
  let a = agents.get(ip);
  if (!a) {
    const family = ip.includes(":") ? 6 : 4;
    a = new Agent({ connect: { lookup: (_h: string, _o: any, cb: any) => cb(null, [{ address: ip, family }]) } });
    agents.set(ip, a);
  }
  return a;
}

// ── 可选正向代理（用于按 SNI 封锁、所有直连 IP 都不通时）──────────
const PROXY_URL = (process.env.BGM_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy || "").trim();
let proxyAgent: Dispatcher | null = null;
function getProxy(): Dispatcher | null {
  if (!PROXY_URL) return null;
  if (!proxyAgent) proxyAgent = new ProxyAgent(PROXY_URL);
  return proxyAgent;
}

/** 发起 HTTPS 请求：优先走代理；否则逐个候选 IP 尝试，连接层失败就换下一个。 */
export async function netFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const proxy = getProxy();
  if (proxy) return undiciFetch(url, { ...init, dispatcher: proxy } as any) as any;

  const host = new URL(url).hostname;
  const ips = await candidateIps(host);
  if (!ips.length) throw new Error(`DNS 解析失败：无法为 ${host} 找到可用 IP`);

  const caller = init.signal as AbortSignal | undefined;
  let lastErr: unknown = new Error("no attempt made");
  for (const ip of ips) {
    const per = AbortSignal.timeout(8_000);
    const signal = caller ? AbortSignal.any([caller, per]) : per;
    try {
      // 拿到任意 HTTP 响应（含 4xx/5xx）即视为已连通，直接返回、不再换 IP；
      // 只有连接层异常（reset/超时/拒绝）才抛出、进入下一个候选 IP。
      return (await undiciFetch(url, { ...init, signal, dispatcher: agentForIp(ip) } as any)) as any;
    } catch (e) {
      lastErr = e;
      if (caller?.aborted) break; // 调用方已放弃（总超时）
    }
  }
  throw lastErr;
}

/** 该域名实际会使用的候选 IP（供 /api/diag 展示）。 */
export async function netResolve4(hostname: string): Promise<string[]> {
  const pinned = pinnedFor(hostname);
  if (pinned) return [`${pinned} (固定)`];
  const ips = await candidateIps(hostname);
  return ips.length ? ips : ["DoH / 系统 DNS 均解析失败"];
}

/** 逐个候选 IP 探测连通性（供 /api/diag 精确定位哪个 IP 能通）。 */
export async function netProbeEach(hostname = "api.bgm.tv", path = "/v0/me"): Promise<any[]> {
  const proxy = getProxy();
  if (proxy) {
    const started = Date.now();
    try {
      const r = await undiciFetch(`https://${hostname}${path}`, {
        headers: { "User-Agent": PROBE_UA, Accept: "application/json" },
        dispatcher: proxy as any, signal: AbortSignal.timeout(8_000),
      } as any);
      return [{ via: "proxy", ok: true, status: (r as any).status, ms: Date.now() - started }];
    } catch (e: any) {
      return [{ via: "proxy", ok: false, error: e?.cause?.code || e?.code || e?.name || "err", ms: Date.now() - started }];
    }
  }
  const ips = await candidateIps(hostname);
  const out: any[] = [];
  for (const ip of ips) {
    const started = Date.now();
    try {
      const r = await undiciFetch(`https://${hostname}${path}`, {
        headers: { "User-Agent": PROBE_UA, Accept: "application/json" },
        dispatcher: agentForIp(ip), signal: AbortSignal.timeout(6_000),
      } as any);
      out.push({ ip, ok: true, status: (r as any).status, ms: Date.now() - started });
    } catch (e: any) {
      out.push({ ip, ok: false, error: e?.cause?.code || e?.code || e?.name || "err", ms: Date.now() - started });
    }
  }
  return out;
}
