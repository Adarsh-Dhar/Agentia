"use client";

/**
 * frontend/components/webcontainer-bot-runner.tsx
 *
 * Bot IDE component. Loads the most recently generated bot from the DB,
 * renders its files, and runs it inside a WebContainer sandbox.
 *
 * Key changes:
 *  - Passes `intent` to BotEnvConfigModal so it renders the correct fields
 *  - Pre-populates MCP_GATEWAY_URL in the env config
 *  - Shows strategy/chain badges in the header
 */

import { useState, useCallback, useEffect } from "react";
import { Zap, Play, Square, Bot } from "lucide-react";

import { useTerminal }       from "@/hooks/use-terminal";
import { useBotCodeGen }     from "@/hooks/use-bot-code-gen";
import { useBotSandbox }     from "@/hooks/use-bot-sandbox";
import { FileExplorer }      from "@/components/ui/FileExplorer";
import { CodeEditor }        from "@/components/ui/code-editor";
import { TerminalPanel }     from "@/components/ui/TerminalPanel";
import { BotEnvConfigModal } from "@/components/ui/Botenvconfigmodal";
import type { BotEnvConfig, BotIntent } from "@/lib/bot-constant";
import { DEFAULT_BOT_ENV_CONFIG } from "@/lib/bot-constant";

// ─── Strategy display helpers ─────────────────────────────────────────────────

function strategyBadge(intent?: BotIntent | null) {
  if (!intent?.strategy) return null;
  const labels: Record<string, string> = {
    arbitrage:    "⚡ Arbitrage",
    sniping:      "🎯 Sniper",
    sentiment:    "📰 Sentiment",
    whale_mirror: "🐋 Whale Mirror",
    dca:          "📊 DCA",
    grid:         "📐 Grid",
    perp:         "📈 Perp/Funding",
    yield:        "🌉 Yield/Bridge",
    mev_intent:   "🛡️ MEV-Protected",
    scalper:      "⚡ HF Scalper",
    news_reactive:"📰 News Trader",
    rebalancing:  "⚖️ Rebalancer",
    ta_scripter:  "📊 TA Trader",
  };
  return labels[intent.strategy] ?? intent.strategy;
}

function chainBadge(intent?: BotIntent | null): string {
  if (!intent) return "EVM";
  if (intent.chain === "solana") return "◎ Solana";
  const nets: Record<string, string> = {
    "base-sepolia": "⬡ Base Sepolia",
    "base-mainnet": "⬡ Base",
    "arbitrum":     "🔴 Arbitrum",
  };
  return nets[intent.network ?? ""] ?? "⬡ EVM";
}

// ─── Component ────────────────────────────────────────────────────────────────

export function WebContainerBotRunner() {
  const [envConfig, setEnvConfig] = useState<BotEnvConfig>({ ...DEFAULT_BOT_ENV_CONFIG });
  const [fileEdits, setFileEdits] = useState<Record<string, string>>({});
  const [envLoaded, setEnvLoaded] = useState(false);
  const [intent,    setIntent]    = useState<BotIntent | null>(null);
  const [showEnvModal, setShowEnvModal] = useState(false);

  const { terminalRef, termRef } = useTerminal();

  const { generateFiles, generatedFiles, selectedFile, setSelectedFile } = useBotCodeGen(termRef);

  const isDryRun = envConfig.SIMULATION_MODE !== "false";

  // Merge file edits on top of generated files
  const currentFiles = generatedFiles.map(f => ({
    ...f,
    content: fileEdits[f.filepath] !== undefined ? fileEdits[f.filepath] : f.content,
  }));

  const sandbox = useBotSandbox({ generatedFiles: currentFiles, envConfig, termRef });
  const { phase, setPhase, status, stopProcess, bootAndRun } = sandbox;

  // On mount: load files + env + intent from DB
  useEffect(() => {
    (async () => {
      const result = await generateFiles();
      if (result?.loadedEnvConfig) {
        setEnvConfig(prev => ({
          ...prev,
          ...result.loadedEnvConfig,
          // Always ensure MCP_GATEWAY_URL is present
          MCP_GATEWAY_URL: result.loadedEnvConfig?.MCP_GATEWAY_URL
            || prev.MCP_GATEWAY_URL
            || DEFAULT_BOT_ENV_CONFIG.MCP_GATEWAY_URL,
        }));
        setEnvLoaded(true);
      }
      if (result?.intent) {
        setIntent(result.intent);
      }
      setPhase("idle");
      // Show env modal on first load so user can review/fill credentials
      setShowEnvModal(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync .env file edits back to envConfig
  useEffect(() => {
    const envFileEdit = fileEdits[".env"];
    if (!envFileEdit) return;
    const parsed: Record<string, string> = {};
    for (const rawLine of envFileEdit.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eqIdx = line.indexOf("=");
      if (eqIdx === -1) continue;
      const k = line.slice(0, eqIdx).trim();
      const v = line.slice(eqIdx + 1).trim();
      if (k) parsed[k] = v;
    }
    setEnvConfig(prev => ({ ...prev, ...parsed }));
  }, [fileEdits]);

  const handleEditorChange = useCallback(
    (value: string) => {
      if (selectedFile) {
        setFileEdits(prev => ({ ...prev, [selectedFile]: value }));
      }
    },
    [selectedFile]
  );

  const handleEnvChange = useCallback(
    (key: keyof BotEnvConfig, value: string) => {
      setEnvConfig(prev => ({ ...prev, [key]: value }));
      // Also update the .env file shown in the editor
      setFileEdits(prev => {
        const existing = prev[".env"] || currentFiles.find(f => f.filepath === ".env")?.content || "";
        const lines = existing.split("\n");
        const idx = lines.findIndex(l => l.startsWith(`${key}=`));
        if (idx >= 0) {
          lines[idx] = `${key}=${value}`;
        } else {
          lines.push(`${key}=${value}`);
        }
        return { ...prev, ".env": lines.filter(Boolean).join("\n") };
      });
    },
    [currentFiles]
  );

  const handleLaunch = () => {
    setShowEnvModal(false);
    setPhase("running");
    bootAndRun();
  };

  const selectedContent = currentFiles.find(f => f.filepath === selectedFile)?.content ?? "";
  const isRunning = phase === "running";

  return (
    <div style={{
      display: "flex", flexDirection: "column",
      height: "700px",
      background: "#020617", borderRadius: "12px",
      border: "1px solid #1e293b", overflow: "hidden",
      fontFamily: "Menlo, 'Courier New', monospace",
      color: "#e2e8f0",
      boxShadow: "0 25px 50px -12px rgba(0,0,0,0.8)",
      position: "relative",
    }}>

      {/* ── Env config overlay ─────────────────────────────────────────────── */}
      {showEnvModal && (
        <BotEnvConfigModal
          envConfig={envConfig}
          intent={intent}
          onChange={handleEnvChange}
          onLaunch={handleLaunch}
          isDryRun={isDryRun}
        />
      )}

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "10px 16px", borderBottom: "1px solid #1e293b",
        background: "rgba(15,23,42,0.8)", flexShrink: 0,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Zap size={14} color="#22d3ee" />
          <span style={{ fontSize: 12, fontWeight: 700, color: "#cbd5e1" }}>
            Bot IDE
          </span>
          {/* Strategy + chain badges */}
          {intent && (
            <>
              {strategyBadge(intent) && (
                <span style={{
                  fontSize: 10, padding: "2px 7px", borderRadius: 20,
                  background: "rgba(34,211,238,0.08)", border: "1px solid rgba(34,211,238,0.2)",
                  color: "#22d3ee",
                }}>
                  {strategyBadge(intent)}
                </span>
              )}
              <span style={{
                fontSize: 10, padding: "2px 7px", borderRadius: 20,
                background: "rgba(139,92,246,0.08)", border: "1px solid rgba(139,92,246,0.2)",
                color: "#a78bfa",
              }}>
                {chainBadge(intent)}
              </span>
            </>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {/* Status pills */}
          <span style={{
            fontSize: 10,
            background: envLoaded ? "rgba(34,197,94,0.1)" : "rgba(251,191,36,0.1)",
            padding: "2px 8px", borderRadius: 4,
            border: `1px solid ${envLoaded ? "rgba(34,197,94,0.3)" : "rgba(251,191,36,0.3)"}`,
            color: envLoaded ? "#4ade80" : "#fbbf24",
          }}>
            {envLoaded ? "ENV ✓" : "ENV ?"}
          </span>

          <span style={{
            fontSize: 10, background: "#0f172a",
            padding: "2px 8px", borderRadius: 4,
            border: "1px solid #1e293b", color: "#64748b",
          }}>
            {status?.toUpperCase() ?? "IDLE"}
          </span>

          {isDryRun && (
            <span style={{
              fontSize: 10, background: "rgba(250,204,21,0.1)",
              padding: "2px 8px", borderRadius: 4,
              border: "1px solid rgba(250,204,21,0.3)", color: "#fbbf24",
            }}>
              SIM
            </span>
          )}

          {/* Configure button */}
          {!showEnvModal && (
            <button
              onClick={() => setShowEnvModal(true)}
              style={{
                display: "flex", alignItems: "center", gap: 5,
                background: "#1e293b", border: "1px solid #334155",
                borderRadius: 6, padding: "5px 10px",
                color: "#94a3b8", fontSize: 11, fontWeight: 600,
                cursor: "pointer", fontFamily: "inherit",
              }}
            >
              <Bot size={11} /> Configure
            </button>
          )}

          {/* Start / Stop */}
          {!showEnvModal && (
            isRunning ? (
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
                <Square size={10} fill="currentColor" /> Stop
              </button>
            ) : generatedFiles.length === 0 ? (
              <button disabled style={{
                display: "flex", alignItems: "center", gap: 5,
                background: "#1e293b", border: "1px solid #334155",
                borderRadius: 6, padding: "5px 12px",
                color: "#475569", fontSize: 11, fontWeight: 700,
                cursor: "not-allowed", fontFamily: "inherit",
              }}>
                <Play size={11} fill="currentColor" /> Loading…
              </button>
            ) : (
              <button
                onClick={() => { setShowEnvModal(true); }}
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
            )
          )}
        </div>
      </div>

      {/* ── Main body ──────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        <FileExplorer
          files={currentFiles}
          selectedFile={selectedFile}
          onSelect={setSelectedFile}
        />

        <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
          <div style={{ flex: 1, position: "relative", display: "flex", flexDirection: "column", minHeight: 0 }}>
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