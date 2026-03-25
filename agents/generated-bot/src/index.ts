// ============================================================
// FILE: src/index.ts
// Entry point — starts the Flash Loan Arbitrageur bot
// ============================================================

import * as dotenv from "dotenv";
dotenv.config();

import { buildArbitrageGraph } from "./workflow.js";

async function main() {
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║   Flash Loan Arbitrageur — Starting Up       ║");
  console.log(`║   Mode: ${process.env.DRY_RUN === "true" ? "DRY RUN (safe)" : "LIVE TRADING ⚠️ "}                  ║`);
  console.log("╚══════════════════════════════════════════════╝\n");

  if (process.env.DRY_RUN !== "true") {
    console.warn("⚠️  WARNING: LIVE MODE ENABLED. Real funds at risk.");
    console.warn("   Waiting 5 seconds... Ctrl+C to abort.");
    await new Promise(r => setTimeout(r, 5000));
  }

  // Build the LangGraph state machine
  const graph = buildArbitrageGraph();

  console.log("[Bot] Starting continuous arbitrage monitoring loop...\n");

  // Run the graph in a continuous loop
  // LangGraph's recursion limit prevents infinite loops
  const result = await graph.invoke(
    {}, // Initial state — all fields use defaults
    { recursionLimit: 100000 } // Allow long-running monitoring
  );

  console.log("[Bot] Final stats:", result.stats);
}

// Handle graceful shutdown
process.on("SIGINT", () => {
  console.log("\n[Bot] Shutting down gracefully...");
  process.exit(0);
});

main().catch((err) => {
  console.error("[Bot] Fatal error:", err);
  process.exit(1);
});