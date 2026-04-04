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

function buildSafeInitiaYieldSweeperIndexTs(): string {
  return [
    'import * as configModule from "./config.js";',
    'import { callMcpTool } from "./mcp_bridge.js";',
    'import { resolveAddress } from "./ons_resolver.js";',
    '',
    'const config = ((configModule as Record<string, unknown>).CONFIG ?? (configModule as Record<string, unknown>).config ?? {}) as Record<string, unknown>;',
    'const POLL_MS = Number(config.POLL_MS ?? 15000);',
    'const THRESHOLD = BigInt(config.SWEEP_THRESHOLD_UUSDC ?? 1000000n);',
    '',
    'function log(level: string, message: string): void {',
    '  console.log("[" + new Date().toISOString() + "] [" + level + "] " + message);',
    '}',
    '',
    'function toBigInt(value: unknown): bigint | null {',
    '  if (typeof value === "bigint") return value;',
    '  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.trunc(value));',
    '  if (typeof value === "string") {',
    '    const trimmed = value.trim();',
    '    if (!trimmed || !/^[0-9]+$/.test(trimmed)) return null;',
    '    try { return BigInt(trimmed); } catch { return null; }',
    '  }',
    '  return null;',
    '}',
    '',
    'function extractBalance(payload: unknown): bigint | null {',
    '  if (!payload || typeof payload !== "object") return null;',
    '  const root = payload as Record<string, unknown>;',
    '  const direct = toBigInt(root.balance ?? root.amount ?? root.value ?? root.coin_amount);',
    '  if (direct !== null) return direct;',
    '  const result = root.result && typeof root.result === "object" ? (root.result as Record<string, unknown>) : null;',
    '  if (!result) return null;',
    '  const nested = toBigInt(result.balance ?? result.amount ?? result.value ?? result.coin_amount);',
    '  if (nested !== null) return nested;',
    '  const content = result.content;',
    '  if (Array.isArray(content) && content.length > 0) {',
    '    for (const item of content) {',
    '      if (!item || typeof item !== "object") continue;',
    '      const text = (item as Record<string, unknown>).text;',
    '      if (typeof text !== "string") continue;',
    '      const digits = text.replace(/[^0-9]/g, "");',
    '      const parsed = toBigInt(digits);',
    '      if (parsed !== null) return parsed;',
    '    }',
    '  }',
    '  return null;',
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
    'async function resolveWalletAddress(): Promise<string> {',
    '  const configured = String(config.USER_WALLET_ADDRESS ?? "").trim();',
    '  if (!configured) throw new Error("USER_WALLET_ADDRESS is required");',
    '  return resolveAddress(configured);',
    '}',
    '',
    'async function runCycle(): Promise<void> {',
    '  const wallet = await resolveWalletAddress();',
    '  const bridge = String(config.INITIA_BRIDGE_ADDRESS ?? "").trim();',
    '  if (!wallet || !bridge) throw new Error("USER_WALLET_ADDRESS and INITIA_BRIDGE_ADDRESS are required");',
    '  let payload: unknown = null;',
    '  try {',
    '    payload = await callMcpTool("initia", "move_view", {',
    '      network: String(config.INITIA_NETWORK ?? "initia-testnet"),',
    '      address: "0x1",',
    '      module: "coin",',
    '      function: "balance",',
    '      args: [wallet, "uusdc"],',
    '    });',
    '  } catch (error) {',
    '    const msg = error instanceof Error ? error.message : String(error);',
    '    log("WARN", "move_view failed: " + msg);',
    '    return;',
    '  }',
    '  const balance = extractBalance(payload) ?? 0n;',
    '  log("INFO", "[SCAN] balance=" + balance.toString() + " threshold=" + THRESHOLD.toString());',
    '  if (balance <= THRESHOLD) return;',
    '  let result: unknown = null;',
    '  try {',
    '    result = await callMcpTool("initia", "move_execute", {',
    '      network: String(config.INITIA_NETWORK ?? "initia-testnet"),',
    '      address: bridge,',
    '      module: "interwoven_bridge",',
    '      function: "sweep_to_l1",',
    '      args: [balance.toString()],',
    '    });',
    '  } catch (error) {',
    '    const msg = error instanceof Error ? error.message : String(error);',
    '    log("WARN", "move_execute failed: " + msg);',
    '    return;',
    '  }',
    '  log("INFO", "[ACT] sweep result=" + JSON.stringify(result ?? {}));',
    '}',
    '',
    'let inFlight = false;',
    'let timer: ReturnType<typeof setTimeout> | null = null;',
    '',
    'async function tick(): Promise<void> {',
    '  if (inFlight) return;',
    '  inFlight = true;',
    '  try {',
    '    await runCycle();',
    '  } catch (error) {',
    '    const msg = error instanceof Error ? error.message : String(error);',
    '    log("ERROR", msg);',
    '  } finally {',
    '    inFlight = false;',
    '    if (timer) clearTimeout(timer);',
    '    timer = setTimeout(() => { void tick(); }, POLL_MS);',
    '  }',
    '}',
    '',
    'void tick();',
    '',
    'process.on("SIGINT", () => process.exit(0));',
    'process.on("SIGTERM", () => process.exit(0));',
  ].join("\n");
}

function buildSafeInitiaSpreadScannerIndexTs(): string {
  return [
    'import * as configModule from "./config.js";',
    'import { callMcpTool } from "./mcp_bridge.js";',
    '',
    'const config = ((configModule as Record<string, unknown>).CONFIG ?? (configModule as Record<string, unknown>).config ?? {}) as Record<string, unknown>;',
    'const POLL_MS = Number(config.POLL_MS ?? 15000);',
    'const ESTIMATED_BRIDGE_FEE_USDC = BigInt(config.ESTIMATED_BRIDGE_FEE_USDC ?? 5000n);',
    '',
    'function requireConfiguredAddress(name: string, value: unknown): string {',
    '  const resolved = String(value ?? "").trim();',
    '  if (!resolved) throw new Error(name + " is not set");',
    '  return resolved;',
    '}',
    '',
    'const poolAAddress = requireConfiguredAddress("INITIA_POOL_A_ADDRESS", config.INITIA_POOL_A_ADDRESS);',
    'const poolBAddress = requireConfiguredAddress("INITIA_POOL_B_ADDRESS", config.INITIA_POOL_B_ADDRESS);',
    'const ENDPOINTS = [',
    '  { id: "minitia-a", address: poolAAddress },',
    '  { id: "minitia-b", address: poolBAddress },',
    '];',
    '',
    'function log(level: string, message: string): void {',
    '  console.log("[" + new Date().toISOString() + "] [" + level + "] " + message);',
    '}',
    '',
    'function toBigInt(value: unknown): bigint | null {',
    '  if (typeof value === "bigint") return value;',
    '  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.trunc(value));',
    '  if (typeof value === "string") {',
    '    const trimmed = value.trim();',
    '    if (!trimmed) return null;',
    '    if (!/^[0-9]+$/.test(trimmed)) return null;',
    '    try { return BigInt(trimmed); } catch { return null; }',
    '  }',
    '  return null;',
    '}',
    '',
    'function extractPrice(payload: unknown): bigint | null {',
    '  if (payload && typeof payload === "object") {',
    '    const root = payload as Record<string, unknown>;',
    '    const direct = toBigInt(root.balance ?? root.amount ?? root.value ?? root.coin_amount);',
    '    if (direct !== null) return direct;',
    '    const result = root.result && typeof root.result === "object" ? (root.result as Record<string, unknown>) : null;',
    '    if (result) {',
    '      const nested = toBigInt(result.balance ?? result.amount ?? result.value ?? result.coin_amount);',
    '      if (nested !== null) return nested;',
    '    }',
    '  }',
    '  return null;',
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
    'async function runCycle(): Promise<void> {',
    '  log("INFO", "Spread scan cycle start");',
    '  const quotes = await Promise.allSettled(',
    '    ENDPOINTS.map((endpoint) => safeMcp("initia", "move_view", {',
    '      network: String(config.INITIA_NETWORK ?? "initia-testnet"),',
    '      address: "0x1",',
    '      module: "coin",',
    '      function: "balance",',
    '      args: [endpoint.address, "uusdc"],',
    '    }).then((payload) => ({ endpoint, payload })))',
    '  );',
    '',
    '  const prices: Array<{ id: string; price: bigint }> = [];',
    '  for (const settled of quotes) {',
    '    if (settled.status !== "fulfilled") {',
    '      const msg = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);',
    '      log("WARN", "Endpoint quote failed: " + msg);',
    '      continue;',
    '    }',
    '    const { endpoint, payload } = settled.value;',
    '    const price = extractPrice(payload);',
    '    if (price === null) {',
    '      log("WARN", "[SCAN] " + endpoint.id + " returned non-numeric payload");',
    '      continue;',
    '    }',
    '    prices.push({ id: endpoint.id, price });',
    '    log("INFO", "[SCAN] " + endpoint.id + " price=" + price.toString());',
    '  }',
    '',
    '  if (prices.length < 2) {',
    '    log("WARN", "Insufficient quotes for spread calculation");',
    '    return;',
    '  }',
    '',
    '  const low = prices.reduce((best, current) => (current.price < best.price ? current : best), prices[0]);',
    '  const high = prices.reduce((best, current) => (current.price > best.price ? current : best), prices[0]);',
    '  const grossSpread = high.price > low.price ? high.price - low.price : 0n;',
    '  const netOpportunity = grossSpread > ESTIMATED_BRIDGE_FEE_USDC ? grossSpread - ESTIMATED_BRIDGE_FEE_USDC : 0n;',
    '  log("INFO", "[QUANTIFY] gross=" + grossSpread.toString() + " fee=" + ESTIMATED_BRIDGE_FEE_USDC.toString() + " net=" + netOpportunity.toString());',
    '}',
    '',
    'let inFlight = false;',
    'let timer: ReturnType<typeof setTimeout> | null = null;',
    '',
    'async function tick(): Promise<void> {',
    '  if (inFlight) return;',
    '  inFlight = true;',
    '  try {',
    '    await runCycle();',
    '  } catch (error) {',
    '    const msg = error instanceof Error ? error.message : String(error);',
    '    log("ERROR", msg);',
    '  } finally {',
    '    inFlight = false;',
    '    if (timer) clearTimeout(timer);',
    '    timer = setTimeout(() => { void tick(); }, POLL_MS);',
    '  }',
    '}',
    '',
    'function stop(): void {',
    '  if (timer) clearTimeout(timer);',
    '  timer = null;',
    '}',
    '',
    'void tick();',
    '',
    'process.on("SIGINT", () => {',
    '  stop();',
    '  log("INFO", "Shutdown complete");',
    '  process.exit(0);',
    '});',
    '',
    'process.on("SIGTERM", () => {',
    '  stop();',
    '  log("INFO", "Shutdown complete");',
    '  process.exit(0);',
    '});',
  ].join("\n");
}

function patchInitiaStrategyBotFiles(
  files: GeneratedFile[],
  intent: Record<string, unknown>,
  promptText = "",
): GeneratedFile[] {
  if (String(intent.chain ?? "").toLowerCase() !== "initia") {
    return files;
  }

  const normalizedPrompt = String(promptText ?? "").toLowerCase();
  const promptIsCrossChain = /(liquidation sniper|omni-chain liquidat|cross[-. ]chain liquidat|flash[-. ]bridge|spatial arb|cross[-. ]chain arb|yield nomad|auto[-. ]compounder|omni[-. ]chain yield)/.test(normalizedPrompt);
  const promptIsYieldSweeper = !promptIsCrossChain && /(yield sweeper|auto-consolidator|auto consolidator|consolidate idle funds|sweep_to_l1|bridge back to l1|sweep)/.test(normalizedPrompt);
  const promptIsSpreadScanner = /(spread scanner|read-only scanner|read only scanner|market intelligence)/.test(normalizedPrompt);

  const isYieldSweeper = promptIsYieldSweeper || isInitiaYieldSweeperIntent(intent);
  const isSpreadScanner = !isYieldSweeper && (promptIsSpreadScanner || isInitiaSpreadScannerIntent(intent));

  if (!isYieldSweeper && !isSpreadScanner) {
    return files;
  }

  const hasIndex = files.some((file) => file.filepath.replace(/^[./]+/, "") === "src/index.ts");
  if (!hasIndex) {
    return files;
  }

  return files.map((file) => {
    const cleanPath = file.filepath.replace(/^[./]+/, "");
    if (cleanPath === "src/index.ts") {
      return {
        ...file,
        content: isYieldSweeper ? buildSafeInitiaYieldSweeperIndexTs() : buildSafeInitiaSpreadScannerIndexTs(),
      };
    }
    if (cleanPath === "src/config.ts") {
      return {
        ...file,
        content: isYieldSweeper ? buildSafeInitiaYieldConfigTs() : buildSafeInitiaSpreadConfigTs(),
      };
    }
    return file;
  });
}

function buildSafeInitiaSentimentIndexTs(): string {
  return [
    'import * as configModule from "./config.js";',
    'import { callMcpTool } from "./mcp_bridge.js";',
    '',
    'const config = ((configModule as Record<string, unknown>).config ?? (configModule as Record<string, unknown>).CONFIG ?? {}) as Record<string, unknown>;',
    'const POLL_MS = 15000;',
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
    'function toBigInt(value: unknown): bigint | null {',
    '  if (typeof value === "bigint") return value;',
    '  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.trunc(value));',
    '  if (typeof value === "string") {',
    '    const trimmed = value.trim();',
    '    if (!/^[0-9]+$/.test(trimmed)) return null;',
    '    try { return BigInt(trimmed); } catch { return null; }',
    '  }',
    '  return null;',
    '}',
    '',
    'function extractBalance(payload: unknown): bigint | null {',
    '  if (!payload || typeof payload !== "object") return null;',
    '  const root = payload as Record<string, unknown>;',
    '  const direct = toBigInt(root.balance ?? root.amount ?? root.value ?? root.coin_amount);',
    '  if (direct !== null) return direct;',
    '  const result = (root.result && typeof root.result === "object") ? (root.result as Record<string, unknown>) : null;',
    '  if (!result) return null;',
    '  return toBigInt(result.balance ?? result.amount ?? result.value ?? result.coin_amount);',
    '}',
    '',
    'async function readPoolBalance(address: string): Promise<bigint | null> {',
    '  const payload = await safeMcp("initia", "move_view", {',
    '    network: String(process.env.INITIA_NETWORK ?? "initia-testnet"),',
    '    address: "0x1",',
    '    module: "coin",',
    '    function: "balance",',
    '    args: [address, "uusdc"],',
    '  });',
    '  return extractBalance(payload);',
    '}',
    '',
    'async function fetchPrices(poolAAddress: string, poolBAddress: string): Promise<{ poolA: bigint; poolB: bigint }> {',
    '  const [poolA, poolB] = await Promise.all([readPoolBalance(poolAAddress), readPoolBalance(poolBAddress)]);',
    '  if (poolA === null || poolB === null) {',
    '    throw new Error("Failed to parse pool balances from move_view payload");',
    '  }',
    '  log("INFO", "[LISTEN] Pool A balance: " + poolA.toString());',
    '  log("INFO", "[LISTEN] Pool B balance: " + poolB.toString());',
    '  return { poolA, poolB };',
    '}',
    '',
    'async function runCycle(): Promise<void> {',
    '  log("INFO", "Initia sentiment cycle start");',
    '  const poolAAddress = requireConfiguredAddress("INITIA_POOL_A_ADDRESS", process.env.INITIA_POOL_A_ADDRESS ?? "");',
    '  const poolBAddress = requireConfiguredAddress("INITIA_POOL_B_ADDRESS", process.env.INITIA_POOL_B_ADDRESS ?? "");',
    '  const flashPoolAddress = requireConfiguredAddress("INITIA_FLASH_POOL_ADDRESS", process.env.INITIA_FLASH_POOL_ADDRESS ?? "");',
    '  const swapRouterAddress = requireConfiguredAddress("INITIA_SWAP_ROUTER_ADDRESS", process.env.INITIA_SWAP_ROUTER_ADDRESS ?? "");',
    '  const [sentiment] = await Promise.all([',
    '    safeMcp("lunarcrush", "get_coin_details", { coin: "INIT", symbol: "INIT" }),',
    '  ]);',
    '  const { poolA, poolB } = await fetchPrices(poolAAddress, poolBAddress);',
    '  const spread = poolA > poolB ? poolA - poolB : poolB - poolA;',
    '',
    '  const score = extractScore(sentiment);',
    '  log("INFO", "Sentiment score=" + score);',
    '  log("INFO", "Spread=" + spread.toString() + " p1=" + poolA.toString() + " p2=" + poolB.toString());',
    '  if (spread < 2000n) {',
    '    log("INFO", "Spread below threshold; hold");',
    '    return;',
    '  }',
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
    'let pollTimer: ReturnType<typeof setTimeout> | null = null;',
    'let backoffMs = POLL_MS;',
    '',
    'function scheduleNextCycle(delayMs: number): void {',
    '  if (pollTimer) clearTimeout(pollTimer);',
    '  pollTimer = setTimeout(() => { void tick(); }, delayMs);',
    '}',
    '',
    'const tick = async (): Promise<void> => {',
    '  if (inFlight) return;',
    '  inFlight = true;',
    '  try {',
    '    await runCycle();',
    '    backoffMs = POLL_MS;',
    '  } catch (error) {',
    '    const msg = error instanceof Error ? error.message : String(error);',
    '    log("ERROR", msg);',
    '    backoffMs = Math.min(POLL_MS * 8, Math.max(POLL_MS, backoffMs * 2));',
    '  } finally {',
    '    inFlight = false;',
    '    scheduleNextCycle(backoffMs);',
    '  }',
    '};',
    '',
    'void tick();',
    '',
    'function stopPolling(): void {',
    '  if (pollTimer) clearTimeout(pollTimer);',
    '  pollTimer = null;',
    '}',
    '',
    'process.on("SIGINT", () => {',
    '  stopPolling();',
    '  log("INFO", "Shutting down bot");',
    '  process.exit(0);',
    '});',
    '',
    'process.on("SIGTERM", () => {',
    '  stopPolling();',
    '  log("INFO", "Shutting down bot");',
    '  process.exit(0);',
    '});',
  ].join("\n");
}

function buildMcpBridgeTs(): string {
  return [
    'const MCP_GATEWAY_URL = process.env.MCP_GATEWAY_URL ?? "http://localhost:8000/mcp";',
    'const MCP_GATEWAY_UPSTREAM_URL = process.env.MCP_GATEWAY_UPSTREAM_URL ?? "";',
    'const INITIA_KEY = process.env.INITIA_KEY ?? "";',
    '',
    'function isProxyGateway(value: string): boolean {',
    '  return /\\/api\\/mcp-proxy\\/?$/i.test(String(value || ""));',
    '}',
    '',
    'function normalizeGatewayBase(raw: string): string {',
    '  const value = String(raw ?? "").trim() || "http://localhost:8000/mcp";',
    '  const base = value.replace(/\\/+$/, "");',
    '  if (isProxyGateway(base)) return base;',
    '  return /\\/mcp$/i.test(base) ? base : `${base}/mcp`;',
    '}',
    '',
    'function parseMcpJsonResponse(body: string): unknown | null {',
    '  const trimmed = String(body || "").trim();',
    '  if (!trimmed) return null;',
    '  try {',
    '    return JSON.parse(trimmed);',
    '  } catch {}',
    '  const firstBrace = trimmed.indexOf("{");',
    '  const lastBrace = trimmed.lastIndexOf("}");',
    '  if (firstBrace >= 0 && lastBrace > firstBrace) {',
    '    try {',
    '      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));',
    '    } catch {}',
    '  }',
    '  return null;',
    '}',
    '',
    'export async function callMcpTool(server: string, tool: string, args: Record<string, unknown>): Promise<unknown> {',
    '  if (server === "initia" && tool === "move_execute" && !INITIA_KEY) {',
    '    throw new Error("INITIA_KEY missing for move_execute. Enable AutoSign session key mode and relaunch.");',
    '  }',
    '  const base = normalizeGatewayBase(MCP_GATEWAY_URL);',
    '  const url = `${base}/${server}/${tool}`;',
    '  console.log(`[MCP] request start server=${server} tool=${tool} base=${base} url=${url} upstream=${MCP_GATEWAY_UPSTREAM_URL || "<empty>"}`);',
    '  let response: Response;',
    '  try {',
    '    response = await fetch(url, {',
    '      method: "POST",',
    '      headers: {',
    '        "Content-Type": "application/json",',
    '        ...(INITIA_KEY ? { "x-session-key": INITIA_KEY } : {}),',
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
    '  const body = await response.text().catch(() => "");',
    '  const parsed = parseMcpJsonResponse(body);',
    '  if (parsed !== null) return parsed;',
    '  const snippet = body.replace(/\\s+/g, " ").slice(0, 200);',
    '  throw new Error(`MCP ${server}/${tool} invalid JSON body: ${snippet}`);',
    '}',
    '',
  ].join("\n");
}

function normalizeRuntimeVarNames(files: GeneratedFile[]): GeneratedFile[] {
  return files.map((file) => {
    if (typeof file.content !== "string") return file;

    const patched = file.content
      .replace(/\bRPC_PROVIDER_URL\b/g, "INITIA_RPC_URL")
      .replace(/\bRPC_URL\b/g, "INITIA_RPC_URL")
      .replace(/\bWALLET_PRIVATE_KEY\b/g, "INITIA_KEY")
      .replace(/\bPRIVATE_KEY\b/g, "INITIA_KEY");

    return { ...file, content: patched };
  });
}

function patchSentimentBotFiles(files: GeneratedFile[], intent: Record<string, unknown>) {
  const initiaSentiment = isInitiaSentimentIntent(intent);

  if (!initiaSentiment) {
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
      return { ...file, content: buildSafeInitiaSentimentIndexTs() };
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

        const dependencies = {
          ...(parsed.dependencies ?? {}),
          dotenv: "^16.4.0",
        };

        const scripts = {
          ...(parsed.scripts ?? {}),
          start: parsed.scripts?.start ?? "tsx src/index.ts",
          dev: parsed.scripts?.dev ?? "tsx src/index.ts",
        };

        const nextPkg = {
          ...parsed,
          name: "initia-sentiment-bot",
          description: "Initia sentiment bot using lunarcrush + initia MCP",
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
    {
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
    },
    null,
    2,
  );

  return [...ensuredMcpBridge, { filepath: "package.json", content: fallbackSentimentPackage, language: "json" }];
}

function buildSafeInitiaYieldConfigTs(): string {
  return [
    'export const config = {',
    '  INITIA_NETWORK: process.env.INITIA_NETWORK ?? "initia-testnet",',
    '  USER_WALLET_ADDRESS: process.env.USER_WALLET_ADDRESS ?? "",',
    '  ONS_REGISTRY_ADDRESS: process.env.ONS_REGISTRY_ADDRESS ?? "0x1",',
    '  INITIA_BRIDGE_ADDRESS: process.env.INITIA_BRIDGE_ADDRESS ?? "",',
    '  SWEEP_THRESHOLD_UUSDC: BigInt(process.env.SWEEP_THRESHOLD_UUSDC ?? "1000000"),',
    '  POLL_MS: Number(process.env.POLL_MS ?? "15000"),',
    '};',
    '',
    'export const CONFIG = config;',
  ].join("\n");
}

function buildSafeInitiaSpreadConfigTs(): string {
  return [
    'export const config = {',
    '  INITIA_NETWORK: process.env.INITIA_NETWORK ?? "initia-testnet",',
    '  INITIA_POOL_A_ADDRESS: process.env.INITIA_POOL_A_ADDRESS ?? "",',
    '  INITIA_POOL_B_ADDRESS: process.env.INITIA_POOL_B_ADDRESS ?? "",',
    '  ESTIMATED_BRIDGE_FEE_USDC: BigInt(process.env.ESTIMATED_BRIDGE_FEE_USDC ?? "5000"),',
    '  POLL_MS: Number(process.env.POLL_MS ?? "15000"),',
    '};',
    '',
    'export const CONFIG = config;',
 

function buildSafeInitiaOnsResolverTs(): string {
  return [
    'import { callMcpTool } from "./mcp_bridge.js";',
    'import { CONFIG } from "./config.js";',
    '',
    'const _resolvedCache = new Map<string, string>();',
    '',
    'export function isInitName(value: string): boolean {',
    '  return /^[a-z0-9_-]+\\.init$/i.test(String(value ?? "").trim());',
    '}',
    '',
    'function extractAddressFromPayload(payload: unknown): string | null {',
    '  if (!payload || typeof payload !== "object") return null;',
    '  const root = payload as Record<string, unknown>;',
    '  for (const field of ["address", "resolved_address", "value", "account"]) {',
    '    if (typeof root[field] === "string" && (root[field] as string).trim()) {',
    '      return (root[field] as string).trim();',
    '    }',
    '  }',
    '  const result = root.result;',
    '  if (result && typeof result === "object") {',
    '    const content = (result as Record<string, unknown>).content;',
    '    if (Array.isArray(content) && content.length > 0) {',
    '      const text = (content[0] as Record<string, unknown>).text;',
    '      if (typeof text === "string") {',
    '        const trimmed = text.trim();',
    '        if (trimmed.startsWith("{")) {',
    '          try {',
    '            const inner = JSON.parse(trimmed) as Record<string, unknown>;',
    '            for (const field of ["address", "resolved_address", "value"]) {',
    '              if (typeof inner[field] === "string") return (inner[field] as string).trim();',
    '            }',
    '          } catch {',
    '          }',
    '        }',
    '        if (trimmed.startsWith("init1") || trimmed.startsWith("0x")) {',
    '          return trimmed;',
    '        }',
    '      }',
    '    }',
    '  }',
    '  return null;',
    '}',
    '',
    'export async function resolveAddress(nameOrAddress: string): Promise<string> {',
    '  const normalized = String(nameOrAddress ?? "").trim().toLowerCase();',
    '  if (!isInitName(normalized)) {',
    '    return String(nameOrAddress ?? "").trim();',
    '  }',
    '  const cached = _resolvedCache.get(normalized);',
    '  if (cached) {',
    '    return cached;',
    '  }',
    '  const response = await callMcpTool("initia", "move_view", {',
    '    network: String(CONFIG.INITIA_NETWORK ?? "initia-testnet"),',
    '    address: String(process.env.ONS_REGISTRY_ADDRESS ?? CONFIG.ONS_REGISTRY_ADDRESS ?? "0x1"),',
    '    module: "initia_names",',
    '    function: "resolve",',
    '    args: [normalized],',
    '  });',
    '  const resolved = extractAddressFromPayload(response);',
    '  if (!resolved) {',
    '    throw new Error(`ONS registry returned no address for \'${normalized}\'`);',
    '  }',
    '  _resolvedCache.set(normalized, resolved);',
    '  return resolved;',
    '}',
    '',
  ].join("\n");
}
 ].join("\n");
}

function isInitiaYieldSweeperIntent(intent: Record<string, unknown>): boolean {
  const strategy = String(intent.strategy ?? "").toLowerCase();
  const botType = String(intent.bot_type ?? intent.bot_name ?? "").toLowerCase();
  if (strategy === "cross_chain_sweep") return false;
  return strategy === "yield" || strategy === "yield_sweeper" || /sweep|yield/.test(botType);
}

function isInitiaSpreadScannerIntent(intent: Record<string, unknown>): boolean {
  const strategy = String(intent.strategy ?? "").toLowerCase();
  const botType = String(intent.bot_type ?? intent.bot_name ?? "").toLowerCase();
  return strategy === "arbitrage" || /spread scanner|market intelligence/.test(botType);
}

function isInitiaSentimentIntent(intent: Record<string, unknown>): boolean {
  const strategy = String(intent.strategy ?? "").toLowerCase();
  return strategy === "sentiment";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deriveFallbackIntent(prompt: string): Record<string, unknown> {
  const lowered = String(prompt ?? "").toLowerCase();
  const isCrossChainLiquidation = /(liquidation sniper|omni-chain liquidat|cross[-. ]chain liquidat)/.test(lowered);
  const isCrossChainArbitrage = /(flash[-. ]bridge|spatial arb|cross[-. ]chain arb)/.test(lowered);
  const isCrossChainSweep = /(yield nomad|auto[-. ]compounder|omni[-. ]chain yield)/.test(lowered);
  const isYield = /(yield sweeper|auto-consolidator|sweep_to_l1|bridge back to l1|sweep)/.test(lowered);
  const isSentiment = /(sentiment|lunarcrush|social)/.test(lowered);
  const isCustomUtility = /(custom utility|custom workflow|intent:\s*custom|strategy:\s*custom)/.test(lowered);

  if (isCrossChainLiquidation) {
    return {
      chain: "initia",
      network: "initia-testnet",
      execution_model: "polling",
      strategy: "cross_chain_liquidation",
      bot_type: "Omni-Chain Liquidation Sniper",
      bot_name: "Omni-Chain Liquidation Sniper",
      mcps: ["initia"],
      required_mcps: ["initia"],
      requires_openai_key: false,
    };
  }

  if (isCrossChainArbitrage) {
    return {
      chain: "initia",
      network: "initia-testnet",
      execution_model: "polling",
      strategy: "cross_chain_arbitrage",
      bot_type: "Flash-Bridge Spatial Arbitrageur",
      bot_name: "Flash-Bridge Spatial Arbitrageur",
      mcps: ["initia"],
      required_mcps: ["initia"],
      requires_openai_key: false,
    };
  }

  if (isCrossChainSweep) {
    return {
      chain: "initia",
      network: "initia-testnet",
      execution_model: "polling",
      strategy: "cross_chain_sweep",
      bot_type: "Omni-Chain Yield Nomad",
      bot_name: "Omni-Chain Yield Nomad",
      mcps: ["initia"],
      required_mcps: ["initia"],
      requires_openai_key: false,
    };
  }

  if (isCustomUtility) {
    return {
      chain: "initia",
      network: "initia-testnet",
      execution_model: "polling",
      strategy: "custom_utility",
      bot_type: "Custom Utility Initia Bot",
      mcps: ["initia"],
      required_mcps: ["initia"],
      requires_openai_key: false,
    };
  }

  if (isSentiment) {
    return {
      chain: "initia",
      network: "initia-testnet",
      execution_model: "agentic",
      strategy: "sentiment",
      bot_type: "Initia Sentiment Bot",
      mcps: ["initia", "lunarcrush"],
      required_mcps: ["initia", "lunarcrush"],
      requires_openai_key: true,
    };
  }

  if (isYield) {
    return {
      chain: "initia",
      network: "initia-testnet",
      execution_model: "polling",
      strategy: "yield",
      bot_type: "Cross-Rollup Yield Sweeper",
      mcps: ["initia"],
      required_mcps: ["initia"],
      requires_openai_key: false,
    };
  }

  return {
    chain: "initia",
    network: "initia-testnet",
    execution_model: "polling",
    strategy: "arbitrage",
    bot_type: "Cross-Rollup Spread Scanner",
    mcps: ["initia"],
    required_mcps: ["initia"],
    requires_openai_key: false,
  };
}

function pickPublicGateway(preferred: string, fallback: string): string {
  const value = String(preferred ?? "").trim();
  if (value) return value;
  return fallback;
}

function loadAgentEnvDefaults(): Record<string, string> {
  const out: Record<string, string> = {};
  const candidates = [
    path.resolve(process.cwd(), "../agents/.env"),
    path.resolve(process.cwd(), "../agents/.env.local"),
  ];

  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const parsed = parseEnvText(fs.readFileSync(file, "utf8"));
      Object.assign(out, parsed);
    } catch {
      // ignore missing/unreadable defaults
    }
  }

  return out;
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
        const useInitiaFallback = shouldUseInitiaDeterministicFallback();
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
    const fallbackFiles = metaData && typeof metaData === "object" && "files" in metaData
      ? (metaData as unknown as { files?: unknown }).files
      : [];
    const filesList = output.files || fallbackFiles || [];
    const normalizedFiles: GeneratedFile[] = (Array.isArray(filesList) ? filesList : [])
      .map((raw: unknown, idx: number) => {
        const candidate = raw as Record<string, unknown>;
        const filepath =
          (typeof candidate?.filepath === "string" && candidate.filepath.trim()) ||
          (typeof candidate?.path === "string" && candidate.path.trim()) ||
          (typeof candidate?.filename === "string" && candidate.filename.trim()) ||
          `generated_${idx + 1}.txt`;

        const content = candidate?.content ?? candidate?.code ?? candidate?.text ?? "";
        const language = typeof candidate?.language === "string" ? candidate.language : undefined;

        return language ? { filepath, content, language } : { filepath, content };
      })
      .filter((f: { filepath: string }) => ![".env", ".env.example"].includes(f.filepath));

    let files = normalizedFiles;
    files = patchInitiaStrategyBotFiles(files, intent, `${originalPrompt}\n${expandedPrompt}`);
    files = patchSentimentBotFiles(files, intent);
    files = normalizeRuntimeVarNames(files);

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

    const sessionKeyMode = String(finalEnv.SESSION_KEY_MODE || "").toLowerCase() === "true";
    if (sessionKeyMode) {
      // Session key is browser-derived and injected only at runtime.
      delete finalEnv.INITIA_KEY;
      finalEnv.SESSION_KEY_MODE = "true";
    }

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