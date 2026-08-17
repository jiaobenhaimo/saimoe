/**
 * 网络地址归一化工具。
 *
 * normalizeIp：IPv6 按 /64 前缀归一。同一条家庭宽带的 IPv6 后缀会频繁变化，
 * 前缀才是稳定的「同网络」身份；IPv4 原样返回（同一运营商出口即同一网络）。
 * 分组 / 判定「同网络」一律用归一化结果，展示证据时用完整原始 IP。
 */
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
