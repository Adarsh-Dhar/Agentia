/**
 * frontend/app/api/generate-bot/route.ts
 *
 * Receives a structured BotConfig from the configurator chat,
 * calls the Python Meta-Agent server to scaffold the bot code,
 * then saves it as an Agent + files in the database.
 *
 * POST /api/generate-bot
 * Body: { config: BotConfig }
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { encryptEnvConfig } from "@/lib/crypto-env";
import type { BotConfig } from "@/lib/types";

const META_AGENT_URL = process.env.META_AGENT_URL ?? "http://127.0.0.1:8000";

// ─── Build the prompt from BotConfig ─────────────────────────────────────────

function buildPrompt(cfg: BotConfig): string {
  const chainMap: Record<string, { chainId: number; rpc: string }> = {
    "base-sepolia": { chainId: 84532, rpc: "https://base-sepolia.g.alchemy.com/v2/YOUR_KEY" },
    "base-mainnet": { chainId: 8453,  rpc: "https://mainnet.base.org" },
    "arbitrum":     { chainId: 42161, rpc: "https://arb1.arbitrum.io/rpc" },
  };

  const tokenAddresses: Record<string, Record<string, string>> = {
    USDC: {
      "base-sepolia": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "base-mainnet": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "arbitrum":     "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    },
    USDT: {
      "base-sepolia": "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",
      "base-mainnet": "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",
      "arbitrum":     "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
    },
    WETH: {
      "base-sepolia": "0x4200000000000000000000000000000000000006",
      "base-mainnet": "0x4200000000000000000000000000000000000006",
      "arbitrum":     "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    },
    CBBTC: {
      "base-sepolia": "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
      "base-mainnet": "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
      "arbitrum":     "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
    },
    AERO: {
      "base-sepolia": "0x940181a94A35A4569E4529A3CDfB74e38FD98631",
      "base-mainnet": "0x940181a94A35A4569E4529A3CDfB74e38FD98631",
      "arbitrum":     "",
    },
  };

  const chainInfo  = chainMap[cfg.chain]  ?? chainMap["base-sepolia"];
  const baseAddr   = tokenAddresses[cfg.baseToken]?.[cfg.chain]   ?? "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const targetAddr = tokenAddresses[cfg.targetToken]?.[cfg.chain] ?? "0x4200000000000000000000000000000000000006";

  const securityInstructions =
    cfg.securityProvider === "none"
      ? "// Skip token risk checks entirely for maximum speed."
      : cfg.securityProvider === "webacy"
      ? `If profitable, verify BOTH tokens with Webacy get_token_risk (chain="${cfg.chain}"). Only proceed if both tokens pass: risk=="low" OR score<${cfg.maxRiskScore}.`
      : `If profitable, verify BOTH tokens with GoPlus Security. Only proceed if both tokens are safe.`;

  return `
Write an autonomous arbitrage bot named "${cfg.botName}" for ${cfg.chain} (Chain ID: ${chainInfo.chainId}).

CONFIGURATION:
- Base Token (flash loan asset): ${cfg.baseToken} (${baseAddr})
- Target Token (arbitrage target): ${cfg.targetToken} (${targetAddr})
- DEX / Aggregator: ${cfg.dex}
- Flash Loan Provider: Aave V3
- Borrow Amount: ${cfg.borrowAmountHuman} ${cfg.baseToken} (convert to base units at startup)
- Minimum Net Profit to Execute: ${cfg.minProfitUsd} ${cfg.baseToken} (in human units; convert appropriately)
- Gas Buffer: ${cfg.gasBufferUsdc} ${cfg.baseToken} (in human units; convert appropriately)
- Loop Interval: Every ${cfg.pollingIntervalSec} seconds
- Simulation Mode default: ${cfg.simulationMode ? "true (no real transactions)" : "false (live execution)"}

STRATEGY:
Run a continuous async loop every ${cfg.pollingIntervalSec} seconds.
Use ${cfg.dex} get_quote to check the ${cfg.baseToken}->${cfg.targetToken}->${cfg.baseToken} round-trip price.
Calculate net profit after the 0.09% Aave flash loan fee and the gas buffer.
All math must use integers (base units) only — no floats, no Decimal, no round().
${securityInstructions}
Get swap calldata from ${cfg.dex} get_swap_data using tokenIn/tokenOut keys.
Execute via goat_evm write_contract using the "address" key (not contractAddress).
Use structured logging. Call convert_to_base_units at startup for ALL token amounts.
Include SIMULATION_MODE toggle (read from env var).
`.trim();
}

// ─── Route Handler ────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const config = body.config as BotConfig;

    if (!config || !config.chain || !config.baseToken || !config.targetToken) {
      return NextResponse.json({ error: "Invalid bot configuration." }, { status: 400 });
    }

    // Build the natural-language prompt from the structured config
    const prompt = buildPrompt(config);

    // Call the Python Meta-Agent
    let metaResponse: Response;
    try {
      metaResponse = await fetch(`${META_AGENT_URL}/create-bot`, {
        method:  "POST",
        headers: { "Content-Type": "application/json", accept: "application/json" },
        body:    JSON.stringify({ prompt }),
        signal:  AbortSignal.timeout(180_000), // 3 min
      });
    } catch {
      // Fallback: generate a WebContainer-compatible TypeScript bot instead
      return generateWebContainerFallback(config);
    }

    if (!metaResponse.ok) {
      const text = await metaResponse.text().catch(() => "");
      return NextResponse.json(
        { error: `Meta-agent returned ${metaResponse.status}: ${text.slice(0, 200)}` },
        { status: 502 }
      );
    }

    const metaData = await metaResponse.json();
    const output   = metaData.output ?? {};
    const files: { filepath: string; content: string }[] = output.files ?? [];

    if (files.length === 0) {
      return NextResponse.json({ error: "Meta-agent returned no files." }, { status: 500 });
    }

    // Persist to database
    const userId = "public-user";
    await prisma.user.upsert({
      where:  { id: userId },
      update: {},
      create: { id: userId, email: `${userId}@placeholder.agentia`, walletAddress: "" },
    });

    const botName      = config.botName || "ArbitrageBot";
    const configRecord = {
      chain:              config.chain,
      baseToken:          config.baseToken,
      targetToken:        config.targetToken,
      dex:                config.dex,
      securityProvider:   config.securityProvider,
      borrowAmountHuman:  config.borrowAmountHuman,
      minProfitUsd:       config.minProfitUsd,
      gasBufferUsdc:      config.gasBufferUsdc,
      pollingIntervalSec: config.pollingIntervalSec,
      simulationMode:     config.simulationMode,
      generatedAt:        new Date().toISOString(),
    };

    const agent = await prisma.agent.create({
      data: {
        name:          botName,
        userId,
        status:        "STOPPED",
        configuration: configRecord,
        files: {
          create: files.map(f => ({
            filepath: f.filepath,
            content:  f.content,
            language: f.filepath.endsWith(".py") ? "python" : "plaintext",
          })),
        },
      },
      include: { files: true },
    });

    return NextResponse.json({
      agentId:  agent.id,
      botName,
      files,
      thoughts: output.thoughts ?? "",
      config:   configRecord,
    });

  } catch (err) {
    console.error("[POST /api/generate-bot]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error." },
      { status: 500 }
    );
  }
}

// ─── Fallback: WebContainer TypeScript Bot ────────────────────────────────────
// Used when the Python Meta-Agent isn't running (e.g. local dev without the agent server).
// Generates a fully functional TS bot that mirrors the Python architecture.

async function generateWebContainerFallback(config: BotConfig): Promise<NextResponse> {
  const chainIds: Record<string, number> = {
    "base-sepolia": 84532,
    "base-mainnet": 8453,
    "arbitrum":     42161,
  };
  const tokenAddr: Record<string, Record<string, string>> = {
    USDC:  {
      "base-sepolia": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "base-mainnet": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "arbitrum":     "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    },
    USDT:  {
      "base-sepolia": "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",
      "base-mainnet": "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",
      "arbitrum":     "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
    },
    WETH:  {
      "base-sepolia": "0x4200000000000000000000000000000000000006",
      "base-mainnet": "0x4200000000000000000000000000000000000006",
      "arbitrum":     "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    },
    CBBTC: {
      "base-sepolia": "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
      "base-mainnet": "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
      "arbitrum":     "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
    },
    AERO:  {
      "base-sepolia": "0x940181a94A35A4569E4529A3CDfB74e38FD98631",
      "base-mainnet": "0x940181a94A35A4569E4529A3CDfB74e38FD98631",
      "arbitrum":     "",
    },
  };

  const chainId  = chainIds[config.chain]  ?? 84532;
  const baseAddr = tokenAddr[config.baseToken]?.[config.chain]   ?? "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const tgtAddr  = tokenAddr[config.targetToken]?.[config.chain] ?? "0x4200000000000000000000000000000000000006";
  const baseDec  = config.baseToken === "WETH" ? 18 : 6;
  const tgtDec   = config.targetToken === "WETH" || config.targetToken === "AERO" ? 18
                 : config.targetToken === "CBBTC" ? 8
                 : 6;

  // ─── src/config.ts ──────────────────────────────────────────────────────────
  const configTs = `import "dotenv/config";
import { ethers } from "ethers";

// ── ${config.botName} — Generated Configuration ─────────────────────────────
// Chain: ${config.chain} (${chainId})
// Pair: ${config.baseToken} ↔ ${config.targetToken}
// DEX: ${config.dex} | Security: ${config.securityProvider}

export const BASE_TOKEN_ADDRESS   = "${baseAddr}";
export const TARGET_TOKEN_ADDRESS = "${tgtAddr}";
export const ARB_BOT_ADDRESS      = process.env.ARB_BOT_ADDRESS ?? "0x6b7b81e04D024259b87a6C0F5ab5Eb04d9539102";
export const ONE_INCH_ROUTER      = "0x111111125421cA6dc452d289314280a0f8842A65";
export const CHAIN_ID             = ${chainId};
export const BASE_DECIMALS        = ${baseDec};
export const TARGET_DECIMALS      = ${tgtDec};

// ── Financial constants (all BigInt) ─────────────────────────────────────────
export const AAVE_FEE_BPS         = 9n;
export const BORROW_AMOUNT_HUMAN  = process.env.BORROW_AMOUNT_HUMAN ?? "${config.borrowAmountHuman}";
export const MIN_PROFIT_HUMAN     = ${config.minProfitUsd};
export const GAS_BUFFER_BASE      = ${config.gasBufferUsdc}_000_000n;
export const POLL_INTERVAL_MS     = ${config.pollingIntervalSec * 1000};

// ── Runtime ──────────────────────────────────────────────────────────────────
export const SIMULATION_MODE      = (process.env.SIMULATION_MODE ?? "${config.simulationMode}") !== "false";
export const WEBACY_API_KEY       = process.env.WEBACY_API_KEY ?? "";
export const ONEINCH_API_KEY      = process.env.ONEINCH_API_KEY ?? "";
export const WALLET_PRIVATE_KEY   = process.env.WALLET_PRIVATE_KEY ?? "";
export const RPC_PROVIDER_URL     = process.env.RPC_PROVIDER_URL ?? "";

export function parseBaseUnits(human: string, decimals: number): bigint {
  return BigInt(Math.round(parseFloat(human) * 10 ** decimals));
}
export function createProvider() {
  if (!RPC_PROVIDER_URL) throw new Error("RPC_PROVIDER_URL is not set");
  return new ethers.JsonRpcProvider(RPC_PROVIDER_URL);
}
export function createSigner(provider: ethers.JsonRpcProvider) {
  if (!WALLET_PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY is not set");
  const key = WALLET_PRIVATE_KEY.startsWith("0x") ? WALLET_PRIVATE_KEY : \`0x\${WALLET_PRIVATE_KEY}\`;
  return new ethers.Wallet(key, provider);
}

export const FLASHLOAN_ABI = [
  { inputs:[{internalType:"address",name:"_addressProvider",type:"address"}], stateMutability:"nonpayable", type:"constructor" },
  { inputs:[{internalType:"address",name:"asset",type:"address"},{internalType:"uint256",name:"amount",type:"uint256"},{internalType:"uint256",name:"premium",type:"uint256"},{internalType:"address",name:"initiator",type:"address"},{internalType:"bytes",name:"params",type:"bytes"}], name:"executeOperation", outputs:[{internalType:"bool",name:"",type:"bool"}], stateMutability:"nonpayable", type:"function" },
  { inputs:[{internalType:"address",name:"tokenToBorrow",type:"address"},{internalType:"uint256",name:"amountToBorrow",type:"uint256"},{internalType:"address",name:"routerTarget",type:"address"},{internalType:"bytes",name:"swapData",type:"bytes"}], name:"requestArbitrage", outputs:[], stateMutability:"nonpayable", type:"function" },
  { inputs:[{internalType:"address",name:"token",type:"address"}], name:"withdrawProfit", outputs:[], stateMutability:"nonpayable", type:"function" },
] as const;
`;

  // ─── src/index.ts ────────────────────────────────────────────────────────────
  const securityNote = config.securityProvider === "none"
    ? `// Security checks disabled by user configuration`
    : `// ${config.securityProvider === "webacy" ? "Webacy" : "GoPlus"} token risk check`;

  const indexTs = `/**
 * src/index.ts — ${config.botName}
 * Chain: ${config.chain} (chainId read from config) | Pair: ${config.baseToken}→${config.targetToken}→${config.baseToken}
 * DEX: ${config.dex} | Security: ${config.securityProvider}
 * Generated by Agentia Bot Configurator
 */
import "dotenv/config";
import {
  SIMULATION_MODE, BORROW_AMOUNT_HUMAN, POLL_INTERVAL_MS,
  WALLET_PRIVATE_KEY, RPC_PROVIDER_URL, WEBACY_API_KEY, ONEINCH_API_KEY,
  BASE_TOKEN_ADDRESS, TARGET_TOKEN_ADDRESS, ARB_BOT_ADDRESS, ONE_INCH_ROUTER,
  AAVE_FEE_BPS, GAS_BUFFER_BASE, MIN_PROFIT_HUMAN, BASE_DECIMALS, CHAIN_ID,
  FLASHLOAN_ABI, parseBaseUnits, createProvider, createSigner,
} from "./config.js";

// ── 1inch API — chain ID comes from config constant, never hardcoded ───────────
const API_BASE = \`https://api.1inch.dev/swap/v6.0/\${CHAIN_ID}\`;

const C = {
  reset: "\\x1b[0m", cyan: "\\x1b[36m", green: "\\x1b[32m",
  red: "\\x1b[31m", yellow: "\\x1b[33m", dim: "\\x1b[2m", bold: "\\x1b[1m",
};

function log(level: "INFO" | "WARN" | "ERROR" | "EXEC", msg: string) {
  const ts  = new Date().toISOString().replace("T", " ").slice(0, 19);
  const col = level === "INFO" ? C.cyan : level === "EXEC" ? C.green : level === "WARN" ? C.yellow : C.red;
  console.log(\`\${C.dim}\${ts}\${C.reset} [\${col}\${level}\${C.reset}] \${msg}\`);
}

async function oneInchFetch(path: string): Promise<unknown> {
  const res = await fetch(\`\${API_BASE}\${path}\`, {
    headers: { Authorization: \`Bearer \${ONEINCH_API_KEY}\`, Accept: "application/json" },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    let msg = body.slice(0, 200);
    try {
      const parsed = JSON.parse(body) as { description?: string; error?: string };
      msg = parsed.description ?? parsed.error ?? msg;
    } catch {}
    throw new Error(\`1inch \${res.status}: \${msg}\`);
  }
  return res.json();
}

async function getQuote(src: string, dst: string, amount: bigint): Promise<bigint> {
  const qs   = new URLSearchParams({ src, dst, amount: amount.toString() });
  const data = await oneInchFetch(\`/quote?\${qs}\`) as { dstAmount: string };
  if (!data.dstAmount) throw new Error("1inch quote: missing dstAmount in response");
  return BigInt(data.dstAmount);
}

async function getSwapData(src: string, dst: string, amount: bigint, from: string): Promise<string> {
  const qs = new URLSearchParams({
    src, dst, amount: amount.toString(), from,
    slippage: "1", disableEstimate: "true", allowPartialFill: "false",
  });
  const d = await oneInchFetch(\`/swap?\${qs}\`) as { tx: { data: string } };
  if (!d?.tx?.data) throw new Error("1inch swap: missing tx.data in response");
  return d.tx.data;
}

${config.securityProvider !== "none" ? `
${securityNote}
async function isTokenSafe(addr: string): Promise<boolean> {
  try {
    const res = await fetch(
      \`https://api.webacy.com/addresses/\${addr}?chain=${config.chain}\`,
      { headers: { "x-api-key": WEBACY_API_KEY, Accept: "application/json" } }
    );
    if (!res.ok) return false;
    const d = await res.json() as { risk?: string; score?: number };
    return (d.risk ?? "unknown").toLowerCase() === "low" || (d.score ?? 100) < ${config.maxRiskScore ?? 20};
  } catch { return false; }
}

async function verifyTokens(): Promise<boolean> {
  const [b, t] = await Promise.all([
    isTokenSafe(BASE_TOKEN_ADDRESS),
    isTokenSafe(TARGET_TOKEN_ADDRESS),
  ]);
  return b && t;
}` : `
${securityNote}
async function verifyTokens(): Promise<boolean> { return true; }`}

function validate(): void {
  const errs: string[] = [];
  if (!ONEINCH_API_KEY) errs.push("ONEINCH_API_KEY not set  →  https://portal.1inch.dev");
  ${config.securityProvider === "webacy" ? `if (!WEBACY_API_KEY)    errs.push("WEBACY_API_KEY not set   →  https://webacy.com");` : ""}
  if (!SIMULATION_MODE) {
    if (!RPC_PROVIDER_URL)   errs.push("RPC_PROVIDER_URL required for live mode");
    if (!WALLET_PRIVATE_KEY) errs.push("WALLET_PRIVATE_KEY required for live mode");
  }
  if (errs.length) { errs.forEach(e => log("ERROR", e)); process.exit(1); }
}

console.log(\`
\${C.bold}\${C.cyan}╔══════════════════════════════════════════════════════╗
║  ${config.botName.substring(0, 50).padEnd(50)}  ║
║  Chain: ${config.chain.padEnd(14)} | Pair: ${config.baseToken}→${config.targetToken}${" ".repeat(Math.max(0, 22 - config.baseToken.length - config.targetToken.length))}  ║
╚══════════════════════════════════════════════════════╝\${C.reset}
\`);

validate();

const BORROW_BASE = parseBaseUnits(BORROW_AMOUNT_HUMAN, BASE_DECIMALS);
const MIN_PROFIT  = parseBaseUnits(String(MIN_PROFIT_HUMAN), BASE_DECIMALS);
const provider    = !SIMULATION_MODE ? createProvider() : null;
const signer      = !SIMULATION_MODE && provider ? createSigner(provider) : null;

if (SIMULATION_MODE) log("WARN", "SIMULATION MODE — no real transactions will broadcast");
else                 log("WARN", \`LIVE MODE — real transactions on ${config.chain} (chainId \${CHAIN_ID})\`);

log("INFO", \`Borrow:     \${BORROW_BASE.toLocaleString()} base units (\${BORROW_AMOUNT_HUMAN} ${config.baseToken})\`);
log("INFO", \`Min profit: \${MIN_PROFIT.toLocaleString()} base units ($${config.minProfitUsd})\`);
log("INFO", \`Polling every \${POLL_INTERVAL_MS / 1000}s | 1inch chain ID: \${CHAIN_ID}\`);

let cycle = 0;

async function runCycle(): Promise<void> {
  cycle++;
  try {
    const targetAmt   = await getQuote(BASE_TOKEN_ADDRESS, TARGET_TOKEN_ADDRESS, BORROW_BASE);
    const grossReturn = await getQuote(TARGET_TOKEN_ADDRESS, BASE_TOKEN_ADDRESS, targetAmt);
    const fee         = (BORROW_BASE * AAVE_FEE_BPS) / 10_000n;
    const netProfit   = grossReturn - BORROW_BASE - fee - GAS_BUFFER_BASE;

    const netH   = (Number(netProfit)   / 10 ** BASE_DECIMALS).toFixed(6);
    const grossH = (Number(grossReturn) / 10 ** BASE_DECIMALS).toFixed(6);

    if (netProfit > MIN_PROFIT) {
      log("INFO", \`Cycle #\${cycle} ✓ Opportunity: gross \${grossH} ${config.baseToken}, net +\${netH} ${config.baseToken}\`);

      const tokensOk = await verifyTokens();
      if (!tokensOk) {
        log("WARN", \`Cycle #\${cycle} Token risk check failed, skipping\`);
        return;
      }
      log("INFO", \`Cycle #\${cycle} Token risk check passed\`);

      if (SIMULATION_MODE) {
        log("EXEC", \`[SIM] Cycle #\${cycle} Would flash loan. Net: +\${netH} ${config.baseToken}\`);
      } else {
        if (!signer) { log("ERROR", "No signer — cannot execute"); return; }
        log("EXEC", \`Cycle #\${cycle} Fetching swap calldata from 1inch...\`);
        const calldata = await getSwapData(
          BASE_TOKEN_ADDRESS, TARGET_TOKEN_ADDRESS, BORROW_BASE, ARB_BOT_ADDRESS
        );
        const { ethers } = await import("ethers");
        const contract = new ethers.Contract(ARB_BOT_ADDRESS, FLASHLOAN_ABI, signer);
        const tx = await contract.requestArbitrage(
          BASE_TOKEN_ADDRESS, BORROW_BASE, ONE_INCH_ROUTER, calldata
        );
        const rc = await tx.wait(1);
        if (!rc || rc.status !== 1) throw new Error(\`TX reverted: \${tx.hash}\`);
        log("EXEC", \`Cycle #\${cycle} ✓ TX confirmed: \${tx.hash}\`);
      }
    } else {
      log("INFO", \`Cycle #\${cycle} No opportunity. Net: \${netH} ${config.baseToken} (after fees+buffer)\`);
    }
  } catch (err: unknown) {
    log("ERROR", \`Cycle #\${cycle}: \${(err as Error).message}\`);
  }
}

runCycle();
const timer = setInterval(runCycle, POLL_INTERVAL_MS);
process.on("SIGINT",  () => { clearInterval(timer); process.exit(0); });
process.on("SIGTERM", () => { clearInterval(timer); process.exit(0); });
`;

  // ─── .env.example ────────────────────────────────────────────────────────────
  const envExample = `# ${config.botName} — Environment Variables
# Generated by Agentia Bot Configurator

# Required
ONEINCH_API_KEY=your_1inch_key_here         # https://portal.1inch.dev
${config.securityProvider === "webacy" ? "WEBACY_API_KEY=your_webacy_key_here         # https://webacy.com\n" : ""}
# Required for LIVE mode (not needed when SIMULATION_MODE=true)
RPC_PROVIDER_URL=${
  config.chain === "base-sepolia" ? "https://base-sepolia.g.alchemy.com/v2/YOUR_KEY"
  : config.chain === "base-mainnet" ? "https://base.g.alchemy.com/v2/YOUR_KEY"
  : "https://arb-mainnet.g.alchemy.com/v2/YOUR_KEY"
}
WALLET_PRIVATE_KEY=0000000000000000000000000000000000000000000000000000000000000001

# Safety
SIMULATION_MODE=${config.simulationMode}    # Set to false for live trading

# Tuning
BORROW_AMOUNT_HUMAN=${config.borrowAmountHuman}
POLL_INTERVAL=${config.pollingIntervalSec}
`;

  // ─── package.json ─────────────────────────────────────────────────────────────
  const packageJson = JSON.stringify({
    name:        config.botName.toLowerCase().replace(/\s+/g, "-"),
    version:     "1.0.0",
    type:        "module",
    description: `${config.baseToken}→${config.targetToken} flash loan arbitrage on ${config.chain}`,
    scripts:     { start: "tsx src/index.ts", dev: "tsx src/index.ts" },
    dependencies: { ethers: "^6.13.0", dotenv: "^16.4.0" },
    devDependencies: { typescript: "^5.4.0", "@types/node": "^20.0.0", tsx: "^4.7.0" },
  }, null, 2);

  const files = [
    { filepath: "package.json",    content: packageJson },
    { filepath: "src/config.ts",   content: configTs    },
    { filepath: "src/index.ts",    content: indexTs     },
    { filepath: ".env.example",    content: envExample  },
  ];

  // Save to DB
  try {
    const userId = "public-user";
    await prisma.user.upsert({
      where:  { id: userId },
      update: {},
      create: { id: userId, email: `${userId}@placeholder.agentia`, walletAddress: "" },
    });

    const agent = await prisma.agent.create({
      data: {
        name:   config.botName,
        userId,
        status: "STOPPED",
        configuration: {
          chain:             config.chain,
          baseToken:         config.baseToken,
          targetToken:       config.targetToken,
          dex:               config.dex,
          securityProvider:  config.securityProvider,
          borrowAmountHuman: config.borrowAmountHuman,
          minProfitUsd:      config.minProfitUsd,
          simulationMode:    config.simulationMode,
          generatedAt:       new Date().toISOString(),
          source:            "bot-configurator-fallback",
        },
        files: {
          create: files.map(f => ({
            filepath: f.filepath,
            content:  f.content,
            language: f.filepath.endsWith(".ts") ? "typescript"
                    : f.filepath.endsWith(".json") ? "json"
                    : "plaintext",
          })),
        },
      },
      include: { files: true },
    });

    return NextResponse.json({
      agentId:  agent.id,
      botName:  config.botName,
      files,
      thoughts: `${config.botName}: ${config.baseToken}→${config.targetToken} arbitrage on ${config.chain} via ${config.dex}. Flash loan from Aave V3. ${config.simulationMode ? "Simulation mode." : "Live mode."}`,
      config,
      source:   "fallback",
    });
  } catch {
    return NextResponse.json({
      agentId:  "offline-" + Date.now(),
      botName:  config.botName,
      files,
      thoughts: `${config.botName} generated offline (DB unavailable).`,
      config,
      source:   "offline-fallback",
    });
  }
}