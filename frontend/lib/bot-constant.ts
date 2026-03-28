/**
 * frontend/lib/bot-constant.ts
 *
 * Env-config shape and defaults for the Base Sepolia arbitrage bot.
 * Bot uses direct REST APIs (1inch + Webacy) + ethers.js — no MCP subprocesses.
 */

export interface BotEnvConfig {
  ONEINCH_API_KEY:     string;  // Required — get at https://portal.1inch.dev
  WEBACY_API_KEY:      string;  // Required — get at https://webacy.com
  RPC_PROVIDER_URL:    string;  // Required for live mode
  WALLET_PRIVATE_KEY:  string;  // Required for live mode (hex, no 0x prefix)
  SIMULATION_MODE:     string;  // "true" | "false"
  BORROW_AMOUNT_HUMAN: string;  // Human-readable USDC, e.g. "1"
  POLL_INTERVAL:       string;  // Seconds between cycles, e.g. "5"
}

export const DEFAULT_BOT_ENV_CONFIG: BotEnvConfig = {
  ONEINCH_API_KEY:     "",
  WEBACY_API_KEY:      "",
  RPC_PROVIDER_URL:    "https://base-sepolia.g.alchemy.com/v2/YOUR_KEY",
  WALLET_PRIVATE_KEY:  "",
  SIMULATION_MODE:     "true",
  BORROW_AMOUNT_HUMAN: "1",
  POLL_INTERVAL:       "5",
};

export const BOT_ENTRY_POINT = "src/index.ts";

export const BOT_NPMRC = [
  "registry=https://registry.npmjs.org/",
  "maxsockets=2",
  "fetch-retries=5",
  "fetch-retry-mintimeout=20000",
  "fetch-retry-maxtimeout=120000",
  "fund=false",
  "audit=false",
].join("\n");