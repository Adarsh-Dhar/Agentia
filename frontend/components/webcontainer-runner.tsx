"use client";

import { useState, useRef, useEffect } from "react";

// ─── Global WebContainer Instance ─────────────────────────────────────────────
// Store the WebContainer instance outside the component to survive hot reloads
let globalWebContainerInstance: any = null;
import { FileCode, Terminal as TerminalIcon, Play, Settings, Zap } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

// ─── Types ────────────────────────────────────────────────────────────────────

interface GeneratedFile {
  filepath: string;
  content: string;
}

interface EnvConfig {
  EVM_RPC_URL: string;
  EVM_PRIVATE_KEY: string;
  CONTRACT_ADDRESS: string;
  MAX_LOAN_USD: string;
  MIN_PROFIT_USD: string;
  DRY_RUN: string;
}

type Phase = "idle" | "generating" | "env-setup" | "running";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseFilesToTree(files: any[]): Record<string, any> {
  const tree: Record<string, any> = {};
  for (const file of files) {
    const path = file.filepath || file.path || file.filename;
    let content = file.content ?? file.code ?? file.contents ?? "";

    if (!path) continue;

    // FIX: If the LLM returned a JSON object, stringify it properly
    if (typeof content === "object" && content !== null) {
      content = JSON.stringify(content, null, 2);
    }

    // Sanitize and split path
    const cleanPath = path.replace(/^[./]+/, "");
    const parts = cleanPath.split("/");

    let cur: any = tree;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!part) continue;

      if (i === parts.length - 1) {
        cur[part] = { file: { contents: String(content) } };
      } else {
        if (!cur[part]) cur[part] = { directory: {} };
        // If this part was previously a file, convert it to a directory
        else if (cur[part].file) cur[part] = { directory: {} };
        cur = cur[part].directory;
      }
    }
  }
  return tree;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function WebContainerRunner() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [status, setStatus] = useState("Idle");
  const [envConfig, setEnvConfig] = useState<EnvConfig>({
    EVM_RPC_URL:     "https://sepolia-rollup.arbitrum.io/rpc", // Arbitrum Sepolia
    EVM_PRIVATE_KEY: "",
    CONTRACT_ADDRESS: "0xb50201558B00496A145fE76f7424749556E326D8", // Aave V3 Arbitrum Sepolia
    MAX_LOAN_USD:    "10000",
    MIN_PROFIT_USD:  "50",
    DRY_RUN:         "true",
  });
  const [generatedFiles, setGeneratedFiles] = useState<GeneratedFile[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  const webcontainerRef = useRef<unknown>(null);
  const terminalElRef   = useRef<HTMLDivElement>(null);
  const termRef         = useRef<Terminal | null>(null);
  const fitRef          = useRef<FitAddon | null>(null);

  // ── Init terminal ─────────────────────────────────────────────────────────

  useEffect(() => {
    if (!terminalElRef.current || termRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      convertEol: true,
      disableStdin: true,
      theme: {
        background: "#020617",
        foreground: "#22d3ee",
        green:      "#4ade80",
        yellow:     "#facc15",
        red:        "#f87171",
        cyan:       "#22d3ee",
        magenta:    "#c084fc",
        blue:       "#60a5fa",
      },
      fontSize: 12,
      fontFamily: "Menlo, 'Courier New', monospace",
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(terminalElRef.current);
    fit.fit();

    termRef.current = term;
    fitRef.current  = fit;

    term.writeln("\x1b[36m[System]\x1b[0m Terminal ready. Click \x1b[1mGenerate Bot\x1b[0m to start.");

    const obs = new ResizeObserver(() => fit.fit());
    obs.observe(terminalElRef.current);
    return () => { obs.disconnect(); term.dispose(); termRef.current = null; };
  }, []);

  // ── Phase 1: Generate files ───────────────────────────────────────────────

  const generateFiles = async () => {
    const term = termRef.current;
    if (!term) return;

    term.clear();
    setPhase("generating");
    setStatus("Generating bot code...");
    term.writeln("\x1b[36m[System]\x1b[0m Calling AI code generator...");

    try {
      const res = await fetch("/api/get-code", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ intent: "Build a Flash Loan Arbitrageur on Arbitrum using Aave V3" }),
      });

      const data = await res.json();
      if (!data.files?.length) throw new Error("No files received from generator");

      setGeneratedFiles(data.files);
      // Robustly find a starting file if src/workflow.ts doesn't exist
      const hasWorkflow = data.files.some((f: any) => (f.filepath || f.path) === "src/workflow.ts");
      if (!hasWorkflow && data.files.length > 0) {
        const firstFile = data.files[0].filepath || data.files[0].path;
        setSelectedFile(firstFile);
      } else {
        setSelectedFile("src/workflow.ts");
      }

      term.writeln("\x1b[32m[System]\x1b[0m " + data.files.length + " files generated successfully.");
      term.writeln("\x1b[33m[System]\x1b[0m Configure your environment variables, then click \x1b[1mLaunch Sandbox\x1b[0m.");

      setPhase("env-setup");
      setStatus("Awaiting config...");
    } catch (err: unknown) {
      setPhase("idle");
      setStatus("Error");
      term.writeln("\x1b[31m[Error]\x1b[0m " + String(err instanceof Error ? err.message : err));
    }
  };

  // ── Phase 2: Boot WebContainer and run ────────────────────────────────────

  const bootAndRun = async () => {
    const term = termRef.current;
    if (!term) return;

    setPhase("running");
    setStatus("Booting sandbox...");
    term.writeln("\x1b[36m[System]\x1b[0m Injecting environment and booting WebContainer...");

    try {
      // Merge .env overrides into the files list
      const envContent = [
        `DRY_RUN=${envConfig.DRY_RUN}`,
        `EVM_RPC_URL=${envConfig.EVM_RPC_URL}`,
        `EVM_PRIVATE_KEY=${envConfig.EVM_PRIVATE_KEY || "DEMO"}`,
        `CONTRACT_ADDRESS=${envConfig.CONTRACT_ADDRESS}`,
        `MAX_LOAN_USD=${envConfig.MAX_LOAN_USD}`,
        `MIN_PROFIT_USD=${envConfig.MIN_PROFIT_USD}`,
        `POLL_MS=3000`,
      ].join("\n");

      const finalFiles = [
        ...generatedFiles.filter(f => f.filepath !== ".env" && f.filepath !== ".npmrc"),
        { filepath: ".env",   content: envContent },
        {
          filepath: ".npmrc",
          content: [
            "registry=https://registry.yarnpkg.com/",
            "maxsockets=2",
            "fetch-retries=5",
            "fetch-retry-mintimeout=20000",
            "fetch-retry-maxtimeout=120000",
            "fund=false",
            "audit=false",
          ].join("\n"),
        },
      ];

      setGeneratedFiles(finalFiles);
      setSelectedFile(".env");

      // Boot WebContainer using global instance
      const { WebContainer } = await import("@webcontainer/api");
      if (!globalWebContainerInstance) {
        try {
          // Add a timeout race so it doesn't hang forever
          globalWebContainerInstance = await Promise.race([
            (WebContainer as { boot: () => Promise<unknown> }).boot(),
            new Promise((_, reject) => setTimeout(() => reject(new Error("WebContainer Boot Timeout")), 15000))
          ]);
        } catch (bootErr: any) {
          if (bootErr?.message?.includes("Only a single WebContainer instance")) {
            throw new Error("WebContainer is already running in the background. Please hard refresh the page (Cmd/Ctrl + R). ");
          }
          throw bootErr;
        }
      }
      // Sync the ref for local component usage
      webcontainerRef.current = globalWebContainerInstance;
      const wc = webcontainerRef.current as {
        mount: (t: unknown) => Promise<void>;
        spawn: (cmd: string, args: string[], opts?: Record<string, unknown>) => Promise<{
          output: { pipeTo: (w: WritableStream) => void };
          exit: Promise<number>;
        }>;
        on?: (ev: string, cb: (port: number, url: string) => void) => void;
      };

      // Add try-catch specifically around the mount function to catch FS errors
      try {
        await wc.mount(parseFilesToTree(finalFiles));
      } catch (mountErr: any) {
        throw new Error(`Failed to mount files. The LLM likely generated invalid paths or used native FS modules. Details: ${mountErr.message}`);
      }

      // npm install
      setStatus("Installing packages...");
      term.writeln("\x1b[36m[System]\x1b[0m npm install --legacy-peer-deps");

      const install = await wc.spawn("jsh", ["-c", "npm install --loglevel=error --legacy-peer-deps --no-fund"], {
        env: { npm_config_yes: "true" },
      });

      install.output.pipeTo(new WritableStream({ write(chunk) { term.write(chunk); } }));

      const installCode = await install.exit;
      if (installCode !== 0) {
        setStatus("Install failed");
        term.writeln("\x1b[31m[Error]\x1b[0m npm install failed (exit " + installCode + ")");
        setPhase("env-setup");
        return;
      }

      // Prepare the environment object for the process
      const validHexKey = envConfig.EVM_PRIVATE_KEY || "DEMO";
      const processEnv = {
        EVM_RPC_URL:      envConfig.EVM_RPC_URL,
        EVM_PRIVATE_KEY:  validHexKey,
        CONTRACT_ADDRESS: envConfig.CONTRACT_ADDRESS,
        MAX_LOAN_USD:     envConfig.MAX_LOAN_USD,
        MIN_PROFIT_USD:   envConfig.MIN_PROFIT_USD,
        DRY_RUN:          envConfig.DRY_RUN,
        POLL_MS:          "3000",
        // Specific Testnet Token Aliases
        WETH_ADDRESS:     "0x980b62da83eff3d4576c647993b0c1d7faf17c73",
        USDC_ADDRESS:     "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
        // Generic aliases for the bot logic
        RPC_URL:          envConfig.EVM_RPC_URL,
        PRIVATE_KEY:      validHexKey
      };

      // Improve entry point detection (Skip files that look like config)
      const actualFiles = finalFiles.map(f => (f.filepath || (f as any).path || "").replace(/^[./]+/, ""));
      const entryPoints = [
        "src/agent/index.ts", // Prioritize this!
        "src/index.ts",
        "index.ts",
        "src/main.ts",
        "main.ts",
        "src/workflow.ts"
      ];

      // Refine the fallback to ignore the 'shared' folder
      const foundEntry = entryPoints.find(p => actualFiles.includes(p)) || 
                         actualFiles.find(f => f.endsWith(".ts") && !f.includes("config") && !f.includes("types") && !f.includes("shared")) || 
                         "src/agent/index.ts";

      setStatus("Bot running...");
      term.writeln(`\n\x1b[36m[System]\x1b[0m Detected entry point: \x1b[1m${foundEntry}\x1b[0m`);

      // Run with the 'env' option
      const run = await wc.spawn("npx", ["tsx", foundEntry], {
        env: processEnv
      });
      run.output.pipeTo(new WritableStream({ write(chunk) { term.write(chunk); } }));

      const exitCode = await run.exit;
      if (exitCode !== 0) {
        term.writeln(`\n\x1b[31m[Error]\x1b[0m Bot crashed with exit code ${exitCode}`);
        setStatus("Crashed");
      } else {
        setStatus("Finished");
      }
    } catch (err: unknown) {
      setStatus("Error");
      term.writeln("\x1b[31m[Error]\x1b[0m " + String(err instanceof Error ? err.message : err));
      setPhase("env-setup");
    }
  };

  // ─── Render ───────────────────────────────────────────────────────────────

  let selectedContent = generatedFiles.find(f => f.filepath === selectedFile)?.content;
  if (selectedContent === undefined) {
    selectedContent = "// Click Generate Bot to see files";
  } else if (typeof selectedContent === "object") {
    // If the content is an object (e.g. package.json), pretty-print it
    selectedContent = JSON.stringify(selectedContent, null, 2);
  }

  return (
    <div className="flex flex-col h-[700px] bg-slate-950 rounded-xl border border-slate-800 overflow-hidden font-mono shadow-2xl text-slate-200">

      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800 bg-slate-900/60">
        <div className="flex items-center gap-2">
          <Zap size={14} className="text-cyan-400" />
          <h2 className="text-xs font-bold text-slate-300">Flash Loan Arbitrageur IDE</h2>
          <span className="text-[10px] px-2 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-400">
            Aave V3 · Arbitrum
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[10px] bg-slate-800 px-2 py-1 rounded text-slate-400 border border-slate-700">
            {status.toUpperCase()}
          </span>
          <button
            onClick={generateFiles}
            disabled={phase !== "idle"}
            className="flex items-center gap-1.5 bg-cyan-600 hover:bg-cyan-500 disabled:bg-slate-800 disabled:text-slate-500 disabled:cursor-not-allowed px-3 py-1.5 rounded text-xs font-bold text-white transition-all active:scale-95"
          >
            <Play size={11} fill="currentColor" /> Generate Bot
          </button>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">

        {/* File Explorer */}
        <div className="w-52 border-r border-slate-800 bg-slate-900/30 p-2 overflow-y-auto">
          <div className="text-[10px] uppercase text-slate-600 font-black mb-2 px-2 tracking-widest">Explorer</div>
          {[...new Map(generatedFiles.map(f => [f.filepath, f])).values()].map(file => (
            <button
              key={file.filepath}
              onClick={() => setSelectedFile(file.filepath)}
              className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs mb-0.5 transition-colors text-left ${
                selectedFile === file.filepath
                  ? "bg-cyan-600/10 text-cyan-400 border border-cyan-500/20"
                  : "text-slate-500 hover:bg-slate-800/50 hover:text-slate-300"
              }`}
            >
              <FileCode size={13} className={selectedFile === file.filepath ? "text-cyan-400" : "text-slate-600"} />
              <span className="truncate">{file.filepath}</span>
            </button>
          ))}
        </div>

        {/* Editor + Config + Terminal Container */}
        <div className="flex-1 flex flex-col min-w-0">

          {/* Top Section: Editor and Overlay (Scoped together) */}
          <div className="flex-1 relative flex flex-col min-h-0">
            {/* Env Setup Overlay - Now only covers the Editor area */}
            {phase === "env-setup" && (
              <div className="absolute inset-0 z-20 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-6">
                <div className="w-full max-w-md bg-[#0f172a] border border-slate-700 rounded-xl shadow-2xl overflow-hidden">
                  <div className="px-6 py-4 border-b border-slate-800 bg-slate-900 flex items-center gap-2">
                    <Settings size={15} className="text-cyan-400" />
                    <div>
                      <h3 className="text-sm font-bold text-slate-200">Flash Loan Configuration</h3>
                      <p className="text-[10px] text-slate-400">Environment variables for the arbitrage bot</p>
                    </div>
                  </div>

                  <div className="p-5 space-y-3">
                    {(
                      [
                        { key: "EVM_RPC_URL",    label: "EVM RPC URL (Arbitrum)",    type: "text",     placeholder: "https://arb1.arbitrum.io/rpc" },
                        { key: "EVM_PRIVATE_KEY", label: "EVM Private Key",          type: "password", placeholder: "0x... (leave blank for DRY RUN)" },
                        { key: "CONTRACT_ADDRESS", label: "Contract Address (Deployed)", type: "text", placeholder: "0xb50201558B00496A145fE76f7424749556E326D8" },
                        { key: "MAX_LOAN_USD",    label: "Max Flash Loan (USD)",     type: "number",   placeholder: "10000" },
                        { key: "MIN_PROFIT_USD",  label: "Min Profit Target (USD)",  type: "number",   placeholder: "50" },
                      ] as const
                    ).map(({ key, label, type, placeholder }) => (
                      <div key={key}>
                        <label className="block text-[10px] uppercase font-bold text-slate-500 mb-1">{label}</label>
                        <input
                          type={type}
                          value={envConfig[key]}
                          placeholder={placeholder}
                          onChange={e => setEnvConfig(prev => ({ ...prev, [key]: e.target.value }))}
                          className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-xs text-slate-300 focus:border-cyan-500/50 focus:outline-none transition-colors"
                        />
                      </div>
                    ))}
                    {envConfig.DRY_RUN === "false" && (
                      <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-xs text-red-300">
                        ⚠️  LIVE mode — real transactions will be sent. Ensure your contract is deployed.
                      </div>
                    )}
                  </div>

                  <div className="px-5 py-4 border-t border-slate-800 bg-slate-900">
                    <button
                      onClick={bootAndRun}
                      className="w-full bg-gradient-to-r from-cyan-600 to-blue-600 hover:opacity-90 px-4 py-2.5 rounded-lg text-xs font-bold text-white transition-all shadow-lg active:scale-95 flex items-center justify-center gap-2"
                    >
                      <Zap size={13} /> Launch Sandbox
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Code Editor Content */}
            <div className="flex-1 overflow-auto bg-[#020617] p-4">
              <pre className="text-[11px] leading-relaxed text-slate-300 whitespace-pre-wrap break-all">
                <code>{selectedContent}</code>
              </pre>
            </div>
          </div>

          {/* Terminal Section - Moved outside the relative container to stay visible */}
          <div className="h-64 border-t border-slate-800 bg-[#020617] flex flex-col">
            <div className="flex items-center justify-between px-4 py-1.5 bg-slate-900/40 border-b border-slate-800">
              <div className="flex items-center gap-2">
                <TerminalIcon size={12} className="text-slate-500" />
                <span className="text-[10px] uppercase text-slate-500 font-bold tracking-widest">Terminal</span>
              </div>
              <button
                onClick={() => termRef.current?.clear()}
                className="text-[9px] text-slate-600 hover:text-slate-400 uppercase font-bold"
              >
                Clear
              </button>
            </div>
            <div className="flex-1 p-1 overflow-hidden" ref={terminalElRef} />
          </div>
        </div>
      </div>
    </div>
  );
}