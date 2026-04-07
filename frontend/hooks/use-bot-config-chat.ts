/**
 * frontend/hooks/use-bot-config-chat.ts
 *
 * Multi-turn Planner Agent chat hook.
 *
 * Conversation flow:
 *   1. User describes their bot strategy.
 *   2. classify-intent → expandedPrompt + intent (quick client-side pass).
 *   3. POST /create-bot-chat with full history.
 *      a. status="clarification_needed" → append question, wait for next user message.
 *      b. status="ready"                → save bot, show success card.
 *      c. status="error"                → show error inline.
 *
 * All messages are accumulated into `chatHistory` and sent on EVERY turn so
 * the Python Planner Agent has full context — matching the architecture spec.
 */

"use client";

import {
  useState,
  useRef,
  useCallback,
  useEffect,
  ChangeEvent,
  KeyboardEvent,
} from "react";
import { v4 as uuidv4 } from "uuid";

// ─── Types ────────────────────────────────────────────────────────────────────

export type MessageRole = "user" | "assistant";

export interface ChatCard {
  type: "dynamic_credentials_form" | "success_card";
  // dynamic_credentials_form
  fields?: CredentialField[];
  // success_card
  agentId?: string;
  botName?: string;
}

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: Date;
  card?: ChatCard;
}

export interface CredentialField {
  key: string;
  label: string;
  placeholder: string;
  type?: "text" | "password";
  required?: boolean;
}

export type Step =
  | "idle"        // waiting for first message
  | "classifying" // quick intent classify
  | "planning"    // Planner loop running
  | "ask_keys"    // showing credentials form to user
  | "generating"  // saving bot to DB
  | "done";       // bot ready

// ─── Credential field schemas per strategy ────────────────────────────────────

const STRATEGY_FIELDS: Record<string, CredentialField[]> = {
  yield: [
    { key: "USER_WALLET_ADDRESS", label: "Wallet Address", placeholder: "init1... or yourname.init", required: true },
    { key: "INITIA_BRIDGE_ADDRESS", label: "Bridge Contract Address", placeholder: "0x1", required: true },
    { key: "INITIA_USDC_METADATA_ADDRESS", label: "USDC Metadata Object Address", placeholder: "0x...", required: true },
    { key: "MCP_GATEWAY_URL", label: "MCP Gateway URL", placeholder: "http://localhost:8000/mcp", type: "text", required: true },
  ],
  arbitrage: [
    { key: "INITIA_POOL_A_ADDRESS", label: "Pool A Address", placeholder: "0x...", required: true },
    { key: "INITIA_POOL_B_ADDRESS", label: "Pool B Address", placeholder: "0x...", required: true },
    { key: "INITIA_USDC_METADATA_ADDRESS", label: "USDC Metadata Address", placeholder: "0x...", required: true },
    { key: "INITIA_SWAP_ROUTER_ADDRESS", label: "Swap Router Address", placeholder: "0x...", required: true },
    { key: "INITIA_EXECUTION_AMOUNT_USDC", label: "Execution Amount (µUSDC)", placeholder: "1000000", required: true },
    { key: "MCP_GATEWAY_URL", label: "MCP Gateway URL", placeholder: "http://localhost:8000/mcp", required: true },
  ],
  cross_chain_liquidation: [
    { key: "INITIA_POOL_A_ADDRESS", label: "Lending Pool Address", placeholder: "0x...", required: true },
    { key: "INITIA_BRIDGE_ADDRESS", label: "Bridge Contract Address", placeholder: "0x1", required: true },
    { key: "USER_WALLET_ADDRESS", label: "Wallet Address", placeholder: "init1...", required: true },
    { key: "INITIA_USDC_METADATA_ADDRESS", label: "USDC Metadata Address", placeholder: "0x...", required: true },
    { key: "MCP_GATEWAY_URL", label: "MCP Gateway URL", placeholder: "http://localhost:8000/mcp", required: true },
  ],
  cross_chain_arbitrage: [
    { key: "INITIA_POOL_A_ADDRESS", label: "Pool A Address (buy side)", placeholder: "0x...", required: true },
    { key: "INITIA_POOL_B_ADDRESS", label: "Pool B Address (sell side)", placeholder: "0x...", required: true },
    { key: "INITIA_USDC_METADATA_ADDRESS", label: "USDC Metadata Address", placeholder: "0x...", required: true },
    { key: "INITIA_EXECUTION_AMOUNT_USDC", label: "Execution Amount (µUSDC)", placeholder: "1000000", required: true },
    { key: "MCP_GATEWAY_URL", label: "MCP Gateway URL", placeholder: "http://localhost:8000/mcp", required: true },
  ],
  cross_chain_sweep: [
    { key: "USER_WALLET_ADDRESS", label: "Wallet Address", placeholder: "init1...", required: true },
    { key: "INITIA_BRIDGE_ADDRESS", label: "Bridge Contract Address", placeholder: "0x1", required: true },
    { key: "INITIA_USDC_METADATA_ADDRESS", label: "USDC Metadata Address", placeholder: "0x...", required: true },
    { key: "MCP_GATEWAY_URL", label: "MCP Gateway URL", placeholder: "http://localhost:8000/mcp", required: true },
  ],
  sentiment: [
    { key: "INITIA_POOL_A_ADDRESS", label: "Pool A Address", placeholder: "0x...", required: true },
    { key: "INITIA_POOL_B_ADDRESS", label: "Pool B Address", placeholder: "0x...", required: true },
    { key: "USER_WALLET_ADDRESS", label: "Wallet Address", placeholder: "init1...", required: true },
    { key: "MCP_GATEWAY_URL", label: "MCP Gateway URL", placeholder: "http://localhost:8000/mcp", required: true },
  ],
  custom_utility: [
    { key: "USER_WALLET_ADDRESS", label: "Wallet Address", placeholder: "init1...", required: false },
    { key: "MCP_GATEWAY_URL", label: "MCP Gateway URL", placeholder: "http://localhost:8000/mcp", required: true },
  ],
};

const FALLBACK_FIELDS: CredentialField[] = [
  { key: "USER_WALLET_ADDRESS", label: "Wallet Address", placeholder: "init1...", required: false },
  { key: "MCP_GATEWAY_URL", label: "MCP Gateway URL", placeholder: "http://localhost:8000/mcp", required: true },
];

// ─── Strategy detection chips ─────────────────────────────────────────────────

const INITIAL_CHIPS = [
  "Yield sweeper bot",
  "Cross-chain arbitrage bot",
  "Spread scanner bot",
  "Custom utility bot",
];

// ─── Hook ─────────────────────────────────────────────────────────────────────

interface ServerMessage {
  role: string;
  content: string;
}

export function useBotConfigChat() {
  const [messages,        setMessages]        = useState<ChatMessage[]>([]);
  const [input,           setInput]           = useState("");
  const [step,            setStep]            = useState<Step>("idle");
  const [isTyping,        setIsTyping]        = useState(false);
  const [isGenerating,    setIsGenerating]    = useState(false);
  const [chips,           setChips]           = useState<string[]>(INITIAL_CHIPS);
  const [generatedAgentId,setGeneratedAgentId]= useState<string | null>(null);
  const [envDefaults,     setEnvDefaults]     = useState<Record<string, string>>({});

  // Full conversation history sent to the Python backend on every turn.
  // The Planner Agent needs the ENTIRE history to maintain context.
  const chatHistoryRef = useRef<ServerMessage[]>([]);

  // Intent detected during classify step
  const detectedStrategyRef = useRef<string>("custom_utility");
  const expandedPromptRef   = useRef<string>("");
  const requestIdRef        = useRef<string>(uuidv4());

  const bottomRef = useRef<HTMLDivElement>(null);

  // ── Scroll ─────────────────────────────────────────────────────────────────

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isTyping]);

  // ── Load env defaults ───────────────────────────────────────────────────────

  useEffect(() => {
    fetch("/api/env-defaults")
      .then((r) => r.json())
      .then((data) => {
        if (data?.values && typeof data.values === "object") {
          setEnvDefaults(data.values as Record<string, string>);
        }
      })
      .catch(() => {});
  }, []);

  // ── Greeting ────────────────────────────────────────────────────────────────

  useEffect(() => {
    const greeting: ChatMessage = {
      id:        uuidv4(),
      role:      "assistant",
      content:   (
        "👋 Hi! I'm the **Planner Agent** — I'll help you design and generate a production-ready " +
        "Initia bot.\n\n" +
        "Tell me what you want your bot to do. I'll verify your addresses on-chain, ask for anything " +
        "that's missing, and then generate the complete TypeScript code.\n\n" +
        "What kind of bot are you building?"
      ),
      timestamp: new Date(),
    };
    setMessages([greeting]);
  }, []);

  // ── Append message helpers ──────────────────────────────────────────────────

  const appendMessage = useCallback(
    (role: MessageRole, content: string, card?: ChatCard): ChatMessage => {
      const msg: ChatMessage = {
        id:        uuidv4(),
        role,
        content,
        timestamp: new Date(),
        card,
      };
      setMessages((prev) => [...prev, msg]);
      return msg;
    },
    []
  );

  const appendAssistant = useCallback(
    (content: string, card?: ChatCard) => appendMessage("assistant", content, card),
    [appendMessage]
  );

  // ── Push to persistent history (sent to Python) ────────────────────────────

  const pushHistory = useCallback((role: "user" | "assistant", content: string) => {
    chatHistoryRef.current = [
      ...chatHistoryRef.current,
      { role, content },
    ];
  }, []);

  // ── Call /create-bot-chat with full history ─────────────────────────────────

  const callPlannerAgent = useCallback(
    async (additionalContext?: string): Promise<void> => {
      setStep("planning");
      setIsGenerating(true);
      setChips([]);

      try {
        const history = chatHistoryRef.current;

        // Inject expanded prompt context as a system message if we have it
        const fullHistory =
          expandedPromptRef.current && history.length <= 2
            ? [
                ...history,
                {
                  role: "system" as const,
                  content: `Expanded technical specification:\n${expandedPromptRef.current}`,
                },
                ...(additionalContext
                  ? [{ role: "system" as const, content: additionalContext }]
                  : []),
              ]
            : additionalContext
            ? [...history, { role: "system" as const, content: additionalContext }]
            : history;

        const res = await fetch(
          `${process.env.NEXT_PUBLIC_META_AGENT_URL ?? "http://127.0.0.1:8000"}/create-bot-chat`,
          {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({
              messages:   fullHistory,
              request_id: requestIdRef.current,
            }),
          }
        );

        if (!res.ok) {
          const errText = await res.text().catch(() => "");
          throw new Error(`Meta-Agent HTTP ${res.status}: ${errText.slice(0, 300)}`);
        }

        const data = await res.json();

        // ── clarification_needed ────────────────────────────────────────────
        if (data.status === "clarification_needed") {
          const question = String(data.question ?? "Could you provide more details?");
          setIsTyping(true);
          await sleep(600);
          setIsTyping(false);
          appendAssistant(question);
          pushHistory("assistant", question);
          setStep("idle");
          return;
        }

        // ── ready ────────────────────────────────────────────────────────────
        if (data.status === "ready") {
          const botName = String(data.bot_name ?? "Your Bot");
          const intent  = data.intent ?? {};
          const files   = data.files  ?? [];

          // Determine which credential fields to show based on detected strategy
          const strategy = String(
            intent.strategy ?? detectedStrategyRef.current ?? "custom_utility"
          );
          const fields = STRATEGY_FIELDS[strategy] ?? FALLBACK_FIELDS;

          // Filter out fields whose values are already known from env
          const filteredFields = fields.filter(
            (f) => !envDefaults[f.key] || envDefaults[f.key].trim() === ""
          );

          // If all required values are already in env, skip the form and generate immediately
          const allPresent = filteredFields.filter((f) => f.required).length === 0;

          if (allPresent) {
            await finalizeBot({ files, intent, botName, envConfig: envDefaults });
            return;
          }

          // Show dynamic credentials form
          setIsTyping(true);
          await sleep(500);
          setIsTyping(false);

          appendAssistant(
            `✅ **${botName}** is architecturally complete! The Planner has verified your strategy.\n\n` +
            `I just need a few runtime credentials to finish generating the bot:`,
            {
              type:   "dynamic_credentials_form",
              fields: filteredFields,
            }
          );

          // Store files + intent for use after user submits credentials
          pendingBotRef.current = { files, intent, botName };
          setStep("ask_keys");
          return;
        }

        // ── error ─────────────────────────────────────────────────────────────
        const errMsg = String(data.message ?? "An unknown error occurred.");
        appendAssistant(`❌ ${errMsg}`);
        setStep("idle");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[callPlannerAgent] Error:", msg);
        setIsTyping(false);
        appendAssistant(
          `❌ Could not reach the Meta-Agent. Please ensure it's running:\n\n` +
          `\`\`\`\ncd agents && uvicorn main:app --reload --port 8000\n\`\`\`\n\n` +
          `Error: ${msg}`
        );
        setStep("idle");
      } finally {
        setIsGenerating(false);
      }
    },
    [appendAssistant, envDefaults, pushHistory]
  );

  // ── Pending bot state (files + intent waiting for credentials) ─────────────

  const pendingBotRef = useRef<{
    files:   Record<string, unknown>[];
    intent:  Record<string, unknown>;
    botName: string;
  } | null>(null);

  // ── Finalize: save bot to DB, show success card ────────────────────────────

  const finalizeBot = useCallback(
    async (params: {
      files:     Record<string, unknown>[];
      intent:    Record<string, unknown>;
      botName:   string;
      envConfig: Record<string, string>;
    }) => {
      const { files, intent, botName, envConfig } = params;
      setStep("generating");
      setIsTyping(true);

      try {
        await sleep(400);
        setIsTyping(false);
        appendAssistant("⏳ Saving your bot and encrypting credentials…");

        const saveRes = await fetch("/api/generate-bot", {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({
            prompt:         chatHistoryRef.current[0]?.content ?? botName,
            expandedPrompt: expandedPromptRef.current || chatHistoryRef.current[0]?.content,
            envConfig,
            intent,
          }),
        });

        if (!saveRes.ok) {
          const errText = await saveRes.text().catch(() => "");
          throw new Error(`Save failed (${saveRes.status}): ${errText.slice(0, 300)}`);
        }

        const saved = await saveRes.json();
        const agentId = String(saved.agentId ?? "");

        if (!agentId) {
          throw new Error("No agentId returned from save endpoint.");
        }

        setGeneratedAgentId(agentId);
        setStep("done");
        setChips([]);

        appendAssistant(
          `🎉 **${botName}** is ready! Your bot has been generated, verified, and saved.`,
          {
            type:    "success_card",
            agentId,
            botName,
          }
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[finalizeBot] Error:", msg);
        setIsTyping(false);
        appendAssistant(`❌ Failed to save bot: ${msg}`);
        setStep("idle");
      }
    },
    [appendAssistant]
  );

  // ── Submit dynamic credentials ─────────────────────────────────────────────

  const submitDynamicKeys = useCallback(
    async (formData: Record<string, string>) => {
      if (!pendingBotRef.current) return;
      const { files, intent, botName } = pendingBotRef.current;

      // Merge form data with env defaults (form data takes priority)
      const mergedEnv: Record<string, string> = { ...envDefaults, ...formData };

      // Inject verified params as a system context for next Planner call if needed
      const contextLine = Object.entries(formData)
        .filter(([, v]) => v.trim())
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
      if (contextLine) {
        pushHistory("user", `My configuration: ${contextLine}`);
      }

      await finalizeBot({ files, intent, botName, envConfig: mergedEnv });
    },
    [envDefaults, finalizeBot, pushHistory]
  );

  // ── Main send handler ──────────────────────────────────────────────────────

  const handleSend = useCallback(
    async (overrideText?: string) => {
      const text = (overrideText ?? input).trim();
      if (!text || isGenerating) return;

      setInput("");
      setChips([]);

      // Append user message to UI
      appendMessage("user", text);
      // Append to persistent history
      pushHistory("user", text);

      setIsTyping(true);

      try {
        // ── First turn: run classify-intent for expanded prompt ──────────────
        if (chatHistoryRef.current.filter((m) => m.role === "user").length === 1) {
          let expandedPrompt = text;

          try {
            const classifyRes = await fetch("/api/classify-intent", {
              method:  "POST",
              headers: { "Content-Type": "application/json" },
              body:    JSON.stringify({ prompt: text }),
            });
            if (classifyRes.ok) {
              const classifyData = await classifyRes.json();
              expandedPrompt = classifyData.expandedPrompt || text;
              const detectedStrategy = String(
                classifyData.intent?.strategy ?? "custom_utility"
              );
              detectedStrategyRef.current = detectedStrategy;
              expandedPromptRef.current   = expandedPrompt;
            }
          } catch {
            // classify-intent failure is non-fatal
          }

          setIsTyping(false);
          appendAssistant(
            "Got it! Let me analyse your request and verify the on-chain parameters…"
          );
          pushHistory("assistant", "Analysing your request…");

          await sleep(300);
          await callPlannerAgent();
          return;
        }

        // ── Subsequent turns: push to history and re-run Planner ──────────────
        setIsTyping(false);
        await callPlannerAgent();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[handleSend] Error:", msg);
        setIsTyping(false);
        appendAssistant(`❌ ${msg}`);
        setStep("idle");
      }
    },
    [input, isGenerating, appendMessage, appendAssistant, pushHistory, callPlannerAgent]
  );

  // ── Input handlers ─────────────────────────────────────────────────────────

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void handleSend();
      }
    },
    [handleSend]
  );

  const handleInputChange = useCallback((e: ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
  }, []);

  return {
    messages,
    input,
    isTyping,
    isGenerating,
    chips,
    bottomRef,
    generatedAgentId,
    step,
    envDefaults,
    handleSend,
    handleKeyDown,
    handleInputChange,
    submitDynamicKeys,
  };
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}