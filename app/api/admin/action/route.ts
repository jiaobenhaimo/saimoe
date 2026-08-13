import { NextRequest, NextResponse } from "next/server";
import { ensureSchema, createCompetition, deleteCompetition, removeCandidate, deleteComment, logAudit, invalidateVotes } from "@/lib/db";
import { apiEnabled } from "@/lib/flags";
import { getActiveCompetition, startGroups, startKnockout, advanceKnockout, advanceGroupMatchday, updateCompetition, scheduleCompetition, clearSchedule, undoLastTransition, resettleCurrentRound, setNominationRules, setPhaseDeadline, setPace, setGroupDayCap, resolvePlayoff } from "@/lib/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authed(req: NextRequest): boolean {
  const token = req.headers.get("x-admin-token");
  return !!process.env.ADMIN_TOKEN && token === process.env.ADMIN_TOKEN;
}

export async function POST(req: NextRequest) {
  if (!authed(req)) return NextResponse.json({ error: "未授权：管理员令牌不正确。" }, { status: 401 });
  if (!apiEnabled()) return NextResponse.json({ error: "服务 API 已禁用。请设置环境变量 API_ENABLED=true 后重新部署。", disabled: true }, { status: 503 });
  try {
    ensureSchema();
    const body = await req.json();
    const action = body.action as string;
    // record the action AFTER it succeeds, tagging the resulting phase
    const rec = (summary: string) => { try { logAudit(action, summary, getActiveCompetition()?.phase ?? null); } catch {} };

    if (action === "create") {
      const title = String(body.title || "SML").trim();
      const id = createCompetition(title);
      rec(`创建比赛《${title}》(#${id})`);
      return NextResponse.json({ ok: true, id });
    }

    const comp = getActiveCompetition();
    if (!comp) return NextResponse.json({ error: "还没有比赛，请先创建。" }, { status: 400 });

    if (action === "update") {
      updateCompetition(comp.id, String(body.title ?? ""), body.description ?? null, body.shortName ? String(body.shortName) : "");
      rec(`修改标题/简介${body.shortName ? " / 简称" : ""}`);
      return NextResponse.json({ ok: true });
    }
    if (action === "schedule") {
      if (body.dayCap !== undefined) setGroupDayCap(comp.id, Number(body.dayCap));
      scheduleCompetition(comp.id, {
        nomEndsAt: Number(body.nomEndsAt) || null,
        autoSize: Number(body.size),
        roundHours: body.roundHours ? Number(body.roundHours) : null,
        groupPerRound: Number(body.groupPerRound) || 0,
        groupRoundDays: Number(body.groupRoundDays) || 0,
        groupSize: Number(body.groupSize) || 0,
        dayCap: Number(body.dayCap) || 0,
        groupMode: (body.mode === "rr" || body.mode === "approval") ? body.mode : "",
        groupsPerDay: Number(body.groupsPerDay) || 0,
        postponeDays: Number(body.postponeDays) || 1,
      });
      rec(`设定定时赛程(取前 ${Number(body.size) || "?"} 名;提名截止 ${body.nomEndsAt ? new Date(Number(body.nomEndsAt)).toLocaleString("zh-CN") : "—"})`);
      return NextResponse.json({ ok: true });
    }
    if (action === "unschedule") { clearSchedule(comp.id); rec("取消定时赛程"); return NextResponse.json({ ok: true }); }
    if (action === "nom_rules") {
      setNominationRules(comp.id, Number(body.userLimit) || 0, Number(body.minVotes) || 0);
      rec(`更新提名约束(每人上限 ${Number(body.userLimit) || 0}、最低票 ${Number(body.minVotes) || 0})`);
      return NextResponse.json({ ok: true, message: "已更新提名约束。" });
    }
    if (action === "delete_comment") { deleteComment(comp.id, Number(body.commentId)); rec(`删除评论 #${Number(body.commentId)}`); return NextResponse.json({ ok: true }); }
    if (action === "start_groups") {
      if (body.dayCap !== undefined) setGroupDayCap(comp.id, Number(body.dayCap));
      startGroups(comp.id, Number(body.size), Number(body.perRound) || 0, Number(body.roundDays) || 0, Number(body.groupSize) || 0, (body.mode === "rr" || body.mode === "approval") ? body.mode : "", Number(body.groupsPerDay) || 0);
      rec(`开小组赛(取前 ${Number(body.size)} 名;每组 ${Number(body.groupSize) || comp.group_size || 4} 人;模式 ${body.mode === "rr" ? "循环赛" : "投票晋级"})`);
      return NextResponse.json({ ok: true });
    }
    if (action === "start_knockout") { startKnockout(comp.id); rec("结算小组赛 → 生成淘汰赛"); return NextResponse.json({ ok: true }); }
    if (action === "advance") { advanceKnockout(comp.id); rec("推进淘汰赛一轮"); return NextResponse.json({ ok: true }); }
    if (action === "advance_group") { const r = advanceGroupMatchday(comp.id); rec(r.message); return NextResponse.json({ ok: true, message: r.message, done: r.done }); }
    if (action === "resolve_playoff") { resolvePlayoff(comp.id); rec("结算第三名加赛 → 生成淘汰赛"); return NextResponse.json({ ok: true, message: "加赛已结算,淘汰赛已生成。" }); }
    if (action === "set_deadline") {
      setPhaseDeadline(comp.id, Number(body.hours) || 0);
      const on = Number(body.hours) > 0;
      rec(on ? `设定本阶段截止(还剩 ${Number(body.hours)} 小时)` : "清除本阶段截止");
      return NextResponse.json({ ok: true, message: on ? "已设定本阶段截止时间。" : "已清除本阶段截止时间。" });
    }
    if (action === "set_pace") {
      setPace(comp.id, Number(body.groupRoundDays) || 0, Number(body.roundHours) || 0);
      rec(`更新后续节奏(比赛日 ${Number(body.groupRoundDays) || "—"} 天 / 每轮 ${Number(body.roundHours) || "—"} 小时)`);
      return NextResponse.json({ ok: true, message: "已更新后续赛程节奏。" });
    }
    if (action === "reset") { deleteCompetition(comp.id); rec(`删除比赛 #${comp.id}`); return NextResponse.json({ ok: true }); }
    if (action === "remove_candidate") {
      if (comp.phase !== "nomination") return NextResponse.json({ error: "仅在提名阶段可移除角色。" }, { status: 400 });
      const ok = removeCandidate(comp.id, Number(body.candidateId));
      if (!ok) return NextResponse.json({ error: "角色不存在。" }, { status: 404 });
      rec(`移除提名角色 #${Number(body.candidateId)}`);
      return NextResponse.json({ ok: true, message: "已移除该角色。" });
    }
    if (action === "undo") { const message = undoLastTransition(comp.id); rec(`撤回上一步:${message}`); return NextResponse.json({ ok: true, message }); }
    if (action === "resettle") { const message = resettleCurrentRound(comp.id); rec(`重算本轮:${message}`); return NextResponse.json({ ok: true, message }); }
    if (action === "invalidate_votes") {
      const by = body.by === "ip" ? "ip" : body.by === "voter" ? "voter" : "bucket";
      const key = String(body.key || "");
      if (!key) return NextResponse.json({ error: "缺少要作废的目标。" }, { status: 400 });
      const removed = invalidateVotes(comp.id, by as "bucket" | "ip" | "voter", key);
      const label = by === "ip" ? "IP" : by === "voter" ? "身份" : "设备指纹";
      rec(`作废可疑票:按${label} ${key.slice(0, 12)} · 删除 ${removed} 票`);
      return NextResponse.json({ ok: true, removed, message: `已作废 ${removed} 票。若该轮已结算,请用「按当前票数重算本轮」。` });
    }

    return NextResponse.json({ error: "未知操作。" }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "admin action failed" }, { status: 400 });
  }
}
