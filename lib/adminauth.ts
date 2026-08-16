import crypto from "node:crypto";

/** Constant-time admin-token check. Use everywhere instead of `token === ADMIN_TOKEN`
 *  so comparison time doesn't leak how many leading chars matched. */
export function adminOk(token: string | null | undefined): boolean {
  const secret = process.env.ADMIN_TOKEN || "";
  if (!secret || !token) return false;
  const a = Buffer.from(String(token));
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
