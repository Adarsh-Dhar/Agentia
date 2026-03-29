"use client";

import { useState, useCallback, useEffect } from "react";
import { Zap, Play, Square } from "lucide-react";

import { useTerminal }       from "@/hooks/use-terminal";
import { useBotCodeGen }     from "@/hooks/use-bot-code-gen";
import { useBotSandbox }     from "@/hooks/use-bot-sandbox";
import { FileExplorer }      from "@/components/ui/FileExplorer";
import { CodeEditor }        from "@/components/ui/code-editor";
import { TerminalPanel }     from "@/components/ui/TerminalPanel";
import type { BotEnvConfig } from "@/lib/bot-constant";
import { DEFAULT_BOT_ENV_CONFIG } from "@/lib/bot-constant";

export function WebContainerBotRunner() {
  const [envConfig, setEnvConfig] = useState<BotEnvConfig>({ ...DEFAULT_BOT_ENV_CONFIG });
  const [fileEdits, setFileEdits] = useState<Record<string, string>>({});
  // Track whether env has been loaded from DB — prevents overwriting with defaults on re-render
  const [envLoaded, setEnvLoaded] = useState(false);

  const { terminalRef, termRef } = useTerminal();

  const { generateFiles, generatedFiles, selectedFile, setSelectedFile } = useBotCodeGen(termRef);

  const isDryRun = envConfig.SIMULATION_MODE === "true";

  // Merge file edits on top of generated files
  const currentFiles = generatedFiles.map((f) => ({
    ...f,
    content: fileEdits[f.filepath] !== undefined ? fileEdits[f.filepath] : f.content,
  }));

  const sandbox = useBotSandbox({ generatedFiles: currentFiles, envConfig, termRef });
  const { phase, setPhase, status, stopProcess, bootAndRun } = sandbox;

  // On mount: load files and inject env config from DB
  useEffect(() => {
    (async () => {
      const result = await generateFiles();
      if (result?.loadedEnvConfig) {
        setEnvConfig(result.loadedEnvConfig);
        setEnvLoaded(true);
      }
      setPhase("idle");
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // If the user edits the .env file directly in the code editor, sync it to envConfig
  useEffect(() => {
    const envFileEdit = fileEdits[".env"];
    if (!envFileEdit) return;

    // Parse the edited .env and update envConfig
    const parsed: Record<string, string> = {};
    for (const rawLine of envFileEdit.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eqIdx = line.indexOf("=");
      if (eqIdx === -1) continue;
      const key   = line.slice(0, eqIdx).trim();
      const value = line.slice(eqIdx + 1).trim();
      if (key) parsed[key] = value;
    }

    setEnvConfig((prev) => ({
      ...prev,
      SIMULATION_MODE:     parsed.SIMULATION_MODE     ?? prev.SIMULATION_MODE,
      RPC_PROVIDER_URL:    parsed.RPC_PROVIDER_URL    ?? prev.RPC_PROVIDER_URL,
      WALLET_PRIVATE_KEY:  parsed.WALLET_PRIVATE_KEY  ?? prev.WALLET_PRIVATE_KEY,
      ONEINCH_API_KEY:     parsed.ONEINCH_API_KEY     ?? prev.ONEINCH_API_KEY,
      WEBACY_API_KEY:      parsed.WEBACY_API_KEY      ?? prev.WEBACY_API_KEY,
      BORROW_AMOUNT_HUMAN: parsed.BORROW_AMOUNT_HUMAN ?? prev.BORROW_AMOUNT_HUMAN,
      POLL_INTERVAL:       parsed.POLL_INTERVAL       ?? prev.POLL_INTERVAL,
    }));
  }, [fileEdits]);

  const handleEditorChange = useCallback(
    (value: string) => {
      if (selectedFile) {
        setFileEdits((prev) => ({ ...prev, [selectedFile]: value }));
      }
    },
    [selectedFile]
  );

  const selectedContent =
    currentFiles.find((f) => f.filepath === selectedFile)?.content ?? "";

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
            Arbitrage Bot IDE
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {/* Env status indicator */}
          <span
            style={{
              fontSize:   10,
              background: envLoaded ? "rgba(34,197,94,0.1)" : "rgba(251,191,36,0.1)",
              padding:    "2px 8px",
              borderRadius: 4,
              border:     `1px solid ${envLoaded ? "rgba(34,197,94,0.3)" : "rgba(251,191,36,0.3)"}`,
              color:      envLoaded ? "#4ade80" : "#fbbf24",
            }}
          >
            {envLoaded ? "ENV ✓" : "NO ENV"}
          </span>

          <span
            style={{
              fontSize: 10,
              background: "#0f172a",
              padding: "2px 8px",
              borderRadius: 4,
              border: "1px solid #1e293b",
              color: "#64748b",
            }}
          >
            {status?.toUpperCase() ?? "IDLE"}
          </span>

          {isDryRun && (
            <span
              style={{
                fontSize: 10,
                background: "rgba(250,204,21,0.1)",
                padding: "2px 8px",
                borderRadius: 4,
                border: "1px solid rgba(250,204,21,0.3)",
                color: "#fbbf24",
              }}
            >
              SIM
            </span>
          )}

          {/* Control buttons */}
          {phase === "running" ? (
            <button
              onClick={stopProcess}
              style={{
                display: "flex", alignItems: "center", gap: 5,
                background: "#7f1d1d", border: "1px solid #991b1b",
                borderRadius: 6, padding: "5px 12px",
                color: "#fca5a5", fontSize: 11, fontWeight: 700,
                cursor: "pointer", fontFamily: "inherit",
              }}
            >
              <Square size={10} fill="currentColor" /> Stop Bot
            </button>
          ) : generatedFiles.length === 0 ? (
            <button
              disabled
              style={{
                display: "flex", alignItems: "center", gap: 5,
                background: "#1e293b", border: "1px solid #334155",
                borderRadius: 6, padding: "5px 12px",
                color: "#475569", fontSize: 11, fontWeight: 700,
                cursor: "not-allowed", fontFamily: "inherit",
              }}
            >
              <Play size={11} fill="currentColor" /> Loading…
            </button>
          ) : (
            <button
              onClick={() => {
                setPhase("running");
                bootAndRun();
              }}
              style={{
                display: "flex", alignItems: "center", gap: 5,
                background: "#059669", border: "1px solid #10b981",
                borderRadius: 6, padding: "5px 12px",
                color: "#a7f3d0", fontSize: 11, fontWeight: 700,
                cursor: "pointer", fontFamily: "inherit",
              }}
            >
              <Play size={11} fill="currentColor" /> Launch Bot
            </button>
          )}
        </div>
      </div>

      {/* ── Main body ── */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        <FileExplorer
          files={currentFiles}
          selectedFile={selectedFile}
          onSelect={setSelectedFile}
        />

        <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
          <div
            style={{
              flex: 1,
              position: "relative",
              display: "flex",
              flexDirection: "column",
              minHeight: 0,
            }}
          >
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