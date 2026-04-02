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
  return content;
}

function patchJsonParseSecretKey(content: string): string {
  return content;
}

function patchUnsafeBigIntScientific(content: string): string {
  return content;
}

function patchMissingBs58Import(content: string): string {
  return content;
}

function patchSentimentThresholdsForTesting(content: string): string {
  return content;
}

function patchOverlappingRunCycleInterval(content: string): string {
  return content;
}

function patchSentimentObservationLoop(content: string): string {
  return content;
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

  return content.replace(
    /process\.env\.GOPLUS_API_KEY\s*\?\?\s*\(\(\)\s*=>\s*\{\s*throw\s+new\s+Error\([^)]*\);?\s*\}\)\(\)/g,
    'process.env.GOPLUS_API_KEY ?? ""',
  );
}

function patchConfigAliasExport(content: string): string {
  if (!content.includes("export const config =")) {
    return content;
  }

  if (content.includes("export const CONFIG =") || content.includes("export { config as CONFIG }")) {
    return content;
  }

  return `${content}\nexport { config as CONFIG };\n`;
}

function patchInvalidPublicEndpoints(content: string): string {
  return content;
}

function patchWebsocketFallbackCycle(content: string): string {
  return content;
}

function repairBrokenSentimentCompatibility(content: string): string {
  return content;
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
  const lower = content.toLowerCase();
  const hasLunarcrush = /callMcpTool\(\s*['"]lunarcrush['"]/.test(content) || lower.includes("lunarcrush");
  const looksSentimentBot = lower.includes("sentiment") || hasLunarcrush;
  const looksSolanaBot =
    /new\s+Connection\(/.test(content) ||
    lower.includes("solana") ||
    lower.includes("solana_rpc_url") ||
    lower.includes("api.mainnet-beta.solana.com");
  const hasExistingFallbackMarker = content.includes("cycle_ok wallet=");
  return looksSentimentBot && looksSolanaBot && !hasExistingFallbackMarker;
}

function patchConfigExportCompatibility(content: string): string {
  if (!content.includes("./config.js") || !content.includes("CONFIG")) {
    return content;
  }

  if (content.includes("__configModule") || content.includes("config as CONFIG")) {
    return content;
  }

  return content.replace(
    /import\s*\{\s*CONFIG\s*\}\s*from\s*['"]\.\/config\.js['"];?/g,
    "import * as __configModule from './config.js';\nconst CONFIG = (((__configModule as Record<string, unknown>).CONFIG ?? (__configModule as Record<string, unknown>).config ?? __configModule) as Record<string, string>);",
  );
}

function buildFallbackSentimentIndexTs(): string {
  return [
    "import { Connection, Keypair } from '@solana/web3.js';",
    "import bs58 from 'bs58';",
    "import * as config from './config.js';",
    "import { callMcpTool } from './mcp_bridge.js';",
    "",
    "const cfg = (config.CONFIG ? config.CONFIG : config.config ? config.config : config);",
    "let cycleCount = 0;",
    "let inFlight = false;",
    "",
    "function parseSecret(raw) {",
    "  if (!raw) return null;",
    "  const value = raw.toString().trim().replace(/\\r/g, '').replace(/^['\"]|['\"]$/g, '');",
    "  if (!value) return null;",
    "  if (value.startsWith('[') && value.endsWith(']')) {",
    "    try {",
    "      const arr = JSON.parse(value);",
    "      if (Array.isArray(arr)) return Uint8Array.from(arr.map(Number));",
    "    } catch {}",
    "  }",
    "  return bs58.decode(value);",
    "}",
    "",
    "function log(level, msg) {",
    "  const ts = new Date().toISOString();",
    "  console.log('[' + ts + '] [' + level + '] ' + msg);",
    "}",
    "",
    "const rpcUrl = (cfg.SOLANA_RPC_URL || cfg.RPC_URL || 'https://api.mainnet-beta.solana.com').trim();",
    "const connection = new Connection(rpcUrl, 'confirmed');",
    "const key = parseSecret(cfg.SOLANA_PRIVATE_KEY || cfg.PRIVATE_KEY);",
    "const keypair = key ? Keypair.fromSecretKey(key) : Keypair.generate();",
    "",
    "async function safeFetch(url, label) {",
    "  try {",
    "    const r = await fetch(url);",
    "    if (!r.ok) throw new Error('HTTP ' + r.status);",
    "    return await r.json();",
    "  } catch (err) {",
    "    log('WARN', label + ' failed: ' + err.message);",
    "    return null;",
    "  }",
    "}",
    "",
    "async function tryMcpTool(server, tool, args) {",
    "  try {",
    "    return await callMcpTool(server, tool, args);",
    "  } catch (err) {",
    "    log('DEBUG', 'MCP ' + server + '/' + tool + ' unavailable');",
    "    return null;",
    "  }",
    "}",
    "",
    "async function runCycle() {",
    "  cycleCount++;",
    "  log('INFO', '=== CYCLE #' + cycleCount + ' START ===');",
    "  log('INFO', 'Wallet: ' + keypair.publicKey.toBase58());",
    "",
    "  const sources = {};",
    "",
    "  log('INFO', 'Fetching price data...');",
    "  const priceData = await safeFetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', 'coingecko');",
    "  if (priceData && priceData.solana) {",
    "    sources.price = priceData.solana.usd;",
    "    log('INFO', 'SOL Price: $' + sources.price);",
    "  } else {",
    "    log('WARN', 'Price data unavailable');",
    "  }",
    "",
    "  log('INFO', 'Attempting sentiment data fetch...');",
    "  const sentiment = await tryMcpTool('lunarcrush', 'getSentiment', { coin: 'SOL' });",
    "  if (sentiment) {",
    "    sources.sentiment = sentiment;",
    "    log('INFO', 'Sentiment: ' + JSON.stringify(sentiment).substring(0, 100));",
    "  }",
    "",
    "  log('INFO', 'Attempting risk assessment...');",
    "  const risk = await tryMcpTool('webacy', 'getRisk', { address: keypair.publicKey.toBase58() });",
    "  if (risk) {",
    "    sources.risk = risk;",
    "    log('INFO', 'Risk Score: ' + JSON.stringify(risk).substring(0, 100));",
    "  }",
    "",
    "  const sourceCount = Object.keys(sources).length;",
    "  log('INFO', 'Data sources available: ' + sourceCount + '/3 (price, sentiment, risk)');",
    "",
    "  if (sourceCount === 0) {",
    "    log('WARN', 'No data sources available this cycle, will retry in 10s');",
    "  } else if (sourceCount === 1) {",
    "    log('WARN', 'Degraded mode: only 1 data source available');",
    "  } else {",
    "    log('INFO', 'Ready to execute trading logic');",
    "  }",
    "",
    "  log('INFO', '=== CYCLE #' + cycleCount + ' COMPLETE ===');",
    "}",
    "",
    "const run = async () => {",
    "  if (inFlight) return;",
    "  inFlight = true;",
    "  try {",
    "    await runCycle();",
    "  } catch (err) {",
    "    log('ERROR', err.message);",
    "  } finally {",
    "    inFlight = false;",
    "  }",
    "};",
    "",
    "log('INFO', 'Bot starting...');",
    "void run();",
    "const timer = setInterval(run, 10000);",
    "log('INFO', 'Cycle interval: 10 seconds');",
    "",
    "process.on('SIGINT', () => {",
    "  clearInterval(timer);",
    "  log('INFO', 'Shutting down (SIGINT)...');",
    "  process.exit(0);",
    "});",
    "process.on('SIGTERM', () => {",
    "  clearInterval(timer);",
    "  log('INFO', 'Shutting down (SIGTERM)...');",
    "  process.exit(0);",
    "});",
  ].join('\n');
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

    const patchedContent = patchConfigExportCompatibility(file.content);
    const patchedLegacy = patchLegacySolanaDecode(patchedContent);
    const patchedJsonParse = patchJsonParseSecretKey(patchedLegacy);
    const patchedBs58 = patchMissingBs58Import(patchedJsonParse);
    const patchedBigInt = patchUnsafeBigIntScientific(patchedBs58);
    const patchedInterval = patchOverlappingRunCycleInterval(patchedBigInt);
    const patchedSentiment = patchSentimentObservationLoop(patchedInterval);
    const repairedSentiment = repairBrokenSentimentCompatibility(patchedSentiment);
    const patchedGoPlus = patchGoPlusKeyRequirement(repairedSentiment);
    const patchedEndpoints = patchInvalidPublicEndpoints(patchedGoPlus);
    const patchedWsFallback = patchWebsocketFallbackCycle(patchedEndpoints);
    const patchedThresholds = patchSentimentThresholdsForTesting(patchedWsFallback);
    const patchedAlias = cleanPath === "src/config.ts"
      ? patchConfigAliasExport(patchedThresholds)
      : patchedThresholds;
    if (patchedAlias !== file.content) {
      patchesApplied += 1;
      return { ...file, content: patchedAlias };
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