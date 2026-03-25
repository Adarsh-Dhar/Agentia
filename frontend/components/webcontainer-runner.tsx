"use client";

import { useState, useRef, useEffect } from "react";
import { FileCode, Terminal as TerminalIcon, Play } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css"; // Required for proper terminal styling

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
  const [status, setStatus] = useState("Idle");
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
      disableStdin: true, // Read-only for this execution view
      theme: {
        background: '#020617', // match tailwind slate-950
        foreground: '#22c55e', // text-green-500
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

    // Handle resize
    const resizeObserver = new ResizeObserver(() => fitAddon.fit());
    resizeObserver.observe(terminalElementRef.current);

    return () => {
      resizeObserver.disconnect();
      term.dispose();
      terminalRef.current = null;
    };
  }, []);

  const generateAndRun = async () => {
    const term = terminalRef.current;
    if (!term) return;

    term.clear();
    setStatus("Generating code via AI...");
    term.writeln("\x1b[1;34m[System]\x1b[0m Requesting code generation...");

    try {
      const res = await fetch("/api/get-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          intent: `Build a Flash Loan Arbitrageur on Solana using Jupiter and Aave. Use EXACT versions: "@solana/web3.js": "1.95.0", "@jup-ag/api": "6.0.21", "dotenv": "16.4.5"`,
        }),
      });
      const data = await res.json();

      if (!data.files) throw new Error("No files received.");

      // Add a resilient .npmrc (npm works much better in WebContainers than pnpm)
      data.files.push({
        filepath: ".npmrc",
        content: "registry=https://registry.yarnpkg.com/\nmaxsockets=2\nfetch-retries=5\nfetch-retry-mintimeout=20000\nfetch-retry-maxtimeout=120000\nfund=false\naudit=false\n"
      });

      setGeneratedFiles(data.files);
      setSelectedFile(data.files[0].filepath);
      setStatus("Booting Sandbox...");
      term.writeln("\x1b[1;34m[System]\x1b[0m Booting WebContainer...");

      const { WebContainer } = await import("@webcontainer/api");
      if (!webcontainerInstanceRef.current) {
        webcontainerInstanceRef.current = await WebContainer.boot();
      }
      const instance = webcontainerInstanceRef.current;

      const fileSystemTree = parseFilesToTree(data.files);
      await instance.mount(fileSystemTree);

      // --- THE BOLT.NEW WAY: Spawn jsh with npm_config_yes ---
      setStatus("Installing dependencies...");
      term.writeln("\x1b[1;34m[System]\x1b[0m Executing: npm install");
      
      const installProcess = await instance.spawn('jsh', ['-c', 'npm install --loglevel=info --ignore-scripts --legacy-peer-deps --no-fund'], {
        env: { npm_config_yes: "true" } // Auto-answer yes to any interactive prompts
      });

      // Pipe directly to xterm
      installProcess.output.pipeTo(
        new WritableStream({
          write(chunk) {
            term.write(chunk);
          }
        })
      );

      const installExitCode = await installProcess.exit;
      if (installExitCode !== 0) {
        setStatus("Install failed");
        term.writeln(`\n\x1b[1;31m[Error]\x1b[0m npm install failed with exit code ${installExitCode}`);
        return;
      }

      // --- Listen for server-ready event ---
      instance.on && instance.on('server-ready', (port: number, url: string) => {
        term.writeln(`\n\x1b[1;32m🚀 Agent Dashboard Live at: ${url}\x1b[0m\n`);
      });

      // --- THE BOLT.NEW WAY: Spawn start command via jsh ---
      setStatus("Running agent...");
      term.writeln("\n\x1b[1;34m[System]\x1b[0m Executing: npm start\n");
      
      const startProcess = await instance.spawn('jsh', ['-c', 'npm start'], {
        env: { npm_config_yes: "true" }
      });

      startProcess.output.pipeTo(
        new WritableStream({
          write(chunk) {
            term.write(chunk);
          }
        })
      );

      setStatus("Agent running");

    } catch (err: any) {
      setStatus("Error");
      if (terminalRef.current) {
        terminalRef.current.writeln(`\n\x1b[1;31m[Error]\x1b[0m ${err.message}`);
      }
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
            onClick={generateAndRun} 
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 px-3 py-1.5 rounded text-xs font-bold text-white transition-all active:scale-95"
          >
            <Play size={12} fill="currentColor" /> Generate Code
          </button>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar Explorer */}
        <div className="w-52 border-r border-slate-800 bg-slate-900/20 p-2 overflow-y-auto custom-scrollbar">
          <div className="text-[10px] uppercase text-slate-600 font-black mb-3 px-2 tracking-widest">Explorer</div>
          {generatedFiles.map(file => (
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

        {/* Code Editor & Terminal */}
        <div className="flex-1 flex flex-col min-w-0 bg-slate-950">
          {/* Editor Area */}
          <div className="flex-1 p-6 overflow-auto custom-scrollbar">
            <pre className="text-sm leading-relaxed text-slate-300">
              <code className="block whitespace-pre">
                {generatedFiles.find(f => f.filepath === selectedFile)?.content || "// Generate code to view files"}
              </code>
            </pre>
          </div>

          {/* Terminal Output UI using xterm.js */}
          <div className="h-72 border-t border-slate-800 bg-[#020617] flex flex-col">
            <div className="flex items-center justify-between px-4 py-2 bg-slate-900/30 border-b border-slate-800">
              <span className="text-[10px] uppercase text-slate-500 font-bold tracking-widest">Terminal Output</span>
              <button 
                onClick={() => terminalRef.current?.clear()}
                className="text-[9px] text-slate-600 hover:text-slate-400 uppercase font-bold"
              >
                Clear Logs
              </button>
            </div>
            {/* This is where xterm attaches */}
            <div className="flex-1 p-2 overflow-hidden" ref={terminalElementRef} />
          </div>
        </div>
      </div>
    </div>
  );
}