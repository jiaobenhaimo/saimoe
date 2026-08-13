import { NextRequest, NextResponse } from "next/server";
import { apiEnabled } from "@/lib/flags";
import { getState } from "@/lib/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authed(req: NextRequest): boolean {
  const token = req.headers.get("x-admin-token");
  return !!process.env.ADMIN_TOKEN && token === process.env.ADMIN_TOKEN;
}

function esc(s: string): string {
  const t = String(s ?? "").replace(/"/g, '""');
  return /[",\n]/.test(t) ? `"${t}"` : t;
}

export async function GET(req: NextRequest) {
  if (!authed(req)) return NextResponse.json({ error: "未授权：管理员令牌不正确。" }, { status: 401 });
  if (!apiEnabled()) return NextResponse.json({ error: "服务 API 已禁用。", disabled: true }, { status: 503 });

  const format = req.nextUrl.searchParams.get("format") === "csv" ? "csv" : "json";
  const state: any = getState("export");
  if (!state.competition) return NextResponse.json({ error: "还没有比赛。" }, { status: 400 });

  if (format === "json") {
    return NextResponse.json({ exportedAt: new Date().toISOString(), ...state });
  }

  // Export the CURRENT phase's results. Order matters: the group block now persists into
  // later phases (for the results-review UI), so check the most-advanced block first.
  const ROUND_CN: Record<string, string> = { final: "决赛", semi: "半决赛", quarter: "四分之一决赛" };
  const roundName = (label: string): string => ROUND_CN[label] || (label.startsWith("top:") ? `${label.slice(4)} 强` : label);
  const rows: string[][] = [];
  if (state.knockout && state.knockout.rounds && state.knockout.rounds.length) {
    rows.push(["阶段", "轮", "轮名称", "角色", "结果"]);
    for (const r of state.knockout.rounds) {
      for (const m of r.matchups) {
        for (const side of [m.a, m.b]) {
          const name = side?.nameCn || side?.name || "—";
          const result = m.decided ? (m.winnerId === side?.id ? "晋级" : "淘汰") : "";
          rows.push(["淘汰赛", String(r.round), roundName(r.label), name, result]);
        }
      }
    }
  } else if (state.group) {
    if (state.group.mode === "approval") {
      rows.push(["阶段", "组", "名次", "角色", "得票", "晋级"]);
      for (const g of state.group.groups) {
        (g.members ?? []).forEach((s: any, i: number) =>
          rows.push(["小组赛", String.fromCharCode(65 + g.group), String(i + 1), s.nameCn || s.name, String(s.votes ?? ""), s.advancing ? "是" : ""]));
      }
    } else {
      rows.push(["阶段", "组", "名次", "角色", "胜", "得票"]);
      for (const g of state.group.groups) {
        g.standings.forEach((s: any, i: number) =>
          rows.push(["小组赛", String.fromCharCode(65 + g.group), String(i + 1), s.nameCn || s.name, String(s.wins), String(s.votesFor ?? "")]));
      }
    }
  } else if (state.nomination) {
    rows.push(["阶段", "角色", "提名数"]);
    for (const p of state.nomination.pool) rows.push(["提名", p.nameCn || p.name, String(p.votes)]);
  }

  const csv = "\ufeff" + rows.map((r) => r.map(esc).join(",")).join("\n");
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="saimoe-${state.competition.id}.csv"`,
    },
  });
}
