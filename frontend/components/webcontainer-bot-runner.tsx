"use client";

/**
 * frontend/components/webcontainer-bot-runner.tsx
 *
 * Full IDE for the Base Sepolia MCP arbitrage bot.
 * Replaces WebContainerRunner for the /dashboard/webcontainer route.
 *
 * Layout:
 *   ┌─ Header (title, status, Generate / Configure / Run / Stop) ────────┐
 *   ├─ FileExplorer │ CodeEditor                                          │
 *   ├──────────────────────────────────────────────────────────────────── ┤
 *   └─ Terminal                                                           ┘
 */

import { useState }        from "react";
import { Zap, Play, Settings, Square } from "lucide-react";

import { useTerminal }       from "@/hooks/use-terminal";
import { useBotCodeGen }     from "@/hooks/use-bot-code-gen";
import { useBotSandbox }     from "@/hooks/use-bot-sandbox";
import { FileExplorer }      from "@/components/ui/FileExplorer";
import { CodeEditor }        from "@/components/ui/code-editor";
import { TerminalPanel }     from "@/components/ui/TerminalPanel";
import { BotEnvConfigModal } from "@/components/ui/Botenvconfigmodal";
import type { BotEnvConfig } from "@/lib/bot-constant";
import { DEFAULT_BOT_ENV_CONFIG } from "@/lib/bot-constant";

export function WebContainerBotRunner() {
  const [envConfig,  setEnvConfig]  = useState<BotEnvConfig>({ ...DEFAULT_BOT_ENV_CONFIG });
  const [fileEdits,  setFileEdits]  = useState<Record<string, string>>({});

  const { terminalRef, termRef } = useTerminal();
  const { generateFiles, generatedFiles, selectedFile, setSelectedFile } = useBotCodeGen(termRef);

  // Merge edits on top of generated content
  const currentFiles = generatedFiles.map(f => ({
    ...f,
    content: fileEdits[f.filepath] !== undefined ? fileEdits[f.filepath] : f.content,
  }));

  const {
    bootAndRun,
    phase,
    status,
    setPhase,
    stopProcess,
    updateFileInSandbox,
  } = useBotSandbox({ generatedFiles: currentFiles, envConfig, termRef });

  const selectedContent = currentFiles.find(f => f.filepath === selectedFile)?.content;
  const isDryRun        = envConfig.SIMULATION_MODE === "true";

  const handleEditorChange = (newContent: string) => {
    if (!selectedFile) return;
    setFileEdits(prev => ({ ...prev, [selectedFile]: newContent }));
    if (phase === "running") {
      updateFileInSandbox(selectedFile, newContent);
    }
  };

  return (
    <div
      style={{
        display:       "flex",
        flexDirection: "column",
        height:        "700px",
        background:    "#020617",
        borderRadius:  "12px",
        border:        "1px solid #1e293b",
        overflow:      "hidden",
        fontFamily:    "Menlo, 'Courier New', monospace",
        color:         "#e2e8f0",
        boxShadow:     "0 25px 50px -12px rgba(0,0,0,0.8)",
      }}
    >
      {/* ── Header ── */}
      <div
        style={{
          display:        "flex",
          alignItems:     "center",
          justifyContent: "space-between",
          padding:        "10px 16px",
          borderBottom:   "1px solid #1e293b",
          background:     "rgba(15,23,42,0.8)",
          flexShrink:     0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Zap size={14} color="#22d3ee" />
          <span style={{ fontSize: 12, fontWeight: 700, color: "#cbd5e1" }}>
            Base Sepolia MCP Arbitrage Bot IDE
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {/* Status badge */}
          <span
            style={{
              fontSize:     10,
              background:   "#0f172a",
              padding:      "2px 8px",
              borderRadius: 4,
              border:       "1px solid #1e293b",
              color:        "#64748b",
            }}
          >
            {status.toUpperCase()}
          </span>

          {/* Simulation indicator */}
          {isDryRun && (
            <span
              style={{
                fontSize:     10,
                background:   "rgba(250,204,21,0.1)",
                padding:      "2px 8px",
                borderRadius: 4,
                border:       "1px solid rgba(250,204,21,0.3)",
                color:        "#fbbf24",
              }}
            >
              SIM
            </span>
          )}

          {/* Action button */}
          {phase === "running" ? (
            <button
              onClick={stopProcess}
              style={{
                display:      "flex",
                alignItems:   "center",
                gap:          5,
                background:   "#7f1d1d",
                border:       "1px solid #991b1b",
                borderRadius: 6,
                padding:      "5px 12px",
                color:        "#fca5a5",
                fontSize:     11,
                fontWeight:   700,
                cursor:       "pointer",
                fontFamily:   "inherit",
              }}
            >
              <Square size={10} fill="currentColor" /> Stop Bot
            </button>
          ) : generatedFiles.length === 0 ? (
            <button
              onClick={generateFiles}
              disabled={phase !== "idle"}
              style={{
                display:      "flex",
                alignItems:   "center",
                gap:          5,
                background:   phase !== "idle" ? "#1e293b" : "#0c4a6e",
                border:       `1px solid ${phase !== "idle" ? "#334155" : "#0369a1"}`,
                borderRadius: 6,
                padding:      "5px 12px",
                color:        phase !== "idle" ? "#475569" : "#38bdf8",
                fontSize:     11,
                fontWeight:   700,
                cursor:       phase !== "idle" ? "not-allowed" : "pointer",
                fontFamily:   "inherit",
              }}
            >
              <Play size={11} fill="currentColor" /> Load Bot Files
            </button>
          ) : (
            <button
              onClick={() => setPhase("env-setup")}
              disabled={phase !== "idle" && phase !== "env-setup"}
              style={{
                display:      "flex",
                alignItems:   "center",
                gap:          5,
                background:   "#312e81",
                border:       "1px solid #4338ca",
                borderRadius: 6,
                padding:      "5px 12px",
                color:        "#a5b4fc",
                fontSize:     11,
                fontWeight:   700,
                cursor:       "pointer",
                fontFamily:   "inherit",
              }}
            >
              <Settings size={11} /> Configure & Run
            </button>
          )}
        </div>
      </div>

      {/* ── Main body ── */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {/* File explorer */}
        <FileExplorer
          files={currentFiles}
          selectedFile={selectedFile}
          onSelect={setSelectedFile}
        />

        {/* Editor + Terminal */}
        <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
          <div style={{ flex: 1, position: "relative", display: "flex", flexDirection: "column", minHeight: 0 }}>
            {/* Env config overlay */}
            {phase === "env-setup" && (
              <BotEnvConfigModal
                envConfig={envConfig}
                onChange={(key, value) => setEnvConfig(prev => ({ ...prev, [key]: value }))}
                onLaunch={bootAndRun}
                isDryRun={isDryRun}
              />
            )}
            <CodeEditor content={selectedContent} onChange={handleEditorChange} />
          </div>

          <TerminalPanel
            terminalRef={terminalRef}
            onClear={() => termRef.current?.clear()}
          />
        </div>
      </div>
    </div>
  );
}