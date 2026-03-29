"use client";

/**
 * frontend/hooks/use-bot-code-gen.ts
 *
 * Fetches bot files — either a specific agentId or the latest bot.
 * Works with both the old hardcoded bot and new custom-configured bots.
 */

import { useState } from "react";
import type { MutableRefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import type { BotEnvConfig } from "@/lib/bot-constant";

export interface BotFile {
  filepath: string;
  content:  string;
  language?: string;
}

/**
 * Parse a .env file string into a key→value map.
 * Handles values that contain "=" (e.g. Alchemy URLs, base64 keys).
 * Ignores blank lines and comment lines.
 */
function parseEnvFile(envContent: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of envContent.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) continue;
    const key   = line.slice(0, eqIdx).trim();
    const value = line.slice(eqIdx + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

export function useBotCodeGen(termRef: MutableRefObject<Terminal | null>) {
  const [generatedFiles, setGeneratedFiles] = useState<BotFile[]>([]);
  const [selectedFile,   setSelectedFile]   = useState<string | null>(null);
  const [agentId,        setAgentId]        = useState<string | null>(null);
  const [botName,        setBotName]        = useState<string>("ArbitrageBot");

  const generateFiles = async (specificAgentId?: string) => {
    const term = termRef.current;
    if (!term) return;
    term.clear();
    term.writeln("\x1b[36m[System]\x1b[0m Loading bot files...");

    try {
      // Try to load from DB (custom-configured bot or latest)
      const url = specificAgentId
        ? `/api/get-latest-bot?agentId=${specificAgentId}`
        : `/api/get-latest-bot`;

      const dbRes = await fetch(url);

      if (dbRes.ok) {
        const data: { agentId: string; name: string; files: BotFile[]; config?: Record<string, unknown> } = await dbRes.json();

        if (data.files?.length) {
          // Keep ALL files (including .env) so they show in the sidebar
          setGeneratedFiles(data.files);

          // Default to opening index.ts (or main.py) instead of .env
          const mainFile = data.files.find(
            (f) =>
              f.filepath === "src/index.ts" ||
              f.filepath === "src/index.js" ||
              f.filepath === "main.py"
          );
          setSelectedFile(mainFile?.filepath ?? data.files[0]?.filepath ?? null);

          if (data.agentId) setAgentId(data.agentId);
          if (data.name)    setBotName(data.name);

          // Parse the decrypted .env file back into a BotEnvConfig object
          const envFile = data.files.find((f) => f.filepath === ".env");
          let loadedEnvConfig: BotEnvConfig | null = null;

          if (envFile?.content) {
            const parsed = parseEnvFile(envFile.content);

            // Only populate if we actually got meaningful values
            loadedEnvConfig = {
              SIMULATION_MODE:     parsed.SIMULATION_MODE     ?? "true",
              RPC_PROVIDER_URL:    parsed.RPC_PROVIDER_URL    ?? "",
              WALLET_PRIVATE_KEY:  parsed.WALLET_PRIVATE_KEY  ?? "",
              ONEINCH_API_KEY:     parsed.ONEINCH_API_KEY     ?? "",
              WEBACY_API_KEY:      parsed.WEBACY_API_KEY      ?? "",
              BORROW_AMOUNT_HUMAN: parsed.BORROW_AMOUNT_HUMAN ?? "1",
              POLL_INTERVAL:       parsed.POLL_INTERVAL       ?? "5",
            };

            // Log which keys were found (values redacted for security)
            const foundKeys = Object.entries(loadedEnvConfig)
              .filter(([, v]) => v && v !== "true" && v !== "1" && v !== "5")
              .map(([k]) => k);
            term.writeln(
              `\x1b[36m[System]\x1b[0m .env loaded — keys found: \x1b[32m${foundKeys.join(", ") || "none"}\x1b[0m`
            );
          } else {
            term.writeln("\x1b[33m[System]\x1b[0m No .env file found in DB — credentials will need to be entered manually.");
          }

          term.writeln(
            `\x1b[32m[System]\x1b[0m Loaded \x1b[1m${data.name || "bot"}\x1b[0m (${data.files.length} files)`
          );

          return { success: true, loadedEnvConfig };
        }
      }

      // Fallback: fetch the hardcoded demo bot
      term.writeln("\x1b[33m[System]\x1b[0m No custom bot found, loading demo bot...");
      const res = await fetch("/api/get-bot-code", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({}),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

      const data: { thoughts: string; files: BotFile[]; agentId?: string } = await res.json();
      if (!data.files?.length) throw new Error("No files received");

      setGeneratedFiles(data.files);
      setSelectedFile("src/index.ts");
      if (data.agentId) setAgentId(data.agentId);

      term.writeln(`\x1b[32m[System]\x1b[0m ${data.files.length} demo files loaded.`);
      term.writeln(`\x1b[33m[Bot]\x1b[0m ${data.thoughts}`);

      return { success: true, loadedEnvConfig: null };

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      term.writeln(`\x1b[31m[Error]\x1b[0m ${msg}`);
      return { success: false, loadedEnvConfig: null };
    }
  };

  return { generateFiles, generatedFiles, selectedFile, setSelectedFile, agentId, botName };
}