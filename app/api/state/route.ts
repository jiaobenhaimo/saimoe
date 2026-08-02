import { NextResponse } from "next/server";
import { ensureSchema } from "@/lib/db";
import { getVoterId } from "@/lib/voter";
import { getState } from "@/lib/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await ensureSchema();
    const vid = await getVoterId();
    const state = await getState(vid);
    return NextResponse.json(state);
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "server error" }, { status: 500 });
  }
}
