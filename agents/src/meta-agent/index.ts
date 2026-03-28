/**
 * META-AGENT: Flash Loan Bot Builder — Initia Edition
 *
 * This is the "coder" agent. It:
 * 1. Connects to all MCP servers (including the new Initia MCP server)
 * 2. Queries them for code snippets
 * 3. Assembles a complete, executable bot project
 * 4. Returns a JSON array of files to the frontend for WebContainer execution
 *
 * The Meta-Agent NEVER executes trades. It only generates code.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { getSystemPrompt } from "../prompts/prompt.js";
import { stripIndents } from "../prompts/stripindents.js";
import { llm } from "./llm.js";

// ─── LLM Output Schemas ───────────────────────────────────────────────────────

export interface GeneratedFile {
  filepath: string;
  content: string;
}

export interface MetaAgentResponse {
  files: GeneratedFile[];
  thoughts: string;
}

// ─── Method 1: AI-Driven Project Generation ───────────────────────────────────

/**
 * Generates a target agent project using the Meta-Agent LLM and returns it as a JSON object.
 * @param userRequest The user's natural language request for the agent.
 * @param mcpSnippets Array of MCP tool code snippets to inject as context.
 */
export async function generateAgentProject(userRequest: string, mcpSnippets: string[]): Promise<MetaAgentResponse> {
  console.log("🧠 Meta-Agent: Starting code generation in memory...");

  const SYSTEM_PROMPT = getSystemPrompt("meta-agent");

  // 1. Construct the prompt
  const fullPrompt = stripIndents`
    ${SYSTEM_PROMPT}
    
    USER REQUEST:
    "${userRequest}"
    
    AVAILABLE MCP TOOL SNIPPETS:
    ${mcpSnippets.join('\n\n')}
    
    INSTRUCTIONS:
    Generate the full project codebase. You must return a JSON object with a "files" array and a "thoughts" string.
  `;

  // 2. Call the shared LLM
  let response, rawContent;
  if (llm && typeof llm.chatCompletion === "function") {
    response = await llm.chatCompletion({
      messages: [
        { role: "system", content: "You are an expert Web3 Meta-Agent Builder. Output strictly in JSON." },
        { role: "user", content: fullPrompt }
      ],
      response_format: { type: "json_object" },
      temperature: 0.2,
    });
    
    // Try both possible response shapes for compatibility depending on LLM SDK version
    rawContent = response.choices?.[0]?.message?.content || "{}";
  } else {
    throw new Error("No LLM client configured");
  }

  // 3. Parse the JSON response
  const parsedResponse = JSON.parse(rawContent) as MetaAgentResponse;

  console.log("💡 Meta-Agent Thoughts:", parsedResponse.thoughts);
  console.log(`📂 Generated ${parsedResponse.files.length} files in memory.`);
  
  // 4. Return directly to the Next.js API route (No file system writing!)
  return parsedResponse;
}

// ─── Method 2: Deterministic MCP Project Assembly ─────────────────────────────

interface MCPServerConfig {
  name: string;
  command: string;
  args: string[];
}

const MCP_SERVERS: MCPServerConfig[] = [
  { name: "goat-solana", command: "node", args: ["../mcp-servers/goat-solana/dist/index.js"] },
  { name: "aave-flashloan", command: "node", args: ["../mcp-servers/aave-flashloan/dist/index.js"] },
  { name: "dexscreener", command: "node", args: ["../mcp-servers/dexscreener/dist/index.js"] },
  { name: "jupiter-api", command: "node", args: ["../mcp-servers/jupiter-api/dist/index.js"] },
  { name: "rugcheck", command: "node", args: ["../mcp-servers/rugcheck/dist/index.js"] },
  { name: "quicknode", command: "node", args: ["../mcp-servers/quicknode/dist/index.js"] },
  { name: "biconomy", command: "node", args: ["../mcp-servers/biconomy/dist/index.js"] },
  { name: "1inch", command: "node", args: ["../mcp-servers/1inch/dist/index.js"] },
  // ── Initia ecosystem server — registered for the Initia Hackathon ──────────
  { name: "initia", command: "node", args: ["../mcp-servers/initia/dist/index.js"] },
];

export class MetaAgent {
  private clients: Map<string, Client> = new Map();

  constructor() {}

  /**
   * Connect to all MCP servers and verify they're responsive.
   */
  async connectToMCPServers(): Promise<void> {
    console.log("[MetaAgent] Connecting to MCP servers...\n");

    for (const config of MCP_SERVERS) {
      try {
        const transport = new StdioClientTransport({
          command: config.command,
          args: config.args,
        });

        const client = new Client(
          { name: `meta-agent-client-${config.name}`, version: "1.0.0" },
          { capabilities: {} }
        );

        await client.connect(transport);
        this.clients.set(config.name, client);

        // Verify by listing tools
        const tools = await client.listTools();
        console.log(`  ✓ ${config.name} (${tools.tools.length} tools available)`);
      } catch (err) {
        console.error(`  ✗ ${config.name} failed to connect: ${err}`);
      }
    }
  }

  /**
   * Call a tool on a specific MCP server and return the text content.
   */
  private async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown> = {}
  ): Promise<string> {
    const client = this.clients.get(serverName);
    if (!client) throw new Error(`MCP server '${serverName}' not connected`);

    const result = await client.callTool({ name: toolName, arguments: args });

    return (result.content as any[])
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n");
  }

  /**
   * MAIN BUILD METHOD: Assembles the complete Flash Loan Arbitrageur bot.
   * Returns the files as an array of GeneratedFile instead of writing them to disk.
   */
  async buildFlashLoanBot(config: {
    chain: "evm_arbitrum" | "solana" | "initia_evm";
    strategy: "single_swap" | "multi_hop" | "triangular" | "cross_rollup";
    network: string;
    maxLoanUSD: number;
    minProfitUSD: number;
    dryRun: boolean;
  }): Promise<GeneratedFile[]> {
    console.log("═══════════════════════════════════════════════════════════════");
    console.log("  META-AGENT: Building Flash Loan Arbitrageur Bot");
    console.log(`  Chain: ${config.chain} | Network: ${config.network}`);
    console.log(`  Strategy: ${config.strategy} | Max Loan: $${config.maxLoanUSD}`);
    console.log("═══════════════════════════════════════════════════════════════\n");

    const isInitia = config.chain === "initia_evm";
    const isEVM = config.chain === "evm_arbitrum" || isInitia;

    // ── Phase 1: Query all MCP servers for code snippets ─────────────────────
    console.log("[MetaAgent] Phase 1: Querying MCP servers for code...\n");

    // Fetch Initia-specific config if building for Initia
    const initiaSnippets = isInitia
      ? await Promise.all([
          this.callTool("initia", "get_initia_evm_config", { network: "all" }),
          this.callTool("initia", "get_initia_core_contracts", { contract: "all" }),
          this.callTool("initia", "get_minitswap_router"),
          this.callTool("initia", "get_initia_bot_template", {
            strategy: config.strategy === "cross_rollup" ? "cross_rollup" : "single_chain",
            pollingIntervalMs: 500, // Initia has 500ms block times
          }),
          config.strategy === "cross_rollup"
            ? this.callTool("initia", "get_cross_rollup_arb_code", { tokenPair: "USDC/INIT" })
            : Promise.resolve(""),
          this.callTool("initia", "get_initia_env_template"),
        ])
      : [];

    const [
      walletCode,
      flashloanContract,
      flashloanExecutor,
      profitCalculator,
      aaveAddresses,
      priceMonitorCode,
      securityCode,
      rpcListenerCode,
      sessionKeyCode,
      swapCode,
    ] = await Promise.all([
      this.callTool("goat-solana", "get_goat_initialization", { includeJupiter: !isEVM, includeSessionKey: false }),
      isEVM ? this.callTool("aave-flashloan", "get_flashloan_contract", { network: isInitia ? "ethereum" : config.network, strategy: config.strategy === "cross_rollup" ? "multi_hop" : config.strategy }) : Promise.resolve("// Solana: Flash loans handled differently"),
      isEVM ? this.callTool("aave-flashloan", "get_flashloan_executor", { library: "ethers" }) : Promise.resolve(""),
      this.callTool("aave-flashloan", "get_profit_calculator"),
      isEVM ? this.callTool("aave-flashloan", "get_aave_addresses", { network: isInitia ? "ethereum" : config.network }) : Promise.resolve(""),
      this.callTool("dexscreener", "get_price_monitor_code", { pollingIntervalMs: isInitia ? 500 : 3000, minGapPercent: 0.5 }),
      this.callTool("rugcheck", "get_token_validator_code", { chain: isEVM ? "ethereum" : "solana", strictMode: true }),
      this.callTool("quicknode", "get_websocket_listener_code", { chain: isEVM ? (isInitia ? "ethereum" : "arbitrum") : "solana", listenFor: "new_blocks" }),
      this.callTool("biconomy", "get_session_key_setup", { maxSpendPerSessionUSD: config.maxLoanUSD, sessionDurationHours: 24 }),
      isEVM ? this.callTool("1inch", "get_swap_code", { chainId: config.network === "arbitrum" ? 42161 : 1, includeApproval: true }) : this.callTool("jupiter-api", "get_jupiter_swap_code", { useVersionedTx: true }),
    ]);

    console.log("  ✓ All code snippets retrieved\n");

    // ── Phase 2: Generate Boilerplate ─────────────────────────────────────────
    console.log("[MetaAgent] Phase 2: Generating LangGraph workflow & config...\n");

    const workflowCode = this.generateWorkflow(config, isEVM, isInitia);
    const indexCode = this.generateIndex(isInitia);
    const packageJson = this.generatePackageJson(isEVM, isInitia);
    const envTemplate = isInitia
      ? (initiaSnippets[5] || this.generateEnvTemplate(config, isEVM))
      : this.generateEnvTemplate(config, isEVM);
    const readmeCode = this.generateReadme(config, isInitia);

    // ── Phase 3: Construct Memory Files ───────────────────────────────────────
    console.log("[MetaAgent] Phase 3: Structuring file payload...\n");

    const files: GeneratedFile[] = [
      { filepath: "package.json", content: packageJson },
      { filepath: ".env.template", content: envTemplate },
      { filepath: "README.md", content: readmeCode },
      { filepath: "tsconfig.json", content: this.generateTsConfig() },
      { filepath: "src/index.ts", content: indexCode },
      { filepath: "src/workflow.ts", content: workflowCode },
      { filepath: "src/price-monitor.ts", content: priceMonitorCode },
      { filepath: "src/token-validator.ts", content: securityCode },
      { filepath: "src/rpc-listener.ts", content: rpcListenerCode },
      { filepath: "src/profit-calculator.ts", content: profitCalculator },
      ...(isInitia
        ? [
            // Initia-specific files
            { filepath: "src/initia-arb-bot.ts", content: initiaSnippets[3] || "" },
            { filepath: "src/cross-rollup-arb.ts", content: initiaSnippets[4] || "" },
            { filepath: "src/initia-config.ts", content: this.generateInitiaConfig(initiaSnippets[0], initiaSnippets[1]) },
            { filepath: "src/flashloan-executor.ts", content: flashloanExecutor },
            { filepath: "src/swap-executor.ts", content: swapCode },
            { filepath: "contracts/FlashLoanArbitrageur.sol", content: flashloanContract },
          ]
        : isEVM
        ? [
            { filepath: "src/flashloan-executor.ts", content: flashloanExecutor },
            { filepath: "src/swap-executor.ts", content: swapCode },
            { filepath: "src/session-keys.ts", content: sessionKeyCode },
            { filepath: "contracts/FlashLoanArbitrageur.sol", content: flashloanContract },
            { filepath: "src/aave-addresses.ts", content: aaveAddresses },
          ]
        : [
            { filepath: "src/wallet.ts", content: walletCode },
            { filepath: "src/swap-executor.ts", content: swapCode },
          ]),
    ];

    console.log(`\n[MetaAgent] ✓ Generated ${files.length} files in memory.`);
    return files;
  }

  // ─── Code Generators ─────────────────────────────────────────────────────────

  private generateInitiaConfig(networkConfig: string, contractConfig: string): string {
    return `
// ============================================================
// FILE: src/initia-config.ts
// Auto-generated Initia network and contract configuration
// ============================================================

// Network config from Initia MCP Server
export const INITIA_NETWORK_CONFIG = ${networkConfig || JSON.stringify({ note: "Fetched from initia-mcp-server" }, null, 2)};

// Core contract addresses
export const INITIA_CONTRACTS = ${contractConfig || JSON.stringify({ note: "Fetched from initia-mcp-server" }, null, 2)};

// Initia-specific constants
export const INITIA_BLOCK_TIME_MS = 500; // 500ms block times
export const INITIA_RECOMMENDED_POLL_MS = 500;
export const INITIA_MIN_GAS_GWEI = 1; // Very low gas on Minitias
`;
  }

  private generateWorkflow(config: any, isEVM: boolean, isInitia: boolean): string {
    const pollingComment = isInitia
      ? "// Initia has 500ms block times — poll every 500ms for maximum speed"
      : "// Standard polling interval";

    return `
// ============================================================
// FILE: src/workflow.ts
// LangGraph State Machine — ${isInitia ? "Initia" : "Flash Loan"} Arbitrageur Brain
// ============================================================

import { StateGraph, Annotation, END, START } from "@langchain/langgraph";
import { startPriceMonitor, detectArbitrageOpportunities } from "./price-monitor.js";
import { isTokenSafe } from "./token-validator.js";
import { calculateArbitrageProfit } from "./profit-calculator.js";
${isInitia
  ? `import { runInitiaArbBot, detectCrossRollupOpportunity } from "./initia-arb-bot.js";`
  : isEVM
  ? `import { FlashLoanExecutor } from "./flashloan-executor.js";`
  : `import { executeSwap } from "./swap-executor.js";`}
import * as dotenv from "dotenv";
dotenv.config();

${pollingComment}
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "${isInitia ? "500" : "3000"}");

const ArbitrageState = Annotation.Root({
  opportunity: Annotation<{
    tokenAddress: string;
    tokenSymbol: string;
    buyDex: string;
    sellDex: string;
    gapPercent: number;
    estimatedProfitUSD: number;
    // Initia-specific cross-rollup fields
    minitiaAPrice?: number;
    minitiaBPrice?: number;
    direction?: string;
  } | null>({ reducer: (_, b) => b }),
  isTokenSafe: Annotation<boolean>({ reducer: (_, b) => b }),
  profitAnalysis: Annotation<{
    isProfitable: boolean;
    netProfit: number;
    recommendation: string;
  } | null>({ reducer: (_, b) => b }),
  executionResult: Annotation<{
    success: boolean;
    txHash?: string;
    profit?: string;
    error?: string;
  } | null>({ reducer: (_, b) => b }),
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

async function monitorPrices(state: State): Promise<Partial<State>> {
  console.log("\\n[Monitor] Scanning for arbitrage opportunities...");

${isInitia ? `
  // Use Initia-specific cross-rollup opportunity detection
  try {
    const opp = await detectCrossRollupOpportunity(
      parseFloat(process.env.MAX_LOAN_USD || "${config.maxLoanUSD}")
    );
    
    if (opp?.viable) {
      console.log(\`[Monitor] 🎯 Cross-rollup opportunity: \${opp.tokenPair} — \${opp.gapPercent}% gap\`);
      return {
        opportunity: {
          tokenAddress: process.env.USDC_ADDRESS || "",
          tokenSymbol: "USDC",
          buyDex: "Minitia A",
          sellDex: "Minitia B",
          gapPercent: opp.gapPercent,
          estimatedProfitUSD: opp.estimatedProfitUSD,
          minitiaAPrice: opp.minitiaAPrice,
          minitiaBPrice: opp.minitiaBPrice,
          direction: opp.direction,
        },
        stats: {
          ...state.stats,
          cyclesRun: state.stats.cyclesRun + 1,
          opportunitiesFound: state.stats.opportunitiesFound + 1,
        },
      };
    }
    console.log("[Monitor] No cross-rollup opportunity — waiting...");
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    return { opportunity: null, stats: { ...state.stats, cyclesRun: state.stats.cyclesRun + 1 } };
  } catch (err: any) {
    console.error("[Monitor] Error:", err.message);
    return { opportunity: null };
  }
` : `
  const watchlist = process.env.WATCHLIST?.split(",") || ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"];
  try {
    const { fetchTokenPairs, detectArbitrageOpportunities: detect } = await import("./price-monitor.js");
    let bestOpportunity = null;
    for (const address of watchlist) {
      const pairs = await fetchTokenPairs(address);
      const opportunities = detect(pairs, 0.5);
      if (opportunities.length > 0 && (!bestOpportunity || opportunities[0].gapPercent > (bestOpportunity as any).gapPercent)) {
        bestOpportunity = { tokenAddress: opportunities[0].tokenAddress, tokenSymbol: opportunities[0].tokenSymbol, buyDex: opportunities[0].buyOn.dexId, sellDex: opportunities[0].sellOn.dexId, gapPercent: opportunities[0].gapPercent, estimatedProfitUSD: opportunities[0].estimatedProfitUSD };
      }
    }
    if (bestOpportunity) {
      console.log(\`[Monitor] 🎯 Opportunity: \${(bestOpportunity as any).tokenSymbol} — \${(bestOpportunity as any).gapPercent}% gap\`);
      return { opportunity: bestOpportunity, stats: { ...state.stats, cyclesRun: state.stats.cyclesRun + 1, opportunitiesFound: state.stats.opportunitiesFound + 1 } };
    }
    console.log("[Monitor] No opportunities found — waiting...");
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    return { opportunity: null, stats: { ...state.stats, cyclesRun: state.stats.cyclesRun + 1 } };
  } catch (err) {
    console.error("[Monitor] Error:", err);
    return { opportunity: null };
  }
`}
}

async function validateSecurity(state: State): Promise<Partial<State>> {
  if (!state.opportunity) return { isTokenSafe: false };
  console.log(\`[Security] Checking \${state.opportunity.tokenSymbol}...\`);
  const safe = await isTokenSafe(state.opportunity.tokenAddress, "${isEVM ? "ethereum" : "solana"}");
  if (!safe) console.log("[Security] ⛔ Token flagged as unsafe — skipping");
  return { isTokenSafe: safe };
}

async function calculateProfit(state: State): Promise<Partial<State>> {
  if (!state.opportunity) return { profitAnalysis: null };
  console.log("[Profit] Calculating net profit...");
  const analysis = calculateArbitrageProfit(
    parseFloat(process.env.MAX_LOAN_USD || "${config.maxLoanUSD}"),
    state.opportunity.gapPercent / 100,
    0.003,
    0.003,
    450000,
    ${isInitia ? "1" : "20"}, // Initia has very low gas fees
    3000
  );
  console.log(\`[Profit] Net profit: $\${analysis.netProfit} | Recommendation: \${analysis.recommendation}\`);
  return { profitAnalysis: analysis };
}

async function executeArbitrage(state: State): Promise<Partial<State>> {
  if (!state.opportunity || !state.profitAnalysis) return { executionResult: { success: false, error: "Missing state" } };
  console.log("[Execute] 🚀 Initiating arbitrage execution${isInitia ? " on Initia" : ""}...");

  if (process.env.DRY_RUN === "true") {
    console.log("[Execute] DRY RUN — simulation only");
    return {
      executionResult: {
        success: true,
        txHash: \`dry-run-\${Date.now()}\`,
        profit: state.profitAnalysis.netProfit.toString(),
      },
      stats: {
        ...state.stats,
        tradesExecuted: state.stats.tradesExecuted + 1,
        totalProfitUSD: state.stats.totalProfitUSD + state.profitAnalysis.netProfit,
      },
    };
  }

${isInitia ? `
  // Execute via Initia Minitswap cross-rollup router
  const { executeCrossRollupArb } = await import("./cross-rollup-arb.js");
  const result = await executeCrossRollupArb(
    {
      tokenPair: "USDC/INIT",
      minitiaAPrice: state.opportunity.minitiaAPrice ?? 0,
      minitiaBPrice: state.opportunity.minitiaBPrice ?? 0,
      gapPercent: state.opportunity.gapPercent,
      direction: (state.opportunity.direction ?? "BUY_A_SELL_B") as any,
      estimatedProfitUSD: state.opportunity.estimatedProfitUSD,
      viable: true,
    },
    parseFloat(process.env.MAX_LOAN_USD || "${config.maxLoanUSD}")
  );
  const execResult = result
    ? { success: true, txHash: result.txHash, profit: result.profit }
    : { success: false, error: "Cross-rollup execution failed" };
` : isEVM ? `
  const executor = new FlashLoanExecutor();
  const execResult = await executor.execute({
    tokenBorrow: state.opportunity.tokenAddress,
    tokenInterim: process.env.INTERIM_TOKEN_ADDRESS!,
    amountBorrow: BigInt(Math.floor(parseFloat(process.env.MAX_LOAN_USD || "10000") * 1e6)),
    feeDexA: 3000,
    feeDexB: 3000,
    minProfit: BigInt(Math.floor(parseFloat(process.env.MIN_PROFIT_USD || "50") * 1e6)),
  });
` : `
  const execResult = { success: true, txHash: "solana-" + Date.now(), profit: "0" };
`}

  return {
    executionResult: execResult,
    stats: (execResult as any).success
      ? {
          ...state.stats,
          tradesExecuted: state.stats.tradesExecuted + 1,
          totalProfitUSD: state.stats.totalProfitUSD + parseFloat((execResult as any).profit || "0"),
        }
      : state.stats,
  };
}

async function logResult(state: State): Promise<Partial<State>> {
  const r = state.executionResult;
  if (r?.success) console.log(\`[Result] ✅ SUCCESS | TX: \${r.txHash} | Profit: $\${r.profit}\`);
  else console.log(\`[Result] ❌ FAILED | \${r?.error}\`);
  console.log(\`[Stats] Cycles: \${state.stats.cyclesRun} | Trades: \${state.stats.tradesExecuted} | Total profit: $\${state.stats.totalProfitUSD.toFixed(2)}\`);
  return {};
}

function routeAfterMonitor(state: State): string { return state.opportunity ? "validateSecurity" : "monitorPrices"; }
function routeAfterSecurity(state: State): string { return state.isTokenSafe ? "calculateProfit" : "monitorPrices"; }
function routeAfterProfit(state: State): string { return state.profitAnalysis?.recommendation === "EXECUTE" ? "executeArbitrage" : "monitorPrices"; }

export function buildArbitrageGraph() {
  const graph = new StateGraph(ArbitrageState)
    .addNode("monitorPrices", monitorPrices)
    .addNode("validateSecurity", validateSecurity)
    .addNode("calculateProfit", calculateProfit)
    .addNode("executeArbitrage", executeArbitrage)
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
      executeArbitrage: "executeArbitrage",
      monitorPrices: "monitorPrices",
    })
    .addEdge("executeArbitrage", "logResult")
    .addEdge("logResult", "monitorPrices");
  return graph.compile();
}
`;
  }

  private generateIndex(isInitia: boolean = false): string {
    return `
import * as dotenv from "dotenv";
dotenv.config();
import { buildArbitrageGraph } from "./workflow.js";

async function main() {
  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║   ${isInitia ? "Initia Cross-Rollup Arbitrageur" : "Flash Loan Arbitrageur"} — Starting Up      ║");
  console.log(\`║   Mode: \${process.env.DRY_RUN === "true" ? "DRY RUN (safe)   " : "LIVE TRADING ⚠️  "}                      ║\`);
  ${isInitia ? `console.log("║   Network: Initia Interwoven Network                ║");
  console.log("║   Block time: 500ms — ultra-fast polling enabled    ║");` : ""}
  console.log("╚══════════════════════════════════════════════════════╝\\n");

  const graph = buildArbitrageGraph();
  console.log("[Bot] Starting continuous arbitrage monitoring loop...\\n");
  const result = await graph.invoke({}, { recursionLimit: 100000 });
  console.log("[Bot] Final stats:", result.stats);
}

process.on("SIGINT", () => {
  console.log("\\n[Bot] Shutting down gracefully...");
  process.exit(0);
});

main().catch((err) => {
  console.error("[Bot] Fatal error:", err);
  process.exit(1);
});
`;
  }

  private generatePackageJson(isEVM: boolean, isInitia: boolean = false): string {
    return JSON.stringify({
      name: isInitia ? "initia-cross-rollup-arbitrageur" : "flash-loan-arbitrageur",
      version: "1.0.0",
      type: "module",
      scripts: {
        build: "tsc",
        start: "node dist/index.js",
        dev: "tsx src/index.ts",
        "dry-run": "DRY_RUN=true tsx src/index.ts",
      },
      dependencies: {
        "@langchain/core": "^0.3.0",
        "@langchain/langgraph": "^0.2.0",
        ethers: "^6.11.0",
        axios: "^1.6.0",
        dotenv: "^16.4.0",
        ...(isInitia
          ? {} // Initia uses ethers.js only — no Solana deps needed
          : !isEVM
          ? {
              "@goat-sdk/core": "^0.3.0",
              "@goat-sdk/wallet-solana": "^0.2.0",
              "@goat-sdk/plugin-jupiter": "^0.2.0",
              "@solana/web3.js": "^1.91.0",
              "@solana/spl-token": "^0.4.0",
              bs58: "^5.0.0",
            }
          : {}),
      },
      devDependencies: {
        typescript: "^5.3.0",
        "@types/node": "^20.0.0",
        tsx: "^4.7.1",
      },
    }, null, 2);
  }

  private generateEnvTemplate(config: any, isEVM: boolean): string {
    return `DRY_RUN=true\nMAX_LOAN_USD=${config.maxLoanUSD}\nMIN_PROFIT_USD=${config.minProfitUSD}\nWATCHLIST=\n${isEVM ? `EVM_RPC_URL=\nEVM_PRIVATE_KEY=\nARBITRAGEUR_CONTRACT_ADDRESS=\nINTERIM_TOKEN_ADDRESS=` : `SOLANA_RPC_URL=\nWALLET_PRIVATE_KEY=`}`;
  }

  private generateTsConfig(): string {
    return JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        outDir: "./dist",
        rootDir: "./src",
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
      },
    }, null, 2);
  }

  private generateReadme(config: any, isInitia: boolean = false): string {
    if (isInitia) {
      return `# Initia Cross-Rollup Arbitrageur
Generated by Agentia Meta-Agent — Initia Hackathon Edition

## What this bot does
Monitors price discrepancies across Initia's EVM Minitias and executes
cross-rollup arbitrage via the Minitswap router, leveraging Initia's
Enshrined Liquidity and 500ms block times for maximum speed.

## Quick Start
1. Copy \`.env.template\` to \`.env\` and fill in your values
2. Get testnet INIT from https://faucet.testnet.initia.xyz
3. Run in dry-run mode first: \`pnpm run dry-run\`
4. When satisfied, set \`DRY_RUN=false\` and run: \`pnpm run dev\`

## Architecture
- **LangGraph workflow** orchestrates the monitor → validate → profit-check → execute loop
- **Minitswap router** handles cross-rollup swaps atomically
- **500ms polling** matches Initia's block time for edge speed
- **Enshrined Liquidity** on Initia L1 means cross-Minitia price gaps are always temporary

## Hackathon demo prompt
> "Agentia, build an arbitrage bot that monitors the USDC/INIT pool on Minitia A.
> When it spots a price discrepancy, use the Minitswap cross-chain router to
> flash loan on Minitia A, swap on Initia L1, and settle the profit back on Minitia A."
`;
    }
    return `# Flash Loan Arbitrageur Bot\nGenerated by Meta-Agent\n\nRun \`pnpm install\` then \`pnpm run dev\`.`;
  }

  /**
   * Disconnects all MCP server connections.
   */
  async disconnect(): Promise<void> {
    for (const [name, client] of this.clients) {
      await client.close();
      console.log(`[MetaAgent] Disconnected from ${name}`);
    }
  }
}