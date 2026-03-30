"use client";

/**
 * frontend/components/ui/Botenvconfigmodal.tsx
 *
 * Dynamically renders the env-var input form based on the BotIntent returned
 * by the orchestrator. This ensures that Solana bots ask for SOLANA_PRIVATE_KEY,
 * agentic bots ask for OPENAI_API_KEY, etc. — instead of always showing the
 * same EVM-only fields.
 */

import { Rocket, Eye, EyeOff, ExternalLink, AlertTriangle, CheckCircle, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import {
  type BotEnvConfig,
  type BotIntent,
  getRequiredEnvFields,
  type EnvFieldDef,
} from "@/lib/bot-constant";

interface Props {
  envConfig: BotEnvConfig;
  intent?:   BotIntent | null;
  onChange:  (key: keyof BotEnvConfig, value: string) => void;
  onLaunch:  () => void;
  isDryRun:  boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function canLaunch(fields: EnvFieldDef[], cfg: BotEnvConfig, isDryRun: boolean): boolean {
  const reqFilled = fields
    .filter(f => f.required && !f.liveOnly)
    .every(f => (cfg[f.key] ?? "").trim().length > 0);

  const liveReqFilled = isDryRun
    ? true
    : fields
        .filter(f => f.required && f.liveOnly)
        .every(f => (cfg[f.key] ?? "").trim().length > 0);

  return reqFilled && liveReqFilled;
}

function strategyIcon(strategy?: string): string {
  if (!strategy) return "🤖";
  if (strategy.includes("arbitrage")) return "⚡";
  if (strategy.includes("snip")) return "🎯";
  if (strategy.includes("sentiment") || strategy.includes("news")) return "📰";
  if (strategy.includes("whale")) return "🐋";
  if (strategy.includes("perp") || strategy.includes("funding")) return "📈";
  if (strategy.includes("dca") || strategy.includes("grid")) return "📊";
  if (strategy.includes("yield") || strategy.includes("bridge")) return "🌉";
  return "🤖";
}

function chainLabel(intent?: BotIntent | null): string {
  if (!intent) return "EVM";
  if (intent.chain === "solana") return "Solana";
  return intent.network ?? "EVM";
}

// ─── Field renderer ───────────────────────────────────────────────────────────

function FieldRow({
  field,
  value,
  isDryRun,
  shown,
  onToggleShow,
  onChange,
}: {
  field:         EnvFieldDef;
  value:         string;
  isDryRun:      boolean;
  shown:         boolean;
  onToggleShow:  () => void;
  onChange:      (v: string) => void;
}) {
  const dimmed = !!field.liveOnly && isDryRun;

  if (field.type === "toggle") {
    const isSim = value === "true";
    return (
      <div key={field.key}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 3 }}>
          <label style={{ fontSize: 11, fontWeight: 600, color: "#94a3b8" }}>{field.label}</label>
          <button
            onClick={() => onChange(isSim ? "false" : "true")}
            style={{
              display: "flex", alignItems: "center", gap: 5,
              background:   isSim ? "rgba(34,211,238,0.1)" : "rgba(239,68,68,0.1)",
              border:       `1px solid ${isSim ? "rgba(34,211,238,0.3)" : "rgba(239,68,68,0.3)"}`,
              borderRadius: 20, padding: "3px 9px",
              cursor: "pointer", color: isSim ? "#22d3ee" : "#f87171",
              fontSize: 11, fontWeight: 700, fontFamily: "inherit",
            }}
          >
            <div style={{ width: 7, height: 7, borderRadius: "50%", background: isSim ? "#22d3ee" : "#f87171" }} />
            {isSim ? "Simulation" : "Live"}
          </button>
        </div>
        {field.helpText && <p style={{ fontSize: 10, color: "#475569", margin: 0 }}>{field.helpText}</p>}
      </div>
    );
  }

  const isPass = field.type === "password";

  return (
    <div style={{ opacity: dimmed ? 0.35 : 1, pointerEvents: dimmed ? "none" : "auto" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
        <label style={{ fontSize: 11, fontWeight: 600, color: "#94a3b8" }}>
          {field.label}
          {field.required && !field.liveOnly && <span style={{ color: "#f87171", marginLeft: 3 }}>*</span>}
          {field.liveOnly && (
            <span style={{ color: "#475569", marginLeft: 4, fontWeight: 400, fontSize: 10 }}>(live only)</span>
          )}
        </label>
        {field.helpLink && (
          <a
            href={field.helpLink} target="_blank" rel="noopener noreferrer"
            style={{ fontSize: 10, color: "#22d3ee", textDecoration: "none", display: "flex", alignItems: "center", gap: 3 }}
          >
            {field.helpLinkLabel ?? "Docs"} <ExternalLink size={9} />
          </a>
        )}
      </div>
      <div style={{ position: "relative" }}>
        <input
          type={isPass && !shown ? "password" : "text"}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={field.placeholder}
          autoComplete="off" spellCheck={false}
          style={{
            width: "100%", boxSizing: "border-box",
            background: "#020617", border: "1px solid #1e293b",
            borderRadius: 6, padding: isPass ? "8px 34px 8px 10px" : "8px 10px",
            color: "#e2e8f0", fontSize: 12,
            fontFamily: "Menlo, 'Courier New', monospace",
            outline: "none", display: "block",
          }}
          onFocus={e => { (e.target as HTMLInputElement).style.borderColor = "#22d3ee"; }}
          onBlur={e  => { (e.target as HTMLInputElement).style.borderColor = "#1e293b"; }}
        />
        {isPass && (
          <button
            type="button" onClick={onToggleShow}
            style={{
              position: "absolute", right: 7, top: "50%", transform: "translateY(-50%)",
              background: "none", border: "none", cursor: "pointer",
              color: "#475569", padding: 2, display: "flex", alignItems: "center",
            }}
          >
            {shown ? <EyeOff size={12} /> : <Eye size={12} />}
          </button>
        )}
      </div>
      {field.helpText && (
        <p style={{ fontSize: 10, color: "#475569", margin: "3px 0 0" }}>{field.helpText}</p>
      )}
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export function BotEnvConfigModal({ envConfig, intent, onChange, onLaunch, isDryRun }: Props) {
  const [shown,      setShown]      = useState<Record<string, boolean>>({});
  const [extraKeys,  setExtraKeys]  = useState<string[]>([]);
  const [newKey,     setNewKey]     = useState("");
  const [showAddKey, setShowAddKey] = useState(false);

  const toggleShow = (k: string) => setShown(p => ({ ...p, [k]: !p[k] }));

  const fields = getRequiredEnvFields(intent);
  const ready  = canLaunch(fields, envConfig, isDryRun);

  const addExtraKey = () => {
    const k = newKey.trim().toUpperCase().replace(/\s+/g, "_");
    if (k && !extraKeys.includes(k) && !fields.find(f => f.key === k)) {
      setExtraKeys(p => [...p, k]);
      onChange(k as keyof BotEnvConfig, "");
    }
    setNewKey("");
    setShowAddKey(false);
  };

  return (
    <div style={{
      position: "absolute", inset: 0,
      background: "rgba(2,6,23,0.97)", backdropFilter: "blur(3px)",
      zIndex: 20, overflowY: "auto",
      display: "flex", flexDirection: "column", alignItems: "center",
      padding: "12px 12px 24px",
    }}>
      <div style={{
        background: "#0f172a", border: "1px solid #1e293b",
        borderRadius: 12, width: "100%", maxWidth: "480px",
        flexShrink: 0, boxShadow: "0 25px 60px rgba(0,0,0,0.8)",
        overflow: "hidden",
      }}>

        {/* ── Header ─────────────────────────────────────────────────────── */}
        <div style={{ padding: "16px 18px 0" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 3 }}>
            <Rocket size={14} color="#22d3ee" />
            <span style={{ fontWeight: 700, fontSize: 13, color: "#e2e8f0" }}>
              Configure Bot Environment
            </span>
          </div>

          {/* Intent badge */}
          {intent && (
            <div style={{
              display: "flex", gap: 6, flexWrap: "wrap",
              marginBottom: 10, marginTop: 6,
            }}>
              <span style={{
                fontSize: 10, padding: "2px 8px", borderRadius: 20,
                background: "rgba(34,211,238,0.08)", border: "1px solid rgba(34,211,238,0.2)",
                color: "#22d3ee", fontWeight: 600,
              }}>
                {strategyIcon(intent.strategy)} {intent.bot_type ?? intent.strategy ?? "Custom Bot"}
              </span>
              <span style={{
                fontSize: 10, padding: "2px 8px", borderRadius: 20,
                background: "rgba(139,92,246,0.08)", border: "1px solid rgba(139,92,246,0.2)",
                color: "#a78bfa", fontWeight: 600,
              }}>
                {chainLabel(intent)}
              </span>
              {intent.execution_model && (
                <span style={{
                  fontSize: 10, padding: "2px 8px", borderRadius: 20,
                  background: "rgba(74,222,128,0.08)", border: "1px solid rgba(74,222,128,0.2)",
                  color: "#4ade80", fontWeight: 600,
                }}>
                  {intent.execution_model}
                </span>
              )}
            </div>
          )}

          <p style={{ fontSize: 10, color: "#64748b", margin: "0 0 12px" }}>
            Credentials exist only in this WebContainer session — nothing is persisted beyond this tab.
          </p>

          {/* Mode banner */}
          <div style={{
            background:   isDryRun ? "rgba(250,204,21,0.07)" : "rgba(239,68,68,0.07)",
            border:       `1px solid ${isDryRun ? "rgba(250,204,21,0.25)" : "rgba(239,68,68,0.3)"}`,
            borderRadius: 7, padding: "8px 11px", marginBottom: 14,
            display: "flex", alignItems: "center", gap: 7,
          }}>
            {isDryRun
              ? <CheckCircle size={12} color="#fbbf24" />
              : <AlertTriangle size={12} color="#f87171" />}
            <span style={{ fontSize: 11, fontWeight: 600, color: isDryRun ? "#fbbf24" : "#f87171" }}>
              {isDryRun
                ? "Simulation mode — no real transactions broadcast"
                : "LIVE MODE — real transactions will be sent"}
            </span>
          </div>
        </div>

        {/* ── Dynamic fields ──────────────────────────────────────────────── */}
        <div style={{ padding: "0 18px 14px", display: "flex", flexDirection: "column", gap: 13 }}>
          {fields.map(field => (
            <FieldRow
              key={field.key}
              field={field}
              value={envConfig[field.key] ?? ""}
              isDryRun={isDryRun}
              shown={!!shown[field.key]}
              onToggleShow={() => toggleShow(field.key as any)}
              onChange={v => onChange(field.key, v)}
            />
          ))}

          {/* Extra custom keys */}
          {extraKeys.map(k => (
            <div key={k}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                <label style={{ fontSize: 11, fontWeight: 600, color: "#94a3b8" }}>{k}</label>
                <button
                  onClick={() => {
                    setExtraKeys(p => p.filter(x => x !== k));
                    onChange(k as keyof BotEnvConfig, "");
                  }}
                  style={{ background: "none", border: "none", cursor: "pointer", color: "#ef4444", padding: 2 }}
                >
                  <Trash2 size={11} />
                </button>
              </div>
              <input
                type="text" value={envConfig[k] ?? ""}
                onChange={e => onChange(k as keyof BotEnvConfig, e.target.value)}
                placeholder={`Value for ${k}`}
                style={{
                  width: "100%", boxSizing: "border-box",
                  background: "#020617", border: "1px solid #1e293b",
                  borderRadius: 6, padding: "8px 10px",
                  color: "#e2e8f0", fontSize: 12,
                  fontFamily: "Menlo, 'Courier New', monospace", outline: "none",
                }}
                onFocus={e => { (e.target as HTMLInputElement).style.borderColor = "#22d3ee"; }}
                onBlur={e  => { (e.target as HTMLInputElement).style.borderColor = "#1e293b"; }}
              />
            </div>
          ))}

          {/* Add custom key */}
          {showAddKey ? (
            <div style={{ display: "flex", gap: 6 }}>
              <input
                type="text" value={newKey}
                onChange={e => setNewKey(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") addExtraKey(); }}
                placeholder="ENV_VAR_NAME"
                autoFocus
                style={{
                  flex: 1, background: "#020617", border: "1px solid #22d3ee",
                  borderRadius: 6, padding: "7px 10px",
                  color: "#e2e8f0", fontSize: 12,
                  fontFamily: "Menlo, 'Courier New', monospace", outline: "none",
                }}
              />
              <button onClick={addExtraKey} style={{
                background: "rgba(34,211,238,0.1)", border: "1px solid rgba(34,211,238,0.3)",
                borderRadius: 6, padding: "7px 12px",
                color: "#22d3ee", fontSize: 11, fontWeight: 700,
                cursor: "pointer", fontFamily: "inherit",
              }}>Add</button>
              <button onClick={() => setShowAddKey(false)} style={{
                background: "none", border: "1px solid #1e293b",
                borderRadius: 6, padding: "7px 10px",
                color: "#64748b", fontSize: 11,
                cursor: "pointer", fontFamily: "inherit",
              }}>✕</button>
            </div>
          ) : (
            <button
              onClick={() => setShowAddKey(true)}
              style={{
                display: "flex", alignItems: "center", gap: 5,
                background: "none", border: "1px dashed #1e293b",
                borderRadius: 6, padding: "7px 10px",
                color: "#475569", fontSize: 11,
                cursor: "pointer", fontFamily: "inherit", width: "100%",
              }}
            >
              <Plus size={11} /> Add custom environment variable
            </button>
          )}
        </div>

        {/* ── Footer / launch ─────────────────────────────────────────────── */}
        <div style={{ padding: "12px 18px 18px", borderTop: "1px solid #1e293b", background: "#0f172a" }}>
          {!ready && (
            <div style={{
              marginBottom: 9, padding: "7px 11px",
              background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)",
              borderRadius: 6, fontSize: 11, color: "#f87171",
            }}>
              {fields.filter(f => f.required && !f.liveOnly && !(envConfig[f.key] ?? "").trim()).length > 0
                ? `Fill in: ${fields.filter(f => f.required && !f.liveOnly && !(envConfig[f.key] ?? "").trim()).map(f => f.label).join(", ")}`
                : "RPC URL and Wallet Key are required for live mode."}
            </div>
          )}

          <button
            onClick={onLaunch} disabled={!ready}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center", gap: 7,
              width: "100%", padding: "10px",
              background: ready
                ? "linear-gradient(135deg, #0369a1, #7c3aed)"
                : "#1e293b",
              border: "none", borderRadius: 8,
              color: ready ? "#ffffff" : "#475569",
              fontSize: 13, fontWeight: 700,
              cursor: ready ? "pointer" : "not-allowed",
              fontFamily: "inherit", transition: "opacity 0.15s",
            }}
            onMouseEnter={e => { if (ready) (e.currentTarget as HTMLButtonElement).style.opacity = "0.88"; }}
            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.opacity = "1"; }}
          >
            <Rocket size={14} />
            {isDryRun ? "Launch Bot (Simulation)" : "Launch Bot (LIVE)"}
          </button>
        </div>

      </div>
    </div>
  );
}