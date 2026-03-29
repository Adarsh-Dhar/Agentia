import "dotenv/config";
import prisma from "./lib/prisma.js";
import { startServer } from "./server.js";
import { stopAgent, listRunningAgents } from "./engine.js";

const PORT = parseInt(process.env.WORKER_PORT ?? "4001", 10);

// ── Graceful shutdown ─────────────────────────────────────────────────────────
async function shutdown(signal: string) {
  console.log(`\n🛑 Received ${signal}. Shutting down...`);

  // Stop all in-memory agents cleanly
  const running = listRunningAgents();
  if (running.length > 0) {
    console.log(`   Stopping ${running.length} running agent(s)...`);
    await Promise.allSettled(running.map((id) => stopAgent(id)));
  }

  await prisma.$disconnect();
  console.log("👋 Worker stopped.");
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ── Boot ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("🚀 Agentia Worker starting...");
  console.log(`   Port      : ${PORT}`);
  console.log(`   Env       : ${process.env.NODE_ENV ?? "development"}\n`);

  await prisma.$connect();
  console.log("✅ Database connected\n");

  // Reset any agents that were left in STARTING/RUNNING/STOPPING
  // from a previous crashed worker run
  const stale = await prisma.agent.updateMany({
    where: { status: { in: ["STARTING", "RUNNING", "STOPPING"] } },
    data: { status: "STOPPED" },
  });
  if (stale.count > 0) {
    console.log(`⚠️  Reset ${stale.count} stale agent(s) to STOPPED`);
  }

  startServer(PORT);
}

main().catch((err) => {
  console.error("Fatal worker error:", err);
  process.exit(1);
});