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