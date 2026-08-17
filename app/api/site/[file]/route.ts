import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { apiEnabled } from "@/lib/flags";
import { getSiteInfo, siteDir } from "@/lib/site";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 提供 $SITE_DIR 下的二维码等图片。这些文件放在服务器（持久卷）上、不进仓库，
// 而 Next 的静态目录 public/ 在镜像里，重新部署就会没了，所以只能由这里读盘返回。
const TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml",
};

export async function GET(_req: NextRequest, ctx: { params: Promise<{ file: string }> }) {
  if (!apiEnabled()) return new NextResponse("disabled", { status: 503 });
  const { file } = await ctx.params;

  // 只允许 site.json 里登记过的文件名：既挡住路径穿越，也避免把整个卷变成文件服务器
  const allowed = new Set(getSiteInfo().qr.map((q) => q.file));
  const name = path.basename(String(file || ""));
  if (!name || name !== String(file) || !allowed.has(name))
    return new NextResponse("not found", { status: 404 });

  const ext = path.extname(name).toLowerCase();
  const type = TYPES[ext];
  if (!type) return new NextResponse("unsupported type", { status: 415 });

  try {
    const buf = fs.readFileSync(path.join(siteDir(), name));
    return new NextResponse(new Uint8Array(buf), {
      status: 200,
      headers: { "Content-Type": type, "Cache-Control": "public, max-age=3600" },
    });
  } catch {
    return new NextResponse("not found", { status: 404 });
  }
}
