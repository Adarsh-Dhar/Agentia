import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { encryptEnvConfig } from "@/lib/crypto-env";
import { assembleBotFiles, assembleInitiaBotFiles } from "../get-bot-code/bot-files";
import { sanitizeIntentMcpLists, shouldUseInitiaDeterministicFallback } from "@/lib/intent/mcp-sanitizer";
import type { Prisma } from "@/lib/generated/prisma/client.ts";
import fs from "node:fs";
import path from "node:path";

const META_AGENT_URL = process.env.META_AGENT_URL ?? "http://127.0.0.1:8000";
const HEALTH_TIMEOUT_MS = Number(process.env.META_AGENT_HEALTH_TIMEOUT_MS ?? "2000");
const HEALTH_RETRIES = Number(process.env.META_AGENT_HEALTH_RETRIES ?? "2");
const META_TIMEOUT_MS = Number(process.env.META_AGENT_GENERATE_TIMEOUT_MS ?? "240000");
const META_RETRIES = Number(process.env.META_AGENT_GENERATE_RETRIES ?? "1");
const MAX_META_PROMPT_CHARS = Number(process.env.MAX_META_PROMPT_CHARS ?? "1800");

type GeneratedFile = { filepath: string; content: unknown; language?: string };

function compactPromptForMetaAgent(input: string): string {
  const normalized = input.replace(/\r/g, "").trim();
  if (normalized.length <= MAX_META_PROMPT_CHARS) return normalized;

  const head = Math.floor(MAX_META_PROMPT_CHARS * 0.7);
  const tail = Math.max(300, MAX_META_PROMPT_CHARS - head - 64);
  return `${normalized.slice(0, head)}\n\n[...truncated for model limit...]\n\n${normalized.slice(-tail)}`;
}

function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const commentIndex = value.indexOf(" #");
    if (commentIndex >= 0) value = value.slice(0, commentIndex).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

function loadAgentEnvDefaults(): Record<string, string> {
  try {
    const envPath = path.resolve(process.cwd(), "../agents/.env");
    const envText = fs.readFileSync(envPath, "utf8");
    return parseEnvText(envText);
  } catch {
    return {};
  }
}

function isLocalGateway(value: string): boolean {
  return /(^|\/\/)(localhost|127\.0\.0\.1|0\.0\.0\.0|192\.168\.)/i.test(String(value || ""));
}

function pickPublicGateway(candidate: string, fallback: string): string {
  const value = String(candidate || "").trim();
  if (!value) return fallback;
  if (/^\/api\/mcp-proxy\/?/i.test(value)) return fallback;
  if (isLocalGateway(value)) return fallback || value;
  return value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isSolanaSentimentIntent(intent: Record<string, unknown>): boolean {
  const strategy = String(intent.strategy ?? intent.execution_model ?? "").toLowerCase();
  const chain = String(intent.chain ?? "").toLowerCase();
  const botType = String(intent.bot_type ?? intent.bot_name ?? "").toLowerCase();

  return chain.includes("solana") && strategy.includes("sentiment") && botType.includes("sentiment");
}

function deriveFallbackIntent(prompt: string): Record<string, unknown> {
  const normalized = prompt.toLowerCase();
  const isSentiment = normalized.includes("sentiment") || normalized.includes("lunarcrush") || normalized.includes("social");
  return sanitizeIntentMcpLists({
    chain: "initia",
    network: normalized.includes("mainnet") ? "initia-mainnet" : "initia-testnet",
    execution_model: isSentiment ? "agentic" : "polling",
    strategy: isSentiment ? "sentiment" : (normalized.includes("arbitrage") || normalized.includes("flash loan") ? "arbitrage" : "unknown"),
    required_mcps: ["initia"],
    mcps: ["initia", ...(isSentiment ? ["lunarcrush"] : []), "pyth"],
    bot_type: isSentiment ? "Initia Sentiment Bot" : "Initia Move Bot",
    bot_name: isSentiment ? "Initia Sentiment Bot" : "Initia Move Bot",
    requires_openai_key: isSentiment,
    requires_solana_wallet: false,
  });
}

function isInitiaSentimentIntent(intent: Record<string, unknown>): boolean {
  const strategy = String(intent.strategy ?? intent.execution_model ?? "").toLowerCase();
  const chain = String(intent.chain ?? "").toLowerCase();
  const botType = String(intent.bot_type ?? intent.bot_name ?? "").toLowerCase();

  return chain.includes("initia") && strategy.includes("sentiment") && botType.includes("sentiment");
}

function buildSafeInitiaSentimentIndexTs(): string {
  return [
    'import * as configModule from "./config.js";',
    'import { callMcpTool } from "./mcp_bridge.js";',
    '',
    'const config = ((configModule as Record<string, unknown>).config ?? (configModule as Record<string, unknown>).CONFIG ?? {}) as Record<string, unknown>;',
    'const POLL_MS = 5000;',
    'const SENTIMENT_BUY_THRESHOLD = 70;',
    'const SENTIMENT_SELL_THRESHOLD = 30;',
    'const SIMULATION_MODE = String(process.env.SIMULATION_MODE ?? config.SIMULATION_MODE ?? "true").toLowerCase() !== "false";',
    '',
    'function log(level: string, message: string): void {',
    '  const ts = new Date().toISOString();',
    '  console.log("[" + ts + "] [" + level + "] " + message);',
    '}',
    '',
    'async function safeMcp(server: string, tool: string, args: Record<string, unknown>): Promise<unknown | null> {',
    '  try {',
    '    return await callMcpTool(server, tool, args);',
    '  } catch (error) {',
    '    const msg = error instanceof Error ? error.message : String(error);',
    '    log("WARN", "MCP " + server + "/" + tool + " unavailable: " + msg);',
    '    return null;',
    '  }',
    '}',
    '',
    'function extractScore(payload: unknown, fallback = 50): number {',
    '  if (!payload || typeof payload !== "object") return fallback;',
    '  const root = payload as Record<string, unknown>;',
    '  const result = (root.result && typeof root.result === "object") ? (root.result as Record<string, unknown>) : root;',
    '  const content = result.content;',
    '  if (Array.isArray(content) && content.length > 0) {',
    '    const text = (content[0] as Record<string, unknown>).text;',
    '    if (typeof text === "string") {',
    '      try {',
    '        const parsed = JSON.parse(text) as Record<string, unknown>;',
    '        const value = Number(parsed.sentiment ?? parsed.score ?? parsed.market_sentiment ?? fallback);',
    '        return Number.isFinite(value) ? value : fallback;',
    '      } catch {}',
    '    }',
    '  }',
    '  return fallback;',
    '}',
    '',
    'function requireConfiguredAddress(name: string, value: string): string {',
    '  const resolved = String(value ?? "").trim();',
    '  if (!resolved) throw new Error(name + " is not set");',
    '  return resolved;',
    '}',
    '',
    'async function runCycle(): Promise<void> {',
    '  log("INFO", "Initia sentiment cycle start");',
    '  const poolAAddress = requireConfiguredAddress("INITIA_POOL_A_ADDRESS", process.env.INITIA_POOL_A_ADDRESS ?? "");',
    '  const poolBAddress = requireConfiguredAddress("INITIA_POOL_B_ADDRESS", process.env.INITIA_POOL_B_ADDRESS ?? "");',
    '  const flashPoolAddress = requireConfiguredAddress("INITIA_FLASH_POOL_ADDRESS", process.env.INITIA_FLASH_POOL_ADDRESS ?? "");',
    '  const swapRouterAddress = requireConfiguredAddress("INITIA_SWAP_ROUTER_ADDRESS", process.env.INITIA_SWAP_ROUTER_ADDRESS ?? "");',
    '  const [sentiment, left, right] = await Promise.all([',
    '    safeMcp("lunarcrush", "get_coin_details", { coin: "INIT", symbol: "INIT" }),',
    '    safeMcp("initia", "move_view", { address: poolAAddress, module: "amm_oracle", function: "spot_price", args: ["uinit", "uusdc"] }),',
    '    safeMcp("initia", "move_view", { address: poolBAddress, module: "amm_oracle", function: "spot_price", args: ["uinit", "uusdc"] }),',
    '  ]);',
    '',
    '  const score = extractScore(sentiment);',
    '  log("INFO", "Sentiment score=" + score);',
    '  log("INFO", "Cross-rollup price snapshots fetched=" + Number(Boolean(left) && Boolean(right)));',
    '',
    '  if (score > SENTIMENT_BUY_THRESHOLD) {',
    '    log("INFO", "Bullish threshold reached");',
    '    if (!SIMULATION_MODE) {',
    '      await safeMcp("initia", "move_execute", {',
    '        transaction: {',
    '          calls: [',
    '            { address: flashPoolAddress, module: "flash_loan", function: "borrow", type_args: ["uinit", "uusdc"], args: ["1000000"] },',
    '            { address: swapRouterAddress, module: "router", function: "swap_exact_in", type_args: ["uinit", "uusdc"], args: ["1000000", "995000"] },',
    '            { address: flashPoolAddress, module: "flash_loan", function: "repay", type_args: ["uinit", "uusdc"], args: ["1000900"] },',
    '          ],',
    '        },',
    '      });',
    '    }',
    '  } else if (score < SENTIMENT_SELL_THRESHOLD) {',
    '    log("INFO", "Bearish threshold reached; skipping long execution");',
    '  } else {',
    '    log("INFO", "Neutral sentiment; no execution");',
    '  }',
    '}',
    '',
    'let inFlight = false;',
    'const tick = async (): Promise<void> => {',
    '  if (inFlight) return;',
    '  inFlight = true;',
    '  try {',
    '    await runCycle();',
    '  } finally {',
    '    inFlight = false;',
    '  }',
    '};',
    '',
    'void tick();',
    'const timer = setInterval(() => { void tick(); }, POLL_MS);',
    '',
    'process.on("SIGINT", () => {',
    '  clearInterval(timer);',
    '  log("INFO", "Shutting down bot");',
    '  process.exit(0);',
    '});',
    '',
    'process.on("SIGTERM", () => {',
    '  clearInterval(timer);',
    '  log("INFO", "Shutting down bot");',
    '  process.exit(0);',
    '});',
  ].join("\n");
}

function buildSafeSolanaSentimentIndexTs(): string {
  return [
    'import { Connection, Keypair } from "@solana/web3.js";',
    'import bs58 from "bs58";',
    'import * as configModule from "./config.js";',
    'import { callMcpTool } from "./mcp_bridge.js";',
    '',
    'const config = ((configModule as Record<string, unknown>).config ?? (configModule as Record<string, unknown>).CONFIG ?? {}) as Record<string, unknown>;',
    '',
    'const POLL_MS = 5000;',
    'const SENTIMENT_BUY_THRESHOLD = 70;',
    'const SENTIMENT_SELL_THRESHOLD = 30;',
    'const RISK_SAFE_THRESHOLD = 20;',
    'const SOL_MINT = "So11111111111111111111111111111111111111112";',
    'const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";',
    'const SIMULATION_MODE = String(process.env.SIMULATION_MODE ?? config.SIMULATION_MODE ?? "false").toLowerCase() === "true";',
    'const MOCK_SENTIMENT = process.env.TEST_SENTIMENT_SCORE ? Number(process.env.TEST_SENTIMENT_SCORE) : null;',
    'const MOCK_RISK = process.env.TEST_RISK_SCORE ? Number(process.env.TEST_RISK_SCORE) : null;',
    'const MOCK_SOL_PRICE = process.env.TEST_SOL_PRICE ? Number(process.env.TEST_SOL_PRICE) : null;',
    'let inFlight = false;',
    'let cycleCount = 0;',
    '',
    'function log(level: string, message: string): void {',
    '  const ts = new Date().toISOString();',
    '  console.log("[" + ts + "] [" + level + "] " + message);',
    '}',
    '',
    'function safeStringify(value: unknown): string {',
    '  try {',
    '    return JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item));',
    '  } catch {',
    '    return String(value);',
    '  }',
    '}',
    '',
    'function toFiniteNumber(value: unknown): number | null {',
    '  if (typeof value === "number") return Number.isFinite(value) ? value : null;',
    '  if (typeof value === "string") {',
    '    const parsed = Number(value);',
    '    return Number.isFinite(parsed) ? parsed : null;',
    '  }',
    '  return null;',
    '}',
    '',
    'function firstNumberByKeys(value: unknown, keys: Set<string>, depth = 0): number | null {',
    '  if (depth > 6 || value == null) return null;',
    '  const direct = toFiniteNumber(value);',
    '  if (direct !== null && depth > 0) return direct;',
    '  if (Array.isArray(value)) {',
    '    for (const item of value) {',
    '      const found = firstNumberByKeys(item, keys, depth + 1);',
    '      if (found !== null) return found;',
    '    }',
    '    return null;',
    '  }',
    '  if (typeof value === "object") {',
    '    const obj = value as Record<string, unknown>;',
    '    for (const [key, raw] of Object.entries(obj)) {',
    '      if (keys.has(key.toLowerCase())) {',
    '        const found = toFiniteNumber(raw);',
    '        if (found !== null) return found;',
    '      }',
    '    }',
    '    for (const raw of Object.values(obj)) {',
    '      const found = firstNumberByKeys(raw, keys, depth + 1);',
    '      if (found !== null) return found;',
    '    }',
    '  }',
    '  return null;',
    '}',
    '',
    'function parseMaybeJson(value: unknown): unknown {',
    '  if (typeof value !== "string") return value;',
    '  const trimmed = value.trim();',
    '  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return value;',
    '  try {',
    '    return JSON.parse(trimmed);',
    '  } catch {',
    '    return value;',
    '  }',
    '}',
    '',
    'function unwrapMcpPayload(payload: unknown): unknown {',
    '  if (!payload || typeof payload !== "object") return payload;',
    '  const root = payload as Record<string, unknown>;',
    '  const result = (root.result && typeof root.result === "object") ? (root.result as Record<string, unknown>) : null;',
    '  if (!result) return payload;',
    '  const content = result.content;',
    '  if (!Array.isArray(content)) return result;',
    '  const normalized = content.map((item) => {',
    '    if (!item || typeof item !== "object") return item;',
    '    const text = (item as Record<string, unknown>).text;',
    '    return parseMaybeJson(text);',
    '  });',
    '  return normalized.length === 1 ? normalized[0] : normalized;',
    '}',
    '',
    'function extractSentimentScore(payload: unknown): number | null {',
    '  const normalized = unwrapMcpPayload(payload);',
    '  return firstNumberByKeys(normalized, new Set(["sentiment", "sentiment_score", "score", "bullish_score", "market_sentiment"]));',
    '}',
    '',
    'function extractRiskScore(payload: unknown): number | null {',
    '  const normalized = unwrapMcpPayload(payload);',
    '  return firstNumberByKeys(normalized, new Set(["risk", "risk_score", "score", "overall_risk", "threat_score"]));',
    '}',
    '',
    'function extractSolPrice(payload: unknown): number | null {',
    '  if (!payload || typeof payload !== "object") return null;',
    '  const root = payload as Record<string, unknown>;',
    '  const jupData = root.data;',
    '  if (jupData && typeof jupData === "object") {',
    '    const dataRecord = jupData as Record<string, unknown>;',
    '    const sol = dataRecord.SOL;',
    '    if (sol && typeof sol === "object") {',
    '      const price = toFiniteNumber((sol as Record<string, unknown>).price);',
    '      if (price !== null) return price;',
    '    }',
    '  }',
    '  const cg = root.solana;',
    '  if (cg && typeof cg === "object") {',
    '    const usd = toFiniteNumber((cg as Record<string, unknown>).usd);',
    '    if (usd !== null) return usd;',
    '  }',
    '  return firstNumberByKeys(root, new Set(["price", "usd", "value"]));',
    '}',
    '',
    'function loadKeypair(): Keypair {',
    '  const rawKey = String(process.env.SOLANA_PRIVATE_KEY ?? config.SOLANA_PRIVATE_KEY ?? config.PRIVATE_KEY ?? "").trim();',
    '  if (SIMULATION_MODE) {',
    '    log("INFO", "Simulation mode active. Using ephemeral keypair.");',
    '    return Keypair.generate();',
    '  }',
    '',
    '  if (!rawKey) {',
    '    throw new Error("SOLANA_PRIVATE_KEY is required when SIMULATION_MODE=false");',
    '  }',
    '',
    '  try {',
    '    const secret = rawKey.startsWith("[") ? Uint8Array.from(JSON.parse(rawKey)) : bs58.decode(rawKey.replace(/^0x/, ""));',
    '    return Keypair.fromSecretKey(secret);',
    '  } catch {',
    '    throw new Error("Invalid SOLANA_PRIVATE_KEY format");',
    '  }',
    '}',
    '',
    'async function safeFetchJson(url: string, label: string): Promise<unknown | null> {',
    '  try {',
    '    const response = await fetch(url);',
    '    if (!response.ok) throw new Error("HTTP " + response.status);',
    '    return await response.json();',
    '  } catch (error) {',
    '    const msg = error instanceof Error ? error.message : String(error);',
    '    log("WARN", label + " unavailable: " + msg);',
    '    return null;',
    '  }',
    '}',
    '',
    'async function safeMcp(server: string, tool: string, args: Record<string, unknown>): Promise<unknown | null> {',
    '  try {',
    '    return await callMcpTool(server, tool, args);',
    '  } catch (error) {',
    '    const msg = error instanceof Error ? error.message : String(error);',
    '    log("WARN", "MCP " + server + "/" + tool + " unavailable: " + msg);',
    '    return null;',
    '  }',
    '}',
    '',
    'async function executeJupiterTrade(side: "buy" | "sell"): Promise<unknown | null> {',
    '  const inputMint = side === "buy" ? USDC_MINT : SOL_MINT;',
    '  const outputMint = side === "buy" ? SOL_MINT : USDC_MINT;',
    '  const amount = side === "buy" ? "1000000" : "50000";',
    '  const wallet = keypair.publicKey.toBase58();',
    '',
    '  const quote = await safeMcp("jupiter", "getQuote", {',
    '    inputMint,',
    '    outputMint,',
    '    amount,',
    '    slippageBps: 100,',
    '  });',
    '',
    '  if (!quote) {',
    '    log("WARN", "Trade skipped: Jupiter quote unavailable.");',
    '    return null;',
    '  }',
    '',
    '  const swapCandidates: Array<{ tool: string; args: Record<string, unknown> }> = [',
    '    { tool: "getSwapData", args: { quoteResponse: quote, userPublicKey: wallet, wrapAndUnwrapSol: true } },',
    '    { tool: "getSwap", args: { quoteResponse: quote, userPublicKey: wallet, wrapAndUnwrapSol: true } },',
    '    { tool: "buildSwapTransaction", args: { quoteResponse: quote, userPublicKey: wallet, wrapAndUnwrapSol: true } },',
    '  ];',
    '',
    '  for (const candidate of swapCandidates) {',
    '    const swap = await safeMcp("jupiter", candidate.tool, candidate.args);',
    '    if (swap) {',
    '      return { signature: "pending", inputAmount: amount, outputAmount: "unknown", quote, swap, tool: candidate.tool };',
    '    }',
    '  }',
    '',
    '  log("WARN", "Quote received but swap payload build failed across known Jupiter tools.");',
    '  return { signature: "quote_only", inputAmount: amount, outputAmount: "unknown", quote };',
    '}',
    '',
    'const keypair = loadKeypair();',
    'const rpcUrl = String(process.env.SOLANA_RPC_URL ?? config.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com");',
    'const connection = new Connection(rpcUrl, "confirmed");',
    '',
    'async function runCycle(): Promise<void> {',
    '  cycleCount += 1;',
    '  log("INFO", "=== CYCLE #" + cycleCount + " START ===");',
    '  log("INFO", "Wallet: " + keypair.publicKey.toBase58());',
    '',
    '  const [sentiment, risk, jupPrice] = await Promise.all([',
    '    safeMcp("lunarcrush", "get_coin_details", { coin: "SOL", symbol: "SOL", apiKey: String(process.env.LUNARCRUSH_API_KEY ?? config.LUNARCRUSH_API_KEY ?? "") }),',
    '    safeMcp("webacy", "get_token_risk", { address: keypair.publicKey.toBase58(), chain: "solana", metrics_date: new Date().toISOString() }),',
    '    safeFetchJson("https://price.jup.ag/v6/price?ids=SOL", "priceData"),',
    '  ]);',
    '',
    '  const pricePayload = jupPrice ?? await safeFetchJson("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd", "coingecko");',
    '  const sentimentScore = Number.isFinite(MOCK_SENTIMENT) ? Number(MOCK_SENTIMENT) : extractSentimentScore(sentiment);',
    '  const riskScore = Number.isFinite(MOCK_RISK) ? Number(MOCK_RISK) : extractRiskScore(risk);',
    '  const solPrice = Number.isFinite(MOCK_SOL_PRICE) ? Number(MOCK_SOL_PRICE) : extractSolPrice(pricePayload);',
    '',
    '  if (solPrice !== null) {',
    '    log("INFO", "SOL Price: $" + solPrice.toFixed(2));',
    '    if (Number.isFinite(MOCK_SOL_PRICE)) log("INFO", "Price source: TEST_SOL_PRICE override");',
    '  } else {',
    '    log("WARN", "SOL price unavailable");',
    '  }',
    '  if (sentimentScore !== null) {',
    '    log("INFO", "Sentiment: " + safeStringify(sentiment));',
    '    if (Number.isFinite(MOCK_SENTIMENT)) log("INFO", "Sentiment source: TEST_SENTIMENT_SCORE override");',
    '  } else {',
    '    log("WARN", "Sentiment unavailable");',
    '  }',
    '  if (riskScore !== null) {',
    '    log("INFO", "Risk Score: " + safeStringify(risk));',
    '    if (Number.isFinite(MOCK_RISK)) log("INFO", "Risk source: TEST_RISK_SCORE override");',
    '  } else {',
    '    log("WARN", "Risk score unavailable");',
    '  }',
    '',
    '  const available = [solPrice !== null, sentimentScore !== null, riskScore !== null].filter(Boolean).length;',
    '  log("INFO", "Data sources available: " + available + "/3 (price, sentiment, risk)");',
    '',
    '  if (sentimentScore !== null && sentimentScore > SENTIMENT_BUY_THRESHOLD && riskScore !== null && riskScore < RISK_SAFE_THRESHOLD) {',
    '    log("INFO", "Bullish sentiment detected (" + sentimentScore + " > " + SENTIMENT_BUY_THRESHOLD + "). Risk score (" + riskScore + ") is safe. Proceeding to trade.");',
    '    if (SIMULATION_MODE) {',
    '      log("INFO", "Simulation mode active. Trade skipped.");',
    '    } else {',
    '      const trade = await executeJupiterTrade("buy");',
    '      if (trade) {',
    '        log("INFO", "Trade executed: " + safeStringify(trade));',
    '      } else {',
    '        log("WARN", "Trade attempt failed: no executable swap payload.");',
    '      }',
    '    }',
    '  } else if (sentimentScore !== null && sentimentScore < SENTIMENT_SELL_THRESHOLD) {',
    '    log("INFO", "Bearish sentiment detected (" + sentimentScore + " < " + SENTIMENT_SELL_THRESHOLD + "). Proceeding to exit position.");',
    '    if (SIMULATION_MODE) {',
    '      log("INFO", "Simulation mode active. Trade skipped.");',
    '    } else {',
    '      const trade = await executeJupiterTrade("sell");',
    '      if (trade) {',
    '        log("INFO", "Trade executed: " + safeStringify(trade));',
    '      } else {',
    '        log("WARN", "Trade attempt failed: no executable swap payload.");',
    '      }',
    '    }',
    '  } else if (sentimentScore !== null) {',
    '    log("INFO", "Sentiment is neutral (" + sentimentScore + "). No actionable triggers met. Holding position.");',
    '  } else {',
    '    log("WARN", "Sentiment unavailable, skipping directional trade decision this cycle.");',
    '  }',
    '',
    '  if (available < 3) {',
    '    log("WARN", "Failed to fetch remote data. Continuing in degraded mode.");',
    '    log("INFO", "Cycle continues with partial/no data until providers recover.");',
    '  }',
    '',
    '  log("INFO", "=== CYCLE #" + cycleCount + " COMPLETE ===");',
    '  log("INFO", "cycle_ok wallet=" + keypair.publicKey.toBase58() + " rpc=" + connection.rpcEndpoint);',
    '}',
    '',
    'const tick = async (): Promise<void> => {',
    '  if (inFlight) return;',
    '  inFlight = true;',
    '  try {',
    '    await runCycle();',
    '  } finally {',
    '    inFlight = false;',
    '  }',
    '};',
    '',
    'void tick();',
    'const timer = setInterval(() => { void tick(); }, POLL_MS);',
    '',
    'process.on("SIGINT", () => {',
    '  clearInterval(timer);',
    '  log("INFO", "Shutting down bot");',
    '  process.exit(0);',
    '});',
    '',
    'process.on("SIGTERM", () => {',
    '  clearInterval(timer);',
    '  log("INFO", "Shutting down bot");',
    '  process.exit(0);',
    '});',
  ].join("\n");
}

function buildMcpBridgeTs(): string {
  return [
    'const MCP_GATEWAY_URL = process.env.MCP_GATEWAY_URL ?? "http://localhost:8000/mcp";',
    'const MCP_GATEWAY_UPSTREAM_URL = process.env.MCP_GATEWAY_UPSTREAM_URL ?? "";',
    '',
    'function isProxyGateway(value: string): boolean {',
    '  return /\/api\/mcp-proxy\/?$/i.test(String(value || ""));',
    '}',
    '',
    'function normalizeGatewayBase(raw: string): string {',
    '  const value = String(raw ?? "").trim() || "http://localhost:8000/mcp";',
    '  const base = value.replace(/\\/+$/, "");',
    '  if (isProxyGateway(base)) return base;',
    '  return /\\/mcp$/i.test(base) ? base : `${base}/mcp`;',
    '}',
    '',
    'export async function callMcpTool(server: string, tool: string, args: Record<string, unknown>): Promise<unknown> {',
    '  const base = normalizeGatewayBase(MCP_GATEWAY_URL);',
    '  const url = `${base}/${server}/${tool}`;',
    '  console.log(`[MCP] request start server=${server} tool=${tool} base=${base} url=${url} upstream=${MCP_GATEWAY_UPSTREAM_URL || "<empty>"}`);',
    '  let response: Response;',
    '  try {',
    '    response = await fetch(url, {',
    '      method: "POST",',
    '      headers: {',
    '        "Content-Type": "application/json",',
    '        "x-mcp-upstream-url": MCP_GATEWAY_UPSTREAM_URL,',
    '        "ngrok-skip-browser-warning": "true",',
    '        "Bypass-Tunnel-Reminder": "true",',
    '      },',
    '      body: JSON.stringify(args ?? {}),',
    '    });',
    '  } catch (error) {',
    '    const details = error instanceof Error ? error.message : String(error);',
    '    console.error(`[MCP] fetch failed server=${server} tool=${tool} url=${url} name=${error instanceof Error ? error.name : "Error"} message=${details}`);',
    '    throw error;',
    '  }',
    '',
    '  if (!response.ok) {',
    '    const body = await response.text().catch(() => "");',
    '    console.error(`[MCP] http error server=${server} tool=${tool} status=${response.status} statusText=${response.statusText} body=${body.slice(0, 300)}`);',
    '    throw new Error(`MCP ${server}/${tool} HTTP ${response.status}: ${body.slice(0, 200)}`);',
    '  }',
    '',
    '  return await response.json();',
    '}',
    '',
  ].join("\n");
}

function normalizeRuntimeVarNames(files: GeneratedFile[], intent: Record<string, unknown>): GeneratedFile[] {
  const chain = String(intent.chain ?? "").toLowerCase();

  return files.map((file) => {
    if (typeof file.content !== "string") return file;

    if (chain.includes("initia")) {
      const patchedInitia = file.content
        .replace(/\bEVM_RPC_URL\b/g, "INITIA_RPC_URL")
        .replace(/\bRPC_PROVIDER_URL\b/g, "INITIA_RPC_URL")
        .replace(/\bSOLANA_RPC_URL\b/g, "INITIA_RPC_URL")
        .replace(/\bEVM_PRIVATE_KEY\b/g, "INITIA_KEY")
        .replace(/\bWALLET_PRIVATE_KEY\b/g, "INITIA_KEY")
        .replace(/\bSOLANA_PRIVATE_KEY\b/g, "INITIA_KEY");
      return { ...file, content: patchedInitia };
    }

    // Normalize only whole-variable names to avoid rewriting inside EVM_RPC_URL.
    let patched = file.content
      .replace(/\bEVM_EVM_RPC_URL\b/g, "EVM_RPC_URL")
      .replace(/\bETHEREUM_RPC_URL\b/g, "EVM_RPC_URL")
      .replace(/\bETH_RPC_URL\b/g, "EVM_RPC_URL")
      .replace(/\bRPC_PROVIDER_URL\b/g, "EVM_RPC_URL")
      .replace(/(^|[^A-Z0-9_])RPC_URL\b/g, "$1EVM_RPC_URL");
    
    // Also normalize private key references
    patched = patched
      .replace(/\bEVM_EVM_PRIVATE_KEY\b/g, "EVM_PRIVATE_KEY")
      .replace(/\bETHEREUM_PRIVATE_KEY\b/g, "EVM_PRIVATE_KEY")
      .replace(/\bETH_PRIVATE_KEY\b/g, "EVM_PRIVATE_KEY");
    
    return { ...file, content: patched };
  });
}

function patchSentimentBotFiles(files: GeneratedFile[], intent: Record<string, unknown>) {
  const solanaSentiment = isSolanaSentimentIntent(intent);
  const initiaSentiment = isInitiaSentimentIntent(intent);

  if (!solanaSentiment && !initiaSentiment) {
    return files;
  }

  const hasIndex = files.some((file) => file.filepath.replace(/^[./]+/, "") === "src/index.ts");
  if (!hasIndex) {
    return files;
  }

  let packageJsonPatched = false;
  let hasMcpBridgeFile = false;

  const patched = files.map((file) => {
    const cleanPath = file.filepath.replace(/^[./]+/, "");
    if (cleanPath === "src/index.ts") {
      if (initiaSentiment) {
        return { ...file, content: buildSafeInitiaSentimentIndexTs() };
      }
      return { ...file, content: buildSafeSolanaSentimentIndexTs() };
    }

    if (cleanPath === "src/mcp_bridge.ts") {
      hasMcpBridgeFile = true;
      return file;
    }

    if (cleanPath === "package.json") {
      packageJsonPatched = true;

      try {
        const raw = typeof file.content === "string" ? file.content : JSON.stringify(file.content ?? {}, null, 2);
        const parsed = JSON.parse(raw) as {
          name?: string;
          description?: string;
          dependencies?: Record<string, string>;
          scripts?: Record<string, string>;
        };

        const dependencies = initiaSentiment
          ? {
              ...(parsed.dependencies ?? {}),
              dotenv: "^16.4.0",
            }
          : {
              ...(parsed.dependencies ?? {}),
              "@solana/web3.js": "^1.98.0",
              bs58: "^6.0.0",
            };

        const scripts = {
          ...(parsed.scripts ?? {}),
          start: parsed.scripts?.start ?? "tsx src/index.ts",
          dev: parsed.scripts?.dev ?? "tsx src/index.ts",
        };

        const nextPkg = {
          ...parsed,
          name: initiaSentiment ? "initia-sentiment-bot" : "solana-sentiment-bot",
          description: initiaSentiment
            ? "Initia sentiment bot using lunarcrush + initia MCP"
            : "Solana sentiment trading bot using LunarCrush + Webacy + Jupiter",
          dependencies,
          scripts,
        };

        return { ...file, content: JSON.stringify(nextPkg, null, 2) };
      } catch {
        // Keep original content if package.json is malformed; fallback package will be appended below.
        return file;
      }
    }

    if (cleanPath === "src/config.ts" && typeof file.content === "string" && file.content.includes("export const config =")) {
      if (file.content.includes("export const CONFIG =") || file.content.includes("export { config as CONFIG }")) {
        return file;
      }
      return { ...file, content: `${file.content}\nexport { config as CONFIG };\n` };
    }

    return file;
  });

  const ensuredMcpBridge = hasMcpBridgeFile
    ? patched
    : [...patched, { filepath: "src/mcp_bridge.ts", content: buildMcpBridgeTs(), language: "typescript" }];

  if (packageJsonPatched) {
    return ensuredMcpBridge;
  }

  const fallbackSentimentPackage = JSON.stringify(
    initiaSentiment
      ? {
          name: "initia-sentiment-bot",
          version: "1.0.0",
          type: "module",
          description: "Initia sentiment bot using lunarcrush + initia MCP",
          scripts: {
            start: "tsx src/index.ts",
            dev: "tsx src/index.ts",
          },
          dependencies: {
            dotenv: "^16.4.0",
          },
          devDependencies: {
            typescript: "^5.4.0",
            "@types/node": "^20.0.0",
            tsx: "^4.7.0",
          },
        }
      : {
          name: "solana-sentiment-bot",
          version: "1.0.0",
          type: "module",
          description: "Solana sentiment trading bot using LunarCrush + Webacy + Jupiter",
          scripts: {
            start: "tsx src/index.ts",
            dev: "tsx src/index.ts",
          },
          dependencies: {
            "@solana/web3.js": "^1.98.0",
            bs58: "^6.0.0",
            dotenv: "^16.4.0",
          },
          devDependencies: {
            typescript: "^5.4.0",
            "@types/node": "^20.0.0",
            tsx: "^4.7.0",
          },
        },
    null,
    2,
  );

  return [...ensuredMcpBridge, { filepath: "package.json", content: fallbackSentimentPackage, language: "json" }];
}

export async function POST(req: NextRequest) {
  const requestId = crypto.randomUUID().slice(0, 8);
  const requestStartedAt = Date.now();
  console.log(`[generate-bot] [${requestId}] Received request`);
  try {
    const body = await req.json();
    console.log(`[generate-bot] [${requestId}] Body keys:`, Object.keys(body));

    // Accept both `prompt` (original) and `expandedPrompt` (pre-expanded by classify-intent).
    // Always prefer the expanded prompt — it gives the meta-agent far more context.
    const expandedPrompt: string = body.expandedPrompt || body.prompt;
    const originalPrompt: string = body.prompt || expandedPrompt;
    const boundedPrompt = compactPromptForMetaAgent(expandedPrompt || originalPrompt || "");
    const envDefaults = loadAgentEnvDefaults();
    const envConfig: Record<string, string> = {
      ...envDefaults,
      ...(body.envConfig || {}),
    };

    if (!boundedPrompt?.trim()) {
      return NextResponse.json({ error: "Prompt is required." }, { status: 400 });
    }

    console.log(`[generate-bot] [${requestId}] Using prompt length:`, boundedPrompt.length, "chars");
    console.log(`[generate-bot] [${requestId}] Meta-Agent timeout: ${META_TIMEOUT_MS}ms retries=${META_RETRIES}`);
    if (boundedPrompt.length > 200) {
      console.log(`[generate-bot] [${requestId}] Prompt preview:`, boundedPrompt.slice(0, 300), "...");
    }

    // Fast preflight: verify Meta-Agent is reachable before a long generation call.
    // Retry a few times to absorb transient startup/busy spikes.
    let healthOk = false;
    let lastHealthError = "unknown error";
    for (let attempt = 1; attempt <= HEALTH_RETRIES + 1; attempt += 1) {
      const healthController = new AbortController();
      const healthTimer = setTimeout(() => healthController.abort(), HEALTH_TIMEOUT_MS);
      try {
        const healthRes = await fetch(`${META_AGENT_URL}/health`, {
          method: "GET",
          headers: { accept: "application/json" },
          signal: healthController.signal,
        });
        clearTimeout(healthTimer);

        if (healthRes.ok) {
          healthOk = true;
          console.log(`[generate-bot] [${requestId}] Meta-Agent health check passed on attempt ${attempt}`);
          break;
        }

        const healthText = await healthRes.text().catch(() => "");
        lastHealthError = `health ${healthRes.status}: ${healthText.slice(0, 200)}`;
      } catch (healthErr: unknown) {
        clearTimeout(healthTimer);
        const msg = healthErr instanceof Error ? healthErr.message : String(healthErr);
        const isAbort = healthErr instanceof DOMException && healthErr.name === "AbortError";
        lastHealthError = isAbort ? "health check timed out" : msg;
      }

      if (attempt <= HEALTH_RETRIES) {
        await delay(400 * attempt);
      }
    }

    if (!healthOk) {
      console.error(`[generate-bot] [${requestId}] Meta-Agent health check failed:`, lastHealthError);
      return NextResponse.json(
        {
          error:
            `Meta-Agent is unavailable (${lastHealthError}) at ${META_AGENT_URL}. ` +
            "Please ensure it is running: cd agents && uvicorn main:app --reload --port 8000",
        },
        { status: 503 }
      );
    }

    // ── Call the Python Universal Meta-Agent ──────────────────────────────
    // We send the EXPANDED prompt so the code-generator has full context.
    // Retry once on timeout/temporary connectivity issue.

    let metaData: {
      output: { files?: Array<{ filepath: string; content: unknown; language?: string }>; thoughts?: string };
      intent: Record<string, unknown>;
      tools_used?: string[];
    } | null = null;

    let lastMetaError = "unknown error";
    let lastMetaStatus = 500;
    for (let attempt = 1; attempt <= META_RETRIES + 1; attempt += 1) {
      const metaController = new AbortController();
      const metaTimer = setTimeout(() => metaController.abort(), META_TIMEOUT_MS);
      const attemptStartedAt = Date.now();
      console.log(`[generate-bot] [${requestId}] Meta-Agent attempt ${attempt}/${META_RETRIES + 1} started`);
      try {
        const metaResponse = await fetch(`${META_AGENT_URL}/create-bot`, {
          method: "POST",
          headers: { "Content-Type": "application/json", accept: "application/json", "x-request-id": requestId },
          body: JSON.stringify({ prompt: boundedPrompt }),
          signal: metaController.signal,
        });

        clearTimeout(metaTimer);

        if (!metaResponse.ok) {
          const errText = await metaResponse.text().catch(() => "");
          lastMetaError = `Meta-Agent HTTP ${metaResponse.status}: ${errText.slice(0, 300)}`;
          lastMetaStatus = metaResponse.status;
          console.error(`[generate-bot] [${requestId}] Meta-Agent attempt ${attempt} failed status=${metaResponse.status} elapsed=${Date.now() - attemptStartedAt}ms`, errText.slice(0, 300));
          if (metaResponse.status === 504) {
            break;
          }
        } else {
          metaData = await metaResponse.json();
          console.log(`[generate-bot] [${requestId}] Meta-Agent attempt ${attempt} succeeded in ${Date.now() - attemptStartedAt}ms`);
          break;
        }
      } catch (fetchErr: unknown) {
        clearTimeout(metaTimer);
        const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
        const isAbort = fetchErr instanceof DOMException && fetchErr.name === "AbortError";
        lastMetaError = msg;

        if (isAbort || msg.toLowerCase().includes("abort")) {
          lastMetaStatus = 504;
        } else if (msg.includes("fetch failed") || msg.includes("ECONNREFUSED")) {
          lastMetaStatus = 503;
        } else {
          lastMetaStatus = 500;
        }
        console.error(`[generate-bot] [${requestId}] Meta-Agent attempt ${attempt} threw after ${Date.now() - attemptStartedAt}ms:`, msg);
        if (lastMetaStatus === 504) {
          break;
        }
      }

      if (attempt <= META_RETRIES) {
        await delay(750 * attempt);
      }
    }

    let usedDeterministicFallback = false;

    if (!metaData) {
      console.error(`[generate-bot] [${requestId}] Meta-Agent generation failed status=${lastMetaStatus} error=${lastMetaError}`);
      if (lastMetaStatus === 504) {
        console.warn(`[generate-bot] [${requestId}] Falling back to deterministic bot files after Meta-Agent timeout`);
        const fallbackIntent = deriveFallbackIntent(boundedPrompt || originalPrompt || "");
        const useInitiaFallback = shouldUseInitiaDeterministicFallback(fallbackIntent);
        metaData = {
          output: {
            thoughts:
              "Meta-Agent timed out, so the deterministic fallback generator was used. " +
              "This preserves the bot build flow while keeping the timeout reason visible in logs.",
            files: useInitiaFallback ? assembleInitiaBotFiles() : assembleBotFiles(),
          },
          intent: fallbackIntent,
          tools_used: ["deterministic-fallback"],
        };
        usedDeterministicFallback = true;
      }

      if (lastMetaStatus === 503 || lastMetaError.includes("fetch failed") || lastMetaError.includes("ECONNREFUSED")) {
        return NextResponse.json(
          {
            error: `Cannot reach the Python Meta-Agent at ${META_AGENT_URL}. ` +
              "Please ensure it is running: cd agents && uvicorn main:app --reload --port 8000",
          },
          { status: 503 }
        );
      }

      if (!usedDeterministicFallback) {
        return NextResponse.json({ error: lastMetaError }, { status: 500 });
      }

      console.log(`[generate-bot] [${requestId}] Deterministic fallback will continue through save/response path`);
    }


    const resolvedMetaData = metaData ?? {
      output: { thoughts: "Deterministic fallback used.", files: [] },
      intent: {},
      tools_used: [],
    };

    console.log(`[generate-bot] [${requestId}] Received meta-agent response in ${Date.now() - requestStartedAt}ms`);
    // Fallback to metaData itself if the agent returned a flat structure
    const output = resolvedMetaData.output || resolvedMetaData;
    const intent = sanitizeIntentMcpLists((resolvedMetaData.intent || {}) as Record<string, unknown>);
    const botName: string = (intent.bot_name as string) || (intent.bot_type as string) || "Universal DeFi Bot";

    // Extract files safely from varying model response shapes
    const filesList = output.files || (metaData as any).files || [];
    const normalizedFiles: GeneratedFile[] = (Array.isArray(filesList) ? filesList : [])
      .map((raw: any, idx: number) => {
        const filepath =
          (typeof raw?.filepath === "string" && raw.filepath.trim()) ||
          (typeof raw?.path === "string" && raw.path.trim()) ||
          (typeof raw?.filename === "string" && raw.filename.trim()) ||
          `generated_${idx + 1}.txt`;

        const content = raw?.content ?? raw?.code ?? raw?.text ?? "";
        const language = typeof raw?.language === "string" ? raw.language : undefined;

        return language ? { filepath, content, language } : { filepath, content };
      })
      .filter((f: { filepath: string }) => ![".env", ".env.example"].includes(f.filepath));

    let files = normalizedFiles;
    files = patchSentimentBotFiles(files, intent);
    files = normalizeRuntimeVarNames(files, intent);

    console.log(`[generate-bot] [${requestId}] Generated files:`, files.map((f: { filepath: string }) => f.filepath).join(", "));

    // ── Build .env content ─────────────────────────────────────────────────
    const publicGatewayFallback = pickPublicGateway(
      envDefaults.MCP_GATEWAY_URL || process.env.MCP_GATEWAY_URL || "",
      "http://localhost:8000/mcp",
    );

    const finalEnv: Record<string, string> = {
      ...envConfig,
      MCP_GATEWAY_URL: pickPublicGateway(envConfig.MCP_GATEWAY_URL || "", publicGatewayFallback),
      SIMULATION_MODE: "false",
    };

    let envPlaintext = "";
    for (const [key, val] of Object.entries(finalEnv)) {
      if (val) envPlaintext += `${key}=${val}\n`;
    }
    const encryptedEnv = encryptEnvConfig(envPlaintext);

    // ── Save agent + files to DB ───────────────────────────────────────────
    const userId = "public-user";
    await prisma.user.upsert({
      where:  { id: userId },
      update: {},
      create: { id: userId, email: `${userId}@placeholder.agentia`, walletAddress: "" },
    });

    const configRecord: Prisma.InputJsonObject = {
      generatedAt:    new Date().toISOString(),
      intent:         intent as Prisma.InputJsonValue,
      toolsUsed:      (resolvedMetaData.tools_used ?? []) as Prisma.InputJsonValue,
      originalPrompt, // Keep original for display
    };

    console.log(`[generate-bot] [${requestId}] Persisting fallback/meta-agent output to DB`);
    const agent = await prisma.agent.create({
      data: {
        name:          botName,
        userId,
        status:        "STOPPED",
        configuration: configRecord,
        envConfig:     encryptedEnv,
        files: {
          create: files.map((f: GeneratedFile) => ({
            filepath: typeof f.filepath === "string" && f.filepath.trim()
              ? f.filepath
              : "generated.txt",
            content:
              typeof f.content === "object"
                ? JSON.stringify(f.content, null, 2)
                : String(f.content),
            language: (() => {
              const fp = typeof f.filepath === "string" ? f.filepath : "";
              return (
                f.language ??
                (fp.endsWith(".ts") ? "typescript"
                  : fp.endsWith(".py") ? "python"
                  : fp.endsWith(".json") ? "json"
                  : "plaintext")
              );
            })(),
          })),
        },
      },
    });

    console.log(`[generate-bot] [${requestId}] Saved agent: ${agent.id} with ${files.length} files in ${Date.now() - requestStartedAt}ms`);

    return NextResponse.json({
      agentId:  agent.id,
      botName,
      files,
      thoughts: output.thoughts ?? "Bot generated successfully.",
      intent,
    });

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[generate-bot] [${requestId}] Error:`, msg);
    return NextResponse.json(
      { error: msg },
      { status: 500 }
    );
  }
}