// Runs once when the Next.js server process starts. Drives the competition
// scheduler and the periodic data backup (both need a single long-lived process).
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { runTick } = await import("./lib/schedule");
    setInterval(() => { try { runTick(true); } catch {} }, 60_000);

    const { backupNow } = await import("./lib/backup");
    setInterval(() => { try { backupNow(); } catch {} }, 30 * 60_000); // every 30 minutes
  }
}
