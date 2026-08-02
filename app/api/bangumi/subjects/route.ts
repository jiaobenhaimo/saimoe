import { NextRequest, NextResponse } from "next/server";
import { apiEnabled } from "@/lib/flags";
import { searchSubjects } from "@/lib/bangumi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!apiEnabled()) return NextResponse.json({ error: "服务 API 已禁用。", disabled: true }, { status: 503 });
  const q = req.nextUrl.searchParams.get("q")?.trim();
  if (!q) return NextResponse.json({ hits: [] });
  try {
    return NextResponse.json({ hits: await searchSubjects(q) });
  } catch (e: any) {
    return NextResponse.json({ hits: [], error: e.message || "作品搜索失败" }, { status: 502 });
  }
}
