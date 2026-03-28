"use client";

import { useState } from "react";
import { DEFAULT_ENV_CONFIG } from "@/lib/constant";
import { useTerminal } from "../hooks/use-terminal";
import { useSandbox } from "../hooks/use-sandbox";
import { useCodeGen } from "../hooks/use-code-gen";
import { FileExplorer } from "./ui/FileExplorer";
import { CodeEditor } from "./ui/code-editor";
import { EnvConfigModal } from "./ui/EnvConfigModal";
import { TerminalPanel } from "./ui/TerminalPanel";
import { Zap, Play, Settings, Square } from "lucide-react"; // ✅ Added Square icon

export function WebContainerRunner() {
  const [envConfig, setEnvConfig] = useState({ ...DEFAULT_ENV_CONFIG });
  const [fileEdits, setFileEdits] = useState<Record<string, string>>({});
  
  const { terminalRef, termRef } = useTerminal();
  const { generateFiles, generatedFiles, selectedFile, setSelectedFile } = useCodeGen(termRef);

  const currentFiles = generatedFiles.map(f => ({
    ...f,
    content: fileEdits[f.filepath] !== undefined ? fileEdits[f.filepath] : f.content
  }));

  const {
    bootAndRun,
    phase,
    status,
    setPhase,
    updateFileInSandbox,
    stopProcess // ✅ Destructured stopProcess
  } = useSandbox({ generatedFiles: currentFiles, envConfig, termRef });

  const selectedContent = currentFiles.find(f => f.filepath === selectedFile)?.content;

  const handleEditorChange = (newContent: string) => {
    if (selectedFile) {
      setFileEdits(prev => ({ ...prev, [selectedFile]: newContent }));
      if (phase === "running" && updateFileInSandbox) {
        updateFileInSandbox(selectedFile, newContent);
      }
    }
  };

  return (
    <div className="flex flex-col h-[700px] bg-slate-950 rounded-xl border border-slate-800 overflow-hidden font-mono shadow-2xl text-slate-200">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800 bg-slate-900/60">
        <div className="flex items-center gap-2">
          <Zap size={14} className="text-cyan-400" />
          <h2 className="text-xs font-bold text-slate-300">Flash Loan Arbitrageur IDE</h2>
        </div>
        
        <div className="flex items-center gap-3">
          <span className="text-[10px] bg-slate-800 px-2 py-1 rounded text-slate-400 border border-slate-700">
            {status.toUpperCase()}
          </span>
          
          {/* ✅ RENDER STOP BUTTON IF RUNNING */}
          {phase === "running" ? (
            <button
              onClick={stopProcess}
              className="flex items-center gap-1.5 bg-red-600 hover:bg-red-500 px-3 py-1.5 rounded text-xs font-bold text-white transition-all active:scale-95"
            >
              <Square size={10} fill="currentColor" /> Stop Bot
            </button>
          ) : generatedFiles.length === 0 ? (
            <button
              onClick={generateFiles}
              disabled={phase !== "idle"}
              className="flex items-center gap-1.5 bg-cyan-600 hover:bg-cyan-500 disabled:bg-slate-800 disabled:text-slate-500 disabled:cursor-not-allowed px-3 py-1.5 rounded text-xs font-bold text-white transition-all active:scale-95"
            >
              <Play size={11} fill="currentColor" /> Generate Bot
            </button>
          ) : (
            <button
              onClick={() => setPhase("env-setup")}
              disabled={phase !== "idle"}
              className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-800 disabled:text-slate-500 disabled:cursor-not-allowed px-3 py-1.5 rounded text-xs font-bold text-white transition-all active:scale-95"
            >
              <Settings size={11} /> Configure & Run
            </button>
          )}
        </div>
      </div>
      
      <div className="flex flex-1 overflow-hidden">
        <FileExplorer files={currentFiles} selectedFile={selectedFile} onSelect={setSelectedFile} />
        <div className="flex-1 flex flex-col min-w-0">
          <div className="flex-1 relative flex flex-col min-h-0">
            {phase === "env-setup" && (
              <EnvConfigModal
                envConfig={envConfig}
                onChange={(key, value) => setEnvConfig(prev => ({ ...prev, [key]: value }))}
                onLaunch={bootAndRun}
                isDryRun={envConfig.DRY_RUN === "true"}
              />
            )}
            <CodeEditor content={selectedContent} onChange={handleEditorChange} />
          </div>
          <TerminalPanel terminalRef={terminalRef} onClear={() => termRef.current?.clear()} />
        </div>
      </div>
    </div>
  );
}