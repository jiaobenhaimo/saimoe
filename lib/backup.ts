import fs from "fs";
import path from "path";
import { dataFilePath } from "./db";

// How many snapshots to keep. At one snapshot / 30 min, 48 ≈ last 24h.
const KEEP = Math.max(1, Number(process.env.BACKUP_KEEP) || 48);
// Where snapshots are written. Defaults to the local NAS mount; point it at a
// persistent mounted volume (see .env.example / docker-compose.yml).
const BACKUP_DIR = process.env.BACKUP_DIR || "/mnt/sml-data";
/** 备份总开关。默认开启；设 BACKUP_ENABLED=false 可整体关掉（定期快照与轮次归档都停）。 */
export function backupEnabled(): boolean {
  return String(process.env.BACKUP_ENABLED ?? "true").toLowerCase() !== "false";
}

/**
 * Snapshot the data file into $BACKUP_DIR/saimoe-<timestamp>.json, keep the
 * most recent KEEP snapshots. BACKUP_DIR must be a persistent mount, otherwise
 * snapshots vanish on restart.
 */
/**
 * 轮次归档：一轮结束时留一份**永不被轮转覆盖**的备份。
 *
 * 为什么不能用普通快照：定期快照只保留最近 BACKUP_KEEP 份（默认 48，约 24 小时）。
 * 「上周三那个比赛日结算前的数据长什么样」这种问题，等到要查的时候快照早就被轮转掉了 ——
 * 而争议往往就是几天后才提出来的。轮次归档单独命名（round-<轮次键>-<时间>.json）、
 * 不参与 prune，一届比赛也就十几份，留着不占地方。
 *
 * `label` 用轮次键（nomination / group:2 / ko:3），同一轮重复调用会加时间戳区分，
 * 不会互相覆盖。
 */
export function archiveRound(label: string): string | null {
  if (!backupEnabled()) return null;
  try {
    const file = dataFilePath();
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, "utf8");
    // 与 backupNow 同样先校验：把一个截断的文件归档成"权威存档"比不归档更糟
    let parsed: any;
    try { parsed = JSON.parse(raw); } catch { console.error("saimoe: skipping round archive — live data file is not valid JSON"); return null; }
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.competitions)) {
      console.error("saimoe: skipping round archive — live data file has unexpected shape");
      return null;
    }
    const dir = path.join(BACKUP_DIR, "rounds");
    fs.mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const safe = String(label || "round").replace(/[^A-Za-z0-9_:-]/g, "_").replace(/:/g, "-");
    const dest = path.join(dir, `round-${safe}-${ts}.json`);
    const tmp = dest + ".tmp";
    fs.writeFileSync(tmp, raw);
    fs.renameSync(tmp, dest);
    // 刻意不 prune：这些就是要长期留着的
    console.log(`saimoe: archived round "${label}" -> ${path.basename(dest)}`);
    return dest;
  } catch (e) {
    console.error("saimoe: round archive failed", e);
    return null;
  }
}

/** 已有的轮次归档清单（管理台展示用）。 */
export function listRoundArchives(): { name: string; bytes: number; at: number }[] {
  try {
    const dir = path.join(BACKUP_DIR, "rounds");
    return fs.readdirSync(dir)
      .filter((f) => f.startsWith("round-") && f.endsWith(".json"))
      .map((f) => {
        const st = fs.statSync(path.join(dir, f));
        return { name: f, bytes: st.size, at: st.mtimeMs };
      })
      .sort((a, b) => b.at - a.at);
  } catch { return []; }
}

export function backupNow(): void {
  if (!backupEnabled()) return;
  try {
    const file = dataFilePath();
    if (!fs.existsSync(file)) return; // nothing to back up yet
    // Validate before snapshotting: copying a truncated/corrupt live file would poison the
    // recovery path (db.ts restores from the newest snapshot), so skip and keep last-good.
    const raw = fs.readFileSync(file, "utf8");
    let parsed: any;
    try { parsed = JSON.parse(raw); } catch { console.error("saimoe: skipping backup — live data file is not valid JSON"); return; }
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.competitions)) {
      console.error("saimoe: skipping backup — live data file has unexpected shape");
      return;
    }
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19); // 2026-08-02T14-30-00
    const name = `saimoe-${ts}.json`;
    const dest = path.join(BACKUP_DIR, name);
    // temp + rename so a crash mid-copy never leaves a half-written snapshot behind
    const tmp = dest + ".tmp";
    fs.writeFileSync(tmp, raw);
    fs.renameSync(tmp, dest);
    prune(BACKUP_DIR);
  } catch (e) {
    console.error("saimoe: backup failed", e);
  }
}

function prune(dir: string): void {
  const files = fs.readdirSync(dir)
    .filter((f) => f.startsWith("saimoe-") && f.endsWith(".json"))
    .sort(); // ISO timestamps sort chronologically
  while (files.length > KEEP) {
    const old = files.shift();
    if (old) { try { fs.unlinkSync(path.join(dir, old)); } catch {} }
  }
}
