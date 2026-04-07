import { NextRequest, NextResponse } from "next/server";
import { sanitizeIntentMcpLists } from "@/lib/intent/mcp-sanitizer";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

// ─── Rich Expander System Prompt ─────────────────────────────────────────────
// This prompt produces a deeply detailed technical spec so the downstream
// code-generation agent has maximum context about what to build.

const EXPANDER_SYSTEM_PROMPT = `You are an expert Initia Blockchain Architect and senior backend engineer.

Your task: take a brief user idea for an Initia-native bot and expand it into an exhaustive, production-grade technical specification. The output will be fed directly to a code-generation agent.

Cover ALL of the following in your expansion:

1. **Target & Execution Architecture**:
  - Chain: Initia (initia-testnet only).
   - Execution Model: Polling loop, Event-driven, or Agentic (AI-driven). Define the exact triggers or intervals.

2. **Domain-Specific Logic (Adapt to the user's request)**:
   - *If Arbitrage/DeFi:* Define flash loan accounting, slippage limits, specific routing pools, and profit math.
   - *If Yield/Sweeper:* Define balance threshold checks and bridge execution parameters.
   - *If NFT/Social/Other:* Define the specific module addresses, queries, and execution rules required.

3. **Initia MCP Integration Guide (CRITICAL)**:
   - The bot MUST use the local \`mcp_bridge.ts\` file to interact with Initia.
   - **Reads:** \`await callMcpTool("initia", "move_view", { network, address, module, function, type_args: [], args: [] })\`
  - **Writes:** \`await callMcpTool("initia", "move_execute", { network, address, module, function, type_args: [tokenTypeIfGeneric], args: [] })\`
  - For generic Move entry functions (for example \`sweep_to_l1<CoinType>\`), you MUST pass exactly one concrete coin/metadata type in \`type_args\`.
   - **CRITICAL SIGNATURE RULE:** \`callMcpTool\` takes EXACTLY 3 arguments (server, tool, args). NEVER pass a 4th argument.

4. **Fungible Asset (FA) Balance Rule (CRITICAL)**:
   - Initia uses Fungible Assets, NOT legacy coins. NEVER use \`move_view\` directly to check balances.
   - You MUST import and use the \`getFaBalance\` helper from \`./mcp_bridge.js\`.
   - **Example:**
     \`\`\`typescript
     import { callMcpTool, getFaBalance } from "./mcp_bridge.js";
     const balance = await getFaBalance(network, walletAddress, String(process.env.INITIA_USDC_METADATA_ADDRESS));
     \`\`\`

5. **Mock Bridge Execution Rule (CRITICAL)**:
   - The \`interwoven_bridge\` requires a valid struct tag for \`type_args\`, NOT a raw FA address.
   - The \`sweep_to_l1\` function takes EXACTLY ONE argument (the amount).
   - **CORRECT SWEEP CALL:**
     \`\`\`typescript
     await callMcpTool("initia", "move_execute", {
       network,
       address: bridgeAddress,
       module: "interwoven_bridge",
       function: "sweep_to_l1",
       type_args: ["0x1::fungible_asset::Metadata"],
       args: [amount.toString()]
     });
     \`\`\`

6. **TypeScript Implementation Constraints**:
   - Use standard \`BigInt\` for all on-chain amounts. No floats.
   - Entry point is always \`src/index.ts\`.
   - **CRITICAL CONFIG RULE:** DO NOT generate a separate \`config.ts\` file. Read all variables directly from \`process.env\`.
   - **CRITICAL TS RULE:** To satisfy TypeScript without crashing, ALWAYS wrap \`process.env\` variables in \`String(...)\`.
     WRONG: \`if (!process.env.WALLET) process.exit(1);\`
     RIGHT: \`const wallet = String(process.env.USER_WALLET_ADDRESS ?? "");\`
   - **CRITICAL PARSING RULE:** balance payload parsing is owned by \`getFaBalance\` in \`mcp_bridge.ts\`. Do NOT implement custom FA balance regex/parsing in \`src/index.ts\`.
   - **CRITICAL FA RULE:** for balance checks, always call \`getFaBalance(network, walletAddress, metadataAddress)\` and never construct a direct FA balance \`move_view\` payload inside \`src/index.ts\`.

Output ONLY the expanded technical specification in plain text with clear headers. No preamble. Be highly specific about the Move modules and functions needed based on the user's intent.`;

// ─── Fallback intent classifier (runs entirely in Next.js if Python is down) ──

const FALLBACK_CLASSIFIER_PROMPT = `You are a DeFi bot intent classifier. Analyze the user's trading bot request and output ONLY a valid JSON object — no markdown, no preamble.

Required schema:
{
  "chain": "initia",
  "network": "initia-testnet",
  "execution_model": "polling" | "websocket" | "agentic",
  "strategy": "arbitrage" | "sniping" | "dca" | "grid" | "sentiment" | "whale_mirror" | "news_reactive" | "yield" | "yield_sweeper" | "cross_chain_liquidation" | "cross_chain_arbitrage" | "cross_chain_sweep" | "custom_utility" | "perp" | "mev_intent" | "scalper" | "rebalancing" | "ta_scripter" | "unknown",
  "required_mcps": ["initia"],
  "bot_type": "human-readable bot name",
  "requires_openai_key": true | false
}

Classification rules (first match wins):
- ALWAYS return chain:"initia" for every request.
- if request includes cross-rollup yield sweeper semantics (yield sweeper, auto-consolidator, consolidate idle funds, bridge back to l1, sweep_to_l1), classify as strategy:"yield" with required_mcps:["initia"] and bot_type:"Cross-Rollup Yield Sweeper".
- cross-chain liquidation / liquidation sniper / omni-chain liquidator → strategy:"cross_chain_liquidation", required_mcps:["initia"]
- flash-bridge arbitrage / cross-chain arb / spatial arbitrage → strategy:"cross_chain_arbitrage", required_mcps:["initia"]
- omni-chain yield / yield nomad / auto-compounder → strategy:"cross_chain_sweep", required_mcps:["initia"]
- if request asks for a custom utility bot, classify as strategy:"custom_utility" with required_mcps:["initia"] and bot_type:"Custom Utility Initia Bot".
- sentiment | social → execution_model:"agentic", strategy:"sentiment", required_mcps:["initia"], requires_openai_key:true
- yield sweeper | auto-consolidator | consolidate idle funds → execution_model:"polling", strategy:"yield", required_mcps:["initia"]
- spread scanner | read-only arbitrage | market intelligence scanner → execution_model:"polling", strategy:"arbitrage", required_mcps:["initia"]
- flash loan | arbitrage | hot potato → execution_model:"polling", strategy:"arbitrage", required_mcps:["initia"]
- otherwise default execution_model:"polling", strategy:"unknown", required_mcps:["initia"]
- if chain is initia, allow only these MCPs: initia (required)
- for initia yield sweeper flows, do NOT include pyth and do NOT imply amm_oracle usage
- default network if unspecified → "initia-testnet"`;

function normalizeIntentFromPrompt(intent: Record<string, unknown>, prompt: string): Record<string, unknown> {
  const mergedPrompt = String(prompt ?? "").toLowerCase();
  const isYieldSweeper = /(yield sweeper|auto-consolidator|auto consolidator|consolidate idle funds|sweep_to_l1|bridge back to l1|sweep)/.test(mergedPrompt);
  const isCrossChainLiquidation = /(liquidation sniper|omni-chain liquidat|cross[-. ]chain liquidat)/.test(mergedPrompt);
  const isCrossChainArbitrage = /(flash[-. ]bridge|spatial arb|cross[-. ]chain arb)/.test(mergedPrompt);
  const isCrossChainSweep = /(yield nomad|auto[-. ]compounder|omni[-. ]chain yield)/.test(mergedPrompt);
  const isSpreadScanner = /(spread scanner|read-only scanner|read only scanner|market intelligence)/.test(mergedPrompt);
  const isSentiment = /(sentiment|social)/.test(mergedPrompt);
  const isCustomUtility = /(custom utility|custom bot|custom workflow|intent:\s*custom|strategy:\s*custom)/.test(mergedPrompt);

  const normalized: Record<string, unknown> = {
    ...intent,
    chain: "initia",
    network: "initia-testnet",
  };

  if (isCustomUtility) {
    normalized.execution_model = "polling";
    normalized.strategy = "custom_utility";
    normalized.bot_type = "Custom Utility Initia Bot";
    normalized.bot_name = "Custom Utility Initia Bot";
    normalized.required_mcps = ["initia"];
    normalized.mcps = ["initia"];
    normalized.requires_openai_key = false;
    normalized.requires_openai = false;
    return normalized;
  }

  if (isCrossChainLiquidation) {
    normalized.execution_model = "polling";
    normalized.strategy = "cross_chain_liquidation";
    normalized.bot_type = "Omni-Chain Liquidation Sniper";
    normalized.bot_name = "Omni-Chain Liquidation Sniper";
    normalized.required_mcps = ["initia"];
    normalized.mcps = ["initia"];
    normalized.requires_openai_key = false;
    normalized.requires_openai = false;
    return normalized;
  }

  if (isCrossChainArbitrage) {
    normalized.execution_model = "polling";
    normalized.strategy = "cross_chain_arbitrage";
    normalized.bot_type = "Flash-Bridge Spatial Arbitrageur";
    normalized.bot_name = "Flash-Bridge Spatial Arbitrageur";
    normalized.required_mcps = ["initia"];
    normalized.mcps = ["initia"];
    normalized.requires_openai_key = false;
    normalized.requires_openai = false;
    return normalized;
  }

  if (isCrossChainSweep) {
    normalized.execution_model = "polling";
    normalized.strategy = "cross_chain_sweep";
    normalized.bot_type = "Omni-Chain Yield Nomad";
    normalized.bot_name = "Omni-Chain Yield Nomad";
    normalized.required_mcps = ["initia"];
    normalized.mcps = ["initia"];
    normalized.requires_openai_key = false;
    normalized.requires_openai = false;
    return normalized;
  }

  if (isYieldSweeper) {
    normalized.execution_model = "polling";
    normalized.strategy = "yield";
    normalized.bot_type = "Cross-Rollup Yield Sweeper";
    normalized.bot_name = "Cross-Rollup Yield Sweeper";
    normalized.required_mcps = ["initia"];
    normalized.mcps = ["initia"];
    normalized.requires_openai_key = false;
    normalized.requires_openai = false;
    return normalized;
  }

  if (isSpreadScanner) {
    normalized.execution_model = "polling";
    normalized.strategy = "arbitrage";
    normalized.bot_type = "Cross-Rollup Spread Scanner";
    normalized.bot_name = "Cross-Rollup Spread Scanner";
    normalized.required_mcps = ["initia"];
    normalized.mcps = ["initia"];
    normalized.requires_openai_key = false;
    normalized.requires_openai = false;
    return normalized;
  }

  if (isSentiment) {
    normalized.execution_model = "agentic";
    normalized.strategy = "sentiment";
    normalized.required_mcps = ["initia"];
    normalized.mcps = ["initia"];
    normalized.requires_openai_key = true;
    normalized.requires_openai = true;
    return normalized;
  }

  return normalized;
}

// ─── Helper: call GitHub Models with a short timeout ─────────────────────────

async function callGitHubModels(
  model: string,
  systemPrompt: string,
  userContent: string,
  maxTokens: number,
  temperature: number,
  timeoutMs: number
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch("https://models.inference.ai.azure.com/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${GITHUB_TOKEN}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user",   content: userContent },
        ],
        temperature,
        max_tokens: maxTokens,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`GitHub Models ${res.status}: ${errText.slice(0, 200)}`);
    }

    const data = await res.json();
    return data.choices[0].message.content.trim();
  } finally {
    clearTimeout(timer);
  }
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  console.log("[classify-intent] Received request");

  try {
    const body = await req.json();
    const originalPrompt: string = body.prompt;

    if (!originalPrompt?.trim()) {
      return NextResponse.json({ error: "Prompt is required." }, { status: 400 });
    }

    console.log("[classify-intent] Original prompt:", originalPrompt);

    // ── Step 1: Expand the prompt into a rich technical spec ────────────────
    let expandedPrompt = originalPrompt;

    if (GITHUB_TOKEN) {
      try {
        console.log("[classify-intent] Expanding prompt via gpt-4o-mini...");
        expandedPrompt = await callGitHubModels(
          "gpt-4o-mini",
          EXPANDER_SYSTEM_PROMPT,
          `Expand this bot idea into a full technical specification:\n\n${originalPrompt}`,
          1200,   // max_tokens — enough for a thorough spec
          0.5,
          25_000  // 25 second timeout for expansion
        );
        console.log("[classify-intent] Expanded prompt length:", expandedPrompt.length, "chars");
        console.log("[classify-intent] Expanded prompt preview:\n", expandedPrompt.slice(0, 300), "...");
      } catch (expandErr: unknown) {
        const msg = expandErr instanceof Error ? expandErr.message : String(expandErr);
        console.warn("[classify-intent] Prompt expansion failed, using original:", msg);
        expandedPrompt = originalPrompt;
      }
    } else {
      console.warn("[classify-intent] No GITHUB_TOKEN — skipping expansion.");
    }

    // Keep expanded specs concise so downstream generation stays within model limits.
    const MAX_EXPANDED_PROMPT_CHARS = Number(process.env.MAX_EXPANDED_PROMPT_CHARS ?? "3200");
    if (expandedPrompt.length > MAX_EXPANDED_PROMPT_CHARS) {
      console.warn(
        "[classify-intent] Expanded prompt too long; truncating:",
        expandedPrompt.length,
        "->",
        MAX_EXPANDED_PROMPT_CHARS,
      );
      expandedPrompt = expandedPrompt.slice(0, MAX_EXPANDED_PROMPT_CHARS);
    }

    // ── Step 2: Classify intent locally via LLM fallback classifier ──────────
    // The updated Python Meta-Agent now exposes /create-bot (not /classify-intent),
    // so this route classifies intent in-process to keep generation flow fast.
    let intent: Record<string, unknown> | null = null;

    // ── Step 3: Classify directly via GitHub Models
    if (!intent || typeof intent !== "object") {
      if (GITHUB_TOKEN) {
        try {
          console.log("[classify-intent] Running fallback LLM classifier...");
          const raw = await callGitHubModels(
            "gpt-4o-mini",
            FALLBACK_CLASSIFIER_PROMPT,
            expandedPrompt,
            512,
            0.0,
            15_000 // 15 second timeout
          );

          // Strip markdown fences if present
          let cleaned = raw.trim();
          if (cleaned.startsWith("```")) {
            const parts = cleaned.split("```");
            cleaned = parts[1] ?? cleaned;
            if (cleaned.startsWith("json")) cleaned = cleaned.slice(4);
          }
          cleaned = cleaned.trim();

          const parsed = JSON.parse(cleaned);
          intent = Array.isArray(parsed) ? parsed[0] : parsed;
          console.log("[classify-intent] Fallback classification succeeded:", JSON.stringify(intent));
        } catch (fallbackErr: unknown) {
          const msg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
          console.warn("[classify-intent] Fallback classifier also failed:", msg);
        }
      }
    }

    // ── Step 4: Last-resort default intent ──────────────────────────────────
    if (!intent || typeof intent !== "object") {
      console.warn("[classify-intent] All classification attempts failed — using hardcoded default.");
      intent = deriveDefaultIntent(expandedPrompt);
    }

    const normalizedIntent = normalizeIntentFromPrompt(
      intent as Record<string, unknown>,
      `${originalPrompt}\n${expandedPrompt}`,
    );
    const sanitizedIntent = sanitizeIntentMcpLists(normalizedIntent);
    console.log("[classify-intent] Final intent:", JSON.stringify(sanitizedIntent));

    return NextResponse.json({
      intent: sanitizedIntent,
      expandedPrompt,
    });

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[classify-intent] Unhandled error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// ─── Derive a sensible default intent from the raw prompt text ────────────────

function deriveDefaultIntent(prompt: string): Record<string, unknown> {
  const lower = prompt.toLowerCase();
  const isCrossChainLiquidation = /(liquidation sniper|omni-chain liquidat|cross[-. ]chain liquidat)/.test(lower);
  const isCrossChainArbitrage = /(flash[-. ]bridge|spatial arb|cross[-. ]chain arb)/.test(lower);
  const isCrossChainSweep = /(yield nomad|auto[-. ]compounder|omni[-. ]chain yield)/.test(lower);
  const isYieldSweeper = /(yield sweeper|auto-consolidator|auto consolidator|sweep|consolidate|sweep_to_l1|bridge back to l1|consolidate idle funds)/.test(lower);
  const isSpreadScanner = /(spread scanner|read-only scanner|read only scanner|market intelligence)/.test(lower);
  const isInitiaSentiment = lower.includes("sentiment") || lower.includes("social");
  const isCustomUtility = /(custom utility|custom bot|custom workflow|intent:\s*custom|strategy:\s*custom)/.test(lower);
  const initiaNetwork = "initia-testnet";
  let strategy = "unknown";
  let botName = "Initia Move Bot";

  if (isInitiaSentiment) {
    strategy = "sentiment";
    botName = "Initia Sentiment Bot";
  } else if (isCrossChainLiquidation) {
    strategy = "cross_chain_liquidation";
    botName = "Omni-Chain Liquidation Sniper";
  } else if (isCrossChainArbitrage) {
    strategy = "cross_chain_arbitrage";
    botName = "Flash-Bridge Spatial Arbitrageur";
  } else if (isCrossChainSweep) {
    strategy = "cross_chain_sweep";
    botName = "Omni-Chain Yield Nomad";
  } else if (isYieldSweeper) {
    strategy = "yield";
    botName = "Cross-Rollup Yield Sweeper";
  } else if (isCustomUtility) {
    strategy = "custom_utility";
    botName = "Custom Utility Initia Bot";
  } else if (isSpreadScanner || lower.includes("arbitrage") || lower.includes("flash loan")) {
    strategy = "arbitrage";
    botName = "Cross-Rollup Spread Scanner";
  }
  return {
    chain: "initia", network: initiaNetwork,
    execution_model: isInitiaSentiment ? "agentic" : "polling",
    strategy,
    required_mcps: ["initia"],
    mcps: ["initia"],
    bot_type: botName,
    bot_name: botName,
    requires_openai: isInitiaSentiment,
    requires_openai_key: isInitiaSentiment,
  };
}