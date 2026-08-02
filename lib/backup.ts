import fs from "fs";
import path from "path";
import { exec } from "child_process";
import { dataFilePath, dataDirPath } from "./db";

// How many local snapshots to keep. At one snapshot / 30 min, 48 ≈ last 24h.
const KEEP = Math.max(1, Number(process.env.BACKUP_KEEP) || 48);

/**
 * Snapshot the data file into $DATA_DIR/backups/saimoe-<timestamp>.json, keep
 * the most recent KEEP snapshots, then (optionally) run BACKUP_HOOK to push the
 * snapshot off-box (e.g. to CloudBase cloud storage).
 *
 * Note: local snapshots only survive restarts if DATA_DIR is a persistent
 * mount. For durable off-box backups set BACKUP_HOOK (see .env.example).
 */
export function backupNow(): void {
  try {
    const file = dataFilePath();
    if (!fs.existsSync(file)) return; // nothing to back up yet
    const dir = path.join(dataDirPath(), "backups");
    fs.mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19); // 2026-08-02T14-30-00
    const name = `saimoe-${ts}.json`;
    const dest = path.join(dir, name);
    fs.copyFileSync(file, dest);
    prune(dir);
    runHook(dest, name);
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

function runHook(file: string, name: string): void {
  const hook = process.env.BACKUP_HOOK;
  if (!hook) return;
  const cmd = hook.split("{FILE}").join(file).split("{NAME}").join(name);
  exec(cmd, (err, _out, stderr) => {
    if (err) console.error("saimoe: backup hook failed", stderr || err.message);
  });
}
