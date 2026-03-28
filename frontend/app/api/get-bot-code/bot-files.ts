/**
 * frontend/app/api/get-bot-code/bot-files.ts
 *
 * Returns the complete Base Sepolia MCP arbitrage bot as an array of
 * { filepath, content } objects that the WebContainer can mount.
 *
 * The bot is a Node.js/TypeScript wrapper that:
 *  1. Reads env vars (supplied by the user in the IDE env modal)
 *  2. Spawns the three MCP servers as child processes via stdio
 *  3. Runs the continuous arbitrage loop, logging to stdout
 *
 * Why Node instead of Python?
 *   WebContainer only supports Node.js. We re-implement the Python
 *   arbitrage logic in TypeScript and wire it to the same MCP servers
 *   the Python version uses.
 */

export interface BotFile {
  filepath: string;
  content: string;
}

export function assembleBotFiles(): BotFile[] {
  return [
    { filepath: "package.json",         content: PACKAGE_JSON },
    { filepath: "tsconfig.json",        content: TSCONFIG },
    { filepath: ".env.example",         content: ENV_EXAMPLE },
    { filepath: "src/config.ts",        content: CONFIG_TS },
    { filepath: "src/mcp-client.ts",    content: MCP_CLIENT_TS },
    { filepath: "src/arbitrage.ts",     content: ARBITRAGE_TS },
    { filepath: "src/index.ts",         content: INDEX_TS },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────

const PACKAGE_JSON = JSON.stringify({
  name: "base-sepolia-arb-bot",
  version: "1.0.0",
  type: "module",
  description: "Base Sepolia MCP flash-loan arbitrage bot (USDC→WETH→USDC via 1inch + Aave)",
  scripts: {
    start: "npx tsx src/index.ts",
    dev:   "npx tsx src/index.ts",
  },
  dependencies: {
    dotenv:         "^16.4.0",
    "@modelcontextprotocol/sdk": "^1.0.0",
  },
  devDependencies: {
    typescript:    "^5.4.0",
    "@types/node": "^20.0.0",
    tsx:           "^4.7.0",
  },
}, null, 2);

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target:            "ES2022",
    module:            "ESNext",
    moduleResolution:  "bundler",
    strict:            true,
    esModuleInterop:   true,
    skipLibCheck:      true,
  },
  include: ["src/**/*"],
}, null, 2);

const ENV_EXAMPLE = `# ── Required ──────────────────────────────────────────────────────────────────
# Your EVM wallet private key (hex, 64 chars)
WALLET_PRIVATE_KEY=0000000000000000000000000000000000000000000000000000000000000001

# Base Sepolia RPC (e.g. from Alchemy or Infura)
RPC_PROVIDER_URL=https://base-sepolia.g.alchemy.com/v2/YOUR_KEY

# Webacy API key (get one at https://webacy.com)
WEBACY_API_KEY=your_webacy_api_key_here

# ── Safety ────────────────────────────────────────────────────────────────────
# Set to "true" to simulate without broadcasting transactions
SIMULATION_MODE=true

# ── Tuning ────────────────────────────────────────────────────────────────────
# USDC borrow amount (human-readable, e.g. "1" = 1 USDC)
BORROW_AMOUNT_HUMAN=1
# Polling interval in seconds
POLL_INTERVAL=5
`;

// ─────────────────────────────────────────────────────────────────────────────
// src/config.ts
// ─────────────────────────────────────────────────────────────────────────────
const CONFIG_TS = `import "dotenv/config";

export const WETH_ADDRESS    = "0x4200000000000000000000000000000000000006";
export const USDC_ADDRESS    = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const ARB_BOT_ADDRESS = "0x6b7b81e04D024259b87a6C0F5ab5Eb04d9539102";
export const ONE_INCH_ROUTER = "0x111111125421cA6dc452d289314280a0f8842A65";
export const CHAIN_ID        = 84532; // Base Sepolia

// Aave flash-loan fee: 0.09 %
export const AAVE_FEE_BPS    = 9n;
// Gas buffer: 2 USDC (in 6-decimal base units)
export const GAS_BUFFER_USDC = 2_000_000n;

export const SIMULATION_MODE = (process.env.SIMULATION_MODE ?? "true") !== "false";
export const BORROW_AMOUNT_HUMAN = process.env.BORROW_AMOUNT_HUMAN ?? "1";
export const POLL_INTERVAL_MS    = (parseInt(process.env.POLL_INTERVAL ?? "5", 10)) * 1000;

export const WALLET_PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY ?? "";
export const RPC_PROVIDER_URL   = process.env.RPC_PROVIDER_URL   ?? "";
export const WEBACY_API_KEY     = process.env.WEBACY_API_KEY      ?? "";

export function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(\`Missing required env var: \${name}\`);
  return v;
}

export const FLASHLOAN_ABI = [
  {
    inputs: [{ internalType: "address", name: "_addressProvider", type: "address" }],
    stateMutability: "nonpayable",
    type: "constructor",
  },
  {
    inputs: [
      { internalType: "address", name: "asset",     type: "address" },
      { internalType: "uint256", name: "amount",    type: "uint256" },
      { internalType: "uint256", name: "premium",   type: "uint256" },
      { internalType: "address", name: "initiator", type: "address" },
      { internalType: "bytes",   name: "params",    type: "bytes"   },
    ],
    name: "executeOperation",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "tokenToBorrow",  type: "address" },
      { internalType: "uint256", name: "amountToBorrow", type: "uint256" },
      { internalType: "address", name: "routerTarget",   type: "address" },
      { internalType: "bytes",   name: "swapData",       type: "bytes"   },
    ],
    name: "requestArbitrage",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "token", type: "address" }],
    name: "withdrawProfit",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
];
`;

// ─────────────────────────────────────────────────────────────────────────────
// src/mcp-client.ts  — lightweight stdio MCP client (no heavy SDK needed in WC)
// ─────────────────────────────────────────────────────────────────────────────
const MCP_CLIENT_TS = `/**
 * Minimal stdio MCP client for the WebContainer environment.
 *
 * Spawns each MCP server as a child process, sends JSON-RPC messages
 * over stdin, and reads responses from stdout.  Only the tools needed
 * by the arbitrage loop are exercised.
 */
import { spawn, ChildProcess } from "child_process";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id:      number;
  method:  string;
  params:  unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id:      number;
  result?: unknown;
  error?:  { code: number; message: string };
}

export class McpServer {
  private proc: ChildProcess;
  private buf  = "";
  private id   = 1;
  private pending = new Map<number, (r: JsonRpcResponse) => void>();

  constructor(command: string, args: string[], env: Record<string, string> = {}) {
    this.proc = spawn(command, args, {
      env:   { ...process.env, ...env },
      stdio: ["pipe", "pipe", "inherit"],
    });

    this.proc.stdout!.on("data", (chunk: Buffer) => {
      this.buf += chunk.toString();
      const lines = this.buf.split("\\n");
      this.buf = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg: JsonRpcResponse = JSON.parse(trimmed);
          const cb = this.pending.get(msg.id);
          if (cb) { this.pending.delete(msg.id); cb(msg); }
        } catch { /* ignore non-JSON */ }
      }
    });

    this.proc.on("error", (err) => {
      console.error(\`[MCP] server error: \${err.message}\`);
    });
  }

  async initialize(): Promise<void> {
    await this.rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "arb-bot", version: "1.0.0" },
    });
  }

  async callTool(tool: string, args: Record<string, unknown>): Promise<unknown> {
    const res = await this.rpc("tools/call", { name: tool, arguments: args });
    const content = (res as { content?: { type: string; text: string }[] })?.content;
    if (!content?.length) throw new Error(\`Tool '\${tool}' returned empty content\`);
    const text = content[0].text;
    try { return JSON.parse(text); } catch { return text; }
  }

  private rpc(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.id++;
      const msg: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
      this.pending.set(id, (r) => {
        if (r.error) reject(new Error(r.error.message));
        else resolve(r.result);
      });
      this.proc.stdin!.write(JSON.stringify(msg) + "\\n");
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(\`Timeout waiting for MCP response to '\${method}'\`));
        }
      }, 30_000);
    });
  }

  kill(): void { this.proc.kill(); }
}

// ─── Convenience wrapper ──────────────────────────────────────────────────────

export class BotMcpClients {
  oneInch!: McpServer;
  webacy!:  McpServer;
  goatEvm!: McpServer;

  async connect(opts: {
    webacyKey:      string;
    walletKey:      string;
    rpcUrl:         string;
  }): Promise<void> {
    console.log("[MCP] Connecting to 1inch...");
    this.oneInch = new McpServer("npx", [
      "-y", "supergateway",
      "--streamableHttp", "https://api.1inch.com/mcp/protocol",
      "--outputTransport", "stdio",
    ]);
    await this.oneInch.initialize();
    console.log("[MCP] ✓ 1inch connected");

    console.log("[MCP] Connecting to Webacy...");
    this.webacy = new McpServer("npx", [
      "-y", "supergateway",
      "--streamableHttp", "https://api.webacy.com/mcp",
      "--header", \`x-api-key: \${opts.webacyKey}\`,
      "--outputTransport", "stdio",
    ]);
    await this.webacy.initialize();
    console.log("[MCP] ✓ Webacy connected");

    // GOAT-EVM is optional in the WebContainer — if GOAT_EVM_PATH is not set
    // we run in simulation-only mode automatically.
    const goatPath = process.env.GOAT_EVM_PATH;
    if (goatPath) {
      console.log("[MCP] Connecting to GOAT EVM...");
      this.goatEvm = new McpServer("npx", ["tsx", goatPath], {
        WALLET_PRIVATE_KEY: opts.walletKey,
        RPC_PROVIDER_URL:   opts.rpcUrl,
      });
      await this.goatEvm.initialize();
      console.log("[MCP] ✓ GOAT EVM connected");
    } else {
      console.log("[MCP] GOAT_EVM_PATH not set — execution disabled (simulation only)");
    }
  }

  shutdown(): void {
    this.oneInch?.kill();
    this.webacy?.kill();
    this.goatEvm?.kill();
  }
}
`;

// ─────────────────────────────────────────────────────────────────────────────
// src/arbitrage.ts
// ─────────────────────────────────────────────────────────────────────────────
const ARBITRAGE_TS = `import {
  WETH_ADDRESS, USDC_ADDRESS, ARB_BOT_ADDRESS,
  ONE_INCH_ROUTER, CHAIN_ID,
  AAVE_FEE_BPS, GAS_BUFFER_USDC,
  FLASHLOAN_ABI,
} from "./config.js";
import type { BotMcpClients } from "./mcp-client.js";

// ─── Unit conversion ──────────────────────────────────────────────────────────

export async function convertToBaseUnits(
  mcp:           BotMcpClients,
  tokenAddress:  string,
  humanAmount:   string,
): Promise<bigint> {
  const res = await mcp.goatEvm.callTool("convert_to_base_units", {
    tokenAddress,
    amount: humanAmount,
  }) as { baseUnits: string };
  return BigInt(res.baseUnits);
}

// ─── Price quotes (read-only) ─────────────────────────────────────────────────

export async function getUsdcToWethQuote(
  mcp:            BotMcpClients,
  amountUsdcBase: bigint,
): Promise<bigint> {
  const res = await mcp.oneInch.callTool("get_quote", {
    tokenIn:  USDC_ADDRESS,
    tokenOut: WETH_ADDRESS,
    amount:   amountUsdcBase.toString(),
    chain:    CHAIN_ID,
  }) as { toTokenAmount: string };
  return BigInt(res.toTokenAmount);
}

export async function getWethToUsdcQuote(
  mcp:            BotMcpClients,
  amountWethBase: bigint,
): Promise<bigint> {
  const res = await mcp.oneInch.callTool("get_quote", {
    tokenIn:  WETH_ADDRESS,
    tokenOut: USDC_ADDRESS,
    amount:   amountWethBase.toString(),
    chain:    CHAIN_ID,
  }) as { toTokenAmount: string };
  return BigInt(res.toTokenAmount);
}

// ─── Profitability check ──────────────────────────────────────────────────────

export interface ProfitResult {
  profitable:    boolean;
  netProfit:     bigint;   // base units (6-decimal USDC)
  wethAmount:    bigint;
  grossReturn:   bigint;
  fee:           bigint;
}

export async function calculateProfit(
  mcp:            BotMcpClients,
  borrowUsdcBase: bigint,
): Promise<ProfitResult> {
  const wethAmount  = await getUsdcToWethQuote(mcp, borrowUsdcBase);
  const grossReturn = await getWethToUsdcQuote(mcp, wethAmount);
  const fee         = (borrowUsdcBase * AAVE_FEE_BPS) / 10_000n;
  const netProfit   = grossReturn - borrowUsdcBase - fee - GAS_BUFFER_USDC;
  return {
    profitable: netProfit > 0n,
    netProfit,
    wethAmount,
    grossReturn,
    fee,
  };
}

// ─── Risk check ───────────────────────────────────────────────────────────────

export async function verifyTokens(mcp: BotMcpClients): Promise<boolean> {
  const [usdcRisk, wethRisk] = await Promise.all([
    mcp.webacy.callTool("get_token_risk", {
      address: USDC_ADDRESS,
      chain:   "base-sepolia",
    }) as Promise<{ risk: string; score: number }>,
    mcp.webacy.callTool("get_token_risk", {
      address: WETH_ADDRESS,
      chain:   "base-sepolia",
    }) as Promise<{ risk: string; score: number }>,
  ]);
  const usdcOk = usdcRisk.risk === "low" || usdcRisk.score < 20;
  const wethOk = wethRisk.risk === "low" || wethRisk.score < 20;
  return usdcOk && wethOk;
}

// ─── Execution ────────────────────────────────────────────────────────────────

export async function getSwapCalldata(
  mcp:            BotMcpClients,
  borrowUsdcBase: bigint,
): Promise<string> {
  const res = await mcp.oneInch.callTool("get_swap_data", {
    tokenIn:  USDC_ADDRESS,
    tokenOut: WETH_ADDRESS,
    amount:   borrowUsdcBase.toString(),
    chain:    CHAIN_ID,
    from:     ARB_BOT_ADDRESS,
    slippage: 1,
  }) as { tx: { data: string } };
  return res.tx.data;
}

export async function executeArbitrage(
  mcp:            BotMcpClients,
  calldata:       string,
  borrowUsdcBase: bigint,
): Promise<string> {
  const res = await mcp.goatEvm.callTool("write_contract", {
    address:      ARB_BOT_ADDRESS,
    abi:          FLASHLOAN_ABI,
    functionName: "requestArbitrage",
    args: [USDC_ADDRESS, borrowUsdcBase.toString(), ONE_INCH_ROUTER, calldata],
  }) as { transactionHash: string };
  return res.transactionHash;
}
`;

// ─────────────────────────────────────────────────────────────────────────────
// src/index.ts  — main entry point
// ─────────────────────────────────────────────────────────────────────────────
const INDEX_TS = `import "dotenv/config";
import {
  SIMULATION_MODE,
  BORROW_AMOUNT_HUMAN,
  POLL_INTERVAL_MS,
  WALLET_PRIVATE_KEY,
  RPC_PROVIDER_URL,
  WEBACY_API_KEY,
  USDC_ADDRESS,
} from "./config.js";
import { BotMcpClients } from "./mcp-client.js";
import {
  convertToBaseUnits,
  calculateProfit,
  verifyTokens,
  getSwapCalldata,
  executeArbitrage,
} from "./arbitrage.js";

// ─── Logging helpers ──────────────────────────────────────────────────────────

const C = {
  reset:  "\\x1b[0m",
  cyan:   "\\x1b[36m",
  green:  "\\x1b[32m",
  red:    "\\x1b[31m",
  yellow: "\\x1b[33m",
  dim:    "\\x1b[2m",
  bold:   "\\x1b[1m",
};

function log(level: "INFO" | "WARN" | "ERROR" | "EXEC", msg: string): void {
  const ts  = new Date().toISOString().replace("T", " ").slice(0, 19);
  const col = level === "INFO"  ? C.cyan
            : level === "EXEC"  ? C.green
            : level === "WARN"  ? C.yellow
            : C.red;
  console.log(\`\${C.dim}\${ts}\${C.reset} [\${col}\${level}\${C.reset}] \${msg}\`);
}

// ─── Banner ───────────────────────────────────────────────────────────────────

console.log(\`
\${C.bold}\${C.cyan}╔══════════════════════════════════════════════════╗
║   Base Sepolia MCP Flash-Loan Arbitrage Bot      ║
║   USDC ─→ WETH ─→ USDC  via 1inch + Aave        ║
╚══════════════════════════════════════════════════╝\${C.reset}
\`);

if (SIMULATION_MODE) {
  log("WARN", "\${C.yellow}SIMULATION MODE — no transactions will be broadcast\${C.reset}");
} else {
  log("WARN", "\${C.red}LIVE MODE — real transactions will be broadcast\${C.reset}");
}

// ─── Pre-flight validation ────────────────────────────────────────────────────

if (!WEBACY_API_KEY) {
  log("ERROR", "WEBACY_API_KEY is not set");
  process.exit(1);
}
if (!SIMULATION_MODE && (!WALLET_PRIVATE_KEY || !RPC_PROVIDER_URL)) {
  log("ERROR", "WALLET_PRIVATE_KEY and RPC_PROVIDER_URL are required for live mode");
  process.exit(1);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const mcp = new BotMcpClients();

async function main(): Promise<void> {
  // Connect MCP servers
  await mcp.connect({
    webacyKey: WEBACY_API_KEY,
    walletKey: WALLET_PRIVATE_KEY,
    rpcUrl:    RPC_PROVIDER_URL,
  });

  // Convert borrow amount once at startup
  let borrowBase: bigint;
  if (mcp.goatEvm) {
    borrowBase = await convertToBaseUnits(mcp, USDC_ADDRESS, BORROW_AMOUNT_HUMAN);
  } else {
    // Fallback: manual conversion (USDC = 6 decimals)
    borrowBase = BigInt(Math.round(parseFloat(BORROW_AMOUNT_HUMAN) * 1_000_000));
  }
  log("INFO", \`Borrow amount: \${borrowBase} base units (\${BORROW_AMOUNT_HUMAN} USDC)\`);

  let cycle = 0;

  const runCycle = async (): Promise<void> => {
    cycle++;
    try {
      const result = await calculateProfit(mcp, borrowBase);

      const netUsd = (Number(result.netProfit) / 1_000_000).toFixed(6);

      if (result.profitable) {
        log("INFO", \`Cycle #\${cycle} — Opportunity found! Net profit: +\${netUsd} USDC\`);

        const riskOk = await verifyTokens(mcp);
        if (!riskOk) {
          log("WARN", "Cycle #\${cycle} — Token risk check failed, skipping");
          return;
        }

        if (SIMULATION_MODE) {
          log("EXEC", \`[SIM] Cycle #\${cycle} — Would execute. Profit: +\${netUsd} USDC\`);
        } else {
          if (!mcp.goatEvm) {
            log("WARN", "GOAT EVM not available — cannot execute (set GOAT_EVM_PATH)");
            return;
          }
          log("EXEC", \`Cycle #\${cycle} — Executing flash loan...\`);
          const calldata = await getSwapCalldata(mcp, borrowBase);
          const txHash   = await executeArbitrage(mcp, calldata, borrowBase);
          log("EXEC", \`Cycle #\${cycle} — TX confirmed: \${txHash}\`);
        }
      } else {
        log("INFO", \`Cycle #\${cycle} — No opportunity. Net: \${netUsd} USDC (after fees)\`);
      }
    } catch (err) {
      log("ERROR", \`Cycle #\${cycle} — \${(err as Error).message}\`);
    }
  };

  // Run first cycle immediately
  await runCycle();

  // Then poll at POLL_INTERVAL
  const interval = setInterval(runCycle, POLL_INTERVAL_MS);

  process.on("SIGINT", () => {
    log("INFO", "Stopping bot...");
    clearInterval(interval);
    mcp.shutdown();
    process.exit(0);
  });
}

main().catch((err) => {
  log("ERROR", err.message ?? String(err));
  mcp.shutdown();
  process.exit(1);
});
`;