import { NextRequest, NextResponse } from "next/server";
import { searchCharacters } from "@/lib/bangumi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q")?.trim();
  if (!q) return NextResponse.json({ hits: [] });
  try {
    const hits = await searchCharacters(q);
    return NextResponse.json({ hits });
  } catch (e: any) {
    return NextResponse.json({ hits: [], error: e.message || "search failed" }, { status: 502 });
  }
}
