// ============================================================
// types.ts — Shared types across all agent framework adapters
// ============================================================

export type MessageRole = "user" | "assistant" | "system" | "tool";

export interface Message {
  role: MessageRole;
  content: string;
  name?: string;
  toolCallId?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema object
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface AgentConfig {
  name: string;
  description?: string;
  model?: string;
  systemPrompt?: string;
  tools?: ToolDefinition[];
  maxIterations?: number;
  temperature?: number;
}

export interface AgentResult {
  output: string;
  messages: Message[];
  iterations: number;
  toolCallsMade: string[];
  metadata?: Record<string, unknown>;
}

export interface WorkflowNode {
  id: string;
  agent: AgentConfig;
  next?: string | ((result: AgentResult) => string); // static or conditional routing
}

export interface WorkflowGraph {
  nodes: WorkflowNode[];
  entryPoint: string;
}

// ============================================================
// defi-types.ts — Shared types for all DeFi/on-chain tools
// ============================================================

export type ChainId =
  | 1       // Ethereum Mainnet
  | 10      // Optimism
  | 56      // BNB Chain
  | 137     // Polygon
  | 42161   // Arbitrum One
  | 8453    // Base
  | "solana";

export type Address = `0x${string}` | string; // EVM hex or Solana base58

export interface Token {
  address: Address;
  symbol: string;
  decimals: number;
  chainId: ChainId;
  logoURI?: string;
}

export interface TokenAmount {
  token: Token;
  amount: bigint;       // raw on-chain amount
  amountFormatted: string; // human-readable
}

export interface TxReceipt {
  hash: string;
  chainId: ChainId;
  status: "success" | "reverted" | "pending";
  gasUsed?: bigint;
  blockNumber?: bigint;
}

export interface PriceQuote {
  inputToken: Token;
  outputToken: Token;
  inputAmount: bigint;
  outputAmount: bigint;
  priceImpact: number;  // 0–100 %
  route: string[];      // protocol names traversed
  estimatedGas?: bigint;
  validUntil: number;   // unix timestamp
}

export interface ArbitrageOpportunity {
  tokenIn: Token;
  tokenOut: Token;
  buyDex: string;
  sellDex: string;
  buyPrice: number;
  sellPrice: number;
  spreadPct: number;     // (sellPrice - buyPrice) / buyPrice * 100
  estimatedProfitUsd: number;
  requiredCapitalUsd: number;
  chainId: ChainId;
  detectedAt: number;    // unix timestamp ms
}

export interface SafetyReport {
  tokenAddress: Address;
  chainId: ChainId;
  isSafe: boolean;
  isHoneypot: boolean;
  isRugPull: boolean;
  riskScore: number;    // 0 (safe) → 100 (dangerous)
  flags: string[];
  source: string;
}