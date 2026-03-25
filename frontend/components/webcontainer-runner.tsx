"use client";

import { useState, useRef, useEffect } from "react";
import { FileCode, Terminal as TerminalIcon, Folder, Play } from "lucide-react";

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
  const [logs, setLogs] = useState<string[]>([]);
  const [generatedFiles, setGeneratedFiles] = useState<{ filepath: string; content: string }[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const webcontainerInstanceRef = useRef<any>(null);
  const terminalEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll terminal
  useEffect(() => {
    terminalEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  const generateAndRun = async () => {
    setStatus("Generating code via AI...");
    setLogs(["[System] Requesting code generation...\n"]);

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

      // Inject strict network rules into pnpm config
      data.files.push({
        filepath: ".pnpmrc",
        content: "maxsockets=3\nfetch-retries=5\nfetch-retry-mintimeout=20000\nfetch-retry-maxtimeout=120000\nfund=false\naudit=false\n"
      });

      setGeneratedFiles(data.files);
      setSelectedFile(data.files[0].filepath);
      setStatus("Booting Sandbox...");

      const { WebContainer } = await import("@webcontainer/api");
      if (!webcontainerInstanceRef.current) {
        webcontainerInstanceRef.current = await WebContainer.boot();
      }
      const instance = webcontainerInstanceRef.current;

      const fileSystemTree = parseFilesToTree(data.files);
      await instance.mount(fileSystemTree);

      // --- PROGRAMMATIC SPAWN: pnpm install ---
      setStatus("Installing dependencies...");
      setLogs((prev) => [...prev, "\n[System] Running 'pnpm install'...\n"]);
      const installProcess = await instance.spawn('pnpm', ['install', '--no-audit', '--no-fund']);
      installProcess.output.pipeTo(
        new WritableStream({
          write(data) {
            setLogs(prev => [...prev, data.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, "")]);
          }
        })
      );
      const installExitCode = await installProcess.exit;
      if (installExitCode !== 0) {
        setStatus("Install failed");
        setLogs(prev => [...prev, `\n[Error] pnpm install failed with exit code ${installExitCode}\n`]);
        return;
      }

      // --- Listen for server-ready event ---
      instance.on && instance.on('server-ready', (port: number, url: string) => {
        setLogs(prev => [...prev, `\n🚀 Agent Dashboard Live at: ${url}\n`]);
      });

      // --- PROGRAMMATIC SPAWN: pnpm start ---
      setStatus("Running agent...");
      setLogs(prev => [...prev, "\n[System] Running 'pnpm start'...\n"]);
      const startProcess = await instance.spawn('pnpm', ['start']);
      startProcess.output.pipeTo(
        new WritableStream({
          write(data) {
            setLogs(prev => [...prev, data.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, "")]);
          }
        })
      );
      // Optionally, you can await startProcess.exit if you want to know when it stops

      setStatus("Agent running");

    } catch (err: any) {
      setStatus("Error");
      setLogs((prev) => [...prev, `\n[Error] ${err.message}\n`]);
    }
  };

  // Manual terminal input is not used in deployment pipeline mode

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

          {/* Terminal Output Only (no manual input) */}
          <div className="h-72 border-t border-slate-800 bg-black/50 flex flex-col">
            {/* Terminal Header with Clear Button */}
            <div className="flex items-center justify-between px-4 py-2 bg-slate-900/30 border-b border-slate-800">
              <span className="text-[10px] uppercase text-slate-500 font-bold tracking-widest">Terminal Output</span>
              <button 
                onClick={() => setLogs([])}
                className="text-[9px] text-slate-600 hover:text-slate-400 uppercase font-bold"
              >
                Clear Logs
              </button>
            </div>
            <div className="flex-1 p-4 overflow-y-auto font-mono text-xs text-green-500/90 custom-scrollbar" style={{ minHeight: 0 }}>
              {logs.map((log: string, i: number) => (
                <span key={i} className="block whitespace-pre-wrap mb-0.5">{log}</span>
              ))}
              <div ref={terminalEndRef} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}