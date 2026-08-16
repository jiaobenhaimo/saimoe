import { NextRequest } from "next/server";
import { ensureSchema } from "@/lib/db";
import { apiEnabled } from "@/lib/flags";
import { checkSignature, parseXml, textReplyXml, wantsVote } from "@/lib/wx";
import { signToken, LINK_TTL_MS } from "@/lib/wxsession";
import { buildRoundReminder } from "@/lib/reminder";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// WeChat Official-Account message callback.
// Configure in mp.weixin.qq.com → 设置与开发 → 基本配置 → 服务器配置(URL = https://<域名>/api/wx)。
// Env: WX_TOKEN (must match the Token you set there), PUBLIC_BASE_URL (for the vote link).
// NOTE: the actual WeChat send/receive can only be verified after deployment; the pure
// pieces (signature check, XML build, token signing, reminder text) are unit-tested.

const TOKEN = () => process.env.WX_TOKEN || "";
const BASE = () => process.env.PUBLIC_BASE_URL || "";

// GET: WeChat server verification handshake — echo back `echostr` if the signature matches.
export async function GET(req: NextRequest) {
  if (!apiEnabled()) return new Response("disabled", { status: 503 }); // 总开关关闭时一并停用公众号回调
  const p = req.nextUrl.searchParams;
  const signature = p.get("signature") || "", timestamp = p.get("timestamp") || "", nonce = p.get("nonce") || "", echostr = p.get("echostr") || "";
  if (checkSignature(signature, timestamp, nonce, TOKEN())) {
    return new Response(echostr, { status: 200, headers: { "content-type": "text/plain" } });
  }
  return new Response("invalid signature", { status: 401 });
}

// POST: inbound user message → passive reply. "投票"/关注/菜单 → per-user tokenised link.
export async function POST(req: NextRequest) {
  if (!apiEnabled()) return new Response("disabled", { status: 503 }); // 总开关关闭时一并停用公众号回调
  const p = req.nextUrl.searchParams;
  if (!checkSignature(p.get("signature") || "", p.get("timestamp") || "", p.get("nonce") || "", TOKEN())) {
    return new Response("invalid signature", { status: 401 });
  }
  ensureSchema();
  const m = parseXml(await req.text());
  if (!m.from) return new Response("success", { status: 200 });

  let reply: string;
  if (wantsVote(m)) {
    const link = `${BASE()}/v?k=${encodeURIComponent(signToken(m.from, LINK_TTL_MS))}`;
    reply = buildRoundReminder({ voteUrl: link }).text; // ① 本轮 ② 预告 ③ 专属投票链接
  } else {
    reply = buildRoundReminder({}).text; // 其它消息：也给本轮信息 + 引导回复「投票」领链接
  }
  return new Response(textReplyXml(m.from, m.to, reply), { status: 200, headers: { "content-type": "application/xml" } });
}
