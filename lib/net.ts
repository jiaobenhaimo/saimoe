// 绕过被污染/被劫持的 DNS,让对 Bangumi 的请求能连到真实服务器。
//
// 背景:部分云托管(如腾讯云 CloudBase Run)容器的 DNS 会把 api.bgm.tv 解析成
// Facebook 等被墙 IP(DNS 污染),导致连接超时。普通 UDP DNS 查询也会被中间人
// 注入假应答,而 DNS 污染的特征就是把域名解析到 Facebook 的 IP 段。因此这里:
//   1) 优先用环境变量固定的 IP(BGM_API_IP / BGM_IMG_IP);
//   2) 否则走 DoH(阿里 dns.alidns.com → DNSPod doh.pub)解析,只用 IPv4,
//      并丢弃命中 Facebook 段的污染答案;
//   3) 仍失败则回退到系统解析(同样过滤污染答案);
//   4) 对 api.bgm.tv 内置一组已知可用 IP 兜底。
import { Agent, fetch as undiciFetch, type Dispatcher } from "undici";
import dns from "node:dns";

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

// ── DNS 污染识别:丢弃命中 Facebook/Twitter 等被墙段的地址 ─────
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
  if (ip.includes(":")) return ip.startsWith("2a03:2880"); // Facebook IPv6 前缀(face:b00c)
  return FB4.some((net) => ip4InNet(ip, net));
}
const clean = (addrs: string[]): string[] => [...new Set(addrs.filter((a) => !isBlocked(a)))];

// ── DoH 解析(带缓存,避免每个请求都走一遍 HTTPS)─────────────
const dohCache = new Map<string, { at: number; addrs: string[] }>();
const DOH_TTL = 5 * 60_000; // 5 分钟

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

// api.bgm.tv 的内置兜底 IP(权威解析在 Cloudflare;199.193.116.105 为阿里云解析结果)
const FALLBACK_API_IPS = ["104.26.8.23", "104.26.9.23", "172.67.73.67", "199.193.116.105"];

function systemLookup(hostname: string, opts: any, cb: any): void {
  dns.lookup(hostname, { ...opts, all: true }, (err, addrs: any) => {
    if (err || !Array.isArray(addrs)) return cb(err);
    const ok = clean(addrs.map((a: any) => a.address));
    cb(null, ok.map((a: string) => ({ address: a, family: 4 })));
  });
}

let agent: Dispatcher | null = null;
function getAgent(): Dispatcher {
  if (!agent) {
    agent = new Agent({
      connect: {
        lookup(hostname: string, opts: any, cb: any) {
          const pinned = pinnedFor(hostname);
          if (pinned) return cb(null, [{ address: pinned, family: 4 }]);
          dohResolve(hostname)
            .then((addrs) => {
              // api.bgm.tv:优先用 DoH 解析出的权威 IP,内置兜底 IP 去重后垫底
              let list: string[];
              if (hostname === "api.bgm.tv") list = [...addrs, ...FALLBACK_API_IPS.filter((ip) => !addrs.includes(ip))];
              else list = addrs;
              if (list.length) cb(null, list.map((a) => ({ address: a, family: 4 })));
              else systemLookup(hostname, opts, cb);
            })
            .catch(() => systemLookup(hostname, opts, cb));
        },
      },
    });
  }
  return agent;
}

/** 对外发起 HTTPS 请求,使用可信 DoH 解析 / 固定 IP,强制走 IPv4。 */
export function netFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return undiciFetch(url, { ...init, dispatcher: getAgent() } as any) as Promise<Response>;
}

/** 返回该域名实际会使用的 IPv4 地址(供 /api/diag 诊断展示)。 */
export async function netResolve4(hostname: string): Promise<string[]> {
  const pinned = pinnedFor(hostname);
  if (pinned) return [`${pinned} (固定)`];
  const addrs = await dohResolve(hostname);
  if (hostname === "api.bgm.tv") {
    const list = [...addrs, ...FALLBACK_API_IPS.filter((ip) => !addrs.includes(ip))];
    return addrs.length ? list : [...FALLBACK_API_IPS, "(兜底)"];
  }
  return addrs.length ? addrs : ["DoH 解析失败(回退系统 DNS)"];
}
