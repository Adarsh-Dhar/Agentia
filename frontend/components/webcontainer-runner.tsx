"use client";

import { useState, useRef, useEffect } from "react";
import { FileCode, Terminal as TerminalIcon, Play, Settings } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";


function parsePrivateKey(input: string): string {
  if (input.startsWith('[') && input.endsWith(']')) {
    return input; // Already a byte array
  }
  // It's a Base58 string. Decode it.
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const bytes = [0];
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    for (let j = 0; j < bytes.length; j++) bytes[j] *= 58;
    bytes[0] += ALPHABET.indexOf(c);
    let carry = 0;
    for (let j = 0; j < bytes.length; j++) {
      bytes[j] += carry;
      carry = bytes[j] >> 8;
      bytes[j] &= 0xff;
    }
    while (carry) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (let i = 0; i < input.length && input[i] === "1"; i++) bytes.push(0);
  return JSON.stringify(bytes.reverse());
}

// Helper: Converts flat [{filepath, content}] into WebContainer's nested tree format
function parseFilesToTree(files: { filepath: string; content: string }[]): any {
  const tree: any = {};
  for (const file of files) {
    const parts = file.filepath.split("/");
    let currentLevel: any = tree;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isFile = i === parts.length - 1;
      if (isFile) {
        currentLevel[part] = { file: { contents: file.content } };
      } else {
        if (!currentLevel[part]) currentLevel[part] = { directory: {} };
        currentLevel = currentLevel[part].directory;
      }
    }
  }
  return tree;
}

export function WebContainerRunner() {
  const [phase, setPhase] = useState<"idle" | "generating" | "env-setup" | "running">("idle");
  const [status, setStatus] = useState("Idle");
  
  // Environment Configuration State
  const [envConfig, setEnvConfig] = useState({
    SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com",
    PRIVATE_KEY: "",
    CHECK_INTERVAL: "5000"
  });

  const [generatedFiles, setGeneratedFiles] = useState<{ filepath: string; content: string }[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  
  const webcontainerInstanceRef = useRef<any>(null);
  const terminalElementRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  // Initialize xterm.js on mount
  useEffect(() => {
    if (!terminalElementRef.current || terminalRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      convertEol: true,
      disableStdin: true,
      theme: {
        background: '#020617', 
        foreground: '#22c55e', 
      },
      fontSize: 12,
      fontFamily: 'Menlo, courier-new, courier, monospace',
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(terminalElementRef.current);
    fitAddon.fit();

    terminalRef.current = term;
    fitAddonRef.current = fitAddon;

    term.writeln("\x1b[1;34m[System]\x1b[0m Terminal initialized. Ready.");

    const resizeObserver = new ResizeObserver(() => fitAddon.fit());
    resizeObserver.observe(terminalElementRef.current);

    return () => {
      resizeObserver.disconnect();
      term.dispose();
      terminalRef.current = null;
    };
  }, []);

  // --- PHASE 1: Fetch Code and Prompt for .env ---
  const generateFiles = async () => {
    const term = terminalRef.current;
    if (!term) return;

    term.clear();
    setPhase("generating");
    setStatus("Generating code via AI...");
    term.writeln("\x1b[1;34m[System]\x1b[0m Requesting code generation...");

    try {
      const res = await fetch("/api/get-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          intent: `Write a FULLY FUNCTIONAL Flash Loan Arbitrage price scanner on Solana using Jupiter v6. 
DO NOT output boilerplate or placeholders like "// logic goes here". Write the complete 'index.js' script that runs a continuous loop, fetching live quote prices between SOL and USDC every 5 seconds, and calculating the price difference. 
Use EXACT versions: "@solana/web3.js": "1.95.0", "@jup-ag/api": "6.0.21", "dotenv": "16.4.5". 
IMPORTANT: You MUST initialize it using 'createJupiterApiClient({ config: { basePath: "https://quote-api.jup.ag/v6" } })'. DO NOT use 'Jupiter.load()'.`
        }),
      });
      const data = await res.json();

      if (!data.files) throw new Error("No files received.");

      setGeneratedFiles(data.files);
      setSelectedFile(data.files[0].filepath);
      
      // Stop here and ask for Environment Variables
      setPhase("env-setup");
      setStatus("Awaiting Config...");
      term.writeln("\x1b[1;33m[System]\x1b[0m Code generated successfully. Awaiting environment variables...");

    } catch (err: any) {
      setPhase("idle");
      setStatus("Error");
      if (terminalRef.current) terminalRef.current.writeln(`\n\x1b[1;31m[Error]\x1b[0m ${err.message}`);
    }
  };

  // --- PHASE 2: Inject .env, Boot Sandbox, and Run ---
  const bootAndRun = async () => {
    const term = terminalRef.current;
    if (!term) return;

    setPhase("running");
    setStatus("Booting Sandbox...");
    term.writeln("\x1b[1;34m[System]\x1b[0m Configuring variables and booting WebContainer...");

    try {
      // 1. Prepare files with injected configuration, filtering out old config files to avoid duplicate React keys
      const finalFiles = generatedFiles.filter(f => f.filepath !== ".npmrc" && f.filepath !== ".env");

      // Inject strict network resilience for WebContainer
      finalFiles.push({
        filepath: ".npmrc",
        content: "registry=https://registry.yarnpkg.com/\nmaxsockets=2\nfetch-retries=5\nfetch-retry-mintimeout=20000\nfetch-retry-maxtimeout=120000\nfund=false\naudit=false\n"
      });

      // Inject the securely gathered .env parameters (support all common key names, auto-handle Base58 or byte array)
      const safeKey = parsePrivateKey(envConfig.PRIVATE_KEY.trim());
      const envContent = `
RPC_URL=${envConfig.SOLANA_RPC_URL}
SOLANA_RPC_URL=${envConfig.SOLANA_RPC_URL}
PRIVATE_KEY=${safeKey}
SECRET_KEY=${safeKey}
KEYPAIR=${safeKey}
WALLET_PRIVATE_KEY=${safeKey}
CHECK_INTERVAL=${envConfig.CHECK_INTERVAL}
`.trim() + '\n';
      finalFiles.push({ filepath: ".env", content: envContent });

      // Update state so the user can see the .env file in the sidebar explorer
      setGeneratedFiles(finalFiles);
      setSelectedFile(".env");

      // 2. Boot WebContainer
      const { WebContainer } = await import("@webcontainer/api");
      if (!webcontainerInstanceRef.current) {
        webcontainerInstanceRef.current = await WebContainer.boot();
      }
      const instance = webcontainerInstanceRef.current;

      const fileSystemTree = parseFilesToTree(finalFiles);
      await instance.mount(fileSystemTree);

      // 3. Install Packages
      setStatus("Installing dependencies...");
      term.writeln("\x1b[1;34m[System]\x1b[0m Executing: npm install");
      
      const installProcess = await instance.spawn('jsh', ['-c', 'npm install --loglevel=info --ignore-scripts --legacy-peer-deps --no-fund node-fetch@2'], {
        env: { npm_config_yes: "true" }
      });

      installProcess.output.pipeTo(
        new WritableStream({ write(chunk) { term.write(chunk); } })
      );

      const installExitCode = await installProcess.exit;
      if (installExitCode !== 0) {
        setStatus("Install failed");
        term.writeln(`\n\x1b[1;31m[Error]\x1b[0m npm install failed with exit code ${installExitCode}`);
        return;
      }

      instance.on && instance.on('server-ready', (port: number, url: string) => {
        term.writeln(`\n\x1b[1;32m🚀 Agent Dashboard Live at: ${url}\x1b[0m\n`);
      });

      // 4. Start Agent
      setStatus("Running agent...");
      term.writeln("\n\x1b[1;34m[System]\x1b[0m Executing: npm start\n");
      
      const startProcess = await instance.spawn('jsh', ['-c', 'npm start'], {
        env: { npm_config_yes: "true" },
        NODE_OPTIONS: "--dns-result-order=ipv4first"
      });

      startProcess.output.pipeTo(
        new WritableStream({ write(chunk) { term.write(chunk); } })
      );

      setStatus("Agent running");

    } catch (err: any) {
      setStatus("Error");
      term.writeln(`\n\x1b[1;31m[Error]\x1b[0m ${err.message}`);
    }
  };

  return (
    <div className="flex flex-col h-[700px] bg-slate-950 rounded-xl border border-slate-800 overflow-hidden font-mono shadow-2xl text-slate-200">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-slate-800 bg-slate-900/50">
        <h2 className="text-xs font-bold flex items-center gap-2 text-slate-400">
          <TerminalIcon size={14} /> Agentia IDE Sandbox
        </h2>
        <div className="flex items-center gap-4">
          <span className="text-[10px] bg-slate-800 px-2 py-1 rounded text-slate-400 border border-slate-700">
            {status.toUpperCase()}
          </span>
          <button 
            onClick={generateFiles} 
            disabled={phase !== "idle"}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-800 disabled:text-slate-500 disabled:cursor-not-allowed px-3 py-1.5 rounded text-xs font-bold text-white transition-all active:scale-95"
          >
            <Play size={12} fill="currentColor" /> Generate Code
          </button>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar Explorer */}
        <div className="w-52 border-r border-slate-800 bg-slate-900/20 p-2 overflow-y-auto custom-scrollbar">
          <div className="text-[10px] uppercase text-slate-600 font-black mb-3 px-2 tracking-widest">Explorer</div>
          {[...new Map(generatedFiles.map(f => [f.filepath, f])).values()].map(file => (
            <button 
              key={file.filepath}
              onClick={() => setSelectedFile(file.filepath)}
              className={`w-full flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer text-xs mb-0.5 transition-colors ${
                selectedFile === file.filepath 
                ? 'bg-blue-600/10 text-blue-400 border border-blue-500/20' 
                : 'text-slate-500 hover:bg-slate-800/50 hover:text-slate-300'
              }`}
            >
              <FileCode size={14} className={selectedFile === file.filepath ? "text-blue-400" : "text-slate-600"} /> 
              <span className="truncate">{file.filepath}</span>
            </button>
          ))}
        </div>

        {/* Code Editor & Config UI */}
        <div className="flex-1 flex flex-col min-w-0 bg-slate-950 relative">
          
          {/* Environment Configuration Overlay */}
          {phase === "env-setup" && (
            <div className="absolute inset-0 z-20 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-6">
              <div className="w-full max-w-md bg-[#0f172a] border border-slate-700 rounded-xl shadow-2xl overflow-hidden">
                <div className="px-6 py-4 border-b border-slate-800 bg-slate-900 flex items-center gap-2">
                  <Settings size={16} className="text-blue-400" />
                  <div>
                    <h3 className="text-sm font-bold text-slate-200">Environment Configuration</h3>
                    <p className="text-[10px] text-slate-400">Required credentials for the Solana Agent</p>
                  </div>
                </div>
                
                <div className="p-6 space-y-4">
                  <div>
                    <label className="block text-[10px] uppercase font-bold text-slate-500 mb-1.5">Solana RPC URL</label>
                    <input 
                      type="text" 
                      value={envConfig.SOLANA_RPC_URL}
                      onChange={e => setEnvConfig({...envConfig, SOLANA_RPC_URL: e.target.value})}
                      className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-xs text-slate-300 focus:border-blue-500 focus:outline-none transition-colors"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] uppercase font-bold text-slate-500 mb-1.5">Wallet Private Key</label>
                    <input 
                      type="password" 
                      value={envConfig.PRIVATE_KEY}
                      onChange={e => setEnvConfig({...envConfig, PRIVATE_KEY: e.target.value})}
                      placeholder="Enter Base58 String or Byte Array"
                      className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-xs text-slate-300 focus:border-blue-500 focus:outline-none transition-colors"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] uppercase font-bold text-slate-500 mb-1.5">Check Interval (ms)</label>
                    <input 
                      type="text" 
                      value={envConfig.CHECK_INTERVAL}
                      onChange={e => setEnvConfig({...envConfig, CHECK_INTERVAL: e.target.value})}
                      className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-xs text-slate-300 focus:border-blue-500 focus:outline-none transition-colors"
                    />
                  </div>
                </div>

                <div className="px-6 py-4 border-t border-slate-800 bg-slate-900 flex justify-end">
                  <button 
                    onClick={bootAndRun}
                    disabled={!envConfig.PRIVATE_KEY}
                    className="bg-green-600 hover:bg-green-500 disabled:bg-slate-800 disabled:text-slate-500 disabled:cursor-not-allowed px-4 py-2 rounded text-xs font-bold text-white transition-all shadow-lg active:scale-95"
                  >
                    Save & Start Sandbox
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Editor Area */}
          <div className="flex-1 p-6 overflow-auto custom-scrollbar">
            <pre className="text-sm leading-relaxed text-slate-300">
              <code className="block whitespace-pre">
                {(() => {
                  const file = generatedFiles.find(f => f.filepath === selectedFile);
                  if (!file) return "// Generate code to view files";
                  if (typeof file.content === "string") return file.content;
                  try {
                    return JSON.stringify(file.content, null, 2);
                  } catch {
                    return String(file.content);
                  }
                })()}
              </code>
            </pre>
          </div>

          {/* Terminal Output */}
          <div className="h-72 border-t border-slate-800 bg-[#020617] flex flex-col z-10">
            <div className="flex items-center justify-between px-4 py-2 bg-slate-900/30 border-b border-slate-800">
              <span className="text-[10px] uppercase text-slate-500 font-bold tracking-widest">Terminal Output</span>
              <button 
                onClick={() => terminalRef.current?.clear()}
                className="text-[9px] text-slate-600 hover:text-slate-400 uppercase font-bold"
              >
                Clear Logs
              </button>
            </div>
            <div className="flex-1 p-2 overflow-hidden" ref={terminalElementRef} />
          </div>
        </div>
      </div>
    </div>
  );
}