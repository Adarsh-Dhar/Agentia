"use client";

/**
 * frontend/components/webcontainer-bot-runner.tsx
 *
 * Bot IDE component. Loads the most recently generated bot from the DB,
 * renders its files, and runs it inside a WebContainer sandbox.
 *
 * Key changes:
 *  - Pre-populates MCP_GATEWAY_URL in the env config
 *  - Shows strategy/chain badges in the header
 *  - Enforces AutoSign session-key launch prerequisites
 */

import { useState, useCallback, useEffect, useRef } from "react";
import { Zap, Play, Square, Bot, ShieldCheck, ShieldOff } from "lucide-react";
import { TESTNET, useInterwovenKit } from "@initia/interwovenkit-react";

import { useTerminal }       from "@/hooks/use-terminal";
import { useBotCodeGen }     from "@/hooks/use-bot-code-gen";
import { useBotSandbox }     from "@/hooks/use-bot-sandbox";
import { FileExplorer }      from "@/components/ui/FileExplorer";
import { CodeEditor }        from "@/components/ui/code-editor";
import { TerminalPanel }     from "@/components/ui/TerminalPanel";
import { SessionKeyConfirmModal } from "@/components/ui/session-key-confirm-modal";
import type { BotEnvConfig, BotIntent } from "@/lib/bot-constant";
import { DEFAULT_BOT_ENV_CONFIG } from "@/lib/bot-constant";

function isLocalOrProxyGateway(value?: string | null): boolean {
  const normalized = String(value || "").trim();
  return /(^|\/\/)(localhost|127\.0\.0\.1|0\.0\.0\.0|192\.168\.)/i.test(normalized) || /\/api\/mcp-proxy\/?$/i.test(normalized);
}

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
  if (!intent) return "◇ Initia";
  const nets: Record<string, string> = {
    "initia-testnet": "◇ Initia Testnet",
    "initia-mainnet": "◇ Initia Mainnet",
  };
  return nets[intent.network ?? ""] ?? "◇ Initia";
}

// ─── Component ────────────────────────────────────────────────────────────────

export function WebContainerBotRunner() {
  const [envConfig, setEnvConfig] = useState<BotEnvConfig>({ ...DEFAULT_BOT_ENV_CONFIG });
  const [fileEdits, setFileEdits] = useState<Record<string, string>>({});
  const [envLoaded, setEnvLoaded] = useState(false);
  const [intent,    setIntent]    = useState<BotIntent | null>(null);
  const [showSessionKeyModal, setShowSessionKeyModal] = useState(false);
  const didAutoLaunchRef = useRef(false);
  const shouldAutoLaunchRef = useRef(false);
  const { autoSign } = useInterwovenKit();

  const { terminalRef, termRef } = useTerminal();

  const { generateFiles, generatedFiles, selectedFile, setSelectedFile } = useBotCodeGen(termRef);

  const isDryRun = envConfig.SIMULATION_MODE === "true";

  // Merge file edits on top of generated files
  const currentFiles = generatedFiles.map(f => ({
    ...f,
    content: fileEdits[f.filepath] !== undefined ? fileEdits[f.filepath] : f.content,
  }));

  const sandbox = useBotSandbox({ generatedFiles: currentFiles, envConfig, termRef });
  const { phase, setPhase, status, stopProcess, bootAndRun } = sandbox;
  const autosignEnabled = autoSign?.isEnabledByChain?.[TESTNET.defaultChainId] ?? false;
  const sessionKey = String((autoSign as { wallet?: { privateKey?: unknown } } | undefined)?.wallet?.privateKey ?? "").trim();
  const sessionKeyActive = autosignEnabled && sessionKey.length > 0;

  // On mount: load files + env + intent from DB
  useEffect(() => {
    (async () => {
      const envDefaultsResponse = await fetch("/api/env-defaults").catch(() => null);
      const envDefaultsJson = envDefaultsResponse && envDefaultsResponse.ok ? await envDefaultsResponse.json().catch(() => null) : null;
      const sharedGateway = typeof envDefaultsJson?.values?.MCP_GATEWAY_URL === "string"
        ? envDefaultsJson.values.MCP_GATEWAY_URL
        : "";

      const result = await generateFiles();
      if (result?.loadedEnvConfig) {
        const loadedGateway = result.loadedEnvConfig?.MCP_GATEWAY_URL || "";
        setEnvConfig(prev => ({
          ...prev,
          ...result.loadedEnvConfig,
          // Always ensure MCP_GATEWAY_URL is present
          MCP_GATEWAY_URL: isLocalOrProxyGateway(loadedGateway)
            ? (sharedGateway || prev.MCP_GATEWAY_URL || DEFAULT_BOT_ENV_CONFIG.MCP_GATEWAY_URL)
            : (loadedGateway || prev.MCP_GATEWAY_URL || sharedGateway || DEFAULT_BOT_ENV_CONFIG.MCP_GATEWAY_URL),
        }));
      }
      // Mark env hydration complete even when no .env exists,
      // so auto-launch can safely proceed with defaults.
      setEnvLoaded(true);
      if (result?.intent) {
        setIntent(result.intent);
      }

      // Mark for auto-launch; actual boot happens after generatedFiles state is populated.
      if (result?.success) {
        shouldAutoLaunchRef.current = true;
      }

      setPhase("idle");
    })();
  }, []);

  // Auto-launch only after both files and env state are hydrated.
  useEffect(() => {
    if (didAutoLaunchRef.current) return;
    if (!shouldAutoLaunchRef.current) return;
    if (generatedFiles.length === 0) return;
    if (!envLoaded) return;
    if (!sessionKeyActive) {
      termRef.current?.writeln("\x1b[33m[System]\x1b[0m AutoSign is required before launch. Enable AutoSign in the sidebar.");
      shouldAutoLaunchRef.current = false;
      return;
    }

    didAutoLaunchRef.current = true;
    shouldAutoLaunchRef.current = false;
    setPhase("booting");
    void bootAndRun({
      ...envConfig,
      SESSION_KEY_MODE: "true",
      INITIA_KEY: sessionKey,
    });
  }, [generatedFiles.length, envLoaded, bootAndRun, envConfig, sessionKey, sessionKeyActive, setPhase, termRef]);

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

  const selectedContent = currentFiles.find(f => f.filepath === selectedFile)?.content ?? "";
  const isRunning = phase === "running";

  const handleLaunch = useCallback(() => {
    if (!autosignEnabled) {
      setShowSessionKeyModal(true);
      return;
    }
    if (!sessionKey) {
      termRef.current?.writeln("\x1b[31m[Error]\x1b[0m Session key unavailable. Re-enable AutoSign and retry.");
      return;
    }
    setShowSessionKeyModal(true);
  }, [autosignEnabled, sessionKey, termRef]);

  const handleSessionKeyConfirm = useCallback(() => {
    setShowSessionKeyModal(false);
    if (!sessionKey) {
      termRef.current?.writeln("\x1b[31m[Error]\x1b[0m Session key unavailable. Re-enable AutoSign and retry.");
      return;
    }
    setPhase("booting");
    void bootAndRun({
      ...envConfig,
      SESSION_KEY_MODE: "true",
      INITIA_KEY: sessionKey,
    });
  }, [bootAndRun, envConfig, sessionKey, setPhase, termRef]);

  const handleSessionKeyCancel = useCallback(() => {
    setShowSessionKeyModal(false);
  }, []);

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

          <span style={{
            fontSize: 10,
            background: sessionKeyActive ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)",
            padding: "2px 8px", borderRadius: 4,
            border: `1px solid ${sessionKeyActive ? "rgba(34,197,94,0.3)" : "rgba(239,68,68,0.3)"}`,
            color: sessionKeyActive ? "#4ade80" : "#fca5a5",
            display: "flex", alignItems: "center", gap: 4,
          }}>
            {sessionKeyActive ? <ShieldCheck size={10} /> : <ShieldOff size={10} />}
            {sessionKeyActive ? "Session Key Active" : "AutoSign Required"}
          </span>

          <button
            type="button"
            style={{
              display: "flex", alignItems: "center", gap: 5,
              background: "#1e293b", border: "1px solid #334155",
              borderRadius: 6, padding: "5px 10px",
              color: "#94a3b8", fontSize: 11, fontWeight: 600,
              fontFamily: "inherit",
              cursor: "default",
            }}
            title={sessionKeyActive ? "Session key is sourced from AutoSign and injected at launch." : "Enable AutoSign to activate session key mode."}
          >
            <Bot size={11} /> {sessionKeyActive ? "Session Key Active ✓" : "Session Key Inactive"}
          </button>

          {/* Start / Stop */}
          {isRunning ? (
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
              onClick={handleLaunch}
              disabled={!sessionKeyActive}
              style={{
                display: "flex", alignItems: "center", gap: 5,
                background: sessionKeyActive ? "#059669" : "#1e293b",
                border: sessionKeyActive ? "1px solid #10b981" : "1px solid #334155",
                borderRadius: 6, padding: "5px 12px",
                color: sessionKeyActive ? "#a7f3d0" : "#64748b", fontSize: 11, fontWeight: 700,
                cursor: sessionKeyActive ? "pointer" : "not-allowed", fontFamily: "inherit",
              }}
            >
              <Play size={11} fill="currentColor" /> Launch Bot
            </button>
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

      {/* ── Session Key Confirmation Modal ─────────────────────────────── */}
      <SessionKeyConfirmModal
        isOpen={showSessionKeyModal}
        isEnabled={autosignEnabled}
        onConfirm={handleSessionKeyConfirm}
        onCancel={handleSessionKeyCancel}
        isDryRun={isDryRun}
      />
    </div>
  );
}