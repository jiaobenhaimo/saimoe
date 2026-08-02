import { cookies } from "next/headers";

/** Read (or lazily create) an anonymous voter id stored in an httpOnly cookie. */
export async function getVoterId(): Promise<string> {
  const jar = await cookies();
  let vid = jar.get("vid")?.value;
  if (!vid) {
    vid =
      (globalThis.crypto?.randomUUID?.() as string) ||
      Math.random().toString(36).slice(2) + Date.now().toString(36);
    jar.set("vid", vid, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
    });
  }
  return vid;
}
