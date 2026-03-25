// ============================================================
// FILE: src/workflow.ts
// LangGraph State Machine — Flash Loan Arbitrageur Brain
// 
// State flow:
//   IDLE → MONITOR_PRICES → VALIDATE_SECURITY → CALCULATE_PROFIT
//        → EXECUTE_FLASHLOAN → VERIFY_RESULT → IDLE (loop)
//
// On any failure: IDLE (wait for next opportunity)
// ============================================================

import { StateGraph, Annotation, END, START } from "@langchain/langgraph";
import { startPriceMonitor, detectArbitrageOpportunities } from "./price-monitor.js";
import { isTokenSafe } from "./token-validator.js";
import { calculateArbitrageProfit } from "./profit-calculator.js";
import { FlashLoanExecutor } from "./flashloan-executor.js";
import * as dotenv from "dotenv";
dotenv.config();

// ─── State Schema ─────────────────────────────────────────────────────────────

const ArbitrageState = Annotation.Root({
  // Current opportunity being evaluated
  opportunity: Annotation<{
    tokenAddress: string;
    tokenSymbol: string;
    buyDex: string;
    sellDex: string;
    gapPercent: number;
    estimatedProfitUSD: number;
  } | null>({ reducer: (_, b) => b }),

  // Security validation result
  isTokenSafe: Annotation<boolean>({ reducer: (_, b) => b }),

  // Profit analysis
  profitAnalysis: Annotation<{
    isProfitable: boolean;
    netProfit: number;
    recommendation: string;
  } | null>({ reducer: (_, b) => b }),

  // Execution result
  executionResult: Annotation<{
    success: boolean;
    txHash?: string;
    profit?: string;
    error?: string;
  } | null>({ reducer: (_, b) => b }),

  // Cycle statistics
  stats: Annotation<{
    cyclesRun: number;
    opportunitiesFound: number;
    tradesExecuted: number;
    totalProfitUSD: number;
  }>({
    default: () => ({ cyclesRun: 0, opportunitiesFound: 0, tradesExecuted: 0, totalProfitUSD: 0 }),
    reducer: (a, b) => ({ ...a, ...b }),
  }),
});

type State = typeof ArbitrageState.State;

// ─── Node: Monitor Prices ──────────────────────────────────────────────────────

async function monitorPrices(state: State): Promise<Partial<State>> {
  console.log("\n[Monitor] Scanning for arbitrage opportunities...");

  // Watchlist of token addresses to monitor
  const watchlist = process.env.WATCHLIST?.split(",") || [
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",  // USDT
  ];

  try {
    // Import fetchTokenPairs inline to avoid circular deps
    const { fetchTokenPairs, detectArbitrageOpportunities: detect } = 
      await import("./price-monitor.js");

    let bestOpportunity = null;

    for (const address of watchlist) {
      const pairs = await fetchTokenPairs(address);
      const opportunities = detect(pairs, 0.5); // Min 0.5% gap
      
      if (opportunities.length > 0) {
        const best = opportunities[0];
        if (!bestOpportunity || best.gapPercent > bestOpportunity.gapPercent) {
          bestOpportunity = {
            tokenAddress: best.tokenAddress,
            tokenSymbol: best.tokenSymbol,
            buyDex: best.buyOn.dexId,
            sellDex: best.sellOn.dexId,
            gapPercent: best.gapPercent,
            estimatedProfitUSD: best.estimatedProfitUSD,
          };
        }
      }
    }

    if (bestOpportunity) {
      console.log(`[Monitor] 🎯 Opportunity: ${bestOpportunity.tokenSymbol} — ${bestOpportunity.gapPercent}% gap`);
      return {
        opportunity: bestOpportunity,
        stats: { ...state.stats, cyclesRun: state.stats.cyclesRun + 1, opportunitiesFound: state.stats.opportunitiesFound + 1 },
      };
    }

    console.log("[Monitor] No opportunities found — waiting...");
    await new Promise(r => setTimeout(r, 3000)); // Wait 3s before next scan
    return {
      opportunity: null,
      stats: { ...state.stats, cyclesRun: state.stats.cyclesRun + 1 },
    };

  } catch (err) {
    console.error("[Monitor] Error:", err);
    return { opportunity: null };
  }
}

// ─── Node: Validate Security ──────────────────────────────────────────────────

async function validateSecurity(state: State): Promise<Partial<State>> {
  if (!state.opportunity) return { isTokenSafe: false };

  console.log(`[Security] Checking ${state.opportunity.tokenSymbol}...`);

  const safe = await isTokenSafe(
    state.opportunity.tokenAddress,
    "ethereum"
  );

  if (!safe) {
    console.log("[Security] ⛔ Token flagged as unsafe — skipping");
  }

  return { isTokenSafe: safe };
}

// ─── Node: Calculate Profit ────────────────────────────────────────────────────

async function calculateProfit(state: State): Promise<Partial<State>> {
  if (!state.opportunity) return { profitAnalysis: null };

  console.log("[Profit] Calculating net profit...");

  const maxLoanUSD = parseFloat(process.env.MAX_LOAN_USD || "50000");

  const analysis = calculateArbitrageProfit(
    maxLoanUSD,
    state.opportunity.gapPercent / 100,
    0.003,   // DEX A fee: 0.3%
    0.003,   // DEX B fee: 0.3%
    450000,  // Gas units estimate
    20,      // Gas price in Gwei
    3000     // ETH price USD
  );

  console.log(`[Profit] Net profit: $${analysis.netProfit} | Recommendation: ${analysis.recommendation}`);

  return { profitAnalysis: analysis };
}

// ─── Node: Execute Flash Loan ─────────────────────────────────────────────────

async function executeFlashLoan(state: State): Promise<Partial<State>> {
  if (!state.opportunity || !state.profitAnalysis) {
    return { executionResult: { success: false, error: "Missing state" } };
  }

  console.log("[Execute] 🚀 Initiating flash loan execution...");

  const isDryRun = process.env.DRY_RUN === "true";
  if (isDryRun) {
    console.log("[Execute] DRY RUN — simulation only");
    return {
      executionResult: {
        success: true,
        txHash: `dry-run-${Date.now()}`,
        profit: state.profitAnalysis.netProfit.toString(),
      },
      stats: {
        ...state.stats,
        tradesExecuted: state.stats.tradesExecuted + 1,
        totalProfitUSD: state.stats.totalProfitUSD + state.profitAnalysis.netProfit,
      },
    };
  }


  // EVM: Use Aave Flash Loan
  const executor = new FlashLoanExecutor();
  const result = await executor.execute({
    tokenBorrow: state.opportunity.tokenAddress,
    tokenInterim: process.env.INTERIM_TOKEN_ADDRESS!,
    amountBorrow: BigInt(Math.floor(parseFloat(process.env.MAX_LOAN_USD || "10000") * 1e6)),
    feeDexA: 3000,
    feeDexB: 3000,
    minProfit: BigInt(Math.floor(parseFloat(process.env.MIN_PROFIT_USD || "50") * 1e6)),
  });


  return {
    executionResult: result,
    stats: result.success ? {
      ...state.stats,
      tradesExecuted: state.stats.tradesExecuted + 1,
      totalProfitUSD: state.stats.totalProfitUSD + parseFloat(result.profit || "0"),
    } : state.stats,
  };
}

// ─── Node: Log Result ─────────────────────────────────────────────────────────

async function logResult(state: State): Promise<Partial<State>> {
  const r = state.executionResult;
  if (r?.success) {
    console.log(`[Result] ✅ SUCCESS | TX: ${r.txHash} | Profit: $${r.profit}`);
  } else {
    console.log(`[Result] ❌ FAILED | ${r?.error}`);
  }
  console.log(`[Stats] Cycles: ${state.stats.cyclesRun} | Trades: ${state.stats.tradesExecuted} | Total profit: $${state.stats.totalProfitUSD.toFixed(2)}`);
  return {};
}

// ─── Conditional Routing ──────────────────────────────────────────────────────

function routeAfterMonitor(state: State): string {
  return state.opportunity ? "validateSecurity" : "monitorPrices"; // Loop back
}

function routeAfterSecurity(state: State): string {
  return state.isTokenSafe ? "calculateProfit" : "monitorPrices"; // Skip unsafe
}

function routeAfterProfit(state: State): string {
  return state.profitAnalysis?.recommendation === "EXECUTE"
    ? "executeFlashLoan"
    : "monitorPrices"; // Not profitable enough
}

// ─── Build & Export the Graph ─────────────────────────────────────────────────

export function buildArbitrageGraph() {
  const graph = new StateGraph(ArbitrageState)
    .addNode("monitorPrices", monitorPrices)
    .addNode("validateSecurity", validateSecurity)
    .addNode("calculateProfit", calculateProfit)
    .addNode("executeFlashLoan", executeFlashLoan)
    .addNode("logResult", logResult)

    .addEdge(START, "monitorPrices")
    .addConditionalEdges("monitorPrices", routeAfterMonitor, {
      validateSecurity: "validateSecurity",
      monitorPrices: "monitorPrices",
    })
    .addConditionalEdges("validateSecurity", routeAfterSecurity, {
      calculateProfit: "calculateProfit",
      monitorPrices: "monitorPrices",
    })
    .addConditionalEdges("calculateProfit", routeAfterProfit, {
      executeFlashLoan: "executeFlashLoan",
      monitorPrices: "monitorPrices",
    })
    .addEdge("executeFlashLoan", "logResult")
    .addEdge("logResult", "monitorPrices"); // Continuous loop

  return graph.compile();
}