import { cookies, headers } from "next/headers";

/**
 * Resolve the voter identity used for de-duplication.
 *
 * Priority:
 *  1) A client-computed device fingerprint sent in the `x-fp` header. This is
 *     derived from stable device/browser traits, so it survives cookie/storage
 *     clears and — crucially — is NOT tied to the public IP: many people behind
 *     one NAT get distinct fingerprints and can each vote once.
 *  2) Fallback: an anonymous httpOnly cookie (for clients that don't send a
 *     fingerprint, e.g. JS disabled).
 *
 * Best-effort by nature: two identical devices can collide, and a determined
 * user can still spoof. For hard integrity, use account login (e.g. Bangumi OAuth).
 */
export async function getVoterId(): Promise<string> {
  const h = await headers();
  const fp = h.get("x-fp");
  if (fp && /^[a-f0-9]{16,128}$/.test(fp)) return "fp_" + fp;

  const jar = await cookies();
  let vid = jar.get("vid")?.value;
  if (!vid) {
    vid =
      (globalThis.crypto?.randomUUID?.() as string) ||
      Math.random().toString(36).slice(2) + Date.now().toString(36);
    jar.set("vid", vid, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 365 });
  }
  return "ck_" + vid;
}
