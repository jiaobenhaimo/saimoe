import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Intentionally does NOT touch the database, so probes stay green even if the
// DB is briefly slow/unreachable. Use this path for liveness/readiness checks.
export function GET() {
  return NextResponse.json({ ok: true, status: "healthy", ts: Date.now() });
}
