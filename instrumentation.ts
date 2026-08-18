// Runs once when the Next.js server process starts. Drives the competition
// scheduler and the periodic data backup (both need a single long-lived process).
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // 记录每一次容器启动。为什么值得记进审计日志（而不是只 console.log）：容器是易失的，
    // 平台重启/重新部署/OOM 被杀之后 stdout 往往已经翻走了，而"数据是不是被重置过""这段
    // 时间调度器有没有在跑"这两个问题事后只能靠启动记录来回答。一行足矣。
    try {
      const { logAudit, ensureSchema } = await import("./lib/db");
      ensureSchema();
      const up = Math.round(process.uptime());
      logAudit("boot", `服务启动（Node ${process.version} · pid ${process.pid} · TZ ${process.env.TZ || "系统默认"} · DATA_DIR ${process.env.DATA_DIR || "默认"}）`, null);
      console.log(`saimoe: started, pid ${process.pid}, node ${process.version}, uptime ${up}s`);
    } catch (e) {
      // 数据卷还没挂好之类的情况不该让整个进程起不来
      console.error("saimoe: could not record startup", e);
    }

    const { runTick } = await import("./lib/schedule");
    setInterval(() => { try { runTick(true); } catch (e) { console.error("saimoe: scheduler tick failed", e); } }, 60_000);

    const { backupNow } = await import("./lib/backup");
    setInterval(() => { try { backupNow(); } catch (e) { console.error("saimoe: backup tick failed", e); } }, 30 * 60_000); // every 30 minutes
  }
}
