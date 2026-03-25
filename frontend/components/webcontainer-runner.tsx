"use client";

import { useState, useRef, useEffect } from "react";
import { FileCode, Terminal as TerminalIcon, Folder, Play } from "lucide-react";

/**
 * Helper: Converts flat [{filepath, content}] into WebContainer's nested tree format.
 */
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
        if (!currentLevel[part]) {
          currentLevel[part] = { directory: {} };
        }
        currentLevel = currentLevel[part].directory;
      }
    }
  }
  return tree;
}

export function WebContainerRunner() {
  // UI State
  const [status, setStatus] = useState("Idle");
  const [logs, setLogs] = useState<string[]>([]);
  const [generatedFiles, setGeneratedFiles] = useState<{ filepath: string; content: string }[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [inputCommand, setInputCommand] = useState("");

  // Refs for WebContainer persistence
  const webcontainerInstanceRef = useRef<any>(null);
  const terminalWriterRef = useRef<WritableStreamDefaultWriter<string> | null>(null);
  const terminalEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll terminal to bottom
  useEffect(() => {
    terminalEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  const generateAndRun = async () => {
    setStatus("Generating code via AI...");
    setLogs(["[System] Requesting code generation...\n"]);

    try {
      // 1. Fetch the code from the API
      const res = await fetch("/api/get-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          intent: `Build a Flash Loan Arbitrageur on Solana using Jupiter and Aave.
          Use these specific dependencies in package.json:
          - @solana/web3.js: ^1.95.0
          - @jup-ag/api: ^6.0.21
          - dotenv: ^16.4.5`,
        }),
      });
      
      const data = await res.json();

      if (!data.files || data.files.length === 0) {
        setStatus("Error: No files received.");
        return;
      }

      // Ensure all file contents are strings
      const safeFiles = data.files.map((f: { content: any; }) => ({
        ...f,
        content: typeof f.content === "string" ? f.content : JSON.stringify(f.content, null, 2)
      }));

      // Inject a default package-lock.json if not present
      const hasLockfile = safeFiles.some(f => f.filepath === "package-lock.json");
      let filesWithLock = safeFiles;
      if (!hasLockfile) {
        filesWithLock = [
          ...safeFiles,
          {
            filepath: "package-lock.json",
            content: JSON.stringify({
              name: "agentia-flashloan-bot",
              lockfileVersion: 2,
              requires: true,
              packages: {},
              dependencies: {}
            }, null, 2)
          }
        ];
      }
      setGeneratedFiles(filesWithLock);
      setSelectedFile(filesWithLock[0].filepath);
      setStatus("Booting Sandbox...");

      // 2. Dynamically import and boot WebContainer
      const { WebContainer } = await import("@webcontainer/api");

      if (!webcontainerInstanceRef.current) {
        webcontainerInstanceRef.current = await WebContainer.boot();
      }

      const instance = webcontainerInstanceRef.current;

      // 3. Mount Files
      const fileSystemTree = parseFilesToTree(filesWithLock);
      await instance.mount(fileSystemTree);

      // 4. Start Interactive Shell (jsh)
      const shellProcess = await instance.spawn("jsh", {
        terminal: { cols: 80, rows: 24 },
      });

      // Capture the writer for manual terminal input
      terminalWriterRef.current = shellProcess.input.getWriter();

      // Stream output to the logs state
      shellProcess.output.pipeTo(
        new WritableStream({
          write(data) {
            // Remove ANSI escape codes for cleaner display in simple div
            const cleanData = data.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, "");
            setLogs((prev) => [...prev, cleanData]);
          },
        })
      );

      setStatus("Ready");
      setLogs((prev) => [...prev, "\n[System] Container ready. Please manually run 'npm install' below.\n"]);

    } catch (err: any) {
      console.error(err);
      setStatus("Error");
      setLogs((prev) => [...prev, `\n[Error] ${err.message}\n`]);
    }
  };

  /**
   * Handles manual terminal command submission
   */
  const handleCommandSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!terminalWriterRef.current || !inputCommand.trim()) return;

    // Write command to terminal + newline to execute
    await terminalWriterRef.current.write(`${inputCommand}\n`);
    setInputCommand("");
  };

  return (
    <div className="flex flex-col h-[700px] bg-slate-950 rounded-xl border border-slate-800 overflow-hidden font-mono shadow-2xl text-slate-200">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-slate-800 bg-slate-900/50">
        <div className="flex items-center gap-3">
          <div className="flex gap-1.5">
            <div className="w-3 h-3 rounded-full bg-red-500/20 border border-red-500/50" />
            <div className="w-3 h-3 rounded-full bg-yellow-500/20 border border-yellow-500/50" />
            <div className="w-3 h-3 rounded-full bg-green-500/20 border border-green-500/50" />
          </div>
          <h2 className="text-xs font-bold flex items-center gap-2 text-slate-400">
            <TerminalIcon size={14} /> agentia-sandbox v1.0
          </h2>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-[10px] bg-slate-800 px-2 py-1 rounded text-slate-400 border border-slate-700">
            {status.toUpperCase()}
          </span>
          <button 
            onClick={generateAndRun} 
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 px-3 py-1.5 rounded text-xs font-bold transition-all active:scale-95 text-white"
          >
            <Play size={12} fill="currentColor" /> Deploy Agent
          </button>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar: File Explorer */}
        <div className="w-52 border-r border-slate-800 bg-slate-900/20 p-2 overflow-y-auto">
          <div className="text-[10px] uppercase text-slate-600 font-black mb-3 px-2 tracking-widest">Explorer</div>
          {generatedFiles.length === 0 && (
            <div className="text-[10px] text-slate-500 px-2 italic">No files generated.</div>
          )}
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

        {/* Main Content: Code Editor & Terminal */}
        <div className="flex-1 flex flex-col min-w-0 bg-slate-950">
          {/* Code View Area */}
          <div className="flex-1 p-6 overflow-auto custom-scrollbar">
            {selectedFile ? (
              <div className="space-y-4">
                <div className="flex items-center gap-2 text-[10px] text-slate-500 mb-2">
                  <Folder size={10} /> agents / <span className="text-slate-300">{selectedFile}</span>
                </div>
                <pre className="text-sm leading-relaxed text-slate-300">
                  <code className="block whitespace-pre">
                    {(() => {
                      const fileContent = generatedFiles.find(f => f.filepath === selectedFile)?.content;
                      return typeof fileContent === "string"
                        ? fileContent
                        : JSON.stringify(fileContent, null, 2);
                    })()}
                  </code>
                </pre>
              </div>
            ) : (
              <div className="h-full flex flex-col items-center justify-center text-slate-600 space-y-2">
                <FileCode size={40} strokeWidth={1} />
                <p className="text-xs uppercase tracking-tighter">Select a file to view code</p>
              </div>
            )}
          </div>

          {/* Terminal Section */}
          <div className="h-64 border-t border-slate-800 bg-black/50 flex flex-col">
            <div className="flex items-center justify-between px-4 py-2 bg-slate-900/30 border-b border-slate-800">
              <span className="text-[10px] uppercase text-slate-500 font-bold tracking-widest">Terminal Output</span>
              <button 
                onClick={() => setLogs([])}
                className="text-[9px] text-slate-600 hover:text-slate-400 uppercase font-bold"
              >
                Clear Logs
              </button>
            </div>
            
            <div className="flex-1 p-4 overflow-y-auto font-mono text-xs text-green-500/90 custom-scrollbar">
              {logs.length === 0 ? (
                <span className="text-slate-700 italic">Console idle...</span>
              ) : (
                logs.map((log, i) => (
                  <span key={i} className="block whitespace-pre-wrap mb-0.5">{log}</span>
                ))
              )}
              <div ref={terminalEndRef} />
            </div>

            {/* Manual Terminal Input Bar */}
            <div className="p-2 bg-slate-900/50 border-t border-slate-800">
              <form onSubmit={handleCommandSubmit} className="flex gap-2">
                <div className="flex-1 relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-blue-500 text-xs font-bold">$</span>
                  <input
                    type="text"
                    value={inputCommand}
                    onChange={(e) => setInputCommand(e.target.value)}
                    placeholder="npm install && npm start"
                    className="w-full bg-black/40 border border-slate-700 rounded-lg pl-7 pr-3 py-2 text-xs font-mono text-white placeholder:text-slate-700 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/20 transition-all"
                  />
                </div>
                <button
                  type="submit"
                  disabled={!terminalWriterRef.current}
                  className="bg-slate-800 hover:bg-slate-700 disabled:opacity-30 disabled:cursor-not-allowed px-4 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest text-slate-300 transition-colors border border-slate-700"
                >
                  Send
                </button>
              </form>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}