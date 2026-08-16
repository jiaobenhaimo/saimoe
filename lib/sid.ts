import { cookies } from "next/headers";
import crypto from "node:crypto";

// A server-issued, HMAC-signed, HttpOnly session id. Unlike the client-supplied
// `x-fp` header, the browser cannot forge or rotate it, so it's a sound key for
// per-identity rate limiting: swapping `x-fp` per request no longer resets the cap.
// (Clearing cookies mints a new sid, but that's a far higher bar than a header swap,
//  and the per-IP limit still applies.)

function secret(): string {
  return process.env.SESSION_SECRET || process.env.ADMIN_TOKEN || "dev-insecure-secret-change-me";
}
function sign(raw: string): string {
  return crypto.createHmac("sha256", secret()).update(raw).digest("base64url");
}

/** Read the signed sid cookie, verifying its signature; mint + set a fresh one if absent/invalid. */
export async function getSid(): Promise<string> {
  const jar = await cookies();
  const cur = jar.get("sid")?.value;
  if (cur) {
    const dot = cur.lastIndexOf(".");
    if (dot > 0) {
      const raw = cur.slice(0, dot), sig = cur.slice(dot + 1);
      const expect = sign(raw);
      // constant-time compare; guard length to avoid timingSafeEqual throw
      if (sig.length === expect.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return raw;
    }
  }
  const raw = (globalThis.crypto?.randomUUID?.() as string) || crypto.randomBytes(16).toString("hex");
  jar.set("sid", `${raw}.${sign(raw)}`, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 60 * 60 * 24 * 365 });
  return raw;
}
