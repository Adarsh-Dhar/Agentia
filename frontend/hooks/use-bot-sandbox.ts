"use client";

/**
 * frontend/hooks/use-bot-sandbox.ts
 *
 * WebContainer sandbox hook for the MCP Base Sepolia arbitrage bot.
 * Replaces use-sandbox.ts.  Key differences:
 *
 *  • Different env-config shape (BotEnvConfig vs EnvConfig)
 *  • Different .env file content
 *  • Entry point is always src/index.ts
 *  • Passes WEBACY_API_KEY, SIMULATION_MODE, etc. to the spawned process
 */

import { useState, useRef, useEffect, MutableRefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import type { BotEnvConfig } from "@/lib/bot-constant";
import { BOT_ENTRY_POINT, BOT_NPMRC } from "@/lib/bot-constant";

export type BotPhase = "idle" | "env-setup" | "running" | "booting" | "installing";

interface BotFile { filepath: string; content: string }

interface UseBotSandboxOptions {
  generatedFiles: BotFile[];
  envConfig:      BotEnvConfig;
  termRef:        MutableRefObject<Terminal | null>;
}

// Singleton — WebContainer can only boot once per page
let globalWC: unknown = null;

function buildEnvFileContent(cfg: BotEnvConfig): string {
  return [
    `SIMULATION_MODE=${cfg.SIMULATION_MODE}`,
    `WALLET_PRIVATE_KEY=${cfg.WALLET_PRIVATE_KEY}`,
    `RPC_PROVIDER_URL=${cfg.RPC_PROVIDER_URL}`,
    `WEBACY_API_KEY=${cfg.WEBACY_API_KEY}`,
    `ONEINCH_API_KEY=${cfg.ONEINCH_API_KEY}`,
    `BORROW_AMOUNT_HUMAN=${cfg.BORROW_AMOUNT_HUMAN || "1"}`,
    `POLL_INTERVAL=${cfg.POLL_INTERVAL || "5"}`,
  ].join("\n");
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
      // ── Build file tree ──────────────────────────────────────────────────
      const envContent = buildEnvFileContent(envConfig);
      const allFiles: BotFile[] = [
        ...generatedFiles.filter(f => f.filepath !== ".env" && f.filepath !== ".npmrc"),
        { filepath: ".env",    content: envContent  },
        { filepath: ".npmrc",  content: BOT_NPMRC   },
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
              setTimeout(() => rej(new Error("WebContainer boot timeout")), 15_000)
            ),
          ]);
        } catch (bootErr: unknown) {
          const msg = (bootErr as Error).message ?? "";
          if (msg.includes("Only a single WebContainer")) {
            throw new Error(
              "WebContainer is already running. Please hard-refresh (Cmd/Ctrl+R) and try again."
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

      // ── npm install ──────────────────────────────────────────────────────
      setStatus("Installing packages…");
      term.writeln("\x1b[36m[System]\x1b[0m npm install --legacy-peer-deps");

      const install = await wc.spawn("jsh", [
        "-c",
        "npm install --loglevel=error --legacy-peer-deps --no-fund",
      ], {
        env:      { npm_config_yes: "true" },
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
        term.writeln("\x1b[31m[Error]\x1b[0m npm install failed");
        setPhase("env-setup");
        return;
      }

      // ── Run bot ──────────────────────────────────────────────────────────
      setStatus("Bot running…");
      term.writeln(
        `\n\x1b[36m[System]\x1b[0m Starting \x1b[1m${BOT_ENTRY_POINT}\x1b[0m …\n`
      );

      const processEnv: Record<string, string> = {
        SIMULATION_MODE:     envConfig.SIMULATION_MODE,
        WALLET_PRIVATE_KEY:  envConfig.WALLET_PRIVATE_KEY,
        RPC_PROVIDER_URL:    envConfig.RPC_PROVIDER_URL,
        WEBACY_API_KEY:      envConfig.WEBACY_API_KEY,
        ONEINCH_API_KEY:     envConfig.ONEINCH_API_KEY,
        BORROW_AMOUNT_HUMAN: envConfig.BORROW_AMOUNT_HUMAN || "1",
        POLL_INTERVAL:       envConfig.POLL_INTERVAL       || "5",
      };

      const run = await wc.spawn("jsh", ["-c", `npx -y tsx ${BOT_ENTRY_POINT}`], {
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