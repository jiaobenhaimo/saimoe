import { NextRequest, NextResponse } from "next/server";
import { searchCharacters } from "@/lib/bangumi";
import { apiEnabled } from "@/lib/flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!apiEnabled()) return NextResponse.json({ error: "服务 API 已禁用。请设置环境变量 API_ENABLED=true 后重新部署。", disabled: true }, { status: 503 });
  const q = req.nextUrl.searchParams.get("q")?.trim();
  if (!q) return NextResponse.json({ hits: [] });
  try {
    const hits = await searchCharacters(q);
    return NextResponse.json({ hits });
  } catch (e: any) {
    return NextResponse.json({ hits: [], error: e.message || "search failed" }, { status: 502 });
  }
}
