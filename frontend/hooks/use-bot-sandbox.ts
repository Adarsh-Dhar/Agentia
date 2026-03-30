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

// Singleton — WebContainer can only boot once per page
let globalWC: unknown = null;

/** Build .env file content from the BotEnvConfig — all keys, skip empty. */
function buildEnvFileContent(cfg: BotEnvConfig): string {
  return Object.entries(cfg)
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
} {
  const paths = files.map(f => f.filepath.replace(/^[./]+/, ""));

  if (paths.includes("main.py")) {
    return { isPython: true, needsInstall: false, runCmd: "python3 main.py" };
  }

  // For all TS/JS bots: npm install then npm run start
  // The generated package.json always has "start": "tsx src/index.ts"
  return { isPython: false, needsInstall: true, runCmd: "npm run start" };
}

/** Build the complete process env from BotEnvConfig, adding sensible defaults. */
function buildProcessEnv(cfg: BotEnvConfig): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (typeof v === "string" && v !== "") {
      env[k] = v;
    }
  }
  // Ensure MCP_GATEWAY_URL always present
  if (!env.MCP_GATEWAY_URL) {
    env.MCP_GATEWAY_URL = "http://localhost:8000/mcp";
  }
  // Ensure SIMULATION_MODE always present
  if (!env.SIMULATION_MODE) {
    env.SIMULATION_MODE = "true";
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
      const { isPython, needsInstall, runCmd } = detectRunStrategy(generatedFiles);
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
        MCP_GATEWAY_URL: envConfig.MCP_GATEWAY_URL || "http://localhost:8000/mcp",
      });

      const allFiles: BotFile[] = [
        ...generatedFiles.filter(f =>
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

      // ── npm install (TypeScript bots only) ───────────────────────────────
      if (needsInstall) {
        setPhase("installing");
        setStatus("Installing packages…");
        term.writeln("\x1b[36m[System]\x1b[0m Running npm install…");

        const install = await wc.spawn("jsh", [
          "-c",
          "npm install --loglevel=error --legacy-peer-deps --no-fund",
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