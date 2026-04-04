import { NextRequest, NextResponse } from "next/server";
import { sanitizeIntentMcpLists } from "@/lib/intent/mcp-sanitizer";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

// ─── Rich Expander System Prompt ─────────────────────────────────────────────
// This prompt produces a deeply detailed technical spec so the downstream
// code-generation agent has maximum context about what to build.

const EXPANDER_SYSTEM_PROMPT = `You are an expert DeFi Quantitative Architect and senior blockchain engineer.

Your task: take a brief user idea for a crypto trading bot and expand it into an exhaustive, production-grade technical specification. The output will be fed directly to a code-generation agent — so the more precise, detailed, and concrete you are, the better the generated bot will be.

Cover ALL of the following in your expansion:

1. **Target Blockchain & Network**: Specify the exact Initia network (initia-testnet or initia-mainnet), chain ID, and why it suits this strategy.

2. **Execution Architecture**: 
   - Polling loop (REST) vs WebSocket (real-time) vs Agentic (AI sub-agent nested inside) 
   - Exact polling interval or event trigger
   - Graceful shutdown, SIGINT/SIGTERM handling

3. **Required Data Sources & APIs**:
  - List every MCP server or REST API needed (for example Initia MCP for Move reads/writes, LunarCrush for sentiment, and any analytics APIs required by the strategy)
   - For each: what data it provides, what endpoint/tool to call, what fields to parse

4. **Step-by-Step Trading Logic**:
   - Initialization: what to set up at startup (providers, connections, base unit conversions)
   - Data collection loop: exactly what to fetch each cycle and in what order
   - Signal computation: how to interpret the raw data into a trade signal
   - Trade decision rules: specific numeric thresholds (e.g. sentiment > 70 = buy, funding rate > 0.01% = short)
   - Order execution: exact contract calls or API calls to place the trade
   - Position management: stop-loss %, take-profit %, max position size
   - Post-trade: logging, cooldown periods, state reset

5. **Risk & Safety Mechanisms**:
   - Token risk check (Webacy or GoPlus) before execution
   - Simulation mode (no real txs broadcast)
   - Max daily loss circuit breaker
   - Slippage tolerance and minimum liquidity checks
   - Flash loan fee accounting (Aave 0.09% fee + gas buffer)
  - Explicit profit/loss reporting every cycle: log gross spread, fee estimate, gas estimate, and net profit or loss in the same token units before any trade decision

For Initia price-sensitive strategies, prefer Initia-native data sources and include oracle usage only if the user explicitly asks for it.

For Initia yield sweeper workflows, do not introduce Pyth or amm_oracle. Use only Initia move_view for 0x1::coin::balance and move_execute for interwoven_bridge::sweep_to_l1 when threshold is met.

6. **Key Environment Variables Required**:
   - List every API key, private key, RPC URL, and config variable the bot needs

7. **TypeScript/Node.js Implementation Notes**:
   - All amounts must use BigInt (no floats)
   - package.json "start" script: "tsx src/index.ts"
   - tsconfig: "module": "NodeNext", "moduleResolution": "NodeNext"
   - MCP calls via mcp_bridge.ts → POST to MCP_GATEWAY_URL
   - WebContainer compatibility notes if applicable

Output ONLY the expanded technical specification in plain text with clear section headers. No markdown code fences, no preamble, no pleasantries. Be exhaustive — aim for 600-900 words minimum.`;

// ─── Fallback intent classifier (runs entirely in Next.js if Python is down) ──

const FALLBACK_CLASSIFIER_PROMPT = `You are a DeFi bot intent classifier. Analyze the user's trading bot request and output ONLY a valid JSON object — no markdown, no preamble.

Required schema:
{
  "chain": "initia",
  "network": "initia-mainnet" | "initia-testnet",
  "execution_model": "polling" | "websocket" | "agentic",
  "strategy": "arbitrage" | "sniping" | "dca" | "grid" | "sentiment" | "whale_mirror" | "news_reactive" | "yield" | "yield_sweeper" | "cross_chain_liquidation" | "cross_chain_arbitrage" | "cross_chain_sweep" | "custom_utility" | "perp" | "mev_intent" | "scalper" | "rebalancing" | "ta_scripter" | "unknown",
  "required_mcps": ["initia","lunarcrush","pyth"],
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
- sentiment | social | LunarCrush → execution_model:"agentic", strategy:"sentiment", required_mcps:["initia","lunarcrush"], requires_openai_key:true
- yield sweeper | auto-consolidator | consolidate idle funds → execution_model:"polling", strategy:"yield", required_mcps:["initia"]
- spread scanner | read-only arbitrage | market intelligence scanner → execution_model:"polling", strategy:"arbitrage", required_mcps:["initia"]
- flash loan | arbitrage | hot potato → execution_model:"polling", strategy:"arbitrage", required_mcps:["initia"]
- otherwise default execution_model:"polling", strategy:"unknown", required_mcps:["initia"]
- if chain is initia, allow only these MCPs: initia (required), lunarcrush (optional), pyth (optional)
- for initia yield sweeper flows, do NOT include pyth and do NOT imply amm_oracle usage
- default network if unspecified → "initia-testnet"`;

function normalizeIntentFromPrompt(intent: Record<string, unknown>, prompt: string): Record<string, unknown> {
  const mergedPrompt = String(prompt ?? "").toLowerCase();
  const isYieldSweeper = /(yield sweeper|auto-consolidator|auto consolidator|consolidate idle funds|sweep_to_l1|bridge back to l1|sweep)/.test(mergedPrompt);
  const isCrossChainLiquidation = /(liquidation sniper|omni-chain liquidat|cross[-. ]chain liquidat)/.test(mergedPrompt);
  const isCrossChainArbitrage = /(flash[-. ]bridge|spatial arb|cross[-. ]chain arb)/.test(mergedPrompt);
  const isCrossChainSweep = /(yield nomad|auto[-. ]compounder|omni[-. ]chain yield)/.test(mergedPrompt);
  const isSpreadScanner = /(spread scanner|read-only scanner|read only scanner|market intelligence)/.test(mergedPrompt);
  const isSentiment = /(sentiment|lunarcrush|social)/.test(mergedPrompt);
  const isCustomUtility = /(custom utility|custom bot|custom workflow|intent:\s*custom|strategy:\s*custom)/.test(mergedPrompt);

  const normalized: Record<string, unknown> = {
    ...intent,
    chain: "initia",
    network: String(intent.network ?? "").toLowerCase().includes("mainnet") ? "initia-mainnet" : "initia-testnet",
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
    normalized.required_mcps = ["initia", "lunarcrush"];
    normalized.mcps = ["initia", "lunarcrush"];
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
  const isInitiaSentiment = lower.includes("sentiment") || lower.includes("lunarcrush") || lower.includes("social");
  const isCustomUtility = /(custom utility|custom bot|custom workflow|intent:\s*custom|strategy:\s*custom)/.test(lower);
  const initiaNetwork = lower.includes("mainnet") ? "initia-mainnet" : "initia-testnet";
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
    mcps: ["initia", ...(isInitiaSentiment ? ["lunarcrush"] : [])],
    bot_type: botName,
    bot_name: botName,
    requires_openai: isInitiaSentiment,
    requires_openai_key: isInitiaSentiment,
  };
}