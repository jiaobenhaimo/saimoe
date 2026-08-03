import { NextResponse } from "next/server";
import dns from "node:dns/promises";
import { apiEnabled } from "@/lib/flags";
import { netResolve4, netFetch, netProbeEach } from "@/lib/net";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UA = process.env.BGM_USER_AGENT || "jiaobenhaimo/saimoe (https://github.com/jiaobenhaimo/saimoe)";

// 网络诊断:在浏览器里直接访问 /api/diag,即可看出容器能否解析并连上 api.bgm.tv,
// 以及失败的根因(DNS / 连接被拒 / 超时等)。只探测固定域名,不做任意请求。
export async function GET() {
  if (!apiEnabled()) return NextResponse.json({ error: "服务 API 已禁用。", disabled: true }, { status: 503 });

  const out: any = {
    ts: Date.now(),
    node: process.version,
    env: { DATA_DIR: process.env.DATA_DIR || null, BACKUP_DIR: process.env.BACKUP_DIR || "/mnt/sml-data" },
  };

  // 1) DNS 解析
  try {
    const addrs = await dns.lookup("api.bgm.tv", { all: true });
    out.dns = { host: "api.bgm.tv", addresses: addrs.map((a) => `${a.address} (IPv${a.family})`) };
  } catch (e: any) {
    out.dns = { host: "api.bgm.tv", error: e.code || e.message };
  }

  // 1b) 应用实际会使用的 IP(可信 DNS / 固定 IP)
  try {
    out.net = { "api.bgm.tv": await netResolve4("api.bgm.tv") };
  } catch (e: any) {
    out.net = { "api.bgm.tv": ["解析失败: " + (e?.message || e)] };
  }

  // 2) HTTPS 探测:/v0/me 返回 401 即代表连通(我们没有传 token,不会真登录)
  //    走与业务相同的 netFetch(可信 DNS / 固定 IP / 多 IP 故障转移),反映修复后的真实路径。
  const started = Date.now();
  try {
    const r = await netFetch("https://api.bgm.tv/v0/me", {
      headers: { "User-Agent": UA, Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    out.api = { reachable: true, status: r.status, ms: Date.now() - started };
  } catch (e: any) {
    out.api = {
      reachable: false,
      error: e?.cause?.code || e?.code || e?.name || "unknown",
      detail: e?.cause?.message || e?.message || "",
      ms: Date.now() - started,
    };
  }

  // 3) 逐个候选 IP 探测:看清到底哪个 IP 能连通(status 401=通)、哪些被 reset。
  //    若所有 IP(含非 Cloudflare 源站)都失败,基本可判定为按 SNI 封锁,需配置 BGM_PROXY。
  try {
    out.probe = await netProbeEach("api.bgm.tv");
  } catch (e: any) {
    out.probe = [{ error: e?.message || String(e) }];
  }

  return NextResponse.json(out);
}
