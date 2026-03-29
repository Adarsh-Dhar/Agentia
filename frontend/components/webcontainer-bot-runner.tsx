"use client";

/**
 * frontend/components/webcontainer-bot-runner.tsx
 *
 * Full IDE for the Base Sepolia MCP arbitrage bot.
 *
 * Layout:
 *   ┌─ Header (title, status, Generate / Configure / Run / Stop / Save) ──┐
 *   ├─ FileExplorer │ CodeEditor                                           │
 *   ├─────────────────────────────────────────────────────────────────────┤
 *   └─ Terminal                                                            ┘
 */

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

// ─── Save status ──────────────────────────────────────────────────────────────

type SaveStatus = "idle" | "saving" | "saved" | "error";

function inferLanguage(filepath: string): string {
  if (filepath.endsWith(".ts") || filepath.endsWith(".tsx")) return "typescript";
  if (filepath.endsWith(".js") || filepath.endsWith(".jsx")) return "javascript";
  if (filepath.endsWith(".json")) return "json";
  if (filepath.endsWith(".md"))   return "markdown";
  return "plaintext";
}

// ─── Inline save button (no external deps beyond existing ones) ───────────────

interface SaveButtonProps {
  files: { filepath: string; content: string; language?: string }[];
  disabled: boolean;
}

function SaveButton({ files, disabled }: SaveButtonProps) {
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
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }

      const data = await res.json();
      setSavedAgentId(data.agentId);
      setSaveStatus("saved");
      // Reset after 4 s so the user can re-save
      setTimeout(() => setSaveStatus("idle"), 4000);
    } catch (err: unknown) {
      console.error("[SaveButton]", err);
      setSaveStatus("error");
      setTimeout(() => setSaveStatus("idle"), 3000);
    }
  }, [files, disabled]);

  // ── Derived visuals ──────────────────────────────────────────────────────
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
      {/* Divider */}
      <div style={{ width: 1, height: 16, background: "#1e293b" }} />

      <button
        onClick={handleSave}
        disabled={isDisabled}
        title={
          files.length === 0
            ? "Load bot files first"
            : saveStatus === "saved"
            ? "Saved — click to save a new version"
            : "Save all bot files to the database"
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

      {/* View agent link — appears after save */}
      {saveStatus === "saved" && savedAgentId && (
        <a
          href={`/dashboard/agents/${savedAgentId}`}
          target="_blank"
          rel="noopener noreferrer"
          title="Open agent detail page"
          style={{
            display:    "flex",
            alignItems: "center",
            gap:        4,
            color:      "#4ade80",
            fontSize:   10,
            opacity:    0.75,
            textDecoration: "none",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
          onMouseLeave={(e) => (e.currentTarget.style.opacity = "0.75")}
        >
          <Database size={10} />
          view
        </a>
      )}

      {/* Keyframe for spinner — injected once */}
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

  // Merge any in-editor edits on top of the generated content
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

  // Save is blocked while the container is actively booting/installing
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
        {/* Left: title */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Zap size={14} color="#22d3ee" />
          <span style={{ fontSize: 12, fontWeight: 700, color: "#cbd5e1" }}>
            Base Sepolia MCP Arbitrage Bot IDE
          </span>
        </div>

        {/* Right: controls */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
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

          {/* Simulation mode indicator */}
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

          {/* Run / Stop / Load / Configure */}
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

          {/* ── Save to DB ── always rendered, disabled until files are loaded */}
          <SaveButton files={currentFiles} disabled={saveDisabled} />
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

        {/* Editor + Terminal stack */}
        <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
          <div
            style={{
              flex:          1,
              position:      "relative",
              display:       "flex",
              flexDirection: "column",
              minHeight:     0,
            }}
          >
            {/* Env config overlay */}
            {phase === "env-setup" && (
              <BotEnvConfigModal
                envConfig={envConfig}
                onChange={(key, value) =>
                  setEnvConfig((prev) => ({ ...prev, [key]: value }))
                }
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