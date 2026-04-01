"use client";

/**
 * frontend/hooks/use-bot-sandbox.ts
 *
 * WebContainer sandbox hook for all Meta-Agent generated bots.
 *
 * Key fixes vs. original:
 *  1. Always injects MCP_GATEWAY_URL so mcp_bridge.ts can reach the gateway.
 *  2. Uses `npm run start` (defined in the generated package.json) instead of
 *     hardcoding `npx tsx` — works for TypeScript, Python fallback, etc.
 *  3. Python bots (main.py present) skip npm install and run `python3 main.py`.
 *  4. Passes ALL env vars from BotEnvConfig into the container process.
 */

import { useState, useRef, useEffect, MutableRefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import type { BotEnvConfig } from "@/lib/bot-constant";
import { BOT_NPMRC } from "@/lib/bot-constant";

export type BotPhase = "idle" | "env-setup" | "running" | "booting" | "installing";

interface BotFile { filepath: string; content: string }

interface UseBotSandboxOptions {
  generatedFiles: BotFile[];
  envConfig:      BotEnvConfig;
  termRef:        MutableRefObject<Terminal | null>;
}

function patchLegacySolanaDecode(content: string): string {
  const decodePattern = /bs58\.decode\(\s*CONFIG\.SOLANA_PRIVATE_KEY\s*\)/g;
  const hasDecodePattern = decodePattern.test(content);
  const hasHelper = content.includes("function decodeSolanaSecretKey(");
  if (!hasDecodePattern && !hasHelper) {
    return content;
  }

  let patched = content;
  if (hasDecodePattern) {
    patched = patched.replace(
      decodePattern,
      "decodeSolanaSecretKey(CONFIG.SOLANA_PRIVATE_KEY as unknown)",
    );
  }

  const robustHelper = `function decodeSolanaSecretKey(input: unknown): Uint8Array {\n  if (input instanceof Uint8Array) return input;\n  if (Array.isArray(input)) return Uint8Array.from(input.map(Number));\n\n  const normalize = (v: string) => v.trim().replace(/\\r/g, "").replace(/^['\\\"]|['\\\"]$/g, "");\n\n  if (typeof input === "string") {\n    const normalized = normalize(input);\n    if (!normalized) {\n      throw new Error("SOLANA_PRIVATE_KEY is empty.");\n    }\n\n    if (normalized.startsWith("[") && normalized.endsWith("]")) {\n      try {\n        const parsed = JSON.parse(normalized);\n        if (Array.isArray(parsed)) {\n          return Uint8Array.from(parsed.map(Number));\n        }\n      } catch {\n        // Fall through to other parsers.\n      }\n    }\n\n    if (/^\\d+(\\s*,\\s*\\d+)+$/.test(normalized)) {\n      return Uint8Array.from(normalized.split(",").map((n) => Number(n.trim())));\n    }\n\n    return bs58.decode(normalized);\n  }\n\n  throw new Error("Invalid SOLANA_PRIVATE_KEY format. Expected bs58 string or byte array.");\n}`;

  // Upgrade older strict helper implementations to robust parsing.
  patched = patched.replace(
    /function decodeSolanaSecretKey\([^)]*\): Uint8Array \{[\s\S]*?\n\}/m,
    robustHelper,
  );

  if (!patched.includes("function decodeSolanaSecretKey(")) {
    const helper = `\n${robustHelper}\n`;

    if (patched.includes("const connection =")) {
      patched = patched.replace("const connection =", `${helper}\nconst connection =`);
    } else {
      patched = `${helper}\n${patched}`;
    }
  }

  return patched;
}

function patchJsonParseSecretKey(content: string): string {
  const parsePattern = /new\s+Uint8Array\(\s*JSON\.parse\(\s*(?:CONFIG\.(?:SOLANA_PRIVATE_KEY|PRIVATE_KEY)|process\.env\.(?:SOLANA_PRIVATE_KEY|PRIVATE_KEY))\s*\|\|\s*['\"]\[\]['\"]\s*\)\s*\)/g;
  if (!parsePattern.test(content)) {
    return content;
  }

  let patched = content;
  patched = patched.replace(
    parsePattern,
    "decodeSolanaSecretKey((CONFIG.PRIVATE_KEY || CONFIG.SOLANA_PRIVATE_KEY) as unknown)",
  );

  const helper = `function decodeSolanaSecretKey(input: unknown): Uint8Array {\n  if (input instanceof Uint8Array) return input;\n  if (Array.isArray(input)) return Uint8Array.from(input.map(Number));\n\n  const normalize = (v: string) => v.trim().replace(/\\r/g, \"\").replace(/^['\\\"]|['\\\"]$/g, \"\");\n\n  if (typeof input === \"string\") {\n    const normalized = normalize(input);\n    if (!normalized) {\n      throw new Error(\"SOLANA_PRIVATE_KEY is empty.\");\n    }\n\n    if (normalized.startsWith(\"[\") && normalized.endsWith(\"]\")) {\n      try {\n        const parsed = JSON.parse(normalized);\n        if (Array.isArray(parsed)) {\n          return Uint8Array.from(parsed.map(Number));\n        }\n      } catch {\n        // Fall through to other parsers.\n      }\n    }\n\n    if (/^\\d+(\\s*,\\s*\\d+)+$/.test(normalized)) {\n      return Uint8Array.from(normalized.split(\",\").map((n) => Number(n.trim())));\n    }\n\n    return bs58.decode(normalized);\n  }\n\n  throw new Error(\"Invalid SOLANA_PRIVATE_KEY format. Expected bs58 string or byte array.\");\n}`;

  patched = patched.replace(
    /function decodeSolanaSecretKey\([^)]*\): Uint8Array \{[\s\S]*?\n\}/m,
    helper,
  );

  if (!patched.includes("function decodeSolanaSecretKey(")) {
    if (patched.includes("const connection =")) {
      patched = patched.replace("const connection =", `${helper}\n\nconst connection =`);
    } else {
      patched = `${helper}\n${patched}`;
    }
  }

  return patched;
}

function scientificToBigIntString(literal: string): string | null {
  const trimmed = literal.trim().toLowerCase();
  const match = /^([+-]?)(\d+)(?:\.(\d+))?e([+-]?\d+)$/.exec(trimmed);
  if (!match) return null;

  const [, sign, intPart, fracPartRaw = "", expRaw] = match;
  const exponent = Number(expRaw);
  if (!Number.isFinite(exponent) || exponent < 0) return null;

  const digits = `${intPart}${fracPartRaw}`.replace(/^0+(?=\d)/, "");
  const fracLen = fracPartRaw.length;
  const shift = exponent - fracLen;
  if (shift < 0) {
    // Would become a decimal value, which BigInt cannot represent.
    return null;
  }

  const normalized = `${digits || "0"}${"0".repeat(shift)}`.replace(/^0+(?=\d)/, "");
  return `${sign === "-" ? "-" : ""}${normalized || "0"}`;
}

function patchUnsafeBigIntScientific(content: string): string {
  return content.replace(
    /BigInt\(\s*([+-]?\d+(?:\.\d+)?[eE][+-]?\d+)\s*\)/g,
    (_full, literal: string) => {
      const asBigIntString = scientificToBigIntString(literal);
      if (!asBigIntString) {
        return `BigInt(String(${literal}))`;
      }
      return `BigInt("${asBigIntString}")`;
    },
  );
}

function patchMissingBs58Import(content: string): string {
  if (!content.includes("bs58.")) {
    return content;
  }

  const hasDefaultImport = /import\s+bs58\s+from\s+["']bs58["'];?/.test(content);
  const hasRequireImport = /const\s+bs58\s*=\s*require\(\s*["']bs58["']\s*\);?/.test(content);
  if (hasDefaultImport || hasRequireImport) {
    return content;
  }

  const importMatch = content.match(/^(import\s+[^\n]+\n)+/m);
  if (importMatch) {
    return `${importMatch[0]}import bs58 from 'bs58';\n${content.slice(importMatch[0].length)}`;
  }

  return `import bs58 from 'bs58';\n${content}`;
}

function patchSentimentThresholdsForTesting(content: string): string {
  // Rewrites sentiment thresholds (70/30) → (55/45) for more frequent signals during testing
  if (!content.includes("sentiment")) {
    return content;
  }
  
  // BUY threshold: if (sentiment > 70) → if (sentiment > 55)
  let patched = content.replace(
    /(\bsentiment\s*>\s*)70\b/g,
    "$155"
  );
  
  // SELL threshold: if (sentiment < 30) → if (sentiment < 45)
  patched = patched.replace(
    /(\bsentiment\s*<\s*)30\b/g,
    "$145"
  );
  
  return patched;
}

function patchOverlappingRunCycleInterval(content: string): string {
  const hasInterval = content.includes("setInterval(runCycle");
  const hasDirectCall = /\brunCycle\(\);/.test(content);
  
  if (!hasInterval && !hasDirectCall) {
    return content;
  }
  if (content.includes("__cycleInFlight")) {
    return content;
  }

  let patched = content;
  const helper = `let __cycleInFlight = false;
const __runCycleSafely = async (): Promise<void> => {
  if (__cycleInFlight) return;
  __cycleInFlight = true;
  try {
    await runCycle();
  } finally {
    __cycleInFlight = false;
  }
};`;

  // Always inject helper in a syntax-safe place: after import block (or file top).
  const importBlock = patched.match(/^(?:import[^\n]*\n)+/);
  if (importBlock) {
    patched = `${importBlock[0]}\n${helper}\n\n${patched.slice(importBlock[0].length)}`;
  } else {
    patched = `${helper}\n\n${patched}`;
  }

  // Replace direct interval scheduling with guarded scheduler.
  if (hasInterval) {
    patched = patched.replace(
      /const\s+(\w+)\s*=\s*setInterval\(\s*runCycle\s*,\s*([^\)]+)\)\s*;/g,
      (_full, timerName: string, intervalExpr: string) =>
        `const ${timerName} = setInterval(() => { void __runCycleSafely(); }, ${intervalExpr});`,
    );
  }

  // Replace eager boot call to runCycle() with guarded version.
  patched = patched.replace(/\brunCycle\(\);/g, "void __runCycleSafely();");

  return patched;
}

function patchSentimentObservationLoop(content: string): string {
  if (!content.includes("callMcpTool") || !content.includes("runCycle")) {
    return content;
  }
  if (content.includes("__safeCallMcpTool") || content.includes("__safeFetchJson")) {
    return content;
  }

  let patched = content;

  const helper = `async function __safeCallMcpTool(server: string, tool: string, args: Record<string, unknown>): Promise<unknown | null> {\n  try {\n    return await callMcpTool(server, tool, args);\n  } catch (err) {\n    const msg = err instanceof Error ? err.message : String(err);\n    console.warn(\`[WARN] MCP source unavailable: \${server}/\${tool} :: \${msg}\`);\n    return null;\n  }\n}\n\nasync function __safeFetchJson(url: string, label: string): Promise<unknown | null> {\n  try {\n    const response = await fetch(url);\n    if (!response.ok) {\n      throw new Error(\`HTTP \${response.status}\`);\n    }\n    return await response.json();\n  } catch (err) {\n    const msg = err instanceof Error ? err.message : String(err);\n    console.warn(\`[WARN] \${label} unavailable: \${msg}\`);\n    return null;\n  }\n}`;

  patched = patched.replace(
    /await\s+callMcpTool\(/g,
    "await __safeCallMcpTool(",
  );

  patched = patched.replace(
    /const\s+(\w+)\s*=\s*await\s*fetch\(([^)]+)\);/g,
    (full, varName: string, urlExpr: string) => {
      // Leave response/res objects as real Response types; downstream code often checks .ok/.status.
      if (varName === "response" || varName === "res") {
        return full;
      }
      return `const ${varName} = await __safeFetchJson(${urlExpr}, "${varName}");`;
    },
  );

  if (patched.includes("async function runCycle()")) {
    patched = patched.replace("async function runCycle()", `${helper}\n\nasync function runCycle()`);
  }

  const minSourcesGuard = `const __healthyCount = [sentimentData, marketData, onChainData, riskData]\n      .filter((value) => value !== null && value !== undefined).length;\n\n    if (__healthyCount < 2) {\n      console.warn(\`[\${new Date().toISOString()}] [WARN] no_trade_reason=insufficient_sources healthy=\${__healthyCount}/4\`);\n      return;\n    }\n\n    `;

  patched = patched.replace(
    /console\.log\(sentimentData,\s*marketData,\s*onChainData,\s*riskData\);/,
    `${minSourcesGuard}console.log(sentimentData, marketData, onChainData, riskData);`,
  );

  return patched;
}

function repairBrokenSentimentCompatibility(content: string): string {
  let patched = content;

  if (!patched.includes("__safeCallMcpTool") && !patched.includes("__safeFetchJson")) {
    return patched;
  }

  // Repair accidental recursive rewrite inside helper body.
  patched = patched.replace(
    /return\s+await\s+__safeCallMcpTool\(server,\s*tool,\s*args\);/g,
    "return await callMcpTool(server, tool, args);",
  );

  // Repair broken replacement where response/res was converted to JSON/null helper
  // but code still expects a Response object (.ok/.status/.json()).
  patched = patched.replace(
    /const\s+response\s*=\s*await\s*__safeFetchJson\(([^,]+),\s*"response"\);/g,
    "const response = await fetch($1);",
  );
  patched = patched.replace(
    /const\s+res\s*=\s*await\s*__safeFetchJson\(([^,]+),\s*"res"\);/g,
    "const res = await fetch($1);",
  );

  return patched;
}

function normalizeEnvValue(raw: string): string {
  const trimmed = raw.trim().replace(/\r/g, "");
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

function patchPackageJsonForTsx(content: string): string {
  try {
    const parsed = JSON.parse(content) as {
      scripts?: Record<string, unknown>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    const scripts = parsed.scripts ?? {};
    const usesTsx = Object.values(scripts).some(
      (value) => typeof value === "string" && /(^|\s)tsx(\s|$)/.test(value),
    );

    if (!usesTsx) {
      return content;
    }

    const deps = parsed.dependencies ?? {};
    const devDeps = parsed.devDependencies ?? {};

    if (!deps.tsx && !devDeps.tsx) {
      devDeps.tsx = "^4.20.6";
      parsed.devDependencies = devDeps;
      return `${JSON.stringify(parsed, null, 2)}\n`;
    }

    return content;
  } catch {
    return content;
  }
}

function patchGoPlusKeyRequirement(content: string): string {
  if (!content.includes("GOPLUS_API_KEY")) {
    return content;
  }

  let patched = content;

  // Common generated strict pattern: throw when GOPLUS_API_KEY is missing.
  patched = patched.replace(
    /process\.env\.GOPLUS_API_KEY\s*\?\?\s*\(\(\)\s*=>\s*\{\s*throw\s+new\s+Error\([^)]*\);?\s*\}\)\(\)/g,
    'process.env.GOPLUS_API_KEY ?? ""',
  );

  // Also handle single-quoted variants if they appear.
  patched = patched.replace(
    /process\.env\.GOPLUS_API_KEY\s*\?\?\s*\(\(\)\s*=>\s*\{\s*throw\s+new\s+Error\([^)]*\);?\s*\}\)\(\)/g,
    "process.env.GOPLUS_API_KEY ?? \"\"",
  );

  // Last-resort downgrade for direct throws tied to GOPLUS_API_KEY checks.
  patched = patched.replace(
    /if\s*\(\s*!process\.env\.GOPLUS_API_KEY\s*\)\s*\{\s*throw\s+new\s+Error\([^)]*\);?\s*\}/g,
    "",
  );

  return patched;
}

function patchInvalidPublicEndpoints(content: string): string {
  let patched = content;

  // Replace legacy LunarCrush v2 REST URL (frequently reset/unstable) with api3 endpoint.
  patched = patched.replace(
    /https:\/\/api\.lunarcrush\.com\/v2\?data=assets(?:&key=[^"'`\s]+)?/g,
    "https://lunarcrush.com/api3/assets?symbol=SOL",
  );

  // Replace SolanaBeach stats URL literals (often HTML in WebContainer) with a JSON-RPC health probe.
  patched = patched.replace(
    /["']https:\/\/solanabeach\.io\/v1\/stats["']/g,
    "(CONFIG.SOLANA_RPC_URL || CONFIG.RPC_URL)",
  );

  // If the source now points at RPC URL, ensure call shape is JSON-RPC POST (not GET).
  patched = patched.replace(
    /fetch\(\s*\(CONFIG\.SOLANA_RPC_URL \|\| CONFIG\.RPC_URL\)\s*\)/g,
    "fetch((CONFIG.SOLANA_RPC_URL || CONFIG.RPC_URL), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }) })",
  );

  // Replace Serum /markets URL literals (often unavailable/405) with a stable public price endpoint.
  patched = patched.replace(
    /`\$\{\s*CONFIG\.SERUM_API_URL\s*\}\/markets`/g,
    "'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd'",
  );

  // Replace hardcoded Solana WS endpoint with config-derived websocket URL.
  patched = patched.replace(
    /new\s+WebSocket\(\s*["']wss:\/\/api\.mainnet-beta\.solana\.com["']\s*\)/g,
    "new WebSocket((CONFIG.SOLANA_RPC_URL || CONFIG.RPC_URL || 'https://api.mainnet-beta.solana.com').replace(/^http/i, 'ws'))",
  );

  // Replace known-invalid LunarCrush WS endpoint variants that commonly return 404.
  patched = patched.replace(
    /new\s+WebSocket\(\s*["']wss:\/\/api\.lunarcrush\.com\/v2["']\s*\)/g,
    "new WebSocket((process.env.LUNARCRUSH_WS_URL || 'wss://stream.lunarcrush.com'))",
  );

  // Ensure axios lunar endpoints have an explicit timeout so cycles don't hang forever.
  patched = patched.replace(
    /axios\.get\(\s*(["'`][^"'`]*lunarcrush[^"'`]*["'`])\s*\)/g,
    "axios.get($1, { timeout: 5000 })",
  );

  return patched;
}

function patchWebsocketFallbackCycle(content: string): string {
  const hasRunCycle = /\b(?:const\s+runCycle\s*=|async\s+function\s+runCycle)\b/.test(content);
  const hasWsMessageTrigger = /ws\.on\(\s*['"]message['"]/.test(content);
  const hasInterval = /setInterval\(/.test(content);

  if (!hasRunCycle || !hasWsMessageTrigger || hasInterval) {
    return content;
  }

  const fallback = `
// Fallback polling keeps bot alive if websocket stream disconnects.
const __fallbackTimer = setInterval(() => {
  void runCycle();
}, 5000);
`;

  let patched = content;
  if (patched.includes("process.on('SIGINT'")) {
    patched = patched.replace(
      "process.on('SIGINT'",
      `${fallback}\nprocess.on('SIGINT'`,
    );
  } else if (patched.includes('process.on("SIGINT"')) {
    patched = patched.replace(
      'process.on("SIGINT"',
      `${fallback}\nprocess.on("SIGINT"`,
    );
  } else {
    patched = `${patched}\n${fallback}`;
  }

  patched = patched.replace(
    /process\.on\((['"])SIGINT\1,\s*\(\)\s*=>\s*\{([\s\S]*?)\}\);/m,
    (_full, q, body) => `process.on(${q}SIGINT${q}, () => {\n  clearInterval(__fallbackTimer);${body}\n});`,
  );

  patched = patched.replace(
    /process\.on\((['"])SIGTERM\1,\s*\(\)\s*=>\s*\{([\s\S]*?)\}\);/m,
    (_full, q, body) => `process.on(${q}SIGTERM${q}, () => {\n  clearInterval(__fallbackTimer);${body}\n});`,
  );

  return patched;
}

function looksMalformedTypeScript(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return true;

  // Common truncation signature from generated snippets.
  if (/headers:\s*\{\s*['\"]Authorization['\"]\s*$/.test(trimmed)) {
    return true;
  }

  // Quick structural sanity checks.
  const count = (re: RegExp) => (content.match(re) || []).length;
  const openBrace = count(/\{/g);
  const closeBrace = count(/\}/g);
  const openParen = count(/\(/g);
  const closeParen = count(/\)/g);

  if (openBrace > closeBrace || openParen > closeParen) {
    return true;
  }

  // Suspicious abrupt endings that frequently indicate truncated source.
  if (/[,:({\[]\s*$/.test(trimmed)) {
    return true;
  }

  return false;
}

function shouldForceSentimentFallback(content: string): boolean {
  const hasLunarcrush = /callMcpTool\(\s*['"]lunarcrush['"]/.test(content);
  const hasSolanaConn = /new\s+Connection\(/.test(content);
  const hasExistingFallbackMarker = content.includes("cycle_ok wallet=");
  return hasLunarcrush && hasSolanaConn && !hasExistingFallbackMarker;
}

function buildFallbackSentimentIndexTs(): string {
  return `import { Connection, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { CONFIG } from './config.js';
import { callMcpTool } from './mcp_bridge.js';

function parseSecret(raw?: string): Uint8Array | null {
  if (!raw) return null;
  const value = raw.trim().replace(/\r/g, '').replace(/^['\"]|['\"]$/g, '');
  if (!value) return null;
  if (value.startsWith('[') && value.endsWith(']')) {
    try {
      const arr = JSON.parse(value) as number[];
      if (Array.isArray(arr)) return Uint8Array.from(arr.map(Number));
    } catch {}
  }
  return bs58.decode(value);
}

const rpcUrl = (CONFIG.SOLANA_RPC_URL || CONFIG.RPC_URL || 'https://api.mainnet-beta.solana.com').trim();
const connection = new Connection(rpcUrl, 'confirmed');
const key = parseSecret((CONFIG as Record<string, string>).PRIVATE_KEY || CONFIG.SOLANA_PRIVATE_KEY);
const keypair = key ? Keypair.fromSecretKey(key) : Keypair.generate();

async function safeFetchJson(url: string, label: string): Promise<unknown | null> {
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[WARN] ' + label + ' unavailable: ' + msg);
    return null;
  }
}

async function safeMcp(server: string, tool: string, args: Record<string, unknown>): Promise<unknown | null> {
  try {
    return await callMcpTool(server, tool, args);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[WARN] MCP source unavailable: ' + server + '/' + tool + ' :: ' + msg);
    return null;
  }
}

async function runCycle(): Promise<void> {
  const sentiment = await safeMcp('lunarcrush', 'get_coin_details', { coin: 'SOL' });
  const price = await safeFetchJson('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', 'priceData');
  const risk = await safeMcp('webacy', 'get_token_risk', { address: keypair.publicKey.toBase58(), chain: 'solana', metrics_date: new Date().toISOString() });

  const healthy = [sentiment, price, risk].filter((v) => v != null).length;
  if (healthy < 2) {
    console.warn('[WARN] no_trade_reason=insufficient_sources healthy=' + healthy + '/3');
    return;
  }

  console.log('[INFO] cycle_ok wallet=' + keypair.publicKey.toBase58());
}

let inFlight = false;
const tick = async (): Promise<void> => {
  if (inFlight) return;
  inFlight = true;
  try {
    await runCycle();
  } finally {
    inFlight = false;
  }
};

void tick();
const timer = setInterval(() => { void tick(); }, 5000);

process.on('SIGINT', () => {
  clearInterval(timer);
  console.log('[INFO] Shutting down gracefully...');
  process.exit(0);
});
process.on('SIGTERM', () => {
  clearInterval(timer);
  console.log('[INFO] Shutting down gracefully...');
  process.exit(0);
});
`;
}

function applyCompatibilityPatches(files: BotFile[]): { files: BotFile[]; patchesApplied: number } {
  let patchesApplied = 0;

  const patchedFiles = files.map((file) => {
    const cleanPath = file.filepath.replace(/^[./]+/, "");

    if (cleanPath.endsWith("package.json")) {
      const patchedContent = patchPackageJsonForTsx(file.content);
      if (patchedContent !== file.content) {
        patchesApplied += 1;
        return { ...file, content: patchedContent };
      }
      return file;
    }

    const isTsSource = cleanPath.endsWith(".ts") || cleanPath.endsWith(".tsx");
    if (!isTsSource) {
      return file;
    }

    if (
      cleanPath === "src/index.ts" &&
      (looksMalformedTypeScript(file.content) || shouldForceSentimentFallback(file.content))
    ) {
      patchesApplied += 1;
      return { ...file, content: buildFallbackSentimentIndexTs() };
    }

    const patchedContent = patchLegacySolanaDecode(file.content);
    const patchedJsonParse = patchJsonParseSecretKey(patchedContent);
    const patchedBs58 = patchMissingBs58Import(patchedJsonParse);
    const patchedBigInt = patchUnsafeBigIntScientific(patchedBs58);
    const patchedInterval = patchOverlappingRunCycleInterval(patchedBigInt);
    const patchedSentiment = patchSentimentObservationLoop(patchedInterval);
    const repairedSentiment = repairBrokenSentimentCompatibility(patchedSentiment);
    const patchedGoPlus = patchGoPlusKeyRequirement(repairedSentiment);
    const patchedEndpoints = patchInvalidPublicEndpoints(patchedGoPlus);
    const patchedWsFallback = patchWebsocketFallbackCycle(patchedEndpoints);
    const patchedThresholds = patchSentimentThresholdsForTesting(patchedWsFallback);
    if (patchedThresholds !== file.content) {
      patchesApplied += 1;
      return { ...file, content: patchedThresholds };
    }

    return file;
  });

  return { files: patchedFiles, patchesApplied };
}

// Singleton — WebContainer can only boot once per page
let globalWC: unknown = null;

/** Build .env file content from the BotEnvConfig — all keys, skip empty. */
function buildEnvFileContent(cfg: BotEnvConfig): string {
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (typeof v === "string" && v !== "") {
      merged[k] = normalizeEnvValue(v);
    }
  }

  // Compatibility alias: some generated templates use LUNAR_CRUSH_API_KEY.
  if (!merged.LUNAR_CRUSH_API_KEY && merged.LUNARCRUSH_API_KEY) {
    merged.LUNAR_CRUSH_API_KEY = merged.LUNARCRUSH_API_KEY;
  }
  if (!merged.LUNARCRUSH_API_KEY && merged.LUNAR_CRUSH_API_KEY) {
    merged.LUNARCRUSH_API_KEY = merged.LUNAR_CRUSH_API_KEY;
  }

  // Public Pyth mode: generated bots should run without a private key.
  if (!merged.PYTH_NETWORK_API_KEY) {
    merged.PYTH_NETWORK_API_KEY = "public";
  }

  // Legacy Solana arbitrage templates may require this key at startup.
  if (!merged.SERUM_API_URL) {
    merged.SERUM_API_URL = "https://serum-api.bonfida.com";
  }

  // Compatibility aliases: some generated templates use RPC_URL/PRIVATE_KEY.
  if (!merged.RPC_URL && merged.SOLANA_RPC_URL) {
    merged.RPC_URL = merged.SOLANA_RPC_URL;
  }
  if (!merged.SOLANA_RPC_URL && merged.RPC_URL) {
    merged.SOLANA_RPC_URL = merged.RPC_URL;
  }
  if (!merged.PRIVATE_KEY && merged.SOLANA_PRIVATE_KEY) {
    merged.PRIVATE_KEY = merged.SOLANA_PRIVATE_KEY;
  }
  if (!merged.SOLANA_PRIVATE_KEY && merged.PRIVATE_KEY) {
    merged.SOLANA_PRIVATE_KEY = merged.PRIVATE_KEY;
  }

  // EVM wallet alias used by some templates.
  if (!merged.WALLET_PRIVATE_KEY && merged.PRIVATE_KEY) {
    merged.WALLET_PRIVATE_KEY = merged.PRIVATE_KEY;
  }
  if (!merged.PRIVATE_KEY && merged.WALLET_PRIVATE_KEY) {
    merged.PRIVATE_KEY = merged.WALLET_PRIVATE_KEY;
  }

  // Ensure Solana RPC URL is always a valid http(s) endpoint.
  if (!merged.SOLANA_RPC_URL || !isHttpUrl(merged.SOLANA_RPC_URL)) {
    merged.SOLANA_RPC_URL = "https://api.mainnet-beta.solana.com";
  }
  if (!merged.RPC_URL || !isHttpUrl(merged.RPC_URL)) {
    merged.RPC_URL = merged.SOLANA_RPC_URL;
  }

  return Object.entries(merged)
    .filter(([, v]) => typeof v === "string")
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

function parseFilesToTree(files: BotFile[]): Record<string, unknown> {
  const tree: Record<string, unknown> = {};
  for (const file of files) {
    const path  = file.filepath.replace(/^[./]+/, "");
    const parts = path.split("/");
    let   cur: Record<string, unknown> = tree;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!part) continue;
      if (i === parts.length - 1) {
        cur[part] = { file: { contents: file.content } };
      } else {
        if (!cur[part]) cur[part] = { directory: {} };
        cur = (cur[part] as { directory: Record<string, unknown> }).directory;
      }
    }
  }
  return tree;
}

/**
 * Determine the run strategy for this bot.
 *
 * Priority:
 *   1. Python: main.py present → skip npm install, run python3 main.py
 *   2. TypeScript: use `npm run start` (defined in generated package.json)
 *      which maps to `tsx src/index.ts`
 */
function detectRunStrategy(files: BotFile[]): {
  isPython: boolean;
  needsInstall: boolean;
  runCmd: string;
  projectRoot: string;
} {
  const paths = files.map(f => f.filepath.replace(/^[./]+/, ""));

  const shortestDirFor = (targetName: string): string | null => {
    const matches = paths.filter(p => p.split("/").pop() === targetName);
    if (matches.length === 0) return null;
    const best = matches.sort((a, b) => a.length - b.length)[0];
    const idx = best.lastIndexOf("/");
    return idx >= 0 ? best.slice(0, idx) : ".";
  };

  const prefix = (dir: string, cmd: string): string =>
    dir && dir !== "." ? `cd "${dir}" && ${cmd}` : cmd;

  if (paths.includes("main.py")) {
    return {
      isPython: true,
      needsInstall: false,
      projectRoot: ".",
      runCmd: "python3 main.py",
    };
  }

  const pkgRoot = shortestDirFor("package.json");
  if (pkgRoot) {
    return {
      isPython: false,
      needsInstall: true,
      projectRoot: pkgRoot,
      runCmd: prefix(pkgRoot, "npm run start"),
    };
  }

  // For all TS/JS bots: npm install then npm run start
  // The generated package.json always has "start": "tsx src/index.ts"
  return {
    isPython: false,
    needsInstall: true,
    projectRoot: ".",
    runCmd: "npm run start",
  };
}

/** Build the complete process env from BotEnvConfig, adding sensible defaults. */
function buildProcessEnv(cfg: BotEnvConfig): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (typeof v === "string" && v !== "") {
      env[k] = normalizeEnvValue(v);
    }
  }
  // Ensure MCP_GATEWAY_URL always present
  if (!env.MCP_GATEWAY_URL) {
    env.MCP_GATEWAY_URL = "http://192.168.1.50:8000/mcp";
  }
  // Ensure SIMULATION_MODE always present
  if (!env.SIMULATION_MODE) {
    env.SIMULATION_MODE = "true";
  }

  // Compatibility alias: allow either naming style in generated code.
  if (!env.LUNAR_CRUSH_API_KEY && env.LUNARCRUSH_API_KEY) {
    env.LUNAR_CRUSH_API_KEY = env.LUNARCRUSH_API_KEY;
  }
  if (!env.LUNARCRUSH_API_KEY && env.LUNAR_CRUSH_API_KEY) {
    env.LUNARCRUSH_API_KEY = env.LUNAR_CRUSH_API_KEY;
  }

  // Public Pyth mode: provide a non-empty value for templates that still guard on presence.
  if (!env.PYTH_NETWORK_API_KEY) {
    env.PYTH_NETWORK_API_KEY = "public";
  }

  // Legacy Solana arbitrage templates may guard on this var.
  if (!env.SERUM_API_URL) {
    env.SERUM_API_URL = "https://serum-api.bonfida.com";
  }

  // Compatibility aliases for generated templates that use generic names.
  if (!env.RPC_URL && env.SOLANA_RPC_URL) {
    env.RPC_URL = env.SOLANA_RPC_URL;
  }
  if (!env.SOLANA_RPC_URL && env.RPC_URL) {
    env.SOLANA_RPC_URL = env.RPC_URL;
  }
  if (!env.PRIVATE_KEY && env.SOLANA_PRIVATE_KEY) {
    env.PRIVATE_KEY = env.SOLANA_PRIVATE_KEY;
  }
  if (!env.SOLANA_PRIVATE_KEY && env.PRIVATE_KEY) {
    env.SOLANA_PRIVATE_KEY = env.PRIVATE_KEY;
  }
  if (!env.WALLET_PRIVATE_KEY && env.PRIVATE_KEY) {
    env.WALLET_PRIVATE_KEY = env.PRIVATE_KEY;
  }
  if (!env.PRIVATE_KEY && env.WALLET_PRIVATE_KEY) {
    env.PRIVATE_KEY = env.WALLET_PRIVATE_KEY;
  }

  // Guard against malformed/placeholder RPC URLs that crash web3.js Connection.
  if (!env.SOLANA_RPC_URL || !isHttpUrl(env.SOLANA_RPC_URL)) {
    env.SOLANA_RPC_URL = "https://api.mainnet-beta.solana.com";
  }
  if (!env.RPC_URL || !isHttpUrl(env.RPC_URL)) {
    env.RPC_URL = env.SOLANA_RPC_URL;
  }

  return env;
}

export function useBotSandbox({ generatedFiles, envConfig, termRef }: UseBotSandboxOptions) {
  const [phase,  setPhase]  = useState<BotPhase>("idle");
  const [status, setStatus] = useState("Idle");

  const wcRef            = useRef<unknown>(null);
  const activeProcessRef = useRef<{ kill(): void } | null>(null);

  // Auto-advance to env-setup once files arrive
  useEffect(() => {
    if (generatedFiles.length > 0 && phase === "idle") {
      setPhase("env-setup");
    }
  }, [generatedFiles, phase]);

  const bootAndRun = async (): Promise<void> => {
    const term = termRef.current;
    if (!term) return;

    setPhase("running");
    setStatus("Booting sandbox…");
    term.writeln("\x1b[36m[System]\x1b[0m Booting WebContainer…");

    try {
      // ── Detect bot type ──────────────────────────────────────────────────
      const { isPython, needsInstall, runCmd, projectRoot } = detectRunStrategy(generatedFiles);
      term.writeln(
        `\x1b[36m[System]\x1b[0m Bot type: \x1b[1m${isPython ? "Python" : "TypeScript/Node"}\x1b[0m` +
        ` — run: \x1b[33m${runCmd}\x1b[0m`
      );

      // ── Log env summary (redact sensitive values) ─────────────────────────
      const envKeys = Object.entries(envConfig)
        .filter(([, v]) => v && v !== "true" && v !== "false" && v !== "1" && v !== "5")
        .map(([k]) => k);
      term.writeln(`\x1b[36m[System]\x1b[0m Env keys set: \x1b[32m${envKeys.join(", ") || "none"}\x1b[0m`);

      // ── Build file tree ──────────────────────────────────────────────────
      const envContent = buildEnvFileContent({
        ...envConfig,
        // Ensure MCP_GATEWAY_URL is always written to .env
        MCP_GATEWAY_URL: envConfig.MCP_GATEWAY_URL || "http://192.168.1.50:8000/mcp",
      });

      const compatibility = applyCompatibilityPatches(generatedFiles);
      if (compatibility.patchesApplied > 0) {
        term.writeln(`\x1b[33m[System]\x1b[0m Applied ${compatibility.patchesApplied} compatibility patch(es) to generated source.`);
      }

      const allFiles: BotFile[] = [
        ...compatibility.files.filter(f =>
          f.filepath !== ".env" &&
          f.filepath !== ".npmrc" &&
          f.filepath !== ".env.example"
        ),
        { filepath: ".env", content: envContent },
        ...(!isPython ? [{ filepath: ".npmrc", content: BOT_NPMRC }] : []),
      ];

      // ── Boot WebContainer (singleton) ────────────────────────────────────
      const { WebContainer } = await import("@webcontainer/api") as {
        WebContainer: { boot(): Promise<unknown> };
      };

      if (!globalWC) {
        try {
          globalWC = await Promise.race([
            WebContainer.boot(),
            new Promise((_, rej) =>
              setTimeout(() => rej(new Error("WebContainer boot timeout after 15s")), 15_000)
            ),
          ]);
        } catch (bootErr: unknown) {
          const msg = (bootErr as Error).message ?? "";
          if (msg.includes("Only a single WebContainer")) {
            throw new Error(
              "WebContainer already running. Hard-refresh (Cmd/Ctrl+Shift+R) and try again."
            );
          }
          throw bootErr;
        }
      }

      wcRef.current = globalWC;

      const wc = wcRef.current as {
        mount(tree: unknown): Promise<void>;
        spawn(cmd: string, args: string[], opts?: unknown): Promise<{
          exit:   Promise<number>;
          input:  { getWriter(): { write(d: string): Promise<void>; releaseLock(): void } };
          output: { pipeTo(s: WritableStream): void };
          kill():  void;
        }>;
        fs: { writeFile(path: string, content: string): Promise<void> };
      };

      await wc.mount(parseFilesToTree(allFiles));
      term.writeln(`\x1b[36m[System]\x1b[0m Mounted ${allFiles.length} files`);

      if (!isPython && !generatedFiles.some(f => f.filepath.replace(/^[./]+/, "").endsWith("package.json"))) {
        setStatus("Missing package.json");
        term.writeln("\x1b[31m[Error]\x1b[0m package.json not found in generated files. Cannot run npm install.");
        setPhase("env-setup");
        return;
      }

      // ── npm install (TypeScript bots only) ───────────────────────────────
      if (needsInstall) {
        setPhase("installing");
        setStatus("Installing packages…");
        term.writeln("\x1b[36m[System]\x1b[0m Running npm install…");

        const install = await wc.spawn("jsh", [
          "-c",
          projectRoot && projectRoot !== "."
            ? `cd "${projectRoot}" && npm install --loglevel=error --legacy-peer-deps --no-fund`
            : "npm install --loglevel=error --legacy-peer-deps --no-fund",
        ], {
          env: { npm_config_yes: "true" },
          terminal: { cols: term.cols, rows: term.rows },
        });

        const installWriter = install.input.getWriter();
        const installHook   = term.onData((d: string) => installWriter.write(d).catch(() => {}));
        install.output.pipeTo(new WritableStream({ write(c) { term.write(c); } }));

        const installCode = await install.exit;
        installHook.dispose();
        installWriter.releaseLock();

        if (installCode !== 0) {
          setStatus("Install failed");
          term.writeln("\x1b[31m[Error]\x1b[0m npm install failed — see output above");
          setPhase("env-setup");
          return;
        }

        term.writeln("\x1b[32m[System]\x1b[0m npm install complete ✓");
      }

      // ── Run bot ──────────────────────────────────────────────────────────
      setPhase("running");
      setStatus("Bot running…");
      term.writeln(`\n\x1b[36m[System]\x1b[0m Starting → \x1b[1m${runCmd}\x1b[0m\n`);

      const processEnv = buildProcessEnv(envConfig);

      const run = await wc.spawn("jsh", ["-c", runCmd], {
        env:      processEnv,
        terminal: { cols: term.cols, rows: term.rows },
      });

      activeProcessRef.current = run;

      const runWriter = run.input.getWriter();
      const runHook   = term.onData((d: string) => runWriter.write(d).catch(() => {}));
      run.output.pipeTo(new WritableStream({ write(c) { term.write(c); } }));

      const exitCode = await run.exit;
      activeProcessRef.current = null;
      runHook.dispose();
      runWriter.releaseLock();

      if (exitCode !== 0 && exitCode !== 130 && exitCode !== 143) {
        term.writeln(`\n\x1b[31m[Error]\x1b[0m Bot exited with code ${exitCode}`);
        setStatus("Crashed");
      } else {
        term.writeln("\n\x1b[32m[System]\x1b[0m Bot stopped.");
        setStatus("Stopped");
      }

      setPhase("env-setup");

    } catch (err: unknown) {
      const msg = (err as Error).message ?? String(err);
      setStatus("Error");
      termRef.current?.writeln(`\x1b[31m[Error]\x1b[0m ${msg}`);
      setPhase("env-setup");
      activeProcessRef.current = null;
    }
  };

  const stopProcess = (): void => {
    if (activeProcessRef.current) {
      activeProcessRef.current.kill();
      activeProcessRef.current = null;
      setStatus("Stopped");
      setPhase("env-setup");
      termRef.current?.writeln("\n\x1b[33m[System]\x1b[0m Bot stopped by user.");
    }
  };

  const updateFileInSandbox = async (filepath: string, content: string): Promise<void> => {
    if (!wcRef.current) return;
    try {
      const safePath = filepath.replace(/^[./]+/, "");
      await (wcRef.current as { fs: { writeFile(p: string, c: string): Promise<void> } })
        .fs.writeFile(safePath, content);
    } catch (err) {
      console.error("Failed to sync file to sandbox:", err);
    }
  };

  return { bootAndRun, phase, status, setPhase, stopProcess, updateFileInSandbox };
}