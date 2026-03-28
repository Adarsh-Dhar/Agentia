"use client";

/**
 * frontend/components/ui/BotEnvConfigModal.tsx
 *
 * Env-setup overlay rendered inside the WebContainer IDE before the bot
 * is launched.  Replaces the old EnvConfigModal which was tuned for the
 * Arbitrum flash-loan bot.
 */

import type { BotEnvConfig } from "@/lib/bot-constant";

interface Props {
  envConfig:  BotEnvConfig;
  onChange:   (key: keyof BotEnvConfig, value: string) => void;
  onLaunch:   () => void;
  isDryRun:   boolean;
}

const FIELD_META: {
  key:         keyof BotEnvConfig;
  label:       string;
  placeholder: string;
  type?:       "password" | "text";
  required:    boolean;
  help:        string;
}[] = [
  {
    key:         "WEBACY_API_KEY",
    label:       "Webacy API Key",
    placeholder: "your-webacy-api-key",
    type:        "password",
    required:    true,
    help:        "Required. Get one free at webacy.com — used for token risk checks.",
  },
  {
    key:         "RPC_PROVIDER_URL",
    label:       "Base Sepolia RPC URL",
    placeholder: "https://base-sepolia.g.alchemy.com/v2/YOUR_KEY",
    type:        "text",
    required:    false,
    help:        "Base Sepolia JSON-RPC endpoint. Required for live mode only.",
  },
  {
    key:         "WALLET_PRIVATE_KEY",
    label:       "Wallet Private Key",
    placeholder: "0x… (64 hex chars)",
    type:        "password",
    required:    false,
    help:        "Private key for the signing wallet. Required for live mode only.",
  },
  {
    key:         "GOAT_EVM_PATH",
    label:       "GOAT EVM Server Path",
    placeholder: "/path/to/goat-evm/index.ts",
    type:        "text",
    required:    false,
    help:        "Absolute path to the GOAT EVM MCP server entry-point. Enables on-chain execution.",
  },
  {
    key:         "BORROW_AMOUNT_HUMAN",
    label:       "Borrow Amount (USDC)",
    placeholder: "1",
    type:        "text",
    required:    false,
    help:        "Human-readable USDC to borrow per flash loan cycle (e.g. 1).",
  },
  {
    key:         "POLL_INTERVAL",
    label:       "Poll Interval (seconds)",
    placeholder: "5",
    type:        "text",
    required:    false,
    help:        "How often to check for arbitrage opportunities.",
  },
];

export function BotEnvConfigModal({ envConfig, onChange, onLaunch, isDryRun }: Props) {
  const canLaunch = !!envConfig.WEBACY_API_KEY.trim();

  return (
    <div
      style={{
        position:        "absolute",
        inset:           0,
        background:      "rgba(2,6,23,0.93)",
        backdropFilter:  "blur(4px)",
        zIndex:          10,
        display:         "flex",
        alignItems:      "center",
        justifyContent:  "center",
        padding:         "16px",
      }}
    >
      <div
        style={{
          background:   "#0d1117",
          border:       "1px solid #21262d",
          borderRadius: "12px",
          padding:      "24px",
          width:        "100%",
          maxWidth:     "520px",
          maxHeight:    "90vh",
          overflowY:    "auto",
          fontFamily:   "Menlo, 'Courier New', monospace",
        }}
      >
        {/* Header */}
        <div style={{ marginBottom: "20px" }}>
          <p style={{ color: "#22d3ee", fontWeight: 700, fontSize: 14, margin: 0 }}>
            ⚡ Base Sepolia MCP Arbitrage Bot
          </p>
          <p style={{ color: "#6e7681", fontSize: 11, marginTop: 4 }}>
            Configure environment variables before launching
          </p>
        </div>

        {/* Simulation toggle */}
        <div
          style={{
            display:      "flex",
            alignItems:   "center",
            gap:          10,
            marginBottom: 20,
            padding:      "10px 14px",
            borderRadius: 8,
            background:   isDryRun ? "rgba(250,204,21,0.08)" : "rgba(239,68,68,0.08)",
            border:       `1px solid ${isDryRun ? "rgba(250,204,21,0.25)" : "rgba(239,68,68,0.25)"}`,
          }}
        >
          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={envConfig.SIMULATION_MODE === "true"}
              onChange={(e) => onChange("SIMULATION_MODE", e.target.checked ? "true" : "false")}
              style={{ width: 14, height: 14, cursor: "pointer" }}
            />
            <span style={{ fontSize: 12, color: isDryRun ? "#fbbf24" : "#f87171", fontWeight: 700 }}>
              {isDryRun ? "SIMULATION MODE (safe — no transactions)" : "LIVE MODE (real transactions)"}
            </span>
          </label>
        </div>

        {/* Fields */}
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {FIELD_META.map((f) => (
            <div key={f.key}>
              <label style={{ display: "block", fontSize: 11, color: "#8b949e", marginBottom: 4 }}>
                {f.label}
                {f.required && <span style={{ color: "#f87171", marginLeft: 4 }}>*</span>}
              </label>
              <input
                type={f.type ?? "text"}
                value={envConfig[f.key]}
                placeholder={f.placeholder}
                onChange={(e) => onChange(f.key, e.target.value)}
                style={{
                  width:        "100%",
                  background:   "#161b22",
                  border:       "1px solid #30363d",
                  borderRadius: 6,
                  padding:      "8px 10px",
                  color:        "#c9d1d9",
                  fontSize:     12,
                  fontFamily:   "inherit",
                  outline:      "none",
                  boxSizing:    "border-box",
                }}
              />
              <p style={{ fontSize: 10, color: "#484f58", margin: "3px 0 0" }}>{f.help}</p>
            </div>
          ))}
        </div>

        {/* Launch button */}
        <button
          onClick={onLaunch}
          disabled={!canLaunch}
          style={{
            marginTop:    20,
            width:        "100%",
            padding:      "10px 0",
            background:   canLaunch
              ? (isDryRun ? "#0e4429" : "#1f2d1f")
              : "#161b22",
            border:       `1px solid ${canLaunch ? (isDryRun ? "#2ea043" : "#388e3c") : "#30363d"}`,
            borderRadius: 8,
            color:        canLaunch ? (isDryRun ? "#3fb950" : "#56d364") : "#484f58",
            fontFamily:   "inherit",
            fontSize:     13,
            fontWeight:   700,
            cursor:       canLaunch ? "pointer" : "not-allowed",
          }}
        >
          {isDryRun ? "▶  Launch Simulation" : "⚡  Launch Live Bot"}
        </button>

        {!canLaunch && (
          <p style={{ fontSize: 10, color: "#f87171", textAlign: "center", marginTop: 8 }}>
            Webacy API Key is required to start
          </p>
        )}
      </div>
    </div>
  );
}