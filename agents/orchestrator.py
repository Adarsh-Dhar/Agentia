"""
orchestrator.py

Simplified Meta-Agent.
Input:  plain-English prompt like "create a sentiment analysis initia bot"
Output: exactly 3 generated files plus the hardcoded MCP bridge:
          1. package.json
          2. src/config.ts
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
  if (server === "initia" && tool === "move_execute" && !CONFIG.INITIA_KEY) {
    throw new Error("INITIA_KEY missing for move_execute. Enable AutoSign session key mode and relaunch.");
  }
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
          ...(CONFIG.INITIA_KEY ? { "x-session-key": CONFIG.INITIA_KEY } : {}),
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

ONS_RESOLVER_CONTENT = '''\
import { callMcpTool } from "./mcp_bridge.js";
import { CONFIG } from "./config.js";

const _resolvedCache = new Map<string, string>();

export function isInitName(value: string): boolean {
  return /^[a-z0-9_-]+\\.init$/i.test(String(value ?? "").trim());
}

function extractAddressFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const root = payload as Record<string, unknown>;
  for (const field of ["address", "resolved_address", "value", "account"]) {
    if (typeof root[field] === "string" && (root[field] as string).trim()) {
      return (root[field] as string).trim();
    }
  }
  const result = root.result;
  if (result && typeof result === "object") {
    const content = (result as Record<string, unknown>).content;
    if (Array.isArray(content) && content.length > 0) {
      const text = (content[0] as Record<string, unknown>).text;
      if (typeof text === "string") {
        const trimmed = text.trim();
        if (trimmed.startsWith("{")) {
          try {
            const inner = JSON.parse(trimmed) as Record<string, unknown>;
            for (const field of ["address", "resolved_address", "value"]) {
              if (typeof inner[field] === "string") return (inner[field] as string).trim();
            }
          } catch {
          }
        }
        if (trimmed.startsWith("init1") || trimmed.startsWith("0x")) {
          return trimmed;
        }
      }
    }
  }
  return null;
}

export async function resolveAddress(nameOrAddress: string): Promise<string> {
  const normalized = String(nameOrAddress ?? "").trim().toLowerCase();
  if (!isInitName(normalized)) {
    return String(nameOrAddress ?? "").trim();
  }
  const cached = _resolvedCache.get(normalized);
  if (cached) {
    return cached;
  }
  const response = await callMcpTool("initia", "move_view", {
    network: String(CONFIG.INITIA_NETWORK ?? "initia-testnet"),
    address: String(process.env.ONS_REGISTRY_ADDRESS ?? CONFIG.ONS_REGISTRY_ADDRESS ?? "0x1"),
    module: "initia_names",
    function: "resolve",
    args: [normalized],
  });
  const resolved = extractAddressFromPayload(response);
  if (!resolved) {
    throw new Error(`ONS registry returned no address for '${normalized}'`);
  }
  _resolvedCache.set(normalized, resolved);
  return resolved;
}
'''


# ─── Classifier ───────────────────────────────────────────────────────────────

CLASSIFIER_SYSTEM = """\
You are a DeFi bot intent classifier.
Analyze the prompt and return ONLY valid JSON — no markdown, no preamble.

Schema:
{
  "chain": "initia",
  "network": "initia-mainnet" | "initia-testnet",
  "strategy": "arbitrage" | "sentiment" | "sniping" | "dca" | "grid" | "whale_mirror" | "yield" | "yield_sweeper" | "custom_utility" | "perp" | "unknown",
  "mcps": ["list of MCP server names to use"],
  "bot_name": "human-readable name",
  "requires_openai": true | false
}

Rules:
- ALWAYS set chain:"initia"
- Classification precedence: if prompt includes yield sweeper semantics (yield sweeper, auto-consolidator, consolidate idle funds, sweep_to_l1, bridge back to l1), classify as strategy:"yield" first.
- If prompt asks for a custom utility bot, classify as strategy:"custom_utility" and do not fall back to arbitrage.
- sentiment / social / lunarcrush -> mcps include "lunarcrush", requires_openai:true
- yield sweeper / auto-consolidator / sweep idle funds -> strategy:"yield", mcps:["initia"], requires_openai:false
- custom utility / custom bot / custom workflow -> strategy:"custom_utility", mcps:["initia"], requires_openai:false
- spread scanner / read-only arbitrage / no execution -> strategy:"arbitrage", mcps:["initia"], requires_openai:false
- arbitrage / flash loan / hot potato -> strategy:"arbitrage", mcps:["initia"]
- for initia arbitrage and yield workflows, do NOT auto-add pyth
- for initia bots, allowed MCPs are: initia (required), lunarcrush (optional), pyth (optional)
- default network: initia-testnet
"""


def _normalize_strategy(strategy: str) -> str:
  value = str(strategy or "").strip().lower()
  if value in {"yield_sweeper", "yield-sweeper"}:
    return "yield"
  if value in {"custom", "custom_utility", "custom-utility", "utility", "custombot", "custom_bot"}:
    return "custom_utility"
  if value in {"spread_scanner", "scanner", "read_only_arbitrage", "read-only-arbitrage"}:
    return "arbitrage"
  return value or "unknown"


# ─── Bot Generator System Prompt ─────────────────────────────────────────────

GENERATOR_SYSTEM = """\
You are an expert Initia bot engineer. Generate production-ready TypeScript for the current Agentia contract.

OUTPUT FORMAT - CRITICAL:
Respond with RAW JSON only. No markdown fences. No preamble. No trailing text.

Schema:
{
  "thoughts": "<one paragraph: architecture rationale>",
  "files": [
    {"filepath": "package.json", "content": "..."},
    {"filepath": "src/config.ts", "content": "..."},
    {"filepath": "src/index.ts", "content": "..."}
  ]
}

You MUST generate EXACTLY these 3 files in this order:
  1. package.json
  2. src/config.ts
  3. src/index.ts

The file src/mcp_bridge.ts is provided separately - do NOT generate it.
Import it in src/index.ts as: import { callMcpTool } from "./mcp_bridge.js".

CORE CONSTRAINTS:
1. TypeScript + Node.js only. Never Python.
2. package.json must use "type": "module" and "start": "tsx src/index.ts".
3. Keep dependencies minimal: dotenv, tsx, typescript, @types/node. Add only what the requested bot truly needs.
4. src/config.ts must read all secrets from process.env. INITIA_KEY can be empty at startup when SESSION_KEY_MODE=true and must be validated lazily at first write.
5. MCP_GATEWAY_URL must fail fast if unset. No hardcoded IP fallback.
6. All money and token math must use BigInt only.
7. SIMULATION_MODE defaults to true unless explicitly set to "false".
8. Use structured logs in the form [timestamp] [LEVEL] message.
9. Add graceful SIGINT and SIGTERM shutdown.
10. Use a guarded scheduler to prevent overlapping cycles.
11. Use Promise.allSettled when fetching multiple independent sources.
12. Never instantiate OpenAI clients or wallets at module scope.
13. Every generated file must be complete. No TODOs, stubs, or placeholder comments.
14. Never use fake placeholder addresses (for example 0xinitia_pool_a/0xinitia_pool_b) or fabricated prices.
15. Always resolve addresses and runtime inputs from CONFIG/process.env and fail fast when required values are missing.
16. If USER_WALLET_ADDRESS or any configured address ends in '.init', resolve it before first use and cache the resolved address.

INITIA RULES:
- Chain is always Initia.
- All reads must use callMcpTool('initia', 'move_view', {...}).
- All writes must use callMcpTool('initia', 'move_execute', {...}).
- Do not use external chain SDK signing flows for Initia.
- Always forward INITIA_KEY as header x-session-key when present.
- Use the exact MCP server names from the intent's mcps list.
- Never invent module or function names. Only use names explicitly supported by the prompt context.
- Never inject mocked balance/price values into production generation paths.

STRATEGY TEMPLATES:
1. Yield sweeper:
   - Run every 15 seconds.
   - Read 0x1::coin::balance via move_view for USER_WALLET_ADDRESS and uusdc.
   - Parse balance as BigInt.
   - Only sweep when balance > 1000000n.
   - Execute interwoven_bridge::sweep_to_l1 with move_execute.
   - Do not use Pyth or any oracle MCPs.

2. Read-only spread scanner:
   - Use move_view only.
   - Compare read-only values across endpoints.
   - Compute spread and log estimated net opportunity.
   - Never call move_execute.

3. Custom utility bot:
   - Prioritize the user's requested action exactly.
   - Do not force arbitrage framing, flash-loan language, or external DEX assumptions.
   - Keep the bot Initia-native, minimal, and deterministic.

4. Other Initia workflows:
   - If the prompt mentions a verified module or function, use it directly with move_view or move_execute as appropriate.
   - If a contract interface is not verified, do not hallucinate it.

REQUIRED RUNTIME SHAPE:
- Use a runCycle() function.
- Use a guarded scheduler that prevents concurrent runs.
- Keep logging and control flow simple, explicit, and deterministic.

The generated code should favor correctness over cleverness. If the prompt conflicts with these rules, follow the Initia rules above.
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
          "chain": "initia", "network": "initia-testnet",
          "strategy": "custom_utility",
          "mcps": ["initia"],
          "bot_name": "Custom Utility Initia Bot",
                "requires_openai": False,
            }
        mcps = [str(m).strip().lower() for m in intent.get("mcps", []) if str(m).strip()]
        chain = "initia"
        prompt_lc = prompt.lower()

        is_yield_sweeper = any(
          k in prompt_lc
          for k in [
            "yield sweeper",
            "auto-consolidator",
            "auto consolidator",
            "sweep",
            "consolidate",
            "sweep_to_l1",
            "bridge back to l1",
            "consolidate idle funds",
          ]
        )
        is_spread_scanner = any(k in prompt_lc for k in ["spread scanner", "read-only scanner", "read only scanner", "read-only", "market intelligence"])
        is_custom_utility = any(k in prompt_lc for k in ["custom utility", "custom bot", "custom workflow", "intent: custom", "strategy: custom"])

        if is_yield_sweeper:
          intent["strategy"] = "yield"
          intent["bot_name"] = "Cross-Rollup Yield Sweeper"
          intent["requires_openai"] = False
        elif is_spread_scanner:
          intent["strategy"] = "arbitrage"
          intent["bot_name"] = "Cross-Rollup Spread Scanner"
          intent["requires_openai"] = False
        elif is_custom_utility:
          intent["strategy"] = "custom_utility"
          intent["bot_name"] = "Custom Utility Initia Bot"
          intent["requires_openai"] = False

        intent["chain"] = chain
        requested_network = str(intent.get("network", "")).strip().lower()
        intent["network"] = requested_network if requested_network in {"initia-mainnet", "initia-testnet"} else os.environ.get("INITIA_NETWORK", "initia-testnet")
        strategy = _normalize_strategy(str(intent.get("strategy", "")))
        intent["strategy"] = strategy
        bot_name = str(intent.get("bot_name", "")).strip().lower()

        allowed = {"initia", "lunarcrush", "pyth"}
        cleaned = [m for m in mcps if m in allowed]
        if strategy in {"yield", "arbitrage", "custom_utility"} or "sweep" in bot_name or ("spread" in bot_name and "scanner" in bot_name):
          cleaned = [m for m in cleaned if m == "initia"]
        elif strategy == "sentiment" and "lunarcrush" not in cleaned:
          cleaned.append("lunarcrush")
        if "initia" not in cleaned:
          cleaned.insert(0, "initia")
        intent["mcps"] = list(dict.fromkeys(cleaned))
        if not intent.get("network"):
          intent["network"] = os.environ.get("INITIA_NETWORK", "initia-testnet")
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
      intent = self.classify_intent(prompt, trace_id=trace_id)
      chain = str(intent.get("chain", "initia")).strip().lower()
      network = str(intent.get("network", "initia-testnet")).strip().lower()
      mcps = [str(m).strip().lower() for m in intent.get("mcps", []) if str(m).strip()]
      strategy = str(intent.get("strategy", "unknown"))
      bot_name = str(intent.get("bot_name", "DeFi Bot"))
      strategy_lc = strategy.strip().lower()
      bot_name_lc = bot_name.strip().lower()

      if network not in {"initia-mainnet", "initia-testnet"}:
        network = "initia-testnet"
        intent["network"] = network
      allowed = {"initia", "lunarcrush", "pyth"}
      mcps = [m for m in mcps if m in allowed]
      if strategy_lc in {"yield", "arbitrage", "custom_utility"} or "sweep" in bot_name_lc or ("spread" in bot_name_lc and "scanner" in bot_name_lc):
        mcps = [m for m in mcps if m == "initia"]
      elif strategy_lc == "sentiment" and "lunarcrush" not in mcps:
        mcps.append("lunarcrush")
      if "initia" not in mcps:
        mcps.insert(0, "initia")
      intent["mcps"] = list(dict.fromkeys(mcps))
      intent["chain"] = "initia"
      chain_ctx = self._chain_context("initia", network, mcps, strategy)
      user_msg = f"""
  Bot name: {bot_name}
  Chain: {chain} | Network: {network}
  Strategy: {strategy}
  MCP servers to use: {', '.join(mcps)}
  Requires OpenAI sub-agent: {intent.get('requires_openai', False)}
  Original user intent: {prompt}

  {chain_ctx}

  Generate the 3 files now.
  """.strip()

      _log("INFO", f"build_bot: generator_prompt_chars={len(user_msg)} system_chars={len(GENERATOR_SYSTEM)}", trace_id)
      raw = self._llm(
        GENERATOR_SYSTEM,
        user_msg,
        temperature=0.1,
        max_tokens=self.max_tokens,
      )
      parsed = self._parse_response(raw)
      if "files" not in parsed:
        _log("WARN", f"build_bot: parsed response missing files key. keys={list(parsed.keys())}", trace_id)
        parsed["files"] = []

      files = parsed.get("files", [])
      files.insert(1, {"filepath": "src/mcp_bridge.ts", "content": MCP_BRIDGE_CONTENT})
      if strategy_lc in {"yield", "arbitrage", "sentiment", "custom_utility"}:
        files.insert(2, {"filepath": "src/ons_resolver.ts", "content": ONS_RESOLVER_CONTENT})

      wanted = {"package.json", "src/config.ts", "src/index.ts"}
      final_files = [f for f in files if f.get("filepath") in wanted or f.get("filepath") in {"src/mcp_bridge.ts", "src/ons_resolver.ts"}]

      _log("INFO", f"build_bot: final_files={[f.get('filepath') for f in final_files]}", trace_id)

      return {
        "status": "ready",
        "intent": intent,
        "output": {
          "thoughts": parsed.get("thoughts", ""),
          "files": final_files,
        },
      }

    def _chain_context(self, chain: str, network: str, mcps: list, strategy: str) -> str:
        if chain == "initia":
            strategy_lc = str(strategy or "").lower()
            is_yield_sweeper = strategy_lc == "yield"
            is_spread_scanner = strategy_lc == "arbitrage"
            is_custom_utility = strategy_lc == "custom_utility"
            initia_mcp_hints = ""
            if "initia" in mcps:
                initia_mcp_hints += "\nWrite: callMcpTool('initia', 'move_execute', {transaction: {calls: [{address, module, function, type_args, args}, ...]}})"
                initia_mcp_hints += "\nRead:  callMcpTool('initia', 'move_view', {address, module, function, args})"
            if "lunarcrush" in mcps:
                initia_mcp_hints += "\nLunarCrush: callMcpTool('lunarcrush', 'get_coin_details', {coin:'INIT'})"
            return f"""
CHAIN CONTEXT — INITIA ({network})
Network IDs:
  initia-mainnet: interwoven-1
  initia-testnet: initiation-2

Canonical denoms (denom/module-driven, not universal ERC-20 addresses):
  INIT: uinit
  USDC: uusdc (deployment-specific; verify per Minitia)

Required config values:
  INITIA_POOL_A_ADDRESS
  INITIA_POOL_B_ADDRESS
  INITIA_FLASH_POOL_ADDRESS
  INITIA_SWAP_ROUTER_ADDRESS
  USER_WALLET_ADDRESS
  INITIA_BRIDGE_ADDRESS

MCP tool signatures:
{initia_mcp_hints}

Initia read pattern:
  - Use callMcpTool('initia', 'move_view', {{address, module, function, args}}) only for verified modules and functions.
  - For yield sweeper workflows, read 0x1::coin::balance for USER_WALLET_ADDRESS and uusdc.
  - For custom utility workflows, follow the exact user prompt and keep the runtime deterministic.

Initia write pattern:
  - Build one atomic move_execute payload with sequential calls inside transaction.calls when execution is required.
  - No callback contracts, no calldata encoding, no manual signing.
  - MCP signs and submits using x-session-key when provided by INITIA_KEY.
  - INITIA_KEY may be injected at runtime when SESSION_KEY_MODE=true; do not fail process startup if missing.

ONS pattern:
  - If any configured address or USER_WALLET_ADDRESS ends in '.init', resolve it once before first use.
  - Cache the resolved value for the current process or polling cycle.
  - If resolution fails, log a warning and skip the cycle rather than crashing the bot.

Yield sweeper pattern (if strategy is yield):
  - Poll every 15s and scan each configured Minitia endpoint/ID.
  - Balance read call must use move_view on address 0x1/module coin/function balance.
  - Only execute sweep when uusdc balance > 1000000n.
  - Execute with module interwoven_bridge/function sweep_to_l1 and args [balance.toString()].
  - Handle endpoint errors per-cycle without crashing.

Spread scanner pattern (if strategy is read-only arbitrage scanner):
  - Read-only operation with move_view only.
  - Query comparable prices across endpoints, compute spread, subtract bridge fee, log net opportunity.
  - Never call move_execute in scanner mode.

Custom utility pattern (if strategy is custom_utility):
  - Do exactly what the user asked, no arbitrage framing.
  - Prefer a minimal Initia-native implementation.
  - If the prompt does not verify a module or function, do not invent one.
"""
        return ""