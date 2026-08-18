/**
 * 网络地址归一化工具。
 *
 * normalizeIp：IPv6 按 /64 前缀归一。同一条家庭宽带的 IPv6 后缀会频繁变化，
 * 前缀才是稳定的「同网络」身份；IPv4 原样返回（同一运营商出口即同一网络）。
 * 分组 / 判定「同网络」一律用归一化结果，展示证据时用完整原始 IP。
 */
/**
 * The caller's IP, resolved from proxy headers.
 *
 * `x-forwarded-for` is a list the client can pre-seed: a request arriving with
 * `X-Forwarded-For: 1.2.3.4` gets that value appended to, not replaced, so the FIRST entry is
 * attacker-controlled unless something upstream strips it. Since the IP feeds both the per-IP
 * rate limits and the device_bucket used by the fraud dashboard, a spoofable value lets one
 * client look like an unlimited number of networks.
 *
 * Resolution order:
 *  1. `PROXY_IP_HEADER` — a single-value header your edge sets and always overwrites. On Fly
 *     that's `Fly-Client-IP`; on Cloudflare, `CF-Connecting-IP`. This is the correct fix.
 *  2. `TRUSTED_PROXY_HOPS=n` — count n entries back from the END of x-forwarded-for, i.e. the
 *     value your own proxy appended rather than whatever the client claimed.
 *  3. Default: first x-forwarded-for entry.
 *
 * The default deliberately preserves the pre-existing behaviour. device_bucket is a hash of
 * (client hardware hash | ip), so changing how the IP is derived would make new buckets
 * incomparable with those already stored — mid-tournament that would silently blind the
 * duplicate-device signals. Set these vars BETWEEN tournaments, not during one.
 */
export function clientIp(h: { get(name: string): string | null }): string {
  const single = (process.env.PROXY_IP_HEADER || "").trim();
  if (single) {
    const v = (h.get(single) || "").trim();
    if (v) return v.split(",")[0].trim();
  }
  const xff = (h.get("x-forwarded-for") || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (xff.length) {
    const hops = Math.max(0, Math.floor(Number(process.env.TRUSTED_PROXY_HOPS) || 0));
    if (hops > 0) return xff[Math.max(0, xff.length - hops)] || xff[xff.length - 1];
    return xff[0];
  }
  return (h.get("x-real-ip") || "").trim() || "unknown";
}

export function normalizeIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const s = ip.trim();
  if (!s || s === "unknown") return null;
  if (!s.includes(":")) return s; // IPv4 原样
  // IPv4-mapped IPv6（::ffff:1.2.3.4）剥成纯 IPv4，否则 /64 归一毫无意义
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(s);
  if (mapped) return mapped[1];
  const groups = s.split(":").filter(Boolean);
  return groups.slice(0, 4).join(":") + "::/64";
}
