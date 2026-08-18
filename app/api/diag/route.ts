import { NextRequest, NextResponse } from "next/server";
import dns from "node:dns/promises";
import { apiEnabled } from "@/lib/flags";
import { adminOk } from "@/lib/adminauth";
import { bgmStats } from "@/lib/bgm";
import { imgCacheStats } from "@/lib/imgcache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 服务端环境诊断：Node 版本、数据/备份目录、Bangumi 网关与图片缓存状态、以及系统 DNS 解析
// （用于观察是否被污染）。注意：服务端**会**主动访问 Bangumi —— /api/bgm 与 /api/img 都在服务端
// 取数据（这正是把跨境请求从用户浏览器搬到服务器的目的），所以这里的 DNS 结果很有意义。
export async function GET(req: NextRequest) {
  if (!apiEnabled()) return NextResponse.json({ error: "服务 API 已禁用。", disabled: true }, { status: 503 });
  if (!adminOk(req.headers.get("x-admin-token"))) return NextResponse.json({ error: "未授权：管理员令牌不正确。" }, { status: 401 });

  const out: any = {
    ts: Date.now(),
    node: process.version,
    env: {
      DATA_DIR: process.env.DATA_DIR || null,
      BACKUP_DIR: process.env.BACKUP_DIR || "/mnt/sml-data",
      PROXY_IP_HEADER: process.env.PROXY_IP_HEADER || null,
      TRUSTED_PROXY_HOPS: process.env.TRUSTED_PROXY_HOPS || null,
      VOTER_ID_MODE: process.env.VOTER_ID_MODE || "fp",
    },
    bgm: bgmStats(),
    imgCache: imgCacheStats(),
  };

  try {
    const addrs = await dns.lookup("api.bgm.tv", { all: true });
    out.dns = { host: "api.bgm.tv", addresses: addrs.map((a) => `${a.address} (IPv${a.family})`) };
  } catch (e: any) {
    out.dns = { host: "api.bgm.tv", error: e.code || e.message };
  }

  return NextResponse.json(out);
}
