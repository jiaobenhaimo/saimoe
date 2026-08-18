import crypto from "node:crypto";
import { getWxGate } from "./db";

// Stateless HMAC tokens bind a WeChat openid to a short-lived one-tap link and, after the
// link is opened, to a longer voter session cookie. No server-side store needed; the
// signature + embedded expiry are self-validating. Secret comes from SESSION_SECRET
// (falls back to ADMIN_TOKEN so a single secret can bootstrap a deployment).

function secret(): string {
  const s = process.env.SESSION_SECRET || process.env.ADMIN_TOKEN || "";
  if (s) return s;
  // A known signing key means anyone could mint a valid voter session (bypassing the WeChat gate).
  if (process.env.NODE_ENV === "production")
    throw new Error("saimoe: SESSION_SECRET (or ADMIN_TOKEN) must be set in production — refusing to sign tokens with a known default.");
  return "dev-insecure-secret-change-me";
}
function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/** Sign `{openid, exp}` → "payload.signature" (base64url). */
export function signToken(openid: string, ttlMs: number): string {
  const body = b64url(Buffer.from(JSON.stringify({ o: openid, e: Date.now() + ttlMs })));
  const sig = b64url(crypto.createHmac("sha256", secret()).update(body).digest());
  return body + "." + sig;
}

/** Verify a token; returns the openid if the signature is valid and not expired, else null. */
export function verifyToken(token: string | null | undefined): string | null {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expect = b64url(crypto.createHmac("sha256", secret()).update(body).digest());
  const a = Buffer.from(sig), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(fromB64url(body).toString("utf8"));
    if (typeof p.e !== "number" || Date.now() > p.e) return null;
    return typeof p.o === "string" && p.o ? p.o : null;
  } catch { return null; }
}

export const LINK_TTL_MS = 10 * 60_000;        // one-tap link: 10 minutes
export const SESSION_TTL_MS = 7 * 86_400_000;  // voter session cookie: 7 days
export const VOTER_COOKIE = "sml_voter";

/** Whether the "must come from a WeChat link to vote" gate is enabled.
 *  Sourced from the WX_VOTE_GATE environment variable (there is no stored setting; changing it
 *  needs a redeploy). Default OFF —
 *  so the site runs perfectly fine WITHOUT any WeChat integration until an admin turns it on. */
export function gateOn(): boolean {
  return getWxGate();
}
