import { NextRequest, NextResponse } from "next/server";
import dns from "node:dns/promises";
import { apiEnabled } from "@/lib/flags";
import { adminOk } from "@/lib/adminauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 服务端环境诊断：Node 版本、数据/备份目录、以及系统 DNS 解析（用于观察是否被污染）。
// 服务端本身已不再访问 Bangumi(所有 Bangumi 交互都在浏览器端完成),故不做出站 HTTPS 探测。
export async function GET(req: NextRequest) {
  if (!apiEnabled()) return NextResponse.json({ error: "服务 API 已禁用。", disabled: true }, { status: 503 });
  if (!adminOk(req.headers.get("x-admin-token"))) return NextResponse.json({ error: "未授权：管理员令牌不正确。" }, { status: 401 });

  const out: any = {
    ts: Date.now(),
    node: process.version,
    env: { DATA_DIR: process.env.DATA_DIR || null, BACKUP_DIR: process.env.BACKUP_DIR || "/mnt/sml-data" },
  };

  try {
    const addrs = await dns.lookup("api.bgm.tv", { all: true });
    out.dns = { host: "api.bgm.tv", addresses: addrs.map((a) => `${a.address} (IPv${a.family})`) };
  } catch (e: any) {
    out.dns = { host: "api.bgm.tv", error: e.code || e.message };
  }

  return NextResponse.json(out);
}
