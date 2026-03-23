// ============================================================
// elizaos.ts — ElizaOS: Autonomous On-Chain Agent Framework
// ============================================================
//
// ElizaOS is the leading TypeScript framework for autonomous agents
// with modular plugins, social media integration, and on-chain actions.
//
// Install: npm install @elizaos/core @elizaos/plugin-bootstrap
// Docs: https://elizaos.github.io/eliza/
// ============================================================

import type { AgentConfig, AgentResult, Message, ToolDefinition } from "../types";

// ── Core ElizaOS type stubs (replaced by real SDK imports) ──────────────────

export interface ElizaPlugin {
  name: string;
  description: string;
  actions?: ElizaAction[];
  providers?: ElizaProvider[];
  evaluators?: ElizaEvaluator[];
}

export interface ElizaAction {
  name: string;
  description: string;
  similes?: string[];            // alternative trigger phrases
  validate: (runtime: ElizaRuntime, message: ElizaMessage) => Promise<boolean>;
  handler: (
    runtime: ElizaRuntime,
    message: ElizaMessage,
    state?: ElizaState
  ) => Promise<void>;
  examples?: Array<Array<{ user: string; content: { text: string } }>>;
}

export interface ElizaProvider {
  get: (runtime: ElizaRuntime, message: ElizaMessage, state?: ElizaState) => Promise<string>;
}

export interface ElizaEvaluator {
  name: string;
  description: string;
  validate: (runtime: ElizaRuntime, message: ElizaMessage) => Promise<boolean>;
  handler: (runtime: ElizaRuntime, message: ElizaMessage) => Promise<void>;
}

export interface ElizaMessage {
  userId: string;
  agentId: string;
  roomId: string;
  content: { text: string; [key: string]: unknown };
}

export interface ElizaState {
  [key: string]: unknown;
}

export interface ElizaRuntime {
  agentId: string;
  character: ElizaCharacter;
  plugins: ElizaPlugin[];
  composeState: (message: ElizaMessage) => Promise<ElizaState>;
  processActions: (message: ElizaMessage, responses: ElizaMessage[]) => Promise<void>;
  messageManager: {
    createMemory: (memory: { userId: string; agentId: string; roomId: string; content: { text: string } }) => Promise<void>;
  };
}

export interface ElizaCharacter {
  name: string;
  bio: string | string[];
  lore?: string[];
  style?: { all?: string[]; chat?: string[]; post?: string[] };
  topics?: string[];
  adjectives?: string[];
  plugins?: string[];
  clients?: string[];
  modelProvider?: string;
  settings?: {
    secrets?: Record<string, string>;
    voice?: { model?: string };
  };
}

// ── Plugin Builder ───────────────────────────────────────────────────────────

/**
 * Create an ElizaOS plugin from a set of tool definitions.
 *
 * @example
 * const plugin = createElizaPlugin("defi", "DeFi tools", [swapTool, priceTool]);
 */
export function createElizaPlugin(
  name: string,
  description: string,
  tools: ToolDefinition[]
): ElizaPlugin {
  const actions: ElizaAction[] = tools.map((tool) => ({
    name: tool.name.toUpperCase().replace(/-/g, "_"),
    description: tool.description,
    similes: [tool.name],
    validate: async (_runtime, message) => {
      return message.content.text.toLowerCase().includes(tool.name.toLowerCase());
    },
    handler: async (_runtime, message, _state) => {
      try {
        // Parse args from message content (real impl would use NLP/structured extraction)
        const args = extractArgsFromMessage(message.content.text, tool.parameters);
        const result = await tool.execute(args);
        console.log(`[ElizaOS:${tool.name}] Result:`, JSON.stringify(result, null, 2));
      } catch (err) {
        console.error(`[ElizaOS:${tool.name}] Error:`, err);
      }
    },
    examples: [
      [
        { user: "user", content: { text: `Use ${tool.name}` } },
        { user: "assistant", content: { text: `Running ${tool.name}...` } },
      ],
    ],
  }));

  return { name, description, actions };
}

// ── Character Builder ────────────────────────────────────────────────────────

/**
 * Build an ElizaOS character definition from an AgentConfig.
 *
 * @example
 * const character = buildElizaCharacter({
 *   name: "TradingBot",
 *   systemPrompt: "You are an expert DeFi trader.",
 *   tools: [swapTool],
 * });
 */
export function buildElizaCharacter(config: AgentConfig): ElizaCharacter {
  return {
    name: config.name,
    bio: config.systemPrompt ?? config.description ?? `I am ${config.name}.`,
    lore: [],
    style: {
      all: ["concise", "helpful", "action-oriented"],
      chat: ["friendly", "direct"],
      post: ["informative"],
    },
    topics: config.tools?.map((t) => t.name) ?? [],
    adjectives: ["autonomous", "reliable", "efficient"],
    plugins: ["@elizaos/plugin-bootstrap"],
    clients: [],
    modelProvider: "openai",
    settings: {
      secrets: {},
    },
  };
}

// ── High-level Agent Runner ──────────────────────────────────────────────────

export interface ElizaAgentOptions {
  config: AgentConfig;
  plugins?: ElizaPlugin[];
  clients?: string[]; // e.g. ["twitter", "discord", "telegram"]
}

/**
 * Simulate an ElizaOS agent turn (single message → action loop).
 * In production this runtime would be instantiated via @elizaos/core.
 *
 * @example
 * const result = await runElizaAgent({
 *   config: { name: "Scout", systemPrompt: "Monitor DeFi pools." },
 *   plugins: [myPlugin],
 * }, "What is the current ETH/USDC pool APR?");
 */
export async function runElizaAgent(
  options: ElizaAgentOptions,
  userMessage: string
): Promise<AgentResult> {
  const { config, plugins = [] } = options;
  const allPlugins = [...plugins, createElizaPlugin("auto", "Auto-generated", config.tools ?? [])];
  const messages: Message[] = [];
  const toolCallsMade: string[] = [];
  let iterations = 0;
  const maxIterations = config.maxIterations ?? 10;

  if (config.systemPrompt) {
    messages.push({ role: "system", content: config.systemPrompt });
  }
  messages.push({ role: "user", content: userMessage });

  console.log(`[ElizaOS] Agent "${config.name}" started`);
  console.log(`[ElizaOS] Loaded plugins: ${allPlugins.map((p) => p.name).join(", ")}`);

  let finalOutput = "";

  while (iterations < maxIterations) {
    iterations++;
    const lastMessage = messages[messages.length - 1];
    const matchedAction = findMatchingAction(lastMessage.content, allPlugins);

    if (matchedAction) {
      console.log(`[ElizaOS] Executing action: ${matchedAction.name}`);
      toolCallsMade.push(matchedAction.name);

      const fakeRuntime = buildFakeRuntime(config, allPlugins);
      const elizaMsg: ElizaMessage = {
        userId: "user-1",
        agentId: config.name,
        roomId: "room-1",
        content: { text: lastMessage.content },
      };

      await matchedAction.handler(fakeRuntime, elizaMsg);
      finalOutput = `Action "${matchedAction.name}" executed successfully.`;
      messages.push({ role: "assistant", content: finalOutput });
      break;
    } else {
      finalOutput = `[${config.name}] Processed: "${lastMessage.content}" — no matching action found. Available: ${
        allPlugins.flatMap((p) => p.actions?.map((a) => a.name) ?? []).join(", ")
      }`;
      messages.push({ role: "assistant", content: finalOutput });
      break;
    }
  }

  return { output: finalOutput, messages, iterations, toolCallsMade };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function findMatchingAction(text: string, plugins: ElizaPlugin[]): ElizaAction | undefined {
  for (const plugin of plugins) {
    for (const action of plugin.actions ?? []) {
      if (
        text.toLowerCase().includes(action.name.toLowerCase()) ||
        action.similes?.some((s) => text.toLowerCase().includes(s.toLowerCase()))
      ) {
        return action;
      }
    }
  }
  return undefined;
}

function extractArgsFromMessage(
  text: string,
  schema: Record<string, unknown>
): Record<string, unknown> {
  // Minimal extraction — replace with proper NLP/structured parsing in production
  const args: Record<string, unknown> = {};
  const properties = (schema as { properties?: Record<string, unknown> }).properties ?? {};
  for (const key of Object.keys(properties)) {
    const match = text.match(new RegExp(`${key}[:\\s]+([\\w.]+)`, "i"));
    if (match) args[key] = match[1];
  }
  return args;
}

function buildFakeRuntime(config: AgentConfig, plugins: ElizaPlugin[]): ElizaRuntime {
  return {
    agentId: config.name,
    character: buildElizaCharacter(config),
    plugins,
    composeState: async () => ({}),
    processActions: async () => {},
    messageManager: {
      createMemory: async (mem) => {
        console.log(`[ElizaOS:memory] Stored: "${mem.content.text}"`);
      },
    },
  };
}

// ── Example Usage ────────────────────────────────────────────────────────────

/*
import { createElizaPlugin, runElizaAgent } from "./elizaos";

const priceTool: ToolDefinition = {
  name: "get_price",
  description: "Fetch the current token price",
  parameters: { properties: { token: { type: "string" } } },
  execute: async ({ token }) => ({ price: 3200, token }),
};

const plugin = createElizaPlugin("crypto", "Crypto tools", [priceTool]);

const result = await runElizaAgent(
  { config: { name: "CryptoScout", systemPrompt: "Monitor prices." }, plugins: [plugin] },
  "get_price token: ETH"
);

console.log(result.output);
*/