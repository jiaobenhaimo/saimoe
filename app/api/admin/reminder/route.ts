import { NextRequest, NextResponse } from "next/server";
import { adminOk } from "@/lib/adminauth";
import { ensureSchema } from "@/lib/db";
import { apiEnabled } from "@/lib/flags";
import { buildRoundReminder } from "@/lib/reminder";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authed(req: NextRequest): boolean {
  const token = req.headers.get("x-admin-token");
  return adminOk(token);
}

export async function GET(req: NextRequest) {
  if (!authed(req)) return NextResponse.json({ error: "未授权：管理员令牌不正确。" }, { status: 401 });
  if (!apiEnabled()) return NextResponse.json({ error: "服务 API 已禁用。", disabled: true }, { status: 503 });
  ensureSchema();
  // mass-send text (goes to everyone → CTA, no per-user link)
  const mass = buildRoundReminder({});
  // pull-style sample (per-user link; here a placeholder token for preview)
  const base = process.env.PUBLIC_BASE_URL || "https://你的域名";
  const pull = buildRoundReminder({ voteUrl: `${base}/v?k=<该用户专属token>` });
  return NextResponse.json({ mass: mass.text, pull: pull.text, hasRound: mass.hasRound, phase: mass.phase });
}
