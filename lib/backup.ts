import fs from "fs";
import path from "path";
import { dataFilePath } from "./db";

// How many snapshots to keep. At one snapshot / 30 min, 48 ≈ last 24h.
const KEEP = Math.max(1, Number(process.env.BACKUP_KEEP) || 48);
// Where snapshots are written. Defaults to the local NAS mount; point it at a
// persistent mounted volume (see .env.example / docker-compose.yml).
const BACKUP_DIR = process.env.BACKUP_DIR || "/mnt/sml-data";

/**
 * Snapshot the data file into $BACKUP_DIR/saimoe-<timestamp>.json, keep the
 * most recent KEEP snapshots. BACKUP_DIR must be a persistent mount, otherwise
 * snapshots vanish on restart.
 */
export function backupNow(): void {
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
