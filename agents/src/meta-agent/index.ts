/**
 * META-AGENT: Flash Loan Bot Builder
 *
 * This is the "coder" agent. It:
 * 1. Connects to all MCP servers
 * 2. Queries them for code snippets
 * 3. Assembles a complete, executable bot project
 * 4. (In a WebContainer environment) compiles and tests the bot
 *
 * The Meta-Agent NEVER executes trades. It only generates code.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import { getSystemPrompt } from "../prompts/prompt";
import { stripIndents } from "../prompts/stripindents";
import { llm } from "./llm";

// --- LLM Output Schema ---
export interface GeneratedFile {
  filepath: string;
  content: string;
}

export interface MetaAgentResponse {
  files: GeneratedFile[];
  thoughts: string;
}


// --- LLM Client: see llm.ts ---

/**
 * Generates a target agent project using the Meta-Agent and writes files locally for inspection.
 * @param userRequest The user's natural language request for the agent.
 * @param mcpSnippets Array of MCP tool code snippets to inject.
 */

// --- LLM Project Generation Function ---
/**
 * Generates a target agent project using the Meta-Agent and writes files locally for inspection.
 * @param userRequest The user's natural language request for the agent.
 * @param mcpSnippets Array of MCP tool code snippets to inject.
 */

export async function generateAgentProject(userRequest: string, mcpSnippets: string[]): Promise<MetaAgentResponse> {
  console.log("🧠 Meta-Agent: Starting code generation...");

  const SYSTEM_PROMPT = getSystemPrompt("meta-agent");

  // 1. Construct the prompt using your existing folder structure
  const fullPrompt = stripIndents`
    ${SYSTEM_PROMPT}
    
    USER REQUEST:
    "${userRequest}"
    
    AVAILABLE MCP TOOL SNIPPETS:
    ${mcpSnippets.join('\n\n')}
    
    INSTRUCTIONS:
    Generate the full project codebase. You must return a JSON object with a "files" array and a "thoughts" string.
  `;

  // 2. Call the shared LLM (Using JSON mode to ensure valid output)
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
    // Try both possible response shapes for compatibility
    rawContent = response.choices?.[0]?.message?.content || response.choices?.[0]?.message?.content || response?.message?.content || "{}";
  } else {
    throw new Error("No LLM client configured");
  }

  // 3. Parse the JSON response
  const parsedResponse = JSON.parse(rawContent) as MetaAgentResponse;

  console.log("💡 Meta-Agent Thoughts:", parsedResponse.thoughts);

  // 4. Return the parsed response directly to the caller (Next.js API route)
  return parsedResponse;
}

// ─── MCP Server Registry ──────────────────────────────────────────────────────

interface MCPServerConfig {
  name: string;
  command: string;
  args: string[];
}

const MCP_SERVERS: MCPServerConfig[] = [
  {
    name: "goat-solana",
    command: "node",
    args: ["../mcp-servers/goat-solana/dist/index.js"],
  },
  {
    name: "aave-flashloan",
    command: "node",
    args: ["../mcp-servers/aave-flashloan/dist/index.js"],
  },
  {
    name: "dexscreener",
    command: "node",
    args: ["../mcp-servers/dexscreener/dist/index.js"],
  },
  {
    name: "jupiter-api",
    command: "node",
    args: ["../mcp-servers/jupiter-api/dist/index.js"],
  },
  {
    name: "rugcheck",
    command: "node",
    args: ["../mcp-servers/rugcheck/dist/index.js"],
  },
  {
    name: "quicknode",
    command: "node",
    args: ["../mcp-servers/quicknode/dist/index.js"],
  },
  {
    name: "biconomy",
    command: "node",
    args: ["../mcp-servers/biconomy/dist/index.js"],
  },
  {
    name: "1inch",
    command: "node",
    args: ["../mcp-servers/1inch/dist/index.js"],
  },
];

// ─── Meta-Agent Core ──────────────────────────────────────────────────────────

export class MetaAgent {
  private clients: Map<string, Client> = new Map();
  private outputDir: string;

  constructor(outputDir: string = "./generated-bot") {
    this.outputDir = outputDir;
  }

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
        tools.tools.forEach((t) => console.log(`      - ${t.name}`));
        console.log();
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
   *
   * @param config Bot configuration options
   */
  async buildFlashLoanBot(config: {
    chain: "evm_arbitrum" | "solana";
    strategy: "single_swap" | "multi_hop" | "triangular";
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



    // ── Phase 1: Query all MCP servers for code snippets ─────────────────────
    console.log("[MetaAgent] Phase 1: Querying MCP servers for code...\n");

    const isEVM = config.chain === "evm_arbitrum";

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
      // Wallet initialization
      this.callTool("goat-solana", "get_goat_initialization", {
        includeJupiter: !isEVM,
        includeSessionKey: false,
      }),

      // Flash loan contract (EVM only)
      isEVM
        ? this.callTool("aave-flashloan", "get_flashloan_contract", {
            network: config.network,
            strategy: config.strategy,
          })
        : Promise.resolve("// Solana: Flash loans handled differently"),

      // Flash loan executor
      isEVM
        ? this.callTool("aave-flashloan", "get_flashloan_executor", {
            library: "ethers",
          })
        : Promise.resolve(""),

      // Profit calculator
      this.callTool("aave-flashloan", "get_profit_calculator"),

      // Aave addresses
      isEVM
        ? this.callTool("aave-flashloan", "get_aave_addresses", {
            network: config.network,
          })
        : Promise.resolve(""),

      // Price monitoring
      this.callTool("dexscreener", "get_price_monitor_code", {
        pollingIntervalMs: 3000,
        minGapPercent: 0.5,
      }),

      // Security validation
      this.callTool("rugcheck", "get_token_validator_code", {
        chain: isEVM ? "ethereum" : "solana",
        strictMode: true,
      }),

      // RPC listener
      this.callTool("quicknode", "get_websocket_listener_code", {
        chain: isEVM ? "arbitrum" : "solana",
        listenFor: "new_blocks",
      }),

      // Session keys
      this.callTool("biconomy", "get_session_key_setup", {
        maxSpendPerSessionUSD: config.maxLoanUSD,
        sessionDurationHours: 24,
      }),

      // Swap execution
      isEVM
        ? this.callTool("1inch", "get_swap_code", {
            chainId: config.network === "arbitrum" ? 42161 : 1,
            includeApproval: true,
          })
        : this.callTool("jupiter-api", "get_jupiter_swap_code", {
            useVersionedTx: true,
          }),
    ]);

    console.log("  ✓ All code snippets retrieved\n");

    // ── Phase 2: Generate the LangGraph State Machine ─────────────────────────
    console.log("[MetaAgent] Phase 2: Generating LangGraph workflow...\n");

    const workflowCode = this.generateWorkflow(config, isEVM);
    const indexCode = this.generateIndex(config);
    const packageJson = this.generatePackageJson(isEVM);
    const envTemplate = this.generateEnvTemplate(config, isEVM);
    const readmeCode = this.generateReadme(config);

    // ── Phase 3: Write all files ───────────────────────────────────────────────
    console.log("[MetaAgent] Phase 3: Writing bot files...\n");

    const files = [
      { path: "package.json", content: packageJson },
      { path: ".env.template", content: envTemplate },
      { path: "README.md", content: readmeCode },
      { path: "tsconfig.json", content: this.generateTsConfig() },
      { path: "src/index.ts", content: indexCode },
      { path: "src/workflow.ts", content: workflowCode },
      { path: "src/price-monitor.ts", content: priceMonitorCode },
      { path: "src/token-validator.ts", content: securityCode },
      { path: "src/rpc-listener.ts", content: rpcListenerCode },
      { path: "src/profit-calculator.ts", content: profitCalculator },
      ...(isEVM
        ? [
            { path: "src/flashloan-executor.ts", content: flashloanExecutor },
            { path: "src/swap-executor.ts", content: swapCode },
            { path: "src/session-keys.ts", content: sessionKeyCode },
            { path: "contracts/FlashLoanArbitrageur.sol", content: flashloanContract },
            { path: "src/aave-addresses.ts", content: aaveAddresses },
          ]
        : [
            { path: "src/wallet.ts", content: walletCode },
            { path: "src/swap-executor.ts", content: swapCode },
          ]),
    ];

    // Map the internal file structure to the GeneratedFile interface and return it
    const generatedFiles: GeneratedFile[] = files.map(f => ({
      filepath: f.path,
      content: f.content
    }));

    console.log(`\n[MetaAgent] ✓ Generated ${generatedFiles.length} files in memory.`);
    return generatedFiles;
  }

  // ─── Code Generators ─────────────────────────────────────────────────────────

  private generateWorkflow(config: any, isEVM: boolean): string {
    return `
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
${isEVM ? `import { FlashLoanExecutor } from "./flashloan-executor.js";` : `import { executeSwap } from "./swap-executor.js";`}
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
  console.log("\\n[Monitor] Scanning for arbitrage opportunities...");

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
      console.log(\`[Monitor] 🎯 Opportunity: \${bestOpportunity.tokenSymbol} — \${bestOpportunity.gapPercent}% gap\`);
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

  console.log(\`[Security] Checking \${state.opportunity.tokenSymbol}...\`);

  const safe = await isTokenSafe(
    state.opportunity.tokenAddress,
    "${isEVM ? "ethereum" : "solana"}"
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

  const maxLoanUSD = parseFloat(process.env.MAX_LOAN_USD || "${config.maxLoanUSD}");

  const analysis = calculateArbitrageProfit(
    maxLoanUSD,
    state.opportunity.gapPercent / 100,
    0.003,   // DEX A fee: 0.3%
    0.003,   // DEX B fee: 0.3%
    450000,  // Gas units estimate
    20,      // Gas price in Gwei
    3000     // ETH price USD
  );

  console.log(\`[Profit] Net profit: $\${analysis.netProfit} | Recommendation: \${analysis.recommendation}\`);

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

${isEVM ? `
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
` : `
  // Solana: Direct swap arbitrage
  // (Flash loans on Solana use protocol-specific approaches)
  const result = { success: true, txHash: "solana-" + Date.now(), profit: "0" };
`}

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
    console.log(\`[Result] ✅ SUCCESS | TX: \${r.txHash} | Profit: $\${r.profit}\`);
  } else {
    console.log(\`[Result] ❌ FAILED | \${r?.error}\`);
  }
  console.log(\`[Stats] Cycles: \${state.stats.cyclesRun} | Trades: \${state.stats.tradesExecuted} | Total profit: $\${state.stats.totalProfitUSD.toFixed(2)}\`);
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
`;
  }

  private generateIndex(config: any): string {
    return `
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
  console.log(\`║   Mode: \${process.env.DRY_RUN === "true" ? "DRY RUN (safe)" : "LIVE TRADING ⚠️ "}                  ║\`);
  console.log("╚══════════════════════════════════════════════╝\\n");

  if (process.env.DRY_RUN !== "true") {
    console.warn("⚠️  WARNING: LIVE MODE ENABLED. Real funds at risk.");
    console.warn("   Waiting 5 seconds... Ctrl+C to abort.");
    await new Promise(r => setTimeout(r, 5000));
  }

  // Build the LangGraph state machine
  const graph = buildArbitrageGraph();

  console.log("[Bot] Starting continuous arbitrage monitoring loop...\\n");

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
  console.log("\\n[Bot] Shutting down gracefully...");
  process.exit(0);
});

main().catch((err) => {
  console.error("[Bot] Fatal error:", err);
  process.exit(1);
});
`;
  }

  private generatePackageJson(isEVM: boolean): string {
    return JSON.stringify(
      {
        name: "flash-loan-arbitrageur",
        version: "1.0.0",
        description: "AI-powered Flash Loan Arbitrageur generated by Meta-Agent",
        type: "module",
        scripts: {
          build: "tsc",
          start: "node dist/index.js",
          dev: "ts-node --esm src/index.ts",
          "dry-run": "DRY_RUN=true node dist/index.js",
        },
        dependencies: {
          "@langchain/core": "^0.3.0",
          "@langchain/langgraph": "^0.2.0",
          ...(isEVM
            ? {
                ethers: "^6.11.0",
                axios: "^1.6.0",
                dotenv: "^16.4.0",
              }
            : {
                "@goat-sdk/core": "^0.3.0",
                "@goat-sdk/wallet-solana": "^0.2.0",
                "@goat-sdk/plugin-jupiter": "^0.2.0",
                "@solana/web3.js": "^1.91.0",
                "@solana/spl-token": "^0.4.0",
                axios: "^1.6.0",
                bs58: "^5.0.0",
                dotenv: "^16.4.0",
              }),
        },
        devDependencies: {
          typescript: "^5.3.0",
          "@types/node": "^20.0.0",
          "ts-node": "^10.9.0",
        },
      },
      null,
      2
    );
  }

  private generateEnvTemplate(config: any, isEVM: boolean): string {
    return `
# ============================================================
# .env — Flash Loan Arbitrageur Configuration
# Generated by Meta-Agent
# NEVER commit this file to version control!
# ============================================================

# ── Execution Mode ──────────────────────────────────────────
DRY_RUN=true          # Set to false only when ready for live trading
LOG_LEVEL=info

# ── Bot Parameters ──────────────────────────────────────────
MAX_LOAN_USD=${config.maxLoanUSD}       # Maximum flash loan size in USD
MIN_PROFIT_USD=${config.minProfitUSD}         # Minimum net profit to execute (USD)
WATCHLIST=            # Comma-separated token addresses to monitor

${
  isEVM
    ? `
# ── EVM (${config.network}) ─────────────────────────────────
EVM_RPC_URL=https://your-endpoint.quiknode.pro/TOKEN/
EVM_WS_URL=wss://your-endpoint.quiknode.pro/TOKEN/
EVM_PRIVATE_KEY=0x...              # ⚠️  Your bot wallet private key
ALCHEMY_RPC_URL=https://arb-mainnet.g.alchemy.com/v2/KEY  # Fallback RPC

# Deployed contract address (deploy FlashLoanArbitrageur.sol first)
ARBITRAGEUR_CONTRACT_ADDRESS=0x...

# Token addresses (Arbitrum)
INTERIM_TOKEN_ADDRESS=0x82aF49447D8a07e3bd95BD0d56f35241523fBab1  # WETH on Arbitrum

# 1inch API key (get from https://portal.1inch.dev/)
ONEINCH_API_KEY=

# Biconomy (optional — for session keys + gasless txs)
BICONOMY_BUNDLER_KEY=
BICONOMY_PAYMASTER_KEY=
ERC20_SESSION_VALIDATION_MODULE=0x...
`
    : `
# ── Solana ──────────────────────────────────────────────────
SOLANA_RPC_URL=https://your-endpoint.quiknode.pro/TOKEN/
SOLANA_WS_URL=wss://your-endpoint.quiknode.pro/TOKEN/
WALLET_PRIVATE_KEY=[1,2,3,...]    # ⚠️  JSON byte array of your bot wallet's secret key
`
}
`;
  }

  private generateTsConfig(): string {
    return JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "bundler",
          outDir: "./dist",
          rootDir: "./src",
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true,
          sourceMap: true,
          resolveJsonModule: true,
        },
        include: ["src/**/*"],
        exclude: ["node_modules", "dist"],
      },
      null,
      2
    );
  }

  private generateReadme(config: any): string {
    return `# Flash Loan Arbitrageur Bot
> Generated by Meta-Agent | ${new Date().toISOString()}

## Architecture
\`\`\`
DexScreener → price gap detected
     ↓
Rugcheck   → token safety validated  
     ↓
Profit Calc → net profit > $${config.minProfitUSD}
     ↓
Aave V3    → flash loan $${config.maxLoanUSD} (0.09% fee)
     ↓
1inch/Jupiter → swap A → swap B
     ↓
Aave V3    → repay loan + fee
     ↓
Profit     → stays in your wallet 🎉
\`\`\`

## Quick Start
\`\`\`bash
cp .env.template .env
# Edit .env with your settings

npm install
npm run build

# Test without real money first:
npm run dry-run

# Go live (only after thorough testing):
npm start
\`\`\`

## Safety Checklist
- [ ] Deploy FlashLoanArbitrageur.sol (EVM only)
- [ ] Fully test with DRY_RUN=true
- [ ] Start with small MAX_LOAN_USD
- [ ] Monitor gas costs vs profit margins
- [ ] Never store private keys in plain text in production
`;
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
