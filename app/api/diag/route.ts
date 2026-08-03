import { NextResponse } from "next/server";
import dns from "node:dns/promises";
import { apiEnabled } from "@/lib/flags";
import { netFetch, usingProxy } from "@/lib/net";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UA = process.env.BGM_USER_AGENT || "jiaobenhaimo/saimoe (https://github.com/jiaobenhaimo/saimoe)";

// 网络诊断:浏览器直接打开 /api/diag,看容器能否连上 api.bgm.tv。
// 走与业务相同的 netFetch(有 BGM_PROXY 就走代理,否则直连)。
export async function GET() {
  if (!apiEnabled()) return NextResponse.json({ error: "服务 API 已禁用。", disabled: true }, { status: 503 });

  const out: any = {
    ts: Date.now(),
    node: process.version,
    proxy: usingProxy() ? "configured (BGM_PROXY)" : "none — direct fetch",
    env: { DATA_DIR: process.env.DATA_DIR || null, BACKUP_DIR: process.env.BACKUP_DIR || "/mnt/sml-data" },
  };

  // 系统 DNS 解析(用于观察是否被污染)
  try {
    const addrs = await dns.lookup("api.bgm.tv", { all: true });
    out.dns = { host: "api.bgm.tv", addresses: addrs.map((a) => `${a.address} (IPv${a.family})`) };
  } catch (e: any) {
    out.dns = { host: "api.bgm.tv", error: e.code || e.message };
  }

  // HTTPS 探测:/v0/me 未带 token 返回 401 即代表连通(不会真的登录)
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
      hint: usingProxy() ? "已配置代理但仍失败:检查代理是否可用、能否访问 api.bgm.tv。" : "直连被 SNI 封锁时无法访问,请设置环境变量 BGM_PROXY 指向可用的正向代理。",
    };
  }

  return NextResponse.json(out);
}
