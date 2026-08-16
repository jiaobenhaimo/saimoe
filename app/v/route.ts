import { NextRequest, NextResponse } from "next/server";
import { verifyToken, signToken, SESSION_TTL_MS, VOTER_COOKIE } from "@/lib/wxsession";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The per-user link from the 公众号 lands here. Validate the one-tap token, then upgrade it
// to a longer voter-session cookie bound to the same openid, and redirect to the voting page.
export async function GET(req: NextRequest) {
  const k = req.nextUrl.searchParams.get("k");
  const openid = verifyToken(k);
  const home = new URL("/", req.nextUrl.origin);
  if (!openid) {
    home.searchParams.set("linkerr", "1");
    return NextResponse.redirect(home);
  }
  const res = NextResponse.redirect(home);
  res.cookies.set(VOTER_COOKIE, signToken(openid, SESSION_TTL_MS), {
    httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
  return res;
}
