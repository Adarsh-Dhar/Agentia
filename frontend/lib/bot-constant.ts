/**
 * frontend/lib/bot-constant.ts
 *
 * Env-config shape and defaults for the Base Sepolia MCP arbitrage bot.
 * Used by the WebContainer IDE env-setup modal.
 */

export interface BotEnvConfig {
  WALLET_PRIVATE_KEY: string;
  RPC_PROVIDER_URL:   string;
  WEBACY_API_KEY:     string;
  GOAT_EVM_PATH:      string;   // optional — live execution only
  SIMULATION_MODE:    string;   // "true" | "false"
  BORROW_AMOUNT_HUMAN: string;
  POLL_INTERVAL:      string;   // seconds
}

export const DEFAULT_BOT_ENV_CONFIG: BotEnvConfig = {
  WALLET_PRIVATE_KEY:  "",
  RPC_PROVIDER_URL:    "https://base-sepolia.g.alchemy.com/v2/YOUR_KEY",
  WEBACY_API_KEY:      "",
  GOAT_EVM_PATH:       "",
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