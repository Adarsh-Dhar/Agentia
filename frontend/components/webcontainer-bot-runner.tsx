"use client";

import { useState, useCallback } from "react";
import { Zap, Play, Settings, Square, Save, CheckCircle2, AlertCircle, Loader2, Database } from "lucide-react";

import { useTerminal }       from "@/hooks/use-terminal";
import { useBotCodeGen }     from "@/hooks/use-bot-code-gen";
import { useBotSandbox }     from "@/hooks/use-bot-sandbox";
import { FileExplorer }      from "@/components/ui/FileExplorer";
import { CodeEditor }        from "@/components/ui/code-editor";
import { TerminalPanel }     from "@/components/ui/TerminalPanel";
import { BotEnvConfigModal } from "@/components/ui/Botenvconfigmodal";
import type { BotEnvConfig } from "@/lib/bot-constant";
import { DEFAULT_BOT_ENV_CONFIG } from "@/lib/bot-constant";

type SaveStatus = "idle" | "saving" | "saved" | "error";

function inferLanguage(filepath: string): string {
  if (filepath.endsWith(".ts") || filepath.endsWith(".tsx")) return "typescript";
  if (filepath.endsWith(".js") || filepath.endsWith(".jsx")) return "javascript";
  if (filepath.endsWith(".json")) return "json";
  if (filepath.endsWith(".md"))   return "markdown";
  return "plaintext";
}

// ─── Save button ──────────────────────────────────────────────────────────────

interface SaveButtonProps {
  files:     { filepath: string; content: string; language?: string }[];
  envConfig: BotEnvConfig; // encrypted server-side before storage
  disabled:  boolean;
}

function SaveButton({ files, envConfig, disabled }: SaveButtonProps) {
  const [saveStatus,   setSaveStatus]   = useState<SaveStatus>("idle");
  const [savedAgentId, setSavedAgentId] = useState<string | null>(null);

  const handleSave = useCallback(async () => {
    if (disabled || files.length === 0) return;
    setSaveStatus("saving");

    try {
      const res = await fetch("/api/agents/save-bot", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          name:  "Base Sepolia Arbitrage Bot",
          files: files.map((f) => ({
            filepath: f.filepath,
            content:  f.content,
            language: f.language ?? inferLanguage(f.filepath),
          })),
          // envConfig is encrypted (AES-256-GCM) by the API route before DB storage
          envConfig,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }

      const data = await res.json();
      setSavedAgentId(data.agentId);
      setSaveStatus("saved");
      setTimeout(() => setSaveStatus("idle"), 4000);
    } catch (err: unknown) {
      console.error("[SaveButton]", err);
      setSaveStatus("error");
      setTimeout(() => setSaveStatus("idle"), 3000);
    }
  }, [files, envConfig, disabled]);

  const isDisabled = disabled || files.length === 0 || saveStatus === "saving";

  const bgColor = saveStatus === "saved"
    ? "rgba(34,197,94,0.12)"
    : saveStatus === "error"
    ? "rgba(239,68,68,0.12)"
    : "#0f172a";

  const borderColor = saveStatus === "saved"
    ? "rgba(34,197,94,0.35)"
    : saveStatus === "error"
    ? "rgba(239,68,68,0.35)"
    : "#1e293b";

  const textColor = saveStatus === "saved"
    ? "#4ade80"
    : saveStatus === "error"
    ? "#f87171"
    : isDisabled
    ? "#334155"
    : "#94a3b8";

  const label = saveStatus === "saving" ? "Saving…"
    : saveStatus === "saved"  ? "Saved!"
    : saveStatus === "error"  ? "Failed"
    : "Save to DB";

  const Icon = saveStatus === "saving" ? Loader2
    : saveStatus === "saved"  ? CheckCircle2
    : saveStatus === "error"  ? AlertCircle
    : Save;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <div style={{ width: 1, height: 16, background: "#1e293b" }} />
      <button
        onClick={handleSave}
        disabled={isDisabled}
        title={
          files.length === 0
            ? "Load bot files first"
            : saveStatus === "saved"
            ? "Saved — click to save a new version"
            : "Save all bot files + credentials (encrypted) to the database"
        }
        style={{
          display:      "flex",
          alignItems:   "center",
          gap:          5,
          background:   bgColor,
          border:       `1px solid ${borderColor}`,
          borderRadius: 6,
          padding:      "5px 11px",
          color:        textColor,
          fontSize:     11,
          fontWeight:   700,
          cursor:       isDisabled ? "not-allowed" : "pointer",
          fontFamily:   "inherit",
          opacity:      isDisabled && saveStatus === "idle" ? 0.45 : 1,
          transition:   "background 0.15s, border-color 0.15s, color 0.15s",
        }}
        onMouseEnter={(e) => {
          if (!isDisabled) (e.currentTarget as HTMLButtonElement).style.borderColor = "#334155";
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.borderColor = borderColor;
        }}
      >
        <Icon
          size={11}
          style={saveStatus === "saving" ? { animation: "spin 1s linear infinite" } : undefined}
        />
        {label}
        {saveStatus === "saved" && savedAgentId && (
          <span style={{ fontFamily: "monospace", fontSize: 10, color: "#22c55e", opacity: 0.7 }}>
            #{savedAgentId.slice(-6)}
          </span>
        )}
      </button>

      {saveStatus === "saved" && savedAgentId && (
        <a
          href={`/dashboard/agents/${savedAgentId}`}
          target="_blank"
          rel="noopener noreferrer"
          title="Open agent detail page"
          style={{
            display:        "flex",
            alignItems:     "center",
            gap:            4,
            color:          "#4ade80",
            fontSize:       10,
            opacity:        0.75,
            textDecoration: "none",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
          onMouseLeave={(e) => (e.currentTarget.style.opacity = "0.75")}
        >
          <Database size={10} />
          view
        </a>
      )}

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function WebContainerBotRunner() {
  const [envConfig, setEnvConfig] = useState<BotEnvConfig>({ ...DEFAULT_BOT_ENV_CONFIG });
  const [fileEdits, setFileEdits] = useState<Record<string, string>>({});

  const { terminalRef, termRef } = useTerminal();
  const { generateFiles, generatedFiles, selectedFile, setSelectedFile } = useBotCodeGen(termRef);

  const currentFiles = generatedFiles.map((f) => ({
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

  const selectedContent = currentFiles.find((f) => f.filepath === selectedFile)?.content;
  const isDryRun        = envConfig.SIMULATION_MODE === "true";

  const handleEditorChange = (newContent: string) => {
    if (!selectedFile) return;
    setFileEdits((prev) => ({ ...prev, [selectedFile]: newContent }));
    if (phase === "running") {
      updateFileInSandbox(selectedFile, newContent);
    }
  };

  const saveDisabled = phase === "booting" || phase === "installing";

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

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 10, background: "#0f172a", padding: "2px 8px", borderRadius: 4, border: "1px solid #1e293b", color: "#64748b" }}>
            {status.toUpperCase()}
          </span>

          {isDryRun && (
            <span style={{ fontSize: 10, background: "rgba(250,204,21,0.1)", padding: "2px 8px", borderRadius: 4, border: "1px solid rgba(250,204,21,0.3)", color: "#fbbf24" }}>
              SIM
            </span>
          )}

          {phase === "running" ? (
            <button
              onClick={stopProcess}
              style={{ display: "flex", alignItems: "center", gap: 5, background: "#7f1d1d", border: "1px solid #991b1b", borderRadius: 6, padding: "5px 12px", color: "#fca5a5", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}
            >
              <Square size={10} fill="currentColor" /> Stop Bot
            </button>
          ) : generatedFiles.length === 0 ? (
            <button
              onClick={generateFiles}
              disabled={phase !== "idle"}
              style={{ display: "flex", alignItems: "center", gap: 5, background: phase !== "idle" ? "#1e293b" : "#0c4a6e", border: `1px solid ${phase !== "idle" ? "#334155" : "#0369a1"}`, borderRadius: 6, padding: "5px 12px", color: phase !== "idle" ? "#475569" : "#38bdf8", fontSize: 11, fontWeight: 700, cursor: phase !== "idle" ? "not-allowed" : "pointer", fontFamily: "inherit" }}
            >
              <Play size={11} fill="currentColor" /> Load Bot Files
            </button>
          ) : (
            <button
              onClick={() => setPhase("env-setup")}
              disabled={phase !== "idle" && phase !== "env-setup"}
              style={{ display: "flex", alignItems: "center", gap: 5, background: "#312e81", border: "1px solid #4338ca", borderRadius: 6, padding: "5px 12px", color: "#a5b4fc", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}
            >
              <Settings size={11} /> Configure & Run
            </button>
          )}

          {/* SaveButton now receives envConfig so credentials are encrypted + stored */}
          <SaveButton files={currentFiles} envConfig={envConfig} disabled={saveDisabled} />
        </div>
      </div>

      {/* ── Main body ── */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        <FileExplorer files={currentFiles} selectedFile={selectedFile} onSelect={setSelectedFile} />

        <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
          <div style={{ flex: 1, position: "relative", display: "flex", flexDirection: "column", minHeight: 0 }}>
            {phase === "env-setup" && (
              <BotEnvConfigModal
                envConfig={envConfig}
                onChange={(key, value) => setEnvConfig((prev) => ({ ...prev, [key]: value }))}
                onLaunch={bootAndRun}
                isDryRun={isDryRun}
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