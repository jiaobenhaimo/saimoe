// Runs once when the Next.js server process starts. We use it to drive the
// competition scheduler on a timer (in addition to the lazy tick on each read).
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { runTick } = await import("./lib/schedule");
    setInterval(() => { try { runTick(true); } catch {} }, 60_000);
  }
}
