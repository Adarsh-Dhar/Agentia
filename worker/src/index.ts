import "dotenv/config";
import { runTradingEngine } from "./engine.js";
import prisma from "./lib/prisma.js";
import type { Agent } from "./types.js";


const POLLING_INTERVAL = parseInt(process.env.POLLING_INTERVAL ?? process.env.POLLING_INTERVAL_MS ?? "5000", 10);
const MAX_CONCURRENT_AGENTS = parseInt(process.env.MAX_CONCURRENT_AGENTS ?? "10", 10);

// ─── Graceful shutdown ────────────────────────────────────────────────────────

let isShuttingDown = false;

async function shutdown(signal: string) {
  console.log(`\n🛑 Received ${signal}. Shutting down gracefully...`);
  isShuttingDown = true;
  await prisma.$disconnect();
  console.log("👋 Worker stopped.");
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ─── Main loop ────────────────────────────────────────────────────────────────

async function tick(): Promise<void> {
  const dbAgents = await prisma.agent.findMany({
    where: { status: "RUNNING" },
    take: MAX_CONCURRENT_AGENTS, // safety cap
    select: {
      id: true,
      name: true,
      strategy: true,
      targetPair: true,
      sessionKeyPriv: true,
      status: true,
      userId: true,
      createdAt: true,
      updatedAt: true
    }
  });

  if (dbAgents.length === 0) {
    console.log("💤 No active agents — waiting...");
    return;
  }

  console.log(`\n🔍 Running engine for ${dbAgents.length} agent(s)...`);

  // Map DB agents to full Agent type
  await Promise.allSettled(dbAgents.map((agent) => runTradingEngine(agent as Agent)));
}

async function startWorker(): Promise<void> {
  console.log("🚀 Agentia AI Worker started");
  console.log(`   Polling interval : ${POLLING_INTERVAL}ms`);
  console.log(`   Max concurrent   : ${MAX_CONCURRENT_AGENTS} agents`);
  console.log(`   Env              : ${process.env.NODE_ENV ?? "development"}\n`);

  // Verify DB connection
  await prisma.$connect();
  console.log("✅ Database connected\n");

  while (!isShuttingDown) {
    const start = Date.now();

    try {
      await tick();
    } catch (error) {
      console.error("❌ Worker loop error:", error);
    }

    // Sleep for whatever remains of the polling interval
    const elapsed = Date.now() - start;
    const sleepMs = Math.max(0, POLLING_INTERVAL - elapsed);
    await new Promise((resolve) => setTimeout(resolve, sleepMs));
  }
}

startWorker().catch((err) => {
  console.error("Fatal worker error:", err);
  process.exit(1);
});