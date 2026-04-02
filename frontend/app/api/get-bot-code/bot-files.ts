/**
 * frontend/app/api/get-bot-code/bot-files.ts
 *
 * Base Sepolia flash-loan arbitrage bot — WebContainer edition.
 *
 * Architecture: MCP-first + REST fallback + ethers.js.
 *   • 1inch MCP (preferred) / Swap API v6 fallback → quotes + swap calldata
 *   • Webacy REST API    → token risk checks
 *   • ethers.js v6       → on-chain flash loan execution
 *
 *   package.json / tsconfig.json / .env.example
 *   src/config.ts   — constants + env validation + ABI
 *   src/mcp.ts      — MCP gateway helper
 *   src/oneinch.ts  — 1inch MCP-first wrapper with REST fallback
 *   src/webacy.ts   — Webacy REST API wrapper
 *   src/execute.ts  — ethers.js flash loan executor
 *   src/index.ts    — main polling loop
 */

export interface BotFile {
  filepath: string;
  content:  string;
}

export function assembleBotFiles(): BotFile[] {
  return [
    { filepath: "package.json",      content: PACKAGE_JSON },
    { filepath: "tsconfig.json",     content: TSCONFIG      },
    { filepath: ".env.example",      content: ENV_EXAMPLE   },
    { filepath: "src/config.ts",     content: CONFIG_TS     },
    { filepath: "src/mcp.ts",        content: MCP_TS        },
    { filepath: "src/oneinch.ts",    content: ONEINCH_TS    },
    { filepath: "src/webacy.ts",     content: WEBACY_TS     },
    { filepath: "src/execute.ts",    content: EXECUTE_TS    },
    { filepath: "src/index.ts",      content: INDEX_TS      },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// package.json
// ─────────────────────────────────────────────────────────────────────────────
const PACKAGE_JSON = JSON.stringify({
  name: "base-sepolia-arb-bot",
  version: "1.0.0",
  type: "module",
  description: "Base Sepolia flash-loan arbitrage: USDC→WETH→USDC via 1inch + Aave",
  scripts: {
    start: "tsx src/index.ts",
    dev:   "tsx src/index.ts",
  },
  dependencies: {
    ethers: "^6.13.0",
    dotenv: "^16.4.0",
  },
  devDependencies: {
    typescript:    "^5.4.0",
    "@types/node": "^20.0.0",
    tsx:           "^4.7.0",
  },
}, null, 2);

// ─────────────────────────────────────────────────────────────────────────────
// tsconfig.json
// ─────────────────────────────────────────────────────────────────────────────
const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target:           "ES2022",
    module:           "ESNext",
    moduleResolution: "bundler",
    strict:           true,
    esModuleInterop:  true,
    skipLibCheck:     true,
  },
  include: ["src/**/*"],
}, null, 2);

// ─────────────────────────────────────────────────────────────────────────────
// .env.example
// ─────────────────────────────────────────────────────────────────────────────
const ENV_EXAMPLE = `# ── Required API keys ─────────────────────────────────────────────────────────
# 1inch Developer Portal: https://portal.1inch.dev
ONEINCH_API_KEY=your_1inch_api_key_here

# Webacy: https://webacy.com
WEBACY_API_KEY=your_webacy_api_key_here

# ── Required for LIVE mode (not needed for SIMULATION_MODE=false) ──────────────
# Base Sepolia RPC — get from Alchemy, Infura, QuickNode, etc.
RPC_PROVIDER_URL=https://base-sepolia.g.alchemy.com/v2/YOUR_KEY

# 64-char hex private key (without 0x prefix) — NEVER share this
WALLET_PRIVATE_KEY=0000000000000000000000000000000000000000000000000000000000000001

# ── Safety ────────────────────────────────────────────────────────────────────
# Set to "true" to disable real transactions during testing
SIMULATION_MODE=false

# MCP gateway used for one_inch tool calls (preferred path)
MCP_GATEWAY_URL=http://localhost:8000/mcp

# Optional 1inch request chain override (default: 8453 in live Base Sepolia, else CHAIN_ID)
# ONEINCH_CHAIN_ID=8453

# Optional estimate flag for /swap (default false)
# ONEINCH_DISABLE_ESTIMATE=false

# ── Tuning ────────────────────────────────────────────────────────────────────
BORROW_AMOUNT_HUMAN=1
POLL_INTERVAL=5
`;

// ─────────────────────────────────────────────────────────────────────────────
// src/config.ts
// ─────────────────────────────────────────────────────────────────────────────
const CONFIG_TS = `import "dotenv/config";
import { ethers } from "ethers";

// ── Addresses (Base Sepolia, all verified) ────────────────────────────────────
export const WETH_ADDRESS    = "0x4200000000000000000000000000000000000006";
export const USDC_ADDRESS    = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const ARB_BOT_ADDRESS = "0x6b7b81e04D024259b87a6C0F5ab5Eb04d9539102";
export const ONE_INCH_ROUTER = "0x111111125421cA6dc452d289314280a0f8842A65";

// IMPORTANT: 84532 is Base Sepolia. Base Mainnet is 8453.
export const CHAIN_ID        = 84532;

/**
 * 1inch public v6 endpoint supports Base mainnet (8453), not Base Sepolia (84532).
 * In live mode on Base Sepolia, route quote/swap requests to 8453 by default.
 */
const ONEINCH_CHAIN_OVERRIDE = process.env.ONEINCH_CHAIN_ID?.trim();
const parsedOneInchChain = ONEINCH_CHAIN_OVERRIDE ? parseInt(ONEINCH_CHAIN_OVERRIDE, 10) : NaN;
export const ONEINCH_REQUEST_CHAIN_ID = Number.isFinite(parsedOneInchChain)
  ? parsedOneInchChain
  : (!((process.env.SIMULATION_MODE ?? "false") === "true") && CHAIN_ID === 84532 ? 8453 : CHAIN_ID);

// ── Fee constants — all BigInt, no floats ─────────────────────────────────────
export const AAVE_FEE_BPS    = 9n;         // 0.09 %
export const GAS_BUFFER_USDC = 2_000_000n; // 2 USDC safety buffer (6-decimal units)

// ── Runtime config ────────────────────────────────────────────────────────────
export const SIMULATION_MODE       = (process.env.SIMULATION_MODE ?? "false") === "true";
export const BORROW_AMOUNT_HUMAN   = String(process.env.BORROW_AMOUNT_HUMAN ?? "1").trim() || "1";
export const POLL_INTERVAL_MS      = Math.max(1000, (parseInt(process.env.POLL_INTERVAL ?? "5", 10) || 5) * 1000);

// ── Credentials ───────────────────────────────────────────────────────────────
export const WALLET_PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY ?? "";
export const RPC_PROVIDER_URL   = process.env.RPC_PROVIDER_URL   ?? "";
export const WEBACY_API_KEY     = process.env.WEBACY_API_KEY      ?? "";
export const ONEINCH_API_KEY    = process.env.ONEINCH_API_KEY     ?? "";
export const MCP_GATEWAY_URL    = process.env.MCP_GATEWAY_URL     ?? "http://localhost:8000/mcp";

export const ONEINCH_DISABLE_ESTIMATE =
  (process.env.ONEINCH_DISABLE_ESTIMATE ?? "false").trim().toLowerCase() === "true";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Convert human-readable USDC string to 6-decimal BigInt base units. */
export function parseUsdc(human: unknown): bigint {
  const str = String(human ?? "0").trim();
  const num = parseFloat(str);
  if (isNaN(num) || num < 0) return 1_000_000n;
  return BigInt(Math.round(num * 1_000_000));
}

export function createProvider(): ethers.JsonRpcProvider {
  if (!RPC_PROVIDER_URL) throw new Error("RPC_PROVIDER_URL is not set");
  return new ethers.JsonRpcProvider(RPC_PROVIDER_URL);
}

export function createSigner(provider: ethers.JsonRpcProvider): ethers.Wallet {
  if (!WALLET_PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY is not set");
  const key = WALLET_PRIVATE_KEY.startsWith("0x")
    ? WALLET_PRIVATE_KEY
    : \`0x\${WALLET_PRIVATE_KEY}\`;
  return new ethers.Wallet(key, provider);
}

// ── Flash loan contract ABI ───────────────────────────────────────────────────
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
] as const;
`;

// ─────────────────────────────────────────────────────────────────────────────
// src/mcp.ts — tiny MCP gateway client for WebContainer bots
// ─────────────────────────────────────────────────────────────────────────────
const MCP_TS = `import { MCP_GATEWAY_URL } from "./config.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeGatewayBase(raw: string): string {
  const trimmed = raw.trim() || "http://localhost:8000/mcp";
  return trimmed.replace(/\\/+$/, "");
}

export async function callMcpTool(
  server: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const base = normalizeGatewayBase(MCP_GATEWAY_URL);
  const url = \`\${base}/\${server}/\${tool}\`;
  const attempts = 2;
  let lastError = "unknown error";

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "ngrok-skip-browser-warning": "true",
          "Bypass-Tunnel-Reminder": "true",
        },
        body: JSON.stringify(args),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        lastError = \`MCP \${server}/\${tool} HTTP \${res.status}: \${text.slice(0, 200)}\`;
      } else {
        return await res.json();
      }
    } catch (err) {
      clearTimeout(timeout);
      lastError = err instanceof Error ? err.message : String(err);
    }

    if (attempt < attempts) {
      await sleep(300 * attempt);
    }
  }

  throw new Error(\`MCP \${server}/\${tool} unavailable: \${lastError}\`);
}
`;

// ─────────────────────────────────────────────────────────────────────────────
// src/oneinch.ts — 1inch MCP-first, REST fallback + testnet-safe mocks
// ─────────────────────────────────────────────────────────────────────────────
const ONEINCH_TS = `/**
 * src/oneinch.ts
 *
 * Routing order:
 *   1) one_inch MCP tool (preferred)
 *   2) 1inch REST v6 fallback
 *   3) deterministic mock data when unsupported testnet chain returns 404
 *
 * Base Sepolia (84532) is not available on 1inch public v6 endpoint.
 * Docs: https://portal.1inch.dev/documentation/apis/swap/swagger
 *
 * All amounts are BigInt in token base units.
 * Auth: Authorization: Bearer <ONEINCH_API_KEY>
 */
import {
  CHAIN_ID,
  ONEINCH_REQUEST_CHAIN_ID,
  ONEINCH_DISABLE_ESTIMATE,
} from "./config.js";
import { callMcpTool } from "./mcp.js";

const MCP_SERVER_CANDIDATES = ["one_inch", "one_inch_mcp"];

type OneInchHttpError = Error & { status?: number; chainId?: number; body?: string };

function isUnsupportedTestnetChain(chainId: number): boolean {
  return chainId === 84532;
}

function normalizeToBigInt(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === "string" && value.trim().length > 0) {
    try {
      return BigInt(value.trim());
    } catch {
      return null;
    }
  }
  return null;
}

function parseMaybeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function pickBigIntByKeys(payload: unknown, keys: string[]): bigint | null {
  if (!payload || typeof payload !== "object") return null;

  const queue: unknown[] = [payload];
  while (queue.length > 0) {
    const cur = queue.shift();
    if (!cur || typeof cur !== "object") continue;

    const rec = cur as Record<string, unknown>;
    for (const key of keys) {
      const parsed = normalizeToBigInt(rec[key]);
      if (parsed !== null) return parsed;
    }

    for (const value of Object.values(rec)) {
      if (value && typeof value === "object") queue.push(value);
      if (typeof value === "string" && value.trim().startsWith("{")) {
        queue.push(parseMaybeJson(value));
      }
    }
  }

  return null;
}

function pickStringByKeys(payload: unknown, keys: string[]): string | null {
  if (!payload || typeof payload !== "object") return null;

  const queue: unknown[] = [payload];
  while (queue.length > 0) {
    const cur = queue.shift();
    if (!cur || typeof cur !== "object") continue;

    const rec = cur as Record<string, unknown>;
    for (const key of keys) {
      const val = rec[key];
      if (typeof val === "string" && val.trim().length > 0) {
        return val;
      }
    }

    for (const value of Object.values(rec)) {
      if (value && typeof value === "object") queue.push(value);
      if (typeof value === "string" && value.trim().startsWith("{")) {
        queue.push(parseMaybeJson(value));
      }
    }
  }

  return null;
}

function buildMockQuote(amount: bigint): { dstAmount: string } {
  // Keep deterministic and conservative so simulation never overstates profitability.
  return { dstAmount: amount.toString() };
}

function buildMockSwapData(): { tx: { data: string; to: string; value: string } } {
  return {
    tx: {
      data: "0x",
      to: "0x111111125421cA6dc452d289314280a0f8842A65",
      value: "0",
    },
  };
}

async function oneInchFetch(path: string, apiKey: string, chainId: number): Promise<unknown> {
  const apiBase = \`https://api.1inch.dev/swap/v6.0/\${chainId}\`;
  const url = \`\${apiBase}\${path}\`;
  const res  = await fetch(url, {
    headers: {
      Authorization: \`Bearer \${apiKey}\`,
      Accept:        "application/json",
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error("1inch request failed") as OneInchHttpError;
    err.status = res.status;
    err.chainId = chainId;
    err.body = body;
    try {
      const parsed = JSON.parse(body) as { description?: string; error?: string };
      const msg    = parsed.description ?? parsed.error ?? body.slice(0, 200);
      err.message = \`1inch API \${res.status} (chain \${chainId}): \${msg}\`;
      throw err;
    } catch {
      err.message = \`1inch API \${res.status} (chain \${chainId}): \${body.slice(0, 200)}\`;
      throw err;
    }
  }

  return res.json();
}

async function tryMcpQuote(src: string, dst: string, amount: bigint, chainId: number): Promise<bigint | null> {
  for (const server of MCP_SERVER_CANDIDATES) {
    try {
      const mcpResponse = await callMcpTool(server, "get_quote", {
        chainId,
        src,
        dst,
        amount: amount.toString(),
      });
      const parsedAmount = pickBigIntByKeys(mcpResponse, ["dstAmount", "toAmount", "amountOut", "outAmount"]);
      if (parsedAmount !== null) return parsedAmount;
    } catch {
      // Try next candidate, then fallback to REST.
    }
  }
  return null;
}

async function tryMcpSwapData(
  src: string,
  dst: string,
  amount: bigint,
  from: string,
  chainId: number,
): Promise<string | null> {
  for (const server of MCP_SERVER_CANDIDATES) {
    try {
      const mcpResponse = await callMcpTool(server, "get_swap_data", {
        chainId,
        src,
        dst,
        amount: amount.toString(),
        from,
        slippage: "1",
        disableEstimate: ONEINCH_DISABLE_ESTIMATE,
        allowPartialFill: false,
      });
      const calldata = pickStringByKeys(mcpResponse, ["data", "swapData", "txData", "calldata"]);
      if (calldata) return calldata;
    } catch {
      // Try next candidate, then fallback to REST.
    }
  }
  return null;
}

/**
 * getQuote — read-only price check, no transaction broadcast.
 */
export async function getQuote(
  src:    string,
  dst:    string,
  amount: bigint,
  apiKey: string,
): Promise<bigint> {
  const mcpAmount = await tryMcpQuote(src, dst, amount, ONEINCH_REQUEST_CHAIN_ID);
  if (mcpAmount !== null) return mcpAmount;

  const qs = new URLSearchParams({
    src,
    dst,
    amount: amount.toString(),
  });
  try {
    const data = await oneInchFetch(\`/quote?\${qs}\`, apiKey, ONEINCH_REQUEST_CHAIN_ID) as { dstAmount: string };
    if (!data.dstAmount) throw new Error("1inch quote: missing dstAmount in response");
    return BigInt(data.dstAmount);
  } catch (err) {
    const httpErr = err as OneInchHttpError;
    if (httpErr?.status === 404 && isUnsupportedTestnetChain(CHAIN_ID)) {
      return BigInt(buildMockQuote(amount).dstAmount);
    }
    throw err;
  }
}

/**
 * getSwapData — build calldata for on-chain swap execution.
 *
 * disableEstimate is configurable via ONEINCH_DISABLE_ESTIMATE (default false).
 */
export async function getSwapData(
  src:    string,
  dst:    string,
  amount: bigint,
  from:   string,
  apiKey: string,
): Promise<string> {
  const mcpCalldata = await tryMcpSwapData(src, dst, amount, from, ONEINCH_REQUEST_CHAIN_ID);
  if (mcpCalldata) return mcpCalldata;

  const qs = new URLSearchParams({
    src,
    dst,
    amount:           amount.toString(),
    from,
    slippage:         "1",
    disableEstimate:  ONEINCH_DISABLE_ESTIMATE ? "true" : "false",
    allowPartialFill: "false",
  });
  try {
    const data = await oneInchFetch(\`/swap?\${qs}\`, apiKey, ONEINCH_REQUEST_CHAIN_ID) as {
      tx: { data: string; to: string; value: string };
    };
    if (!data?.tx?.data) throw new Error("1inch swap: missing tx.data in response");
    return data.tx.data;
  } catch (err) {
    const httpErr = err as OneInchHttpError;
    if (httpErr?.status === 404 && isUnsupportedTestnetChain(CHAIN_ID)) {
      return buildMockSwapData().tx.data;
    }
    throw err;
  }
}
`;

// ─────────────────────────────────────────────────────────────────────────────
// src/webacy.ts — Webacy token risk API (direct REST, no MCP)
// ─────────────────────────────────────────────────────────────────────────────
const WEBACY_TS = `/**
 * src/webacy.ts
 *
 * Webacy token risk API — Base Sepolia
 * Docs: https://docs.webacy.com
 *
 * A token is considered safe if:
 *   risk === "low"  OR  score < 20
 *
 * Both USDC and WETH must pass before any trade executes.
 */

interface WebacyResponse {
  risk?:  string;   // "low" | "medium" | "high"
  score?: number;   // 0–100 (lower = safer)
}

/**
 * Check whether a single token is safe to trade.
 * Fails safe (returns false) on any API error.
 */
export async function isTokenSafe(
  tokenAddress: string,
  apiKey:       string,
): Promise<boolean> {
  const url = \`https://api.webacy.com/addresses/\${tokenAddress}?chain=base-sepolia\`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        "x-api-key": apiKey,
        Accept:      "application/json",
      },
    });
  } catch (networkErr) {
    console.warn(\`[Webacy] Network error checking \${tokenAddress}: \${(networkErr as Error).message}\`);
    return false;
  }

  if (!res.ok) {
    console.warn(\`[Webacy] HTTP \${res.status} for \${tokenAddress} — failing safe\`);
    return false;
  }

  const data = await res.json() as WebacyResponse;
  const risk  = (data.risk  ?? "unknown").toLowerCase();
  const score = typeof data.score === "number" ? data.score : 100;

  return risk === "low" || score < 20;
}

/**
 * Verify BOTH tokens before executing a trade.
 * Returns true only if both tokens are safe.
 */
export async function verifyTokens(
  usdcAddress: string,
  wethAddress: string,
  apiKey:      string,
): Promise<boolean> {
  const [usdcSafe, wethSafe] = await Promise.all([
    isTokenSafe(usdcAddress, apiKey),
    isTokenSafe(wethAddress, apiKey),
  ]);
  return usdcSafe && wethSafe;
}
`;

// ─────────────────────────────────────────────────────────────────────────────
// src/execute.ts — ethers.js on-chain flash loan execution
// ─────────────────────────────────────────────────────────────────────────────
const EXECUTE_TS = `/**
 * src/execute.ts
 *
 * Executes the Aave V3 flash-loan arbitrage on-chain via ethers.js v6.
 *
 * Flow:
 *   1. Call requestArbitrage() on the deployed FlashLoanReceiver contract
 *   2. Aave lends USDC → contract swaps USDC→WETH→USDC via 1inch → repays Aave + 0.09% fee
 *   3. Net profit stays in the contract (call withdrawProfit() separately to claim)
 */
import { ethers } from "ethers";
import { ARB_BOT_ADDRESS, USDC_ADDRESS, ONE_INCH_ROUTER, FLASHLOAN_ABI } from "./config.js";

/**
 * Execute the flash loan arbitrage transaction.
 *
 * @param signer         Funded wallet on Base Sepolia
 * @param borrowUsdcBase USDC borrow amount in base units (BigInt, 6 decimals)
 * @param swapCalldata   ABI-encoded 1inch swap calldata (USDC→WETH direction)
 * @returns              Confirmed transaction hash
 */
export async function executeFlashLoan(
  signer:         ethers.Wallet,
  borrowUsdcBase: bigint,
  swapCalldata:   string,
): Promise<string> {
  const contract = new ethers.Contract(ARB_BOT_ADDRESS, FLASHLOAN_ABI, signer);

  // Gas estimate with 20% buffer
  let gasEstimate: bigint;
  try {
    gasEstimate = await contract.requestArbitrage.estimateGas(
      USDC_ADDRESS,
      borrowUsdcBase,
      ONE_INCH_ROUTER,
      swapCalldata,
    );
    gasEstimate = (gasEstimate * 120n) / 100n;
  } catch {
    gasEstimate = 500_000n; // fallback
  }

  const tx = await contract.requestArbitrage(
    USDC_ADDRESS,
    borrowUsdcBase,
    ONE_INCH_ROUTER,
    swapCalldata,
    { gasLimit: gasEstimate },
  );

  const receipt = await tx.wait(1);

  if (!receipt || receipt.status !== 1) {
    throw new Error(\`Transaction reverted. Hash: \${tx.hash}\`);
  }

  return tx.hash as string;
}
`;

// ─────────────────────────────────────────────────────────────────────────────
// src/index.ts — main polling loop
// ─────────────────────────────────────────────────────────────────────────────
const INDEX_TS = `/**
 * src/index.ts — Base Sepolia Flash-Loan Arbitrage Bot
 *
 * Every POLL_INTERVAL seconds:
 *   1. Fetch USDC→WETH→USDC round-trip quotes from 1inch
 *   2. Calculate net profit after Aave 0.09% fee + 2 USDC gas buffer
 *   3. If profitable: verify both tokens with Webacy
 *   4. If tokens are safe: get swap calldata + execute flash loan (or simulate)
 */
import "dotenv/config";
import {
  SIMULATION_MODE,
  BORROW_AMOUNT_HUMAN,
  POLL_INTERVAL_MS,
  WALLET_PRIVATE_KEY,
  RPC_PROVIDER_URL,
  WEBACY_API_KEY,
  ONEINCH_API_KEY,
  USDC_ADDRESS,
  WETH_ADDRESS,
  ARB_BOT_ADDRESS,
  ONE_INCH_ROUTER,
  AAVE_FEE_BPS,
  GAS_BUFFER_USDC,
  CHAIN_ID,
  ONEINCH_REQUEST_CHAIN_ID,
  createProvider,
  createSigner,
  parseUsdc,
} from "./config.js";
import { getQuote, getSwapData } from "./oneinch.js";
import { verifyTokens }          from "./webacy.js";
import { executeFlashLoan }      from "./execute.js";

// ── ANSI color helpers ────────────────────────────────────────────────────────
const C = {
  reset:  "\\x1b[0m",
  cyan:   "\\x1b[36m",
  green:  "\\x1b[32m",
  red:    "\\x1b[31m",
  yellow: "\\x1b[33m",
  dim:    "\\x1b[2m",
  bold:   "\\x1b[1m",
};

type LogLevel = "INFO" | "WARN" | "ERROR" | "EXEC";

function log(level: LogLevel, msg: string): void {
  const ts  = new Date().toISOString().replace("T", " ").slice(0, 19);
  const col = level === "INFO"  ? C.cyan
            : level === "EXEC"  ? C.green
            : level === "WARN"  ? C.yellow
            : C.red;
  console.log(\`\${C.dim}\${ts}\${C.reset} [\${col}\${level}\${C.reset}] \${msg}\`);
}

// ── Pre-flight validation ─────────────────────────────────────────────────────
function validate(): void {
  const errors: string[] = [];

  if (!ONEINCH_API_KEY) {
    errors.push("ONEINCH_API_KEY is not set  →  get one at https://portal.1inch.dev");
  }
  if (!WEBACY_API_KEY) {
    errors.push("WEBACY_API_KEY is not set   →  get one at https://webacy.com");
  }
  if (!SIMULATION_MODE) {
    if (!RPC_PROVIDER_URL)   errors.push("RPC_PROVIDER_URL is required for live mode");
    if (!WALLET_PRIVATE_KEY) errors.push("WALLET_PRIVATE_KEY is required for live mode");
  }
    if (ONEINCH_REQUEST_CHAIN_ID !== CHAIN_ID) {
      log("WARN", \`1inch request chain (\${ONEINCH_REQUEST_CHAIN_ID}) differs from execution chain (\${CHAIN_ID}); execution will be skipped for safety.\`);
    }

  if (errors.length > 0) {
    errors.forEach(e => log("ERROR", e));
    process.exit(1);
  }
}

// ── Banner ────────────────────────────────────────────────────────────────────
console.log(\`
\${C.bold}\${C.cyan}╔══════════════════════════════════════════════════════╗
║   Base Sepolia Flash-Loan Arbitrage Bot              ║
║   USDC ─→ WETH ─→ USDC  via 1inch + Aave V3         ║
║   Chain ID: \${CHAIN_ID} (Base Sepolia)                 ║
╚══════════════════════════════════════════════════════╝\${C.reset}
\`);

validate();

const BORROW_BASE = parseUsdc(BORROW_AMOUNT_HUMAN);

// Only create provider/signer in live mode
const provider = !SIMULATION_MODE ? createProvider() : null;
const signer   = (!SIMULATION_MODE && provider) ? createSigner(provider) : null;

if (SIMULATION_MODE) {
  log("WARN", \`\${C.yellow}SIMULATION MODE — no transactions will be broadcast\${C.reset}\`);
} else {
  log("WARN", \`\${C.red}LIVE MODE — real transactions will be broadcast on Base Sepolia (chainId \${CHAIN_ID})\${C.reset}\`);
}

log("INFO", \`Borrow amount : \${BORROW_BASE.toLocaleString()} base units (\${BORROW_AMOUNT_HUMAN} USDC)\`);
log("INFO", \`Poll interval : \${POLL_INTERVAL_MS / 1000}s\`);
log("INFO", \`Bot address   : \${ARB_BOT_ADDRESS}\`);
log("INFO", \`1inch chain   : \${ONEINCH_REQUEST_CHAIN_ID} (execution chain \${CHAIN_ID})\`);
console.log();

// ── Main cycle ────────────────────────────────────────────────────────────────
let cycle = 0;
let lastErrorKey = "";
let lastErrorCount = 0;

function logCycleError(message: string): void {
  const key = message.slice(0, 160);
  if (key === lastErrorKey) {
    lastErrorCount += 1;
    if (lastErrorCount === 5 || lastErrorCount % 20 === 0) {
      log("WARN", \`Repeated error (\${lastErrorCount + 1}x): \${message}\`);
    }
    return;
  }

  if (lastErrorCount > 0) {
    log("INFO", \`Previous repeated error count: \${lastErrorCount + 1}\`);
  }

  lastErrorKey = key;
  lastErrorCount = 0;
  log("ERROR", \`Cycle #\${cycle} — \${message}\`);
}

async function runCycle(): Promise<void> {
  cycle++;

  try {
    // Step 1: Get USDC→WETH quote
    const wethAmount = await getQuote(USDC_ADDRESS, WETH_ADDRESS, BORROW_BASE, ONEINCH_API_KEY);

    // Step 2: Get WETH→USDC quote (completing the round-trip)
    const grossReturn = await getQuote(WETH_ADDRESS, USDC_ADDRESS, wethAmount, ONEINCH_API_KEY);

    // Step 3: Calculate net profit — all BigInt arithmetic
    const fee       = (BORROW_BASE * AAVE_FEE_BPS) / 10_000n;
    const netProfit = grossReturn - BORROW_BASE - fee - GAS_BUFFER_USDC;

    const netUsd   = (Number(netProfit)   / 1_000_000).toFixed(6);
    const grossUsd = (Number(grossReturn) / 1_000_000).toFixed(6);
    const feeUsd   = (Number(fee)         / 1_000_000).toFixed(6);

    if (netProfit > 0n) {
      log("INFO", \`Cycle #\${cycle} — ✓ Opportunity found!\`);
      log("INFO", \`  Gross return : \${grossUsd} USDC\`);
      log("INFO", \`  Aave fee     : \${feeUsd} USDC\`);
      log("INFO", \`  Net profit   : +\${netUsd} USDC\`);

      // Step 4: Verify both token risk scores with Webacy
      const tokensOk = await verifyTokens(USDC_ADDRESS, WETH_ADDRESS, WEBACY_API_KEY);
      if (!tokensOk) {
        log("WARN", \`Cycle #\${cycle} — Token risk check failed, skipping\`);
        return;
      }
      log("INFO", \`Cycle #\${cycle} — Token risk check passed\`);

      if (SIMULATION_MODE) {
        log("EXEC", \`[SIM] Cycle #\${cycle} — Would execute flash loan. Net profit: +\${netUsd} USDC\`);
      } else {
        if (ONEINCH_REQUEST_CHAIN_ID !== CHAIN_ID) {
          log("WARN", \`Cycle #\${cycle} — Skipping live execution: 1inch chain (\${ONEINCH_REQUEST_CHAIN_ID}) != execution chain (\${CHAIN_ID})\`);
          return;
        }

        if (!signer) { log("ERROR", "No signer — cannot execute"); return; }

        log("EXEC", \`Cycle #\${cycle} — Fetching swap calldata from 1inch...\`);
        const calldata = await getSwapData(
          USDC_ADDRESS, WETH_ADDRESS, BORROW_BASE, ARB_BOT_ADDRESS, ONEINCH_API_KEY,
        );

        log("EXEC", \`Cycle #\${cycle} — Submitting flash loan transaction...\`);
        const txHash = await executeFlashLoan(signer, BORROW_BASE, calldata);
        log("EXEC", \`Cycle #\${cycle} — ✓ TX confirmed: \${txHash}\`);
      }
    } else {
      log("INFO", \`Cycle #\${cycle} — No opportunity. Net: \${netUsd} USDC (after fees+buffer)\`);
    }
  } catch (err: unknown) {
    logCycleError((err as Error).message);
  }
}

// Run immediately, then on interval
runCycle();
const interval = setInterval(runCycle, POLL_INTERVAL_MS);

process.on("SIGINT", () => {
  log("INFO", "Stopping bot...");
  clearInterval(interval);
  process.exit(0);
});

process.on("SIGTERM", () => {
  log("INFO", "Received SIGTERM, stopping...");
  clearInterval(interval);
  process.exit(0);
});
`;