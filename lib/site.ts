import fs from "node:fs";
import path from "node:path";

/** 站点信息（联系方式 / 主办 / 鸣谢 / 二维码）。
 *
 *  这些内容**故意不放进仓库**：仓库是公开的 GPL 项目，个人微信、QQ、邮箱不该躺在
 *  git 历史里，主办方与鸣谢也属于某一届的具体内容而非项目本身。
 *  所以它们放在服务器上一个未跟踪的文件里：
 *
 *      $SITE_DIR/site.json          （默认 $DATA_DIR/site.json，即持久卷上）
 *      $SITE_DIR/<二维码图片>        （通过 /api/site/<文件名> 提供）
 *
 *  文件不存在时，规则页会自动隐藏对应段落 —— 别人 clone 这个仓库跑起来就是干净的通用版。
 *  格式见仓库根目录的 site.example.json。
 */

/** 三语文本。写成字符串也可以，等同于只填了中文（缺的语言按 日语 → 中文 → 英语 回退）。 */
export interface SiteText { zh: string; en: string; ja: string }
export interface SiteQr { file: string; caption: SiteText }
export interface SiteInfo {
  /** 「如有疑问，请联系」下面那段（可多行，用 \n 换行）。 */
  contact: SiteText;
  /** 主办方一句话。 */
  host: SiteText;
  /** 鸣谢一句话。 */
  thanks: SiteText;
  /** 二维码：file 为 $SITE_DIR 下的文件名，caption 为图下说明。 */
  qr: SiteQr[];
}

const NO_TEXT: SiteText = { zh: "", en: "", ja: "" };
const EMPTY: SiteInfo = { contact: NO_TEXT, host: NO_TEXT, thanks: NO_TEXT, qr: [] };

/** 把配置里的值收成三语结构：字符串当作中文，对象取 zh/en/ja。 */
function text(v: unknown): SiteText {
  const t = (x: unknown) => (typeof x === "string" ? x.trim() : "");
  if (typeof v === "string") return { zh: v.trim(), en: "", ja: "" };
  const o = (v || {}) as Record<string, unknown>;
  return { zh: t(o.zh), en: t(o.en), ja: t(o.ja) };
}
/** 取当前语言的文本，缺失时按 日语 → 中文 → 英语 回退（与角色名一致）。 */
export function pickSiteText(t: SiteText | undefined, lang: "zh" | "en" | "ja"): string {
  if (!t) return "";
  const want = lang === "zh" ? t.zh : lang === "en" ? t.en : t.ja;
  return want || t.ja || t.zh || t.en || "";
}

export function siteDir(): string {
  return process.env.SITE_DIR || path.join(process.env.DATA_DIR || path.join(process.cwd(), ".data"), "site");
}
function configPath(): string {
  // 允许把 site.json 直接放在 DATA_DIR 下（更省事），其次找 SITE_DIR 里的同名文件
  const inData = path.join(process.env.DATA_DIR || path.join(process.cwd(), ".data"), "site.json");
  if (fs.existsSync(inData)) return inData;
  return path.join(siteDir(), "site.json");
}

let cache: { mtimeMs: number; data: SiteInfo } | null = null;

/** 读取站点信息。按 mtime 缓存；文件缺失或损坏时返回空结构（页面自动隐藏相关段落）。 */
export function getSiteInfo(): SiteInfo {
  const file = configPath();
  try {
    const st = fs.statSync(file);
    if (cache && cache.mtimeMs === st.mtimeMs) return cache.data;
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const data: SiteInfo = {
      contact: text(raw?.contact),
      host: text(raw?.host),
      thanks: text(raw?.thanks),
      qr: Array.isArray(raw?.qr)
        ? raw.qr
            .map((q: any) => ({ file: typeof q?.file === "string" ? q.file.trim() : "", caption: text(q?.caption) }))
            // 只接受纯文件名：配置写错（或被塞进 ../ ）时直接丢掉，别让它走到页面和路由上
            .filter((q: SiteQr) => (!q.file || q.file === path.basename(q.file)) && (q.file || q.caption.zh || q.caption.en || q.caption.ja))
            .slice(0, 6)
        : [],
    };
    cache = { mtimeMs: st.mtimeMs, data };
    return data;
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") console.error("saimoe: site.json unreadable", e);
    cache = null;
    return EMPTY;
  }
}
