import { NextRequest, NextResponse } from "next/server";
import { ensureSchema, readDbRO, voterSanction, roundKeyOf } from "@/lib/db";
import { apiEnabled } from "@/lib/flags";
import { getSiteInfo } from "@/lib/site";
import { getVoterId, getDeviceBucket } from "@/lib/voter";
import { getState, getActiveCompetition } from "@/lib/engine";
import { runTick } from "@/lib/schedule";
import { verifyToken, gateOn, VOTER_COOKIE } from "@/lib/wxsession";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    if (!apiEnabled()) return NextResponse.json({ error: "服务 API 已禁用。请设置环境变量 API_ENABLED=true 后重新部署。", disabled: true }, { status: 503 });
    ensureSchema();
    // runTick may advance the competition and write, so it must run BEFORE we take the snapshot
    // we build the response from -- otherwise a phase change wouldn't show up until the next poll.
    runTick();

    const vid = await getVoterId();
    // Single snapshot for the whole response. This endpoint is polled by every open tab every
    // 60s, and it used to deep-clone the entire data file three times per request (getState,
    // commentCounts inside it, then voterSanction).
    const snap = readDbRO();
    const on = gateOn();
    const canVote = !on || !!verifyToken(req.cookies.get(VOTER_COOKIE)?.value);
    const st = getState(vid, snap);
    // Round key comes straight off the snapshot's competition rather than being reassembled
    // from the state projection -- fewer chances for the two to disagree.
    const sanction = voterSanction(
      { voterId: vid, bucket: await getDeviceBucket() },
      roundKeyOf(getActiveCompetition(snap) ?? undefined),
      snap);
    return NextResponse.json({ ...st, voteGate: { on, canVote }, site: getSiteInfo(), sanction });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "server error" }, { status: 500 });
  }
}
