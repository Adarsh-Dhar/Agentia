"use client";

/**
 * frontend/components/ui/Botenvconfigmodal.tsx
 *
 * FIX: Outer container uses alignItems flex-start (not center) so the first
 * field (1inch API Key) is never pushed above the visible scroll area.
 * The card scrolls internally; the footer with the Launch button is sticky.
 */

import { Rocket, Eye, EyeOff, ExternalLink, AlertTriangle, CheckCircle } from "lucide-react";
import { useState } from "react";
import type { BotEnvConfig } from "@/lib/bot-constant";

interface Props {
  envConfig: BotEnvConfig;
  onChange:  (key: keyof BotEnvConfig, value: string) => void;
  onLaunch:  () => void;
  isDryRun:  boolean;
}

interface FieldDef {
  key:           keyof BotEnvConfig;
  label:         string;
  placeholder:   string;
  type:          "text" | "password" | "toggle";
  required:      boolean;
  liveOnly?:     boolean;
  helpText?:     string;
  helpLink?:     string;
  helpLinkLabel?: string;
}

const FIELDS: FieldDef[] = [
  {
    key:           "ONEINCH_API_KEY",
    label:         "1inch API Key",
    placeholder:   "your-1inch-api-key",
    type:          "password",
    required:      true,
    helpText:      "Required for price quotes and swap calldata.",
    helpLink:      "https://portal.1inch.dev",
    helpLinkLabel: "Get key →",
  },
  {
    key:           "WEBACY_API_KEY",
    label:         "Webacy API Key",
    placeholder:   "your-webacy-api-key",
    type:          "password",
    required:      true,
    helpText:      "Required for token risk checks before every execution.",
    helpLink:      "https://webacy.com",
    helpLinkLabel: "Get key →",
  },
  {
    key:      "SIMULATION_MODE",
    label:    "Mode",
    placeholder: "true",
    type:     "toggle",
    required: false,
    helpText: "Simulation: logs opportunities, no transactions sent.",
  },
  {
    key:         "RPC_PROVIDER_URL",
    label:       "Base Sepolia RPC URL",
    placeholder: "https://base-sepolia.g.alchemy.com/v2/YOUR_KEY",
    type:        "text",
    required:    false,
    liveOnly:    true,
    helpText:    "Free endpoint from Alchemy, Infura, or QuickNode.",
  },
  {
    key:         "WALLET_PRIVATE_KEY",
    label:       "Wallet Private Key",
    placeholder: "64-char hex, no 0x prefix",
    type:        "password",
    required:    false,
    liveOnly:    true,
    helpText:    "Required for live mode. Never share this key.",
  },
  {
    key:         "BORROW_AMOUNT_HUMAN",
    label:       "Borrow Amount (USDC)",
    placeholder: "1",
    type:        "text",
    required:    false,
    helpText:    "Human-readable USDC to borrow per flash-loan cycle.",
  },
  {
    key:         "POLL_INTERVAL",
    label:       "Poll Interval (seconds)",
    placeholder: "5",
    type:        "text",
    required:    false,
    helpText:    "Seconds between arbitrage opportunity checks.",
  },
];

export function BotEnvConfigModal({ envConfig, onChange, onLaunch, isDryRun }: Props) {
  const [shown, setShown] = useState<Record<string, boolean>>({});
  const toggleShow = (k: string) => setShown(p => ({ ...p, [k]: !p[k] }));

  const reqFilled  = FIELDS.filter(f => f.required).every(f => (envConfig[f.key] ?? "").trim().length > 0);
  const liveMode   = envConfig.SIMULATION_MODE !== "true";
  const liveFilled = !liveMode ||
    ((envConfig.RPC_PROVIDER_URL ?? "").trim().length > 0 &&
     (envConfig.WALLET_PRIVATE_KEY ?? "").trim().length > 0);
  const canLaunch  = reqFilled && liveFilled;

  return (
    /* ── Outer backdrop ──────────────────────────────────────────────────── */
    <div style={{
      position:       "absolute",
      inset:          0,
      background:     "rgba(2,6,23,0.97)",
      backdropFilter: "blur(3px)",
      zIndex:         20,
      overflowY:      "auto",
      /* KEY FIX: flex-start so card starts at the top, never clipped */
      display:        "flex",
      flexDirection:  "column",
      alignItems:     "center",
      padding:        "12px 12px 24px",
    }}>

      {/* ── Card ─────────────────────────────────────────────────────────── */}
      <div style={{
        background:    "#0f172a",
        border:        "1px solid #1e293b",
        borderRadius:  12,
        width:         "100%",
        maxWidth:      "480px",
        flexShrink:    0,
        boxShadow:     "0 25px 60px rgba(0,0,0,0.8)",
        overflow:      "hidden",
      }}>

        {/* ── Card header ─────────────────────────────────────────────────── */}
        <div style={{ padding: "16px 18px 0" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 3 }}>
            <Rocket size={14} color="#22d3ee" />
            <span style={{ fontWeight: 700, fontSize: 13, color: "#e2e8f0" }}>
              Configure Bot Environment
            </span>
          </div>
          <p style={{ fontSize: 10, color: "#64748b", margin: "0 0 12px" }}>
            Credentials only exist in this WebContainer session — nothing is persisted.
          </p>

          {/* Mode banner */}
          <div style={{
            background:   isDryRun ? "rgba(250,204,21,0.07)" : "rgba(239,68,68,0.07)",
            border:       `1px solid ${isDryRun ? "rgba(250,204,21,0.25)" : "rgba(239,68,68,0.3)"}`,
            borderRadius: 7,
            padding:      "8px 11px",
            marginBottom: 14,
            display:      "flex",
            alignItems:   "center",
            gap:          7,
          }}>
            {isDryRun
              ? <CheckCircle size={12} color="#fbbf24" />
              : <AlertTriangle size={12} color="#f87171" />}
            <span style={{ fontSize: 11, fontWeight: 600, color: isDryRun ? "#fbbf24" : "#f87171" }}>
              {isDryRun
                ? "Simulation mode — no real transactions broadcast"
                : "LIVE MODE — real transactions on Base Sepolia"}
            </span>
          </div>
        </div>

        {/* ── Fields ──────────────────────────────────────────────────────── */}
        <div style={{ padding: "0 18px 14px", display: "flex", flexDirection: "column", gap: 13 }}>
          {FIELDS.map(field => {

            /* ── Toggle ── */
            if (field.type === "toggle") {
              const isSim = (envConfig[field.key] ?? "true") === "true";
              return (
                <div key={field.key}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 3 }}>
                    <label style={{ fontSize: 11, fontWeight: 600, color: "#94a3b8" }}>
                      {field.label}
                    </label>
                    <button
                      onClick={() => onChange(field.key, isSim ? "false" : "true")}
                      style={{
                        display:      "flex",
                        alignItems:   "center",
                        gap:          5,
                        background:   isSim ? "rgba(34,211,238,0.1)" : "rgba(239,68,68,0.1)",
                        border:       `1px solid ${isSim ? "rgba(34,211,238,0.3)" : "rgba(239,68,68,0.3)"}`,
                        borderRadius: 20,
                        padding:      "3px 9px",
                        cursor:       "pointer",
                        color:        isSim ? "#22d3ee" : "#f87171",
                        fontSize:     11,
                        fontWeight:   700,
                        fontFamily:   "inherit",
                      }}
                    >
                      <div style={{ width: 7, height: 7, borderRadius: "50%", background: isSim ? "#22d3ee" : "#f87171" }} />
                      {isSim ? "Simulation" : "Live"}
                    </button>
                  </div>
                  {field.helpText && (
                    <p style={{ fontSize: 10, color: "#475569", margin: 0 }}>{field.helpText}</p>
                  )}
                </div>
              );
            }

            /* ── Text / Password ── */
            const isPass   = field.type === "password";
            const showPlain = shown[field.key];
            const dimmed    = !!field.liveOnly && isDryRun;

            return (
              <div key={field.key} style={{ opacity: dimmed ? 0.35 : 1, pointerEvents: dimmed ? "none" : "auto" }}>
                {/* Label row */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                  <label style={{ fontSize: 11, fontWeight: 600, color: "#94a3b8" }}>
                    {field.label}
                    {field.required && <span style={{ color: "#f87171", marginLeft: 3 }}>*</span>}
                    {field.liveOnly && (
                      <span style={{ color: "#475569", marginLeft: 4, fontWeight: 400, fontSize: 10 }}>
                        (live only)
                      </span>
                    )}
                  </label>
                  {field.helpLink && (
                    <a
                      href={field.helpLink}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ fontSize: 10, color: "#22d3ee", textDecoration: "none", display: "flex", alignItems: "center", gap: 3 }}
                    >
                      {field.helpLinkLabel}
                      <ExternalLink size={9} />
                    </a>
                  )}
                </div>

                {/* Input */}
                <div style={{ position: "relative" }}>
                  <input
                    type={isPass && !showPlain ? "password" : "text"}
                    value={envConfig[field.key] ?? ""}
                    onChange={e => onChange(field.key, e.target.value)}
                    placeholder={field.placeholder}
                    autoComplete="off"
                    spellCheck={false}
                    style={{
                      width:        "100%",
                      boxSizing:    "border-box",
                      background:   "#020617",
                      border:       "1px solid #1e293b",
                      borderRadius: 6,
                      padding:      isPass ? "8px 34px 8px 10px" : "8px 10px",
                      color:        "#e2e8f0",
                      fontSize:     12,
                      fontFamily:   "Menlo, 'Courier New', monospace",
                      outline:      "none",
                      display:      "block",
                    }}
                    onFocus={e => { (e.target as HTMLInputElement).style.borderColor = "#22d3ee"; }}
                    onBlur={e  => { (e.target as HTMLInputElement).style.borderColor = "#1e293b"; }}
                  />
                  {isPass && (
                    <button
                      type="button"
                      onClick={() => toggleShow(field.key)}
                      style={{
                        position:   "absolute",
                        right:      7,
                        top:        "50%",
                        transform:  "translateY(-50%)",
                        background: "none",
                        border:     "none",
                        cursor:     "pointer",
                        color:      "#475569",
                        padding:    2,
                        display:    "flex",
                        alignItems: "center",
                      }}
                    >
                      {showPlain ? <EyeOff size={12} /> : <Eye size={12} />}
                    </button>
                  )}
                </div>

                {field.helpText && (
                  <p style={{ fontSize: 10, color: "#475569", margin: "3px 0 0" }}>{field.helpText}</p>
                )}
              </div>
            );
          })}
        </div>

        {/* ── Footer / launch button ───────────────────────────────────────── */}
        <div style={{ padding: "12px 18px 18px", borderTop: "1px solid #1e293b", background: "#0f172a" }}>
          {!canLaunch && (
            <div style={{
              marginBottom:  9,
              padding:       "7px 11px",
              background:    "rgba(239,68,68,0.08)",
              border:        "1px solid rgba(239,68,68,0.2)",
              borderRadius:  6,
              fontSize:      11,
              color:         "#f87171",
            }}>
              {!reqFilled
                ? "Fill in 1inch API Key and Webacy API Key to continue."
                : "RPC URL and Wallet Key are required for live mode."}
            </div>
          )}

          <button
            onClick={onLaunch}
            disabled={!canLaunch}
            style={{
              display:        "flex",
              alignItems:     "center",
              justifyContent: "center",
              gap:            7,
              width:          "100%",
              padding:        "10px",
              background:     canLaunch
                ? "linear-gradient(135deg, #0369a1, #7c3aed)"
                : "#1e293b",
              border:         "none",
              borderRadius:   8,
              color:          canLaunch ? "#ffffff" : "#475569",
              fontSize:       13,
              fontWeight:     700,
              cursor:         canLaunch ? "pointer" : "not-allowed",
              fontFamily:     "inherit",
              transition:     "opacity 0.15s",
            }}
            onMouseEnter={e => { if (canLaunch) (e.currentTarget as HTMLButtonElement).style.opacity = "0.88"; }}
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