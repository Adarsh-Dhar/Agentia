import { NextRequest, NextResponse } from "next/server";

const META_AGENT_URL = process.env.META_AGENT_URL ?? "http://127.0.0.1:8000";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

// ─── Rich Expander System Prompt ─────────────────────────────────────────────
// This prompt produces a deeply detailed technical spec so the downstream
// code-generation agent has maximum context about what to build.

const EXPANDER_SYSTEM_PROMPT = `You are an expert DeFi Quantitative Architect and senior blockchain engineer.

Your task: take a brief user idea for a crypto trading bot and expand it into an exhaustive, production-grade technical specification. The output will be fed directly to a code-generation agent — so the more precise, detailed, and concrete you are, the better the generated bot will be.

Cover ALL of the following in your expansion:

1. **Target Blockchain & Network**: Specify the exact chain (e.g. Base Sepolia, Solana Mainnet, Arbitrum One), chain ID, and why it suits this strategy.

2. **Execution Architecture**: 
   - Polling loop (REST) vs WebSocket (real-time) vs Agentic (AI sub-agent nested inside) 
   - Exact polling interval or event trigger
   - Graceful shutdown, SIGINT/SIGTERM handling

3. **Required Data Sources & APIs**:
   - List every MCP server or REST API needed (e.g. 1inch for EVM swaps, Jupiter for Solana, LunarCrush for sentiment, Nansen for whale tracking, Hyperliquid for perps, DeBridge for cross-chain, CoW Protocol for MEV-protected swaps, Alchemy for mempool)
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
  "chain": "evm" | "solana",
  "network": "base-sepolia" | "base-mainnet" | "arbitrum" | "solana-mainnet",
  "execution_model": "polling" | "websocket" | "agentic",
  "strategy": "arbitrage" | "sniping" | "dca" | "grid" | "sentiment" | "whale_mirror" | "news_reactive" | "yield" | "perp" | "mev_intent" | "scalper" | "rebalancing" | "ta_scripter" | "unknown",
  "required_mcps": ["one_inch","webacy","lunarcrush","jupiter","nansen","cow_protocol","hyperliquid","lifi","debridge","coingecko","twitter","alchemy","goat_evm","uniswap","chainlink"],
  "bot_type": "human-readable bot name",
  "requires_openai_key": true | false,
  "requires_solana_wallet": true | false
}

Classification rules (first match wins):
- flash loan | arbitrage → execution_model:"polling", strategy:"arbitrage", required_mcps:["one_inch","webacy","goat_evm"]
- CoW | MEV intent | MEV-protected → execution_model:"polling", strategy:"mev_intent", required_mcps:[...,"cow_protocol"]
- sniper | memecoin | mempool → execution_model:"websocket", strategy:"sniping", required_mcps:["one_inch","webacy","alchemy"]
- DCA | dollar cost → execution_model:"polling", strategy:"dca", required_mcps:["one_inch"]
- grid | range → execution_model:"polling", strategy:"grid", required_mcps:["one_inch"]
- sentiment | social | LunarCrush → execution_model:"agentic", strategy:"sentiment", required_mcps:["lunarcrush","one_inch"], requires_openai_key:true
- whale | Nansen | mirror → execution_model:"polling", strategy:"whale_mirror", required_mcps:["nansen","one_inch","webacy"]
- news | GPT trader → execution_model:"agentic", strategy:"news_reactive", required_mcps:["twitter","one_inch"], requires_openai_key:true
- cross-chain | bridge | yield arb → execution_model:"polling", strategy:"yield", required_mcps:["debridge","one_inch"]
- perp | perpetual | funding → execution_model:"polling", strategy:"perp", required_mcps:["hyperliquid"]
- HF | high frequency | scalper → execution_model:"websocket", strategy:"scalper", required_mcps:["one_inch","alchemy"]
- Solana in any request → chain:"solana", network:"solana-mainnet", required_mcps includes "jupiter", requires_solana_wallet:true
- default network if unspecified → "base-sepolia"`;

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

// ─── Helper: call Python Meta-Agent with timeout ──────────────────────────────

async function callPythonClassifier(
  expandedPrompt: string,
  timeoutMs: number
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${META_AGENT_URL}/classify-intent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: expandedPrompt }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Python Meta-Agent ${res.status}: ${errText.slice(0, 200)}`);
    }

    const data = await res.json();
    return (data.intent ?? data) as Record<string, unknown>;
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

    // ── Step 2: Classify intent — try Python Meta-Agent first ───────────────
    let intent: Record<string, unknown> | null = null;

    try {
      console.log("[classify-intent] Calling Python Meta-Agent for classification...");
      intent = await callPythonClassifier(expandedPrompt, 20_000); // 20 second timeout
      console.log("[classify-intent] Python classification succeeded:", JSON.stringify(intent));
    } catch (pyErr: unknown) {
      const msg = pyErr instanceof Error ? pyErr.message : String(pyErr);
      console.warn("[classify-intent] Python Meta-Agent unavailable, falling back to LLM classifier:", msg);
    }

    // ── Step 3: Fallback — classify directly via GitHub Models if Python failed
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

    console.log("[classify-intent] Final intent:", JSON.stringify(intent));

    return NextResponse.json({
      intent,
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

  const isSolana  = lower.includes("solana") || lower.includes("jupiter") || lower.includes("spl");
  const isSniper  = lower.includes("snip") || lower.includes("memecoin") || lower.includes("meme coin") || lower.includes("mempool");
  const isSentim  = lower.includes("sentiment") || lower.includes("lunarcrush") || lower.includes("social");
  const isWhale   = lower.includes("whale") || lower.includes("nansen") || lower.includes("smart money");
  const isPerp    = lower.includes("perp") || lower.includes("perpetual") || lower.includes("funding rate") || lower.includes("hyperliquid");
  const isYield   = lower.includes("yield") || lower.includes("cross-chain") || lower.includes("bridge");
  const isGrid    = lower.includes("grid") || lower.includes("range");
  const isDCA     = lower.includes("dca") || lower.includes("dollar cost");
  const isNews    = lower.includes("news") || lower.includes("gpt trader") || lower.includes("ai trader");
  const isMEV     = lower.includes("cow") || lower.includes("mev") || lower.includes("protected swap");
  const isScalper = lower.includes("scalper") || lower.includes("high frequency") || lower.includes("hf ");

  if (isSolana) {
    return {
      chain: "solana", network: "solana-mainnet",
      execution_model: isSentim ? "agentic" : "polling",
      strategy: isSentim ? "sentiment" : "dca",
      required_mcps: ["jupiter", ...(isSentim ? ["lunarcrush"] : [])],
      bot_type: isSentim ? "Solana Sentiment Bot" : "Solana Jupiter Bot",
      requires_openai_key: isSentim,
      requires_solana_wallet: true,
    };
  }
  if (isSniper || isScalper) {
    return {
      chain: "evm", network: "base-sepolia",
      execution_model: "websocket",
      strategy: isScalper ? "scalper" : "sniping",
      required_mcps: ["one_inch", "webacy", "alchemy"],
      bot_type: isScalper ? "HF Scalper Bot" : "Memecoin Sniper Bot",
      requires_openai_key: false,
      requires_solana_wallet: false,
    };
  }
  if (isSentim || isNews) {
    return {
      chain: "evm", network: "base-sepolia",
      execution_model: "agentic",
      strategy: isNews ? "news_reactive" : "sentiment",
      required_mcps: ["lunarcrush", "one_inch", ...(isNews ? ["twitter"] : [])],
      bot_type: isNews ? "News-Reactive Trader" : "Sentiment Trading Bot",
      requires_openai_key: true,
      requires_solana_wallet: false,
    };
  }
  if (isWhale) {
    return {
      chain: "evm", network: "base-sepolia",
      execution_model: "polling",
      strategy: "whale_mirror",
      required_mcps: ["nansen", "one_inch", "webacy"],
      bot_type: "Whale Mirror Bot",
      requires_openai_key: false,
      requires_solana_wallet: false,
    };
  }
  if (isPerp) {
    return {
      chain: "evm", network: "arbitrum",
      execution_model: "polling",
      strategy: "perp",
      required_mcps: ["hyperliquid"],
      bot_type: "Perpetuals Funding Rate Bot",
      requires_openai_key: false,
      requires_solana_wallet: false,
    };
  }
  if (isYield) {
    return {
      chain: "evm", network: "base-mainnet",
      execution_model: "polling",
      strategy: "yield",
      required_mcps: ["debridge", "one_inch"],
      bot_type: "Cross-Chain Yield Arbitrage Bot",
      requires_openai_key: false,
      requires_solana_wallet: false,
    };
  }
  if (isMEV) {
    return {
      chain: "evm", network: "base-mainnet",
      execution_model: "polling",
      strategy: "mev_intent",
      required_mcps: ["cow_protocol", "one_inch", "webacy"],
      bot_type: "MEV-Protected Swap Bot",
      requires_openai_key: false,
      requires_solana_wallet: false,
    };
  }
  if (isGrid) {
    return {
      chain: "evm", network: "base-sepolia",
      execution_model: "polling",
      strategy: "grid",
      required_mcps: ["one_inch"],
      bot_type: "Grid Trading Bot",
      requires_openai_key: false,
      requires_solana_wallet: false,
    };
  }
  if (isDCA) {
    return {
      chain: "evm", network: "base-sepolia",
      execution_model: "polling",
      strategy: "dca",
      required_mcps: ["one_inch"],
      bot_type: "DCA Bot",
      requires_openai_key: false,
      requires_solana_wallet: false,
    };
  }

  // Hard default: flash loan arbitrage
  return {
    chain: "evm", network: "base-sepolia",
    execution_model: "polling",
    strategy: "arbitrage",
    required_mcps: ["one_inch", "webacy", "goat_evm"],
    bot_type: "EVM Flash Loan Arbitrage Bot",
    requires_openai_key: false,
    requires_solana_wallet: false,
  };
}