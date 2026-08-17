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
  // Opt-in hardening: when VOTER_ID_MODE=sid, de-dup on the server-signed sid cookie
  // (see lib/sid.ts) — the client can't forge/rotate it, so header-swapping can't buy
  // extra votes. Trade-off: clearing cookies yields a new identity. Flip this only
  // BETWEEN tournaments (mid-event it would let anyone who already voted vote once more,
  // since existing votes are keyed on the old identity). Default keeps fingerprint mode.
  if ((process.env.VOTER_ID_MODE || "").toLowerCase() === "sid") {
    const { getSid } = await import("./sid");
    return "sid_" + (await getSid());
  }

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

/**
 * Coarse, cross-browser device hint from the `x-db` header (see computeDeviceBucket
 * on the client). Deliberately low-entropy: it is stored as vote METADATA to let an
 * operator later FLAG possible same-device multi-browser voting. It is NEVER used to
 * de-duplicate or reject a vote — doing so would collapse distinct people who happen
 * to share a hardware profile (the NAT problem again). Returns null when absent.
 */
/** 设备标识 = 客户端硬件哈希 ⊕ 调用方 IP，在服务端合成。
 *
 *  为什么要把 IP 并进来：客户端那串哈希只由屏幕/时区/核心数/内存等粗特征组成，
 *  同型号手机取值完全一样（Safari 上 deviceMemory 恒为 undefined，更少一个维度），
 *  于是「同一指纹」经常只是同型号撞号——实测有一个指纹横跨十几个不同地区的 IP。
 *  合成 IP 后：同机同网 → 同标识（能抓到清缓存换身份继续投）；
 *              同型号不同网 → 不同标识（不再误报）。
 *  注意：这会与旧数据里的 device_bucket 不兼容，旧票的标识不会重算。 */
export async function getDeviceBucket(): Promise<string | null> {
  const h = await headers();
  const raw = h.get("x-db");
  if (!raw || !/^[a-f0-9]{16,128}$/.test(raw)) return null;
  const ip = (h.get("x-forwarded-for") || "").split(",")[0]?.trim() || h.get("x-real-ip") || "";
  const crypto = await import("node:crypto");
  return crypto.createHash("sha256").update(raw + "|" + ip).digest("hex");
}
