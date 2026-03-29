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

export interface BotFile {
  filepath: string;
  content:  string;
  language?: string;
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
        const data: { agentId: string; name: string; files: BotFile[]; config: Record<string, unknown> } = await dbRes.json();

        if (data.files?.length > 0) {
          // 1. Separate the .env file from the code files
          const envFile = data.files.find(f => f.filepath === ".env");
          const codeFiles = data.files.filter(f => f.filepath !== ".env");

          setGeneratedFiles(data.files);
          setAgentId(data.agentId);
          setBotName(data.name);

          // Pick the best default file to show
          const priority = ["src/index.ts", "main.py", "src/index.js", "index.ts"];
          const best = priority.find(p => data.files.some(f => f.filepath === p))
            ?? data.files[0]?.filepath;
          setSelectedFile(best ?? null);

          // 2. Parse the .env file back into a config object
          let loadedEnvConfig = null;
          if (envFile && envFile.content) {
            const envLines = envFile.content.split('\n');
            loadedEnvConfig = {
              SIMULATION_MODE:    envLines.find(l => l.startsWith('SIMULATION_MODE='))?.split('=')[1] || "true",
              RPC_PROVIDER_URL:   envLines.find(l => l.startsWith('RPC_PROVIDER_URL='))?.split('=')[1] || "",
              WALLET_PRIVATE_KEY: envLines.find(l => l.startsWith('WALLET_PRIVATE_KEY='))?.split('=')[1] || "",
              ONEINCH_API_KEY:    envLines.find(l => l.startsWith('ONEINCH_API_KEY='))?.split('=')[1] || "",
              WEBACY_API_KEY:     envLines.find(l => l.startsWith('WEBACY_API_KEY='))?.split('=')[1] || "",
              BORROW_AMOUNT_HUMAN: envLines.find(l => l.startsWith('BORROW_AMOUNT_HUMAN='))?.split('=')[1] || "1",
              POLL_INTERVAL: envLines.find(l => l.startsWith('POLL_INTERVAL='))?.split('=')[1] || "5",
            };
          }

          const cfg = data.config as Record<string, string | number | boolean> | null;
          if (cfg?.chain) {
            term.writeln(`\x1b[32m[System]\x1b[0m Loaded \x1b[1m${data.name}\x1b[0m (${data.files.length} files)`);
            term.writeln(`\x1b[33m[Bot]\x1b[0m Chain: ${cfg.chain} | Pair: ${cfg.baseToken}\u2192${cfg.targetToken} | DEX: ${cfg.dex}`);
          } else {
            term.writeln(`\x1b[32m[System]\x1b[0m Loaded \x1b[1m${data.name}\x1b[0m (${data.files.length} files)`);
          }
          term.writeln("\x1b[33m[System]\x1b[0m Fill in your credentials, then click \x1b[1mLaunch Bot\x1b[0m.");
          // 3. Return the parsed config so the component can use it
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

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      term.writeln(`\x1b[31m[Error]\x1b[0m ${msg}`);
    }
  };

  return { generateFiles, generatedFiles, selectedFile, setSelectedFile, agentId, botName };
}