import { Agent } from "./api";
import { VALID_STRATEGIES, VALID_CONFIDENCE } from "./constant";

export type Role = 'assistant' | 'user' | 'system'

export interface ChatMessage {
  id:        string
  role:      Role
  content:   string
  timestamp: Date
  card?:     PlanCard | ConfirmCard | DeployedCard | ErrorCard
}

export interface PlanCard {
  type: 'plan'
  plan: AgentPlan
}

export interface ConfirmCard {
  type:       'confirm'
  plan:       AgentPlan
  guardrails: Guardrails
}

export interface DeployedCard {
  type:      'deployed'
  agentName: string
  agentId:   string
}

export interface ErrorCard {
  type:    'error'
  message: string
}

export interface AgentPlan {
  agentName:                 string
  strategy:                  'MEME_SNIPER' | 'ARBITRAGE' | 'SENTIMENT_TRADER'
  targetPair:                string
  description:               string
  entryConditions:           string[]
  exitConditions:            string[]
  riskNotes:                 string[]
  sessionDurationHours:      number
  recommendedSpendAllowance: number
  confidence:                'HIGH' | 'MEDIUM' | 'LOW'
  warnings:                  string[]
}

export interface Guardrails {
  spendAllowance:       number
  sessionDurationHours: number
  maxDailyLoss:         number
}

export type ConvState =
  | 'greeting'
  | 'collecting'
  | 'drafting'
  | 'reviewing_plan'
  | 'guardrails'
  | 'deploying'
  | 'deposit'
  | 'done'

  // Shared types for WebContainerRunner and related hooks/components

export interface GeneratedFile {
  filepath: string;
  content: string;
}

export interface EnvConfig {
  EVM_RPC_URL: string;
  EVM_PRIVATE_KEY: string;
  CONTRACT_ADDRESS: string;
  MAX_LOAN_USD: string;
  MIN_PROFIT_USD: string;
  DRY_RUN: string;
}

export type Phase = "idle" | "generating" | "env-setup" | "running";
export type Strategy   = typeof VALID_STRATEGIES[number];
export type Confidence = typeof VALID_CONFIDENCE[number];

export interface MissionPlan {
  agentName:                 string;
  strategy:                  Strategy;
  targetPair:                string;
  description:               string;
  entryConditions:           string[];
  exitConditions:            string[];
  riskNotes:                 string[];
  sessionDurationHours:      number;
  recommendedSpendAllowance: number;
  confidence:                Confidence;
  warnings:                  string[];
}

export interface CreateAgentRequestBody {
  userId:  string;
  intent:  string;           // natural language — required
  // optional overrides (from Tier 3 guardrails)
  spendAllowance?:      number;
  sessionDurationHours?: number;
  maxDailyLoss?:        number;
  // optional pre-generated session key (generated client-side or server-side)
  sessionKeyPub?:  string;
  sessionKeyPriv?: string;
}

export type RouteContext = {
  params: Promise<{ agentId: string }>;
};

export interface AgentsTableProps {
  agents: Agent[]
  onRefresh?: () => void
}

/**
 * frontend/lib/bot-config-types.ts
 *
 * Types and constants for the customizable arbitrage bot configurator.
 * The base architecture (MCP, flash loans, structured logging) never changes —
 * only these parameters are exposed to the user.
 */

// ─── Enumerations ─────────────────────────────────────────────────────────────

export const SUPPORTED_CHAINS = {
  "base-sepolia": { label: "Base Sepolia (Testnet)", chainId: 84532, rpcHint: "https://base-sepolia.g.alchemy.com/v2/YOUR_KEY" },
  "base-mainnet": { label: "Base Mainnet",           chainId: 8453,  rpcHint: "https://mainnet.base.org" },
  "arbitrum":     { label: "Arbitrum One",            chainId: 42161, rpcHint: "https://arb1.arbitrum.io/rpc" },
} as const;

export type ChainKey = keyof typeof SUPPORTED_CHAINS;

export const SUPPORTED_BASE_TOKENS: Record<string, { label: string; address: Record<ChainKey, string>; decimals: number }> = {
  USDC: {
    label:    "USDC",
    address:  {
      "base-sepolia": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "base-mainnet": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "arbitrum":     "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    },
    decimals: 6,
  },
  USDT: {
    label:    "USDT",
    address:  {
      "base-sepolia": "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",
      "base-mainnet": "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",
      "arbitrum":     "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
    },
    decimals: 6,
  },
  WETH: {
    label:    "WETH",
    address:  {
      "base-sepolia": "0x4200000000000000000000000000000000000006",
      "base-mainnet": "0x4200000000000000000000000000000000000006",
      "arbitrum":     "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    },
    decimals: 18,
  },
};

export const SUPPORTED_TARGET_TOKENS: Record<string, { label: string; address: Record<string, string>; decimals: number }> = {
  WETH: {
    label:    "WETH",
    address:  {
      "base-sepolia": "0x4200000000000000000000000000000000000006",
      "base-mainnet": "0x4200000000000000000000000000000000000006",
      "arbitrum":     "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    },
    decimals: 18,
  },
  CBBTC: {
    label:    "cbBTC",
    address:  {
      "base-sepolia": "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
      "base-mainnet": "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
      "arbitrum":     "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
    },
    decimals: 8,
  },
  AERO: {
    label:    "AERO (Base only)",
    address:  {
      "base-sepolia": "0x940181a94A35A4569E4529A3CDfB74e38FD98631",
      "base-mainnet": "0x940181a94A35A4569E4529A3CDfB74e38FD98631",
      "arbitrum":     "",
    },
    decimals: 18,
  },
};

export const SUPPORTED_DEXES = {
  "1inch":    { label: "1inch Aggregator",        description: "Best price routing across all DEXes" },
  "paraswap": { label: "Paraswap",                description: "MEV-protected swaps" },
  "uniswap":  { label: "Uniswap Universal Router", description: "Direct Uniswap V3 routing" },
} as const;

export type DexKey = keyof typeof SUPPORTED_DEXES;

export const SUPPORTED_SECURITY = {
  webacy:  { label: "Webacy (Recommended)", description: "Token risk scoring before every trade" },
  goplus:  { label: "GoPlus Security",      description: "On-chain security analysis" },
  none:    { label: "None (Speed mode)",    description: "Skip risk checks — faster but riskier" },
} as const;

export type SecurityKey = keyof typeof SUPPORTED_SECURITY;

// ─── Bot Configuration Schema ─────────────────────────────────────────────────

export interface BotConfig {
  // Identity
  botName:          string;

  // Network
  chain:            ChainKey;

  // Assets
  baseToken:        string;   // e.g. "USDC"
  targetToken:      string;   // e.g. "WETH"

  // Protocols
  dex:              DexKey;
  securityProvider: SecurityKey;

  // Financial guardrails
  borrowAmountHuman: number;   // e.g. 1 (USDC)
  minProfitUsd:      number;   // e.g. 0.50
  gasBufferUsdc:     number;   // e.g. 2

  // Operational
  pollingIntervalSec: number;  // e.g. 5
  simulationMode:     boolean;

  oneInchApiKey?: string; // Optional API key for 1inch (if using 1inch dex)
  webacyApiKey?: string; // Optional API key for Webacy (if using Webacy security)
  rpcUrl?: string;      // Optional custom RPC URL (if not using defaults)
  privateKey?: string; // Optional private key (if not generated server-side)

  // Optional: max risk score (0-100) from Webacy
  maxRiskScore: number;
}

export const DEFAULT_BOT_CONFIG: BotConfig = {
  botName:            "ArbitrageBot",
  chain:              "base-sepolia",
  baseToken:          "USDC",
  targetToken:        "WETH",
  dex:                "1inch",
  securityProvider:   "webacy",
  borrowAmountHuman:  1,
  minProfitUsd:       0.5,
  gasBufferUsdc:      2,
  pollingIntervalSec: 5,
  simulationMode:     true,
  maxRiskScore:       20,
};

// ─── Chat conversation steps ──────────────────────────────────────────────────

export type BotConfigStep =
  | "greeting"
  | "ask_chain"
  | "ask_base_token"
  | "ask_target_token"
  | "ask_dex"
  | "ask_security"
  | "ask_borrow_amount"
  | "ask_min_profit"
  | "ask_polling"
  | "ask_sim_mode"
  | "ask_bot_name"
  | "review"
  | "generating"
  | "done"
  | "error";

export interface BotConfigChatMessage {
  id:        string;
  role:      "assistant" | "user";
  content:   string;
  timestamp: Date;
  card?:     BotConfigCard;
}

export type BotConfigCard =
  | { type: "chain_picker";    options: string[] }
  | { type: "token_picker";    options: string[]; label: string }
  | { type: "dex_picker";      options: string[] }
  | { type: "security_picker"; options: string[] }
  | { type: "number_input";    field: keyof BotConfig; label: string; placeholder: string; min: number; step: number }
  | { type: "bool_toggle";     field: keyof BotConfig; label: string }
  | { type: "review_card";     config: BotConfig }
  | { type: "success_card";    agentId: string; botName: string };