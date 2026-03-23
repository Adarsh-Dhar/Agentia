// ============================================================
// autogen.ts — AutoGen (Microsoft): Multi-Agent Conversations
// ============================================================
//
// AutoGen specialises in multi-agent conversation and collaborative
// task solving. Agents can converse, critique, and delegate work
// to each other until a task is complete.
//
// Install: pip install pyautogen  (Python SDK — this file provides a
//          TypeScript interface layer to call the AutoGen REST API,
//          or to replicate the pattern in pure TS.)
// Docs: https://microsoft.github.io/autogen/
// ============================================================

import type { AgentConfig, AgentResult, Message, ToolDefinition } from "../types";

// ── Conversation Types ───────────────────────────────────────────────────────

export type AutoGenSpeaker = string; // agent name

export interface ConversationTurn {
  speaker: AutoGenSpeaker;
  message: string;
  timestamp: Date;
}

export interface AutoGenAgentOptions {
  config: AgentConfig;
  isUserProxy?: boolean;    // true → this agent represents the human / code executor
  humanInputMode?: "NEVER" | "ALWAYS" | "TERMINATE";
  terminationPhrase?: string; // e.g. "TERMINATE"
  defaultAutoReply?: string;  // used when humanInputMode is NEVER
}

// ── Agent Classes ────────────────────────────────────────────────────────────

/**
 * Represents a single AutoGen conversable agent.
 *
 * @example
 * const coder = new AutoGenAgent({
 *   config: { name: "Coder", systemPrompt: "Write Python code to solve tasks." },
 * });
 */
export class AutoGenAgent {
  readonly name: string;
  readonly systemPrompt: string;
  readonly tools: ToolDefinition[];
  readonly isUserProxy: boolean;
  readonly humanInputMode: "NEVER" | "ALWAYS" | "TERMINATE";
  readonly terminationPhrase: string;
  readonly defaultAutoReply: string;

  private memory: ConversationTurn[] = [];

  constructor(options: AutoGenAgentOptions) {
    this.name = options.config.name;
    this.systemPrompt = options.config.systemPrompt ?? `You are ${options.config.name}.`;
    this.tools = options.config.tools ?? [];
    this.isUserProxy = options.isUserProxy ?? false;
    this.humanInputMode = options.humanInputMode ?? "NEVER";
    this.terminationPhrase = options.terminationPhrase ?? "TERMINATE";
    this.defaultAutoReply = options.defaultAutoReply ?? "";
  }

  /** Generate a reply to the incoming message. Replace mock logic with real LLM call. */
  async generateReply(
    incomingMessage: string,
    conversationHistory: ConversationTurn[]
  ): Promise<string> {
    if (this.isUserProxy) {
      if (this.humanInputMode === "NEVER") return this.defaultAutoReply || this.terminationPhrase;
      // In "ALWAYS" mode you'd read from stdin / a UI callback
      return this.terminationPhrase;
    }

    // ── Replace with real LLM call ──────────────────────────────────────────
    // const response = await openai.chat.completions.create({
    //   model: this.config.model ?? "gpt-4o",
    //   messages: [
    //     { role: "system", content: this.systemPrompt },
    //     ...conversationHistory.map(t => ({ role: "user" as const, content: `${t.speaker}: ${t.message}` })),
    //     { role: "user", content: incomingMessage },
    //   ],
    // });
    // return response.choices[0].message.content ?? "";
    // ───────────────────────────────────────────────────────────────────────

    const toolHint =
      this.tools.length > 0
        ? ` [Available tools: ${this.tools.map((t) => t.name).join(", ")}]`
        : "";

    return `[${this.name}] Responding to "${incomingMessage.slice(0, 60)}..."${toolHint}`;
  }

  /** Execute a tool by name with provided args. */
  async executeTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const tool = this.tools.find((t) => t.name === name);
    if (!tool) throw new Error(`[AutoGen:${this.name}] Tool "${name}" not found.`);
    return tool.execute(args);
  }

  addMemory(turn: ConversationTurn): void {
    this.memory.push(turn);
  }

  getMemory(): ConversationTurn[] {
    return [...this.memory];
  }
}

// ── GroupChat ────────────────────────────────────────────────────────────────

export type SpeakerSelectionMode = "auto" | "round_robin" | "random";

export interface GroupChatOptions {
  agents: AutoGenAgent[];
  maxRounds?: number;
  speakerSelectionMode?: SpeakerSelectionMode;
  /** Custom selector: given history, return the next agent name */
  customSpeakerSelector?: (
    history: ConversationTurn[],
    agents: AutoGenAgent[]
  ) => AutoGenAgent;
}

/**
 * A group chat orchestrates N agents taking turns to solve a task.
 *
 * @example
 * const chat = new GroupChat({
 *   agents: [coder, reviewer, critic],
 *   maxRounds: 8,
 *   speakerSelectionMode: "round_robin",
 * });
 * const result = await chat.run("Write and review a bubble sort implementation.");
 */
export class GroupChat {
  private agents: AutoGenAgent[];
  private maxRounds: number;
  private selectionMode: SpeakerSelectionMode;
  private customSelector?: GroupChatOptions["customSpeakerSelector"];
  private history: ConversationTurn[] = [];

  constructor(options: GroupChatOptions) {
    this.agents = options.agents;
    this.maxRounds = options.maxRounds ?? 10;
    this.selectionMode = options.speakerSelectionMode ?? "round_robin";
    this.customSelector = options.customSpeakerSelector;
  }

  async run(initialMessage: string): Promise<AgentResult> {
    this.history = [];
    const messages: Message[] = [{ role: "user", content: initialMessage }];
    const toolCallsMade: string[] = [];
    let round = 0;

    console.log(`[AutoGen:GroupChat] Starting with ${this.agents.length} agents`);
    console.log(`[AutoGen:GroupChat] Task: "${initialMessage}"`);

    let currentMessage = initialMessage;

    while (round < this.maxRounds) {
      const speaker = this.selectSpeaker(round);
      console.log(`[AutoGen:GroupChat] Round ${round + 1} — Speaker: ${speaker.name}`);

      const reply = await speaker.generateReply(currentMessage, this.history);
      const turn: ConversationTurn = { speaker: speaker.name, message: reply, timestamp: new Date() };

      this.history.push(turn);
      messages.push({ role: "assistant", name: speaker.name, content: reply });
      speaker.addMemory(turn);

      // Check for tool calls in reply (simplified — real impl uses function_call)
      const toolMatch = reply.match(/\[tool:(\w+)\((.*?)\)\]/);
      if (toolMatch) {
        const [, toolName, rawArgs] = toolMatch;
        try {
          const args = JSON.parse(`{${rawArgs}}`);
          const result = await speaker.executeTool(toolName, args);
          toolCallsMade.push(toolName);
          const resultMsg = `[Tool result: ${JSON.stringify(result)}]`;
          this.history.push({ speaker: "TOOL", message: resultMsg, timestamp: new Date() });
          messages.push({ role: "tool", name: toolName, content: resultMsg });
          currentMessage = resultMsg;
        } catch {
          console.warn(`[AutoGen] Could not parse/execute tool call: ${toolMatch[0]}`);
        }
      } else {
        currentMessage = reply;
      }

      // Termination check
      if (reply.includes("TERMINATE") || reply.toLowerCase().includes("task complete")) {
        console.log(`[AutoGen:GroupChat] Termination signal from ${speaker.name}`);
        break;
      }

      round++;
    }

    const finalOutput = this.history[this.history.length - 1]?.message ?? currentMessage;
    return { output: finalOutput, messages, iterations: round, toolCallsMade };
  }

  getHistory(): ConversationTurn[] {
    return [...this.history];
  }

  private selectSpeaker(round: number): AutoGenAgent {
    if (this.customSelector) return this.customSelector(this.history, this.agents);
    switch (this.selectionMode) {
      case "round_robin":
        return this.agents[round % this.agents.length];
      case "random":
        return this.agents[Math.floor(Math.random() * this.agents.length)];
      case "auto":
      default:
        return this.selectSpeakerAuto();
    }
  }

  /** Auto mode: pick the agent whose name appears last in the conversation. */
  private selectSpeakerAuto(): AutoGenAgent {
    const lastTurn = this.history[this.history.length - 1];
    if (!lastTurn) return this.agents[0];
    const next = this.agents.find((a) => a.name !== lastTurn.speaker) ?? this.agents[0];
    return next;
  }
}

// ── Two-Agent Chat ───────────────────────────────────────────────────────────

/**
 * The classic AutoGen two-agent "initiate_chat" pattern.
 * One agent proposes, the other critiques/verifies.
 *
 * @example
 * const result = await twoAgentChat(userProxy, assistant, "Write a REST API in Express.");
 */
export async function twoAgentChat(
  initiator: AutoGenAgent,
  responder: AutoGenAgent,
  task: string,
  maxRounds = 6
): Promise<AgentResult> {
  const history: ConversationTurn[] = [];
  const messages: Message[] = [{ role: "user", content: task }];
  const toolCallsMade: string[] = [];
  let currentMessage = task;

  console.log(`[AutoGen:TwoAgent] ${initiator.name} → ${responder.name}`);

  for (let i = 0; i < maxRounds; i++) {
    const speaker = i % 2 === 0 ? responder : initiator;
    const reply = await speaker.generateReply(currentMessage, history);
    const turn: ConversationTurn = { speaker: speaker.name, message: reply, timestamp: new Date() };

    history.push(turn);
    messages.push({ role: "assistant", name: speaker.name, content: reply });

    console.log(`[AutoGen] Round ${i + 1} | ${speaker.name}: ${reply.slice(0, 80)}...`);

    if (reply.includes("TERMINATE")) break;
    currentMessage = reply;
  }

  return {
    output: history[history.length - 1]?.message ?? "",
    messages,
    iterations: history.length,
    toolCallsMade,
    metadata: { history },
  };
}

// ── Example Usage ────────────────────────────────────────────────────────────

/*
import { AutoGenAgent, GroupChat, twoAgentChat } from "./autogen";

const userProxy = new AutoGenAgent({
  config: { name: "UserProxy", systemPrompt: "You represent the user." },
  isUserProxy: true,
  humanInputMode: "NEVER",
  defaultAutoReply: "TERMINATE",
});

const coder = new AutoGenAgent({
  config: { name: "Coder", systemPrompt: "Write clean TypeScript code." },
});

const reviewer = new AutoGenAgent({
  config: { name: "Reviewer", systemPrompt: "Review code for bugs and style issues." },
});

// Two-agent chat
const result = await twoAgentChat(userProxy, coder, "Write a binary search function.");
console.log(result.output);

// Group chat
const chat = new GroupChat({ agents: [coder, reviewer, userProxy], maxRounds: 6 });
const groupResult = await chat.run("Design and review a rate-limiter class.");
console.log(groupResult.output);
*/