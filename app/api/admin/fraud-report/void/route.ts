import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { adminOk } from "@/lib/adminauth";
import { ensureSchema, dataFilePath, invalidateVotes, logAudit, readDb } from "@/lib/db";
import { apiEnabled } from "@/lib/flags";
import { short } from "@/lib/fraud";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authed(req: NextRequest): boolean {
  const token = req.headers.get("x-admin-token");
  return adminOk(token);
}

/**
 * POST /api/admin/fraud-report/void
 * { competition_id, voterIds: string[], reason?: string, clusters?: [{ id, score, level, voterIds }] }
 *
 * 复用现有作废逻辑。因为作废是真删、不可撤销：
 *  1. 先落一份完整数据快照到 $DATA_DIR/snapshots/pre-void-{ts}.json；
 *  2. 每个被作废的身份写一条 auditLog（action=void_votes，带上簇 id / 票数 / 检测分）；
 *  3. 若该轮已结算，提示「按当前票数重算本轮」。
 */
export async function POST(req: NextRequest) {
  if (!authed(req)) return NextResponse.json({ error: "未授权：管理员令牌不正确。" }, { status: 401 });
  if (!apiEnabled()) return NextResponse.json({ error: "服务 API 已禁用。", disabled: true }, { status: 503 });
  try {
    ensureSchema();
    const body = await req.json();
    const cid = Number(body.competition_id);
    const voterIds = Array.isArray(body.voterIds) ? body.voterIds.map(String).filter(Boolean) : [];
    if (!cid || !voterIds.length) return NextResponse.json({ error: "缺少比赛或要作废的身份。" }, { status: 400 });
    const reason = String(body.reason || "异常投票簇处置");
    const clusters = Array.isArray(body.clusters) ? body.clusters : [];

    const comp = readDb().competitions.find((c) => c.id === cid);
    const phase = comp?.phase ?? "nomination";
    const needsResettle = phase !== "nomination";

    // 1) 快照（不可撤销操作的第一道保险）
    const snap = snapshotDb();

    // 簇上下文：voter → { clusterId, score }，写进审计摘要
    const meta = new Map<string, { clusterId: string; score: number }>();
    for (const c of clusters) {
      if (!c || !c.id) continue;
      const score = Number(c.score);
      for (const v of Array.isArray(c.voterIds) ? c.voterIds : [])
        meta.set(String(v), { clusterId: String(c.id), score: Number.isFinite(score) ? score : 0 });
    }

    // 2) 逐身份作废 + 审计
    let removed = 0;
    let blocked = 0;
    for (const vid of voterIds) {
      const n = invalidateVotes(cid, "voter", vid);
      if (n > 0) {
        removed += n;
        blocked++;
        const m = meta.get(vid);
        logAudit(
          "void_votes",
          `作废可疑票：${m ? `簇 ${m.clusterId}` : "手动勾选"} · 身份 ${short(vid)} · ${n} 票 · 检测分 ${m && m.score > 0 ? m.score : "—"} · ${reason}`,
          phase,
        );
      }
    }

    return NextResponse.json({
      ok: true,
      removed,
      blocked,
      needsResettle,
      snapshot: path.basename(snap),
      message: `已作废 ${removed} 票（${blocked} 个身份）。${needsResettle ? "该轮已结算，请再执行「按当前票数重算本轮」。当前排名/胜负不会自动更新。" : "提名票数与排名已按当前数据更新。"}`,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "作废失败" }, { status: 400 });
  }
}

/** 把当前整库快照写进 $DATA_DIR/snapshots/pre-void-{ts}.json，返回文件路径。 */
function snapshotDb(): string {
  const db = readDb();
  const dir = path.join(path.dirname(dataFilePath()), "snapshots");
  fs.mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `pre-void-${ts}.json`);
  fs.writeFileSync(file, JSON.stringify(db));
  return file;
}
