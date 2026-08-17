import { NextRequest, NextResponse } from "next/server";
import { ensureSchema, voterSanction, roundKeyOf } from "@/lib/db";
import { apiEnabled } from "@/lib/flags";
import { getSiteInfo } from "@/lib/site";
import { getVoterId, getDeviceBucket } from "@/lib/voter";
import { getState } from "@/lib/engine";
import { runTick } from "@/lib/schedule";
import { verifyToken, gateOn, VOTER_COOKIE } from "@/lib/wxsession";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    if (!apiEnabled()) return NextResponse.json({ error: "服务 API 已禁用。请设置环境变量 API_ENABLED=true 后重新部署。", disabled: true }, { status: 503 });
    ensureSchema();
    runTick();
    const vid = await getVoterId();
    const on = gateOn();
    const canVote = !on || !!verifyToken(req.cookies.get(VOTER_COOKIE)?.value);
    const st = getState(vid);
    // 用 state 投影里的字段拼出当前轮次键，与服务端 roundKeyOf 保持一致
    const c: any = st?.competition;
    const sanction = voterSanction(
      { voterId: vid, bucket: await getDeviceBucket() },
      roundKeyOf(c ? ({ phase: c.phase, group_matchday: c.groupMatchday, ko_round: c.koRound } as any) : undefined));
    return NextResponse.json({ ...st, voteGate: { on, canVote }, site: getSiteInfo(), sanction });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "server error" }, { status: 500 });
  }
}
