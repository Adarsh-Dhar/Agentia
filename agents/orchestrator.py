"""
orchestrator.py

Simplified Meta-Agent.
Input:  plain-English prompt like "create a sentiment analysis initia bot"
Output: exactly 2 generated files plus the hardcoded MCP bridge:
          1. package.json
          2. src/index.ts

Pipeline:
  1. classify_intent()   → detect chain / strategy / MCPs from prompt
  2. build_bot_logic()   → generate 2 files following Listen→Quantify→Corroborate→Protect→Act
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
import "dotenv/config";

const MCP_GATEWAY_URL = process.env.MCP_GATEWAY_URL ?? "";
const INITIA_KEY = process.env.INITIA_KEY ?? "";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeGatewayBase(raw: string): string {
  return String(raw || "").trim().replace(/\\/+$/, "");
}

function buildCandidateUrls(base: string, server: string, tool: string): string[] {
  const withMcp = /\/mcp$/i.test(base) ? base : base + "/mcp";
  const withoutMcp = withMcp.replace(/\/mcp$/i, "");
  return [
    `${withMcp}/${server}/${tool}`,
    `${withoutMcp}/${server}/${tool}`,
  ];
}

export async function callMcpTool(
  server: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const initiaKey = INITIA_KEY.trim();
  if (server === "initia" && tool === "move_execute" && !initiaKey) {
    throw new Error("INITIA_KEY missing for move_execute. Enable AutoSign session key mode and relaunch.");
  }
  const rawGateway = normalizeGatewayBase(MCP_GATEWAY_URL);
  if (!rawGateway) {
    throw new Error("MCP_GATEWAY_URL is missing in config/environment");
  }
  const urls = buildCandidateUrls(rawGateway, server, tool);
  const attempts = 3;
  let lastError = "unknown error";

  console.log(`[MCP] → Calling ${server}/${tool}`);
  console.log(`[MCP] Request args: ${JSON.stringify(args)}`);

  for (let attempt = 1; attempt <= attempts; attempt++) {
    for (const url of urls) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try {
        console.log(`[MCP] URL: ${url} (attempt ${attempt}/${attempts})`);
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(initiaKey ? { "x-session-key": initiaKey } : {}),
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
          if (response.status === 404) {
            continue;
          }
          break;
        }
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
      } catch (err) {
        clearTimeout(timeout);
        lastError = err instanceof Error ? err.message : String(err);
        console.error(`[MCP] ✗ Error: ${lastError}`);
      }
    }
    if (attempt < attempts) await sleep(400 * attempt);
  }
  throw new Error(`MCP ${server}/${tool} unavailable after retries: ${lastError}`);
}
'''

ONS_RESOLVER_CONTENT = '''\
import { callMcpTool } from "./mcp_bridge.js";
import "dotenv/config";

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
    network: String(process.env.INITIA_NETWORK ?? "initia-testnet"),
    address: String(process.env.ONS_REGISTRY_ADDRESS ?? "0x1"),
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
  "strategy": "arbitrage" | "sentiment" | "sniping" | "dca" | "grid" | "whale_mirror" | "yield" | "yield_sweeper" | "cross_chain_liquidation" | "cross_chain_arbitrage" | "cross_chain_sweep" | "custom_utility" | "perp" | "unknown",
  "mcps": ["list of MCP server names to use"],
  "bot_name": "human-readable name",
  "requires_openai": true | false
}

Rules:
- ALWAYS set chain:"initia"
- Classification precedence: if prompt includes yield sweeper semantics (yield sweeper, auto-consolidator, consolidate idle funds, sweep_to_l1, bridge back to l1), classify as strategy:"yield" first.
- cross-chain liquidation / liquidation sniper / omni-chain liquidator -> strategy:"cross_chain_liquidation", mcps:["initia"]
- flash-bridge arbitrage / cross-chain arb / spatial arbitrage -> strategy:"cross_chain_arbitrage", mcps:["initia"]
- omni-chain yield / yield nomad / auto-compounder -> strategy:"cross_chain_sweep", mcps:["initia"]
- If prompt asks for a custom utility bot, classify as strategy:"custom_utility" and do not fall back to arbitrage.
- sentiment / social -> mcps remain initia-only, requires_openai:true
- yield sweeper / auto-consolidator / sweep idle funds -> strategy:"yield", mcps:["initia"], requires_openai:false
- custom utility / custom bot / custom workflow -> strategy:"custom_utility", mcps:["initia"], requires_openai:false
  - spread scanner / arbitrage / profitable spread bots -> strategy:"arbitrage", mcps:["initia"], requires_openai:false
- arbitrage / flash loan / hot potato -> strategy:"arbitrage", mcps:["initia"]
- for initia arbitrage and yield workflows, do NOT auto-add pyth
- for initia bots, allowed MCPs are: initia (required)
- default network: initia-testnet
"""


def _normalize_strategy(strategy: str) -> str:
  value = str(strategy or "").strip().lower()
  if value in {"yield_sweeper", "yield-sweeper"}:
    return "yield"
  if value in {"cross_chain_liquidation", "cross-chain-liquidation", "liquidation_sniper", "omni_chain_liquidator", "omni-chain-liquidator"}:
    return "cross_chain_liquidation"
  if value in {"cross_chain_arbitrage", "cross-chain-arbitrage", "flash_bridge", "flash-bridge", "spatial_arb", "spatial-arb"}:
    return "cross_chain_arbitrage"
  if value in {"cross_chain_sweep", "cross-chain-sweep", "yield_nomad", "yield-nomad", "auto_compounder", "auto-compounder"}:
    return "cross_chain_sweep"
  if value in {"custom", "custom_utility", "custom-utility", "utility", "custombot", "custom_bot"}:
    return "custom_utility"
  if value in {"spread_scanner", "scanner", "read_only_arbitrage", "read-only-arbitrage"}:
    return "arbitrage"
  return value or "unknown"


def _normalize_generated_filepath(raw_path: object) -> str:
  path = str(raw_path or "").strip().replace("\\", "/")
  if not path:
    return ""
  path = re.sub(r"^[./]+", "", path)
  if not path:
    return ""

  lower_path = path.lower()
  base = lower_path.split("/")[-1]

  alias_map = {
    "package.json": "package.json",
    "index.ts": "src/index.ts",
    "main.ts": "src/index.ts",
    "mcp_bridge.ts": "src/mcp_bridge.ts",
    "ons_resolver.ts": "src/ons_resolver.ts",
  }

  if lower_path in alias_map:
    return alias_map[lower_path]
  if base in alias_map:
    return alias_map[base]

  return path


def _sanitize_mcp_bridge_content(content: object) -> str:
  text = str(content or "")
  # Guard against malformed slash regex emitted by broken escaping.
  text = text.replace('replace(//+$/, "")', 'replace(/\\/+$/, "")')
  text = text.replace("replace(//+$/, '')", "replace(/\\/+$/, '')")
  return text


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
    {"filepath": "src/index.ts", "content": "..."}
  ]
}

You MUST generate EXACTLY these 2 files in this order:
  1. package.json
  2. src/index.ts

The file src/mcp_bridge.ts is provided separately - do NOT generate it.
Import it in src/index.ts as: import { callMcpTool } from "./mcp_bridge.js".
Do NOT generate src/config.ts. Read all values directly from process.env inside src/index.ts.

CORE CONSTRAINTS:
1. TypeScript + Node.js only. Never Python.
2. package.json must use "type": "module" and "start": "tsx src/index.ts".
3. Keep dependencies minimal: dotenv, tsx, typescript, @types/node. Add only what the requested bot truly needs.
4. src/index.ts must read all secrets directly from process.env using dotenv. Add `import "dotenv/config";` at the top. INITIA_KEY can be empty at startup when SESSION_KEY_MODE=true and must be validated lazily at first write. Do NOT create a config.ts file.
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
15. Always resolve addresses and runtime inputs from process.env and fail fast when required values are missing.
16. If USER_WALLET_ADDRESS or any configured address ends in '.init', resolve it before first use and cache the resolved address.
17. Never mention wrapper SDK tooling in generated code/comments/dependency lists.
18. Use direct MCP payloads for Initia reads/writes (address/module/function/type_args/args) without middleware abstractions.

INITIA RULES:
- Chain is always Initia.
- All reads must use callMcpTool('initia', 'move_view', {...}).
  - All writes must use callMcpTool('initia', 'move_execute', {network, address, module, function, type_args, args}).
- Do not use external chain SDK signing flows for Initia.
- Do not reference wrapper SDK/plugin layers in code, prose, or dependencies.
- Always forward INITIA_KEY as header x-session-key when present.
- Use the exact MCP server names from the intent's mcps list.
- Never invent module or function names. Only use names explicitly supported by the prompt context.
- Never inject mocked balance/price values into production generation paths.
- CRITICAL: move_view returns a JSON object, not an array. Extract values from payload.result. NEVER use .forEach().

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

4. Cross-chain liquidation sniper (strategy: cross_chain_liquidation):
  - Poll target Minitia lending positions every 5 seconds.
  - Read health factor via verified move_view calls only.
  - When health factor drops below threshold, bridge USDC from L1 to the target Minitia using the exact opinit_bridge schema from chain context.
  - Execute liquidation, then bridge collateral profits back to L1 with interwoven_bridge::sweep_to_l1.
  - Never invent health factor function names.

5. Flash-bridge spatial arbitrageur (strategy: cross_chain_arbitrage):
  - Read prices on two endpoints using move_view.
  - FOR DEX QUOTES (move_view): MUST use address: '0x1', module: 'dex', function: 'get_amount_out'.
  - For Pool A quote: type_args: ['0x1::coin::uusdc', '0x1::coin::uinit'], args: [process.env.INITIA_POOL_A_ADDRESS, "1000000"].
  - For Pool B quote: type_args: ['0x1::coin::uinit', '0x1::coin::uusdc'], args: [process.env.INITIA_POOL_B_ADDRESS, expected_token_output].
  - Compute net profit. If > 0, execute the configured router with move_execute using process.env.INITIA_SWAP_ROUTER_ADDRESS, process.env.INITIA_SWAP_ROUTER_MODULE, process.env.INITIA_SWAP_ROUTER_FUNCTION and process.env.INITIA_SWAP_ROUTER_ARGS.
  - The generated bot must not stop at logging when net profit is positive.
  - Use a configurable execution amount via process.env.INITIA_EXECUTION_AMOUNT_USDC and pass the buy/sell endpoint addresses into the router args template.
  - ALL type_args MUST be fully qualified (e.g. 0x1::coin::uusdc), NEVER just "uusdc" or "uinit".
  - CRITICAL: move_view returns an object. To get the price, you MUST extract it like this: BigInt((quote as any).result.amount). Never cast the raw result object to BigInt.

6. Omni-chain auto-compounder / yield nomad (strategy: cross_chain_sweep):
  - Read APYs from multiple Minitia pools each cycle.
  - Compare APYs as BigInt percentages and move only when the spread justifies the bridge cost.
  - Unstake, bridge back to L1, bridge to the target Minitia, then restake.
  - Enforce a minimum restake duration to avoid thrashing.

7. Other Initia workflows:
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
        is_cross_chain_liquidation = any(k in prompt_lc for k in ["liquidation sniper", "omni-chain liquidator", "cross-chain liquidation", "cross chain liquidation"])
        is_cross_chain_arbitrage = any(k in prompt_lc for k in ["flash-bridge", "flash bridge", "spatial arbitrage", "cross-chain arb", "cross chain arb"])
        is_cross_chain_sweep = any(k in prompt_lc for k in ["yield nomad", "auto-compounder", "auto compounder", "omni-chain yield", "omni chain yield"])
        is_spread_scanner = any(k in prompt_lc for k in ["spread scanner", "read-only scanner", "read only scanner", "read-only", "market intelligence"])
        is_custom_utility = any(k in prompt_lc for k in ["custom utility", "custom bot", "custom workflow", "intent: custom", "strategy: custom"])

        if is_cross_chain_liquidation:
          intent["strategy"] = "cross_chain_liquidation"
          intent["bot_name"] = "Omni-Chain Liquidation Sniper"
          intent["requires_openai"] = False
        elif is_cross_chain_arbitrage:
          intent["strategy"] = "cross_chain_arbitrage"
          intent["bot_name"] = "Flash-Bridge Spatial Arbitrageur"
          intent["requires_openai"] = False
        elif is_cross_chain_sweep:
          intent["strategy"] = "cross_chain_sweep"
          intent["bot_name"] = "Omni-Chain Yield Nomad"
          intent["requires_openai"] = False
        elif is_yield_sweeper:
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

        allowed = {"initia"}
        cleaned = [m for m in mcps if m in allowed]
        if strategy in {"yield", "arbitrage", "custom_utility", "cross_chain_liquidation", "cross_chain_arbitrage", "cross_chain_sweep"} or "sweep" in bot_name or ("spread" in bot_name and "scanner" in bot_name):
          cleaned = [m for m in cleaned if m == "initia"]
        elif strategy == "sentiment" and "initia" not in cleaned:
          cleaned.append("initia")
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
      allowed = {"initia"}
      mcps = [m for m in mcps if m in allowed]
      if strategy_lc in {"yield", "arbitrage", "custom_utility", "cross_chain_liquidation", "cross_chain_arbitrage", "cross_chain_sweep"} or "sweep" in bot_name_lc or ("spread" in bot_name_lc and "scanner" in bot_name_lc):
        mcps = [m for m in mcps if m == "initia"]
      elif strategy_lc == "sentiment" and "initia" not in mcps:
        mcps.append("initia")
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

  Generate the 2 files now.
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

      raw_files = parsed.get("files", [])
      normalized_files: list[dict] = []
      for raw_file in raw_files if isinstance(raw_files, list) else []:
        if not isinstance(raw_file, dict):
          continue
        normalized_path = _normalize_generated_filepath(raw_file.get("filepath"))
        if not normalized_path:
          continue
        normalized_files.append({
          **raw_file,
          "filepath": normalized_path,
        })

      files = normalized_files
      for file_entry in files:
        if str(file_entry.get("filepath", "")) == "src/mcp_bridge.ts":
          # Always enforce the canonical bridge implementation.
          file_entry["content"] = MCP_BRIDGE_CONTENT
      existing_paths = {str(f.get("filepath", "")) for f in files}

      if "src/mcp_bridge.ts" not in existing_paths:
        files.append({"filepath": "src/mcp_bridge.ts", "content": MCP_BRIDGE_CONTENT})
      if strategy_lc in {"yield", "arbitrage", "sentiment", "custom_utility", "cross_chain_liquidation", "cross_chain_arbitrage", "cross_chain_sweep"} and "src/ons_resolver.ts" not in existing_paths:
        files.append({"filepath": "src/ons_resolver.ts", "content": ONS_RESOLVER_CONTENT})

      # Ensure required runtime files always exist even when model path casing/formatting drifts.
      current_paths = {str(f.get("filepath", "")) for f in files}
      if "package.json" not in current_paths:
        files.append({
          "filepath": "package.json",
          "content": json.dumps(
            {
              "name": "agentia-initia-bot",
              "version": "1.0.0",
              "type": "module",
              "scripts": {"start": "tsx src/index.ts", "dev": "tsx src/index.ts"},
              "dependencies": {"dotenv": "^16.4.0"},
              "devDependencies": {"typescript": "^5.4.0", "@types/node": "^20.0.0", "tsx": "^4.7.0"},
            },
            indent=2,
          ),
        })
      if "src/index.ts" not in current_paths:
        files.append({
          "filepath": "src/index.ts",
          "content": (
            'import "dotenv/config";\n'
            'import { callMcpTool } from "./mcp_bridge.js";\n\n'
            'async function main(): Promise<void> {\n'
            '  const payload = await callMcpTool("initia", "move_view", {\n'
            '    network: String(process.env.INITIA_NETWORK ?? "initia-testnet"),\n'
            '    address: "0x1",\n'
            '    module: "coin",\n'
            '    function: "balance",\n'
            '    type_args: ["0x1::coin::uinit"],\n'
            '    args: [String(process.env.USER_WALLET_ADDRESS ?? "")],\n'
            '  });\n'
            '  console.log(JSON.stringify(payload));\n'
            '}\n\n'
            'void main();\n'
          ),
        })

      wanted = {"package.json", "src/index.ts", "src/mcp_bridge.ts", "src/ons_resolver.ts"}
      final_files = [f for f in files if str(f.get("filepath", "")) in wanted]

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
        if chain != "initia":
            return ""

        strategy_lc = str(strategy or "").lower()
        is_yield_sweeper = strategy_lc == "yield"
        is_spread_scanner = strategy_lc == "arbitrage"
        is_custom_utility = strategy_lc == "custom_utility"
        is_cross_chain = strategy_lc in {"cross_chain_liquidation", "cross_chain_arbitrage", "cross_chain_sweep"}

        initia_mcp_hints = ""
        if "initia" in mcps:
          initia_mcp_hints += "\nWrite: callMcpTool('initia', 'move_execute', {network: '<network_id>', address, module, function, type_args, args})"
          initia_mcp_hints += "\nRead:  callMcpTool('initia', 'move_view', {network: '<network_id>', address, module, function, type_args, args})"
          initia_mcp_hints += "\nRule: include type_args explicitly for every move_view call (use [] when none)."
          initia_mcp_hints += "\nRule: The response from move_view is a JSON Object (e.g. { result: ... }), NEVER an array. Do NOT use .forEach() on the MCP response payload."
          initia_mcp_hints += "\nRule: include type_args explicitly for every move_view call (use [] when none)."
          initia_mcp_hints += "\nRule: never wrap move_execute in a custom transaction object; issue one move_execute call per on-chain action."
        if is_yield_sweeper or is_cross_chain:
            initia_mcp_hints += """
\nInterwoven Bridge schema (use these EXACT values — do not invent module names):
  Module address: 0x1
  Module name: opinit_bridge  (for L1 → Minitia) or interwoven_bridge (for Minitia → L1)
  Function: initiate_token_deposit
  Args: [destination_chain_id: string, recipient: string, amount: string, denom: string]
  Example destination_chain_ids:
    "minimove-1"  → MiniMove Minitia
    "miniwasm-1"  → MiniWasm Minitia
    "initiation-2" → L1 Testnet (when bridging back)

  To sweep FROM a Minitia back to L1, use:
    Module: interwoven_bridge / Function: sweep_to_l1 / Args: [amount: string]

CRITICAL RULE FOR CROSS-CHAIN BOTS: If the user asks you to build a bot that bridges
funds between Initia L1 and Minitias, your generated TypeScript MUST use the above
schema in the move_execute payload. Never invent module names. Use destination_chain_id
to route between L1 and Minitias."""

        return f"""
CHAIN CONTEXT — INITIA ({network})
Network IDs:
  initia-mainnet: interwoven-1
  initia-testnet: initiation-2

Canonical denoms (denom/module-driven, not universal ERC-20 addresses):
  INIT: 0x1::coin::uinit (MUST be fully qualified)
  USDC: 0x1::coin::uusdc (MUST be fully qualified)

Required config values:
  INITIA_POOL_A_ADDRESS
  INITIA_POOL_B_ADDRESS
  INITIA_FLASH_POOL_ADDRESS
  INITIA_SWAP_ROUTER_ADDRESS
  INITIA_SWAP_ROUTER_MODULE
  INITIA_SWAP_ROUTER_FUNCTION
  INITIA_SWAP_ROUTER_ARGS
  INITIA_EXECUTION_AMOUNT_USDC
  USER_WALLET_ADDRESS
  INITIA_BRIDGE_ADDRESS

MCP tool signatures:
{initia_mcp_hints}

SDK policy:
  - MCP transport is the integration boundary for generated bots.
  - Never add wrapper SDK/plugin dependencies or wrapper examples.

Initia read pattern:
  - Use callMcpTool('initia', 'move_view', {{address, module, function, type_args, args}}) only for verified modules and functions.
  - Always include type_args in move_view payloads (set type_args: [] when no generic args exist).
  - For yield sweeper workflows, read 0x1::coin::balance with type_args ['uusdc'] and args [USER_WALLET_ADDRESS].
  - For custom utility workflows, follow the exact user prompt and keep the runtime deterministic.

Initia write pattern:
  - Do not wrap multiple actions inside a custom transaction.calls object. Execute each on-chain action with its own move_execute call in order.
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

Spread scanner pattern (if strategy is arbitrage / spread scanner):
  - Read quotes with move_view, compute spread, and execute when net profit is positive.
  - Never treat raw wallet balances as market price; use a verified DEX/oracle view function for quote/price data.
  - Configure INITIA_PRICE_VIEW_TYPE_ARGS with required Move type tags for the quote function (comma-separated string in env/config).
  - Do not issue quote move_view calls with empty type_args when the function expects generic coin types.
  - Query comparable prices across endpoints, compute spread, subtract bridge fee, and if net opportunity > 0 call move_execute against the configured router.
  - If no verified router configuration is present, log a warning and skip execution rather than inventing a contract.

Custom utility pattern (if strategy is custom_utility):
  - Do exactly what the user asked, no arbitrage framing.
  - Prefer a minimal Initia-native implementation.
  - If the prompt does not verify a module or function, do not invent one.
"""