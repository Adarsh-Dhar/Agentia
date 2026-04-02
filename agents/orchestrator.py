"""
orchestrator.py

Simplified Meta-Agent.
Input:  plain-English prompt like "create a sentiment analysis solana bot"
Output: exactly 3 files:
          1. package.json
          2. src/mcp_bridge.ts
          3. src/index.ts

Pipeline:
  1. classify_intent()   → detect chain / strategy / MCPs from prompt
  2. build_bot_logic()   → generate 3 files following Listen→Quantify→Corroborate→Protect→Act
"""

import os
import re
import json
import time
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeoutError
from pathlib import Path
from dotenv import load_dotenv
from azure.ai.inference import ChatCompletionsClient
from azure.ai.inference.models import SystemMessage, UserMessage
from azure.core.credentials import AzureKeyCredential

_BASE_DIR = Path(__file__).resolve().parent
load_dotenv(_BASE_DIR / ".env")
load_dotenv(_BASE_DIR / ".env.local", override=True)

LLM_TIMEOUT_SECONDS = int(os.environ.get("META_AGENT_LLM_TIMEOUT_SECONDS", "240"))


def _log(level: str, message: str, trace_id: str | None = None) -> None:
  prefix = f"[meta-agent] [{level}]"
  if trace_id:
    prefix += f" [{trace_id}]"
  print(f"{prefix} {message}")


# ─── MCP Bridge Template (always the same — hardcoded, not generated) ────────

MCP_BRIDGE_CONTENT = '''\
import { CONFIG } from "./config.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function callMcpTool(
  server: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const gatewayBase = CONFIG.MCP_GATEWAY_URL.replace(/\\/+$/, "");
  const url = `${gatewayBase}/${server}/${tool}`;
  const attempts = 3;
  let lastError = "unknown error";

  console.log(`[MCP] → Calling ${server}/${tool}`);
  console.log(`[MCP] Request args: ${JSON.stringify(args)}`);

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      console.log(`[MCP] URL: ${url} (attempt ${attempt}/${attempts})`);
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "ngrok-skip-browser-warning": "true",
          "Bypass-Tunnel-Reminder": "true",
        },
        body: JSON.stringify(args),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) {
        const errText = await response.text();
        lastError = `MCP ${server}/${tool} failed: ${response.status} — ${errText}`;
        console.error(`[MCP] ✗ Response status: ${response.status}`);
      } else {
        const data = await response.json();
        console.log(`[MCP] ✓ Response received:`, JSON.stringify(data).substring(0, 200));
        const result = (data as { result?: { isError?: boolean; content?: unknown } })?.result;
        if (result?.isError) {
          const content = result.content;
          const detail = Array.isArray(content) && content.length > 0
            ? String((content[0] as { text?: unknown }).text ?? JSON.stringify(content))
            : JSON.stringify(content ?? data);
          throw new Error(`MCP ${server}/${tool} error: ${detail}`);
        }
        return data;
      }
    } catch (err) {
      clearTimeout(timeout);
      lastError = err instanceof Error ? err.message : String(err);
      console.error(`[MCP] ✗ Error: ${lastError}`);
    }
    if (attempt < attempts) await sleep(400 * attempt);
  }
  throw new Error(`MCP ${server}/${tool} unavailable after retries: ${lastError}`);
}
'''


# ─── Classifier ───────────────────────────────────────────────────────────────

CLASSIFIER_SYSTEM = """\
You are a DeFi bot intent classifier.
Analyze the prompt and return ONLY valid JSON — no markdown, no preamble.

Schema:
{
  "chain": "evm" | "solana",
  "network": "base-sepolia" | "base-mainnet" | "arbitrum" | "solana-mainnet",
  "strategy": "arbitrage" | "sentiment" | "sniping" | "dca" | "grid" | "whale_mirror" | "yield" | "perp" | "unknown",
  "mcps": ["list of MCP server names to use"],
  "bot_name": "human-readable name",
  "requires_openai": true | false
}

Rules:
- solana / jupiter / SPL / SOL -> chain:"solana", mcps must include "jupiter"
- sentiment / social / lunarcrush -> mcps include "lunarcrush", requires_openai:true
- rug / safety / risk check -> mcps include "rugcheck" or "webacy"
- arbitrage / flash loan -> mcps include "one_inch", "webacy"
- perp / perpetual / funding -> mcps include "hyperliquid"
- whale / nansen / smart money -> mcps include "nansen"
- always include "pyth" in mcps for price validation
- default network: base-sepolia for EVM, solana-mainnet for Solana
"""


# ─── Bot Generator System Prompt ─────────────────────────────────────────────

GENERATOR_SYSTEM = """\
You are an expert DeFi bot engineer. Generate a production-ready TypeScript bot.

OUTPUT FORMAT — CRITICAL:
Respond with RAW JSON only. No markdown fences. No preamble. No trailing text.

Schema:
{
  "thoughts": "<one paragraph: architecture rationale>",
  "files": [
    {"filepath": "package.json",    "content": "..."},
    {"filepath": "src/config.ts",   "content": "..."},
    {"filepath": "src/index.ts",    "content": "..."}
  ]
}

You MUST generate EXACTLY these 3 files in this order:
  1. package.json
  2. src/config.ts
  3. src/index.ts

The file src/mcp_bridge.ts is provided separately — do NOT generate it.
Import it in src/index.ts as: import { callMcpTool } from "./mcp_bridge.js";

ARCHITECTURE — Listen → Quantify → Corroborate → Protect → Act:

Every bot MUST follow this exact 5-step cycle inside async function runCycle():

  // STEP 1 & 2: LISTEN & QUANTIFY — fetch signals
  // STEP 3: CORROBORATE — cross-check with a second source
  // STEP 4: PROTECT — safety/risk check before any execution
  // STEP 5: ACT — execute the trade/action

HARD RULES:
1.  TypeScript + Node.js ONLY. Never Python.
2.  package.json MUST have: "type": "module", "start": "tsx src/index.ts"
3.  All dependencies: typescript, tsx, dotenv, ethers (for EVM) or @solana/web3.js + bs58 (for Solana)
4.  src/config.ts reads ALL secrets from process.env. Never hardcode keys.
5.  MCP_GATEWAY_URL in config.ts MUST throw if not set:
      MCP_GATEWAY_URL: process.env.MCP_GATEWAY_URL ?? (() => { throw new Error("MCP_GATEWAY_URL not set"); })()
6.  All token math uses BigInt — never float.
7.  SIMULATION_MODE defaults true (process.env.SIMULATION_MODE !== "false").
8.  Structured logging: [timestamp] [LEVEL] message
9.  Graceful shutdown: SIGINT + SIGTERM handlers.
10. Async loop safety — use guarded scheduler:
      let cycleInFlight = false;
      const runCycleSafely = async () => {
        if (cycleInFlight) return;
        cycleInFlight = true;
        try { await runCycle(); } finally { cycleInFlight = false; }
      };
      void runCycleSafely();
      const timer = setInterval(() => { void runCycleSafely(); }, POLL_MS);
11. Use Promise.allSettled for fetching multiple data sources.
12. NEVER hardcode any IP as MCP_GATEWAY_URL fallback.
13. All callMcpTool calls must reference the exact server name from the intent's mcps list.
14. OpenAI (if used): NEVER instantiate at module scope. Always inside the function:
      const OpenAIClass = (OpenAI as any).default ?? (OpenAI as any).OpenAI ?? OpenAI;
      const client = new OpenAIClass({ apiKey: process.env.OPENAI_API_KEY });
15. Solana private key: support BOTH bs58 and JSON-array formats. Validate before decode.
    In simulation mode, allow missing key and use ephemeral keypair.
16. Every file must be COMPLETE — no stubs, no TODOs, no placeholder comments.
17. Include a .env.example as a comment block at the top of src/config.ts showing every required env var.

╔═══════════════════════════════════════════════════════════════════════════════╗
║                    CRITICAL FOR ARBITRAGE BOTS                               ║
╚═══════════════════════════════════════════════════════════════════════════════╝

When generating an arbitrage bot, THESE RULES OVERRIDE THE ABOVE:

A. 1INCH MCP RESPONSE PARSING (CRITICAL BUG FIX):
   - 1inch get_quote returns a complex JSON object, NOT a simple number.
   - DO NOT do: Math.abs(pythPrice - quoteObject) — this returns NaN and breaks safety checks.
   - DO extract: const price = quoteObject?.result?.toTokenAmount || quoteObject?.toTokenAmount;
   - Then compare: if (Number(price) > 0.01 * initialPrice) { /* safe */ }
   - Log the extracted value: console.log(`[1inch] Extracted toTokenAmount: ${price}`);

B. PROFIT CALCULATION WITH FEES (REQUIRED FOR ALL ARBITRAGE):
   - Aave V3 flash loan fee: 0.09% of borrowed amount (9 basis points).
   - Formula: netProfit (in base units) = tokenOutAmount - tokenInAmount - (loanAmount × 0.0009) - estimatedGasCost
   - ONLY execute if: netProfit > 0 (in other words, after all fees and gas, you still make money)
   - Use BigInt for all calculations. Convert to human-readable format ONLY for logging.
   - Example: const fee = (BigInt(loanAmount) * BigInt(9)) / BigInt(10000);

C. ATOMIC EXECUTION FLOW FOR ARBITRAGE:
   - Arbitrage requires 3 consecutive on-chain calls within a single transaction:
     1. Borrow `loanAmount` from Aave V3 flashLoan receiver function
     2. Swap tokenIn→tokenOut on 1inch (or any DEX) using the loan proceeds
     3. Swap tokenOut→tokenIn to close the loop and repay the loan + fee
   - You MUST call the Aave V3 flashLoan function with a `loan_amount` parameter.
   - The swap logic must be inside the flashLoan callback/receiver.
   - Get swap calldata from 1inch get_swap_data, then execute via contract write call.
   - ONLY invoke flashLoan if profit > 0 (Step PROTECT checks this BEFORE Step ACT).

D. ARBITRAGE-SPECIFIC LOGGING:
   - Log every price fetch from both 1inch and Pyth SEPARATELY:
     console.log(`[LISTEN] 1inch price: ${extractedPrice}`);
     console.log(`[LISTEN] Pyth oracle price: ${pythPrice}`);
   - Log profit calculation details:
     console.log(`[QUANTIFY] Loan fee: ${fee.toString()}`);
     console.log(`[QUANTIFY] Net profit: ${netProfit.toString()} (threshold: 0)`);
   - Log PROTECT decision:
     if (netProfit <= 0n) {
       console.log(`[PROTECT] ✗ Profit ${netProfit.toString()} <= 0, SKIP execution`);
       return;
     }
     console.log(`[PROTECT] ✓ Profit ${netProfit.toString()} > 0, PROCEED to execution`);
   - Log execution attempt:
     console.log(`[ACT] → Invoking flashLoan for ${loanAmount.toString()}...`);
"""


# ─── MetaAgent ────────────────────────────────────────────────────────────────

class MetaAgent:
    def __init__(self):
        token = os.environ.get("GITHUB_TOKEN")
        if not token:
            raise ValueError("GITHUB_TOKEN not set in .env")

        self.client = ChatCompletionsClient(
            endpoint=os.environ.get("GITHUB_MODEL_ENDPOINT", "https://models.inference.ai.azure.com"),
            credential=AzureKeyCredential(token),
        )
        self.model      = os.environ.get("GITHUB_MODEL_NAME", "gpt-4o")
        self.max_tokens = int(os.environ.get("GENERATION_MAX_TOKENS", "2048"))

    def _llm(
        self,
        system: str,
        user: str,
        temperature: float = 0.0,
        max_tokens: int = 512,
        *,
        operation: str = "llm",
        trace_id: str | None = None,
    ) -> str:
      started_at = time.monotonic()

      def _complete():
        return self.client.complete(
          messages=[SystemMessage(content=system), UserMessage(content=user)],
          model=self.model,
          temperature=temperature,
          max_tokens=max_tokens,
        )

      executor = ThreadPoolExecutor(max_workers=1)
      try:
        _log(
          "INFO",
          f"{operation}: submitting request model={self.model} system_chars={len(system)} user_chars={len(user)} max_tokens={max_tokens} timeout={LLM_TIMEOUT_SECONDS}s",
          trace_id,
        )
        future = executor.submit(_complete)
        response = future.result(timeout=LLM_TIMEOUT_SECONDS)
      except FuturesTimeoutError:
        # IMPORTANT: avoid blocking on executor shutdown(wait=True) when the
        # worker thread is stuck in network I/O.
        future.cancel()
        executor.shutdown(wait=False, cancel_futures=True)
        elapsed = round(time.monotonic() - started_at, 2)
        msg = (
          f"LLM timeout after {LLM_TIMEOUT_SECONDS}s for {operation} "
          f"(model={self.model}, system_chars={len(system)}, user_chars={len(user)}, max_tokens={max_tokens}, elapsed={elapsed}s)"
        )
        _log("ERROR", msg, trace_id)
        raise TimeoutError(msg)
      except Exception as exc:
        executor.shutdown(wait=False, cancel_futures=True)
        elapsed = round(time.monotonic() - started_at, 2)
        _log(
          "ERROR",
          f"{operation}: failed after {elapsed}s with {exc.__class__.__name__}: {exc}",
          trace_id,
        )
        raise
      else:
        executor.shutdown(wait=False, cancel_futures=True)

      content = response.choices[0].message.content
      elapsed = round(time.monotonic() - started_at, 2)
      _log("INFO", f"{operation}: completed in {elapsed}s", trace_id)
      return content.strip() if isinstance(content, str) else str(content)

    def classify_intent(self, prompt: str, trace_id: str | None = None) -> dict:
        _log("INFO", f"classify_intent: prompt_chars={len(prompt)}", trace_id)
        raw = self._llm(CLASSIFIER_SYSTEM, prompt, temperature=0.0, max_tokens=512, operation="classify_intent", trace_id=trace_id)
        # Strip markdown fences if present
        raw = re.sub(r"```(?:json)?\s*|\s*```", "", raw).strip()
        try:
            intent = json.loads(raw)
        except Exception as exc:
            _log("WARN", f"classify_intent: JSON parse failed, using fallback intent ({exc.__class__.__name__}: {exc})", trace_id)
            # fallback
            intent = {
                "chain": "evm", "network": "base-sepolia",
                "strategy": "arbitrage",
                "mcps": ["one_inch", "webacy", "pyth"],
                "bot_name": "EVM Arbitrage Bot",
                "requires_openai": False,
            }
        # ensure pyth is always present
        mcps = intent.get("mcps", [])
        if "pyth" not in mcps:
            mcps.append("pyth")
            intent["mcps"] = mcps
        _log("INFO", f"classify_intent: intent={json.dumps(intent, ensure_ascii=False)}", trace_id)
        return intent

    def _parse_response(self, raw: str) -> dict:
        # Extract JSON object
        start = raw.find("{")
        end   = raw.rfind("}")
        if start != -1 and end != -1:
            raw = raw[start:end + 1]

        # Remove trailing commas
        raw = re.sub(r",\s*([}\]])", r"\1", raw)

        try:
            from json_repair import loads as repair_loads
            result = repair_loads(raw)
            if isinstance(result, str):
                result = json.loads(result)
            return result if isinstance(result, dict) else {}
        except Exception:
            pass

        try:
            return json.loads(raw)
        except Exception:
            return {"thoughts": "parse error", "files": [{"filepath": "error.ts", "content": raw}]}

    def build_bot(self, prompt: str, trace_id: str | None = None) -> dict:
        _log("INFO", f"build_bot: received prompt_chars={len(prompt)}", trace_id)
        intent  = self.classify_intent(prompt, trace_id=trace_id)
        chain   = intent.get("chain", "evm")
        network = intent.get("network", "base-sepolia")
        mcps    = intent.get("mcps", [])
        strategy = intent.get("strategy", "unknown")
        bot_name = intent.get("bot_name", "DeFi Bot")

        chain_ctx = self._chain_context(chain, network, mcps, strategy)
        _log(
          "INFO",
          f"build_bot: bot_name={bot_name} chain={chain} network={network} strategy={strategy} mcps={','.join(mcps)} chain_ctx_chars={len(chain_ctx)}",
          trace_id,
        )

        user_msg = f"""
Bot request: {prompt}

Bot name: {bot_name}
Chain: {chain} | Network: {network}
Strategy: {strategy}
MCP servers to use: {', '.join(mcps)}
Requires OpenAI sub-agent: {intent.get('requires_openai', False)}

{chain_ctx}

Generate the 3 files now.
""".strip()

        _log("INFO", f"build_bot: generator_prompt_chars={len(user_msg)} system_chars={len(GENERATOR_SYSTEM)}", trace_id)
        raw = self._llm(
          GENERATOR_SYSTEM,
          user_msg,
          temperature=0.1,
          max_tokens=self.max_tokens,
          operation="build_bot",
          trace_id=trace_id,
        )
        _log("INFO", f"build_bot: raw_response_chars={len(raw)}", trace_id)
        parsed = self._parse_response(raw)

        if "files" not in parsed:
          _log("WARN", f"build_bot: parsed response missing files key. keys={list(parsed.keys())}", trace_id)

        files = parsed.get("files", [])
        # Always inject the fixed mcp_bridge.ts
        files.insert(1, {"filepath": "src/mcp_bridge.ts", "content": MCP_BRIDGE_CONTENT})

        # Enforce exactly 3 output files: package.json, src/config.ts, src/index.ts
        # (mcp_bridge is injected separately and not counted as a "generated" file)
        wanted = {"package.json", "src/config.ts", "src/index.ts"}
        final_files = [f for f in files if f.get("filepath") in wanted or f.get("filepath") == "src/mcp_bridge.ts"]

        _log("INFO", f"build_bot: final_files={[f.get('filepath') for f in final_files]}", trace_id)

        return {
            "status":  "ready",
            "intent":  intent,
            "output":  {
                "thoughts": parsed.get("thoughts", ""),
                "files":    final_files,
            },
        }

    def _chain_context(self, chain: str, network: str, mcps: list, strategy: str) -> str:
        if chain == "solana":
            return f"""
CHAIN CONTEXT — SOLANA ({network})
Common mints:
  SOL:  So11111111111111111111111111111111111111112
  USDC: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
  BONK: DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263
  WIF:  EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm
Jupiter MCP: callMcpTool('jupiter', 'getQuote', {{inputMint, outputMint, amount, slippageBps}})
Pyth SOL/USD feed: ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d
Solana key: support bs58 AND JSON-array export formats. Parse in runtime, NOT in config.ts.
Required deps: @solana/web3.js, bs58
"""
        chain_ids = {"base-sepolia": 84532, "base-mainnet": 8453, "arbitrum": 42161}
        cid = chain_ids.get(network, 84532)
        tokens = {
            "base-sepolia": {"USDC":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913","WETH":"0x4200000000000000000000000000000000000006"},
            "base-mainnet": {"USDC":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913","WETH":"0x4200000000000000000000000000000000000006"},
            "arbitrum":     {"USDC":"0xaf88d065e77c8cC2239327C5EDb3A432268e5831","WETH":"0x82aF49447D8a07e3bd95BD0d56f35241523fBab1"},
        }.get(network, {})
        token_lines = "\n".join(f"  {k}: {v}" for k, v in tokens.items())

        mcp_hints = ""
        if "one_inch" in mcps:
            mcp_hints += f"\n1inch: callMcpTool('one_inch', 'get_quote', {{tokenIn, tokenOut, amount:'<str>', chain:{cid}}})"
            mcp_hints += "\n  CRITICAL: Extract toTokenAmount from response, do NOT use entire object in math!"
            mcp_hints += f"\n1inch: callMcpTool('one_inch', 'get_swap_data', {{tokenIn, tokenOut, amount:'<str>', chain:{cid}, from:'<addr>', slippage:1}})"
        if "webacy" in mcps:
            mcp_hints += f"\nWebacy: callMcpTool('webacy', 'get_token_risk', {{address:'<addr>', chain:'{network}'}})"
            mcp_hints += "\n  Pass if risk==='low' OR score<20"
        if "lunarcrush" in mcps:
            mcp_hints += "\nLunarCrush: callMcpTool('lunarcrush', 'get_coin_details', {coin:'SOL'})"
            mcp_hints += "\n  sentiment>70 = bullish signal, galaxy_score>60 = strong"
        if "rugcheck" in mcps:
            mcp_hints += "\nRugcheck: callMcpTool('rugcheck', 'check_token_validity', {mint:'<addr>'})"
            mcp_hints += "\n  Pass if status==='good'"
        if "pyth" in mcps:
            mcp_hints += "\nPyth: callMcpTool('pyth', 'get_latest_price_updates', {ids:['<feedId>']})"
            mcp_hints += "\n  Decode: Number(price) * Math.pow(10, expo). Reject if staleness>60s or conf/price>0.5%"
            mcp_hints += "\n  ETH/USD: ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace"
            mcp_hints += "\n  BTC/USD: e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43"

        return f"""
CHAIN CONTEXT — EVM ({network}, chainId={cid})
Token addresses:
{token_lines}

MCP tool signatures:
{mcp_hints}
"""