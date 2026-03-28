"use client";

/**
 * frontend/hooks/use-bot-code-gen.ts
 *
 * Replaces use-code-gen.ts for the MCP arbitrage bot IDE.
 * Fetches Base Sepolia bot files from /api/get-bot-code instead of /api/get-code.
 */

import { useState } from "react";
import type { MutableRefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import type { BotFile } from "@/app/api/get-bot-code/bot-files";

export function useBotCodeGen(termRef: MutableRefObject<Terminal | null>) {
  const [generatedFiles, setGeneratedFiles] = useState<BotFile[]>([]);
  const [selectedFile,   setSelectedFile]   = useState<string | null>(null);

  const generateFiles = async () => {
    const term = termRef.current;
    if (!term) return;
    term.clear();
    term.writeln("\x1b[36m[System]\x1b[0m Fetching Base Sepolia MCP arbitrage bot files...");

    try {
      const res = await fetch("/api/get-bot-code", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({}),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

      const data: { thoughts: string; files: BotFile[] } = await res.json();

      if (!data.files?.length) throw new Error("No files received from server");

      setGeneratedFiles(data.files);
      setSelectedFile("src/index.ts");

      term.writeln(`\x1b[32m[System]\x1b[0m ${data.files.length} files loaded successfully.`);
      term.writeln(`\x1b[33m[Bot]\x1b[0m ${data.thoughts}`);
      term.writeln("\x1b[33m[System]\x1b[0m Fill in your credentials below, then click \x1b[1mLaunch Bot\x1b[0m.");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      term.writeln(`\x1b[31m[Error]\x1b[0m ${msg}`);
    }
  };

  return { generateFiles, generatedFiles, selectedFile, setSelectedFile };
}