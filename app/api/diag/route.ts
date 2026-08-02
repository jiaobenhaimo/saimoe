import { NextResponse } from "next/server";
import dns from "node:dns/promises";
import { apiEnabled } from "@/lib/flags";

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

  // 2) HTTPS 探测:/v0/me 返回 401 即代表连通(我们没有传 token,不会真登录)
  const started = Date.now();
  try {
    const r = await fetch("https://api.bgm.tv/v0/me", {
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

  return NextResponse.json(out);
}
