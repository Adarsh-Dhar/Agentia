"""
orchestrator.py

Meta-Agent with integrated Planner Agent (Phase 1-4 of the Planner Agent architecture).

Pipeline:
  build_bot(prompt)
    └── orchestrate_bot_creation(chat_history)
          ├── loop:
          │    ├── PlannerAgent.plan(history)        → PlannerState
          │    ├── if needs_mcp_query  → call Initia MCP, inject result, continue
          │    ├── if missing params   → return {status: "clarification_needed"}
          │    └── if ready            → build_bot_logic(enriched_prompt)
          └── build_bot_logic() → 2 files + bridge + ons_resolver
"""

import os
import re
import json
import time
import logging
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeoutError
from pathlib import Path
from typing import Any, Dict, List, Optional

from dotenv import load_dotenv
from azure.ai.inference import ChatCompletionsClient
from azure.ai.inference.models import SystemMessage, UserMessage
from azure.core.credentials import AzureKeyCredential

from planner import (
    PlannerAgent,
    PlannerState,
    InitiaMCPClient,
    summarise_mcp_result,
    extract_resolved_address,
)

_BASE_DIR = Path(__file__).resolve().parent
load_dotenv(_BASE_DIR / ".env")
load_dotenv(_BASE_DIR / ".env.local", override=True)

logger = logging.getLogger(__name__)

LLM_TIMEOUT_SECONDS  = int(os.environ.get("META_AGENT_LLM_TIMEOUT_SECONDS", "240"))
PLANNER_MAX_LOOPS    = int(os.environ.get("PLANNER_MAX_LOOPS", "4"))
PLANNER_ENABLED      = os.environ.get("PLANNER_ENABLED", "true").lower() != "false"


def _log(level: str, message: str, trace_id: Optional[str] = None) -> None:
    prefix = f"[meta-agent] [{level}]"
    if trace_id:
        prefix += f" [{trace_id}]"
    print(f"{prefix} {message}")


# ─── MCP Bridge Template ──────────────────────────────────────────────────────

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
  const withMcp = /\\/mcp$/i.test(base) ? base : base + "/mcp";
  const withoutMcp = withMcp.replace(/\\/mcp$/i, "");
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

export async function getFaBalance(network: string, walletAddress: string, metadataAddress: string): Promise<bigint> {
  try {
    const payload = await callMcpTool("initia", "move_view", {
      network,
      address: "0x1",
      module: "primary_fungible_store",
      function: "balance",
      type_args: ["0x1::fungible_asset::Metadata"],
      args: [walletAddress, metadataAddress]
    });
    const str = JSON.stringify(payload || {});
    const match = str.match(/"(?:balance|amount|value|coin_amount)"\\s*:\\s*"(\\d+)"/) || str.match(/\\[\\s*"(\\d+)"\\s*\\]/);
    return match ? BigInt(match[1]) : 0n;
  } catch (err) {
    console.warn("Failed to get FA balance:", err instanceof Error ? err.message : String(err));
    return 0n;
  }
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
          } catch {}
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
    type_args: [],
    args: [normalized],
  });
  const resolved = extractAddressFromPayload(response);
  if (!resolved) {
    throw new Error(`ONS registry returned no address for \'${normalized}\'`);
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
    "network": "initia-testnet",
  "strategy": "arbitrage" | "sentiment" | "sniping" | "dca" | "grid" | "whale_mirror" | "yield" | "yield_sweeper" | "cross_chain_liquidation" | "cross_chain_arbitrage" | "cross_chain_sweep" | "custom_utility" | "perp" | "unknown",
  "mcps": ["list of MCP server names to use"],
  "bot_name": "human-readable name",
  "requires_openai": true | false
}

Rules:
- ALWAYS set chain:"initia"
- yield sweeper / auto-consolidator / sweep idle funds → strategy:"yield", mcps:["initia"]
- cross-chain liquidation → strategy:"cross_chain_liquidation", mcps:["initia"]
- flash-bridge arbitrage → strategy:"cross_chain_arbitrage", mcps:["initia"]
- omni-chain yield → strategy:"cross_chain_sweep", mcps:["initia"]
- custom utility → strategy:"custom_utility", mcps:["initia"]
- sentiment/social → requires_openai:true
- default network: initia-testnet
"""


def _normalize_strategy(strategy: str) -> str:
    value = str(strategy or "").strip().lower()
    aliases: Dict[str, str] = {
        "yield_sweeper": "yield",
        "yield-sweeper": "yield",
        "cross_chain_liquidation": "cross_chain_liquidation",
        "cross-chain-liquidation": "cross_chain_liquidation",
        "liquidation_sniper": "cross_chain_liquidation",
        "omni_chain_liquidator": "cross_chain_liquidation",
        "cross_chain_arbitrage": "cross_chain_arbitrage",
        "cross-chain-arbitrage": "cross_chain_arbitrage",
        "flash_bridge": "cross_chain_arbitrage",
        "spatial_arb": "cross_chain_arbitrage",
        "cross_chain_sweep": "cross_chain_sweep",
        "cross-chain-sweep": "cross_chain_sweep",
        "yield_nomad": "cross_chain_sweep",
        "auto_compounder": "cross_chain_sweep",
        "custom": "custom_utility",
        "custom_utility": "custom_utility",
        "custom-utility": "custom_utility",
        "spread_scanner": "arbitrage",
    }
    return aliases.get(value, value or "unknown")


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


# ─── Generator System Prompt ─────────────────────────────────────────────────

GENERATOR_SYSTEM = """\
You are an expert Initia bot engineer. Generate production-ready TypeScript for the Agentia platform.

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
"Import tools in src/index.ts as: import { callMcpTool, getFaBalance } from './mcp_bridge.js'.\n"
"Do NOT write your own balance fetching logic. Always use getFaBalance(network, walletAddress, metadataAddress) for token balances."
Do NOT generate src/config.ts. Read all values directly from process.env inside src/index.ts.

CORE CONSTRAINTS:
1. TypeScript + Node.js only.
2. package.json must use "type": "module" and "start": "tsx src/index.ts".
3. Minimal dependencies: dotenv, tsx, typescript, @types/node only.
4. Import "dotenv/config" at top of src/index.ts. Read all secrets from process.env.
5. All money math uses BigInt only — no floats.
6. SIMULATION_MODE defaults to true unless explicitly "false".
7. Use a guarded scheduler (inFlight flag) to prevent concurrent cycles.
8. Add graceful SIGINT/SIGTERM shutdown.
9. Every generated file must be complete — no TODOs or stubs.
10. Never use fake placeholder addresses.
11. INITIA_KEY may be injected at runtime; do not fail at startup if missing.
12. All verified on-chain data injected in the prompt MUST be used directly.

INITIA RULES:
- All reads: callMcpTool('initia', 'move_view', {network, address, module, function, type_args, args})
- All writes: callMcpTool('initia', 'move_execute', {network, address, module, function, type_args, args})
- The response from move_view is a JSON Object. NEVER use .forEach() on it.
- type_args must always be explicitly set ([] when empty).
- Use verified addresses from the enriched prompt — never invent them.
"""


# ─── MetaAgent ────────────────────────────────────────────────────────────────

class MetaAgent:
    def __init__(self):
        token = os.environ.get("GITHUB_TOKEN")
        if not token:
            raise ValueError("GITHUB_TOKEN not set in .env")

        self.client = ChatCompletionsClient(
            endpoint=os.environ.get(
                "GITHUB_MODEL_ENDPOINT", "https://models.inference.ai.azure.com"
            ),
            credential=AzureKeyCredential(token),
        )
        self.model      = os.environ.get("GITHUB_MODEL_NAME", "gpt-4o")
        self.max_tokens = int(os.environ.get("GENERATION_MAX_TOKENS", "2048"))
        self.mcp_client = InitiaMCPClient()
        self.planner    = PlannerAgent(llm_caller=self._llm)

    # ── LLM wrapper ────────────────────────────────────────────────────────────

    def _llm(
        self,
        system: str,
        user: str,
        temperature: float = 0.0,
        max_tokens: int = 512,
        *,
        operation: str = "llm",
        trace_id: Optional[str] = None,
    ) -> str:
        started_at = time.monotonic()

        def _complete():
            return self.client.complete(
                messages=[
                    SystemMessage(content=system),
                    UserMessage(content=user),
                ],
                model=self.model,
                temperature=temperature,
                max_tokens=max_tokens,
            )

        executor = ThreadPoolExecutor(max_workers=1)
        try:
            _log(
                "INFO",
                f"{operation}: model={self.model} system_chars={len(system)} "
                f"user_chars={len(user)} max_tokens={max_tokens} "
                f"timeout={LLM_TIMEOUT_SECONDS}s",
                trace_id,
            )
            future   = executor.submit(_complete)
            response = future.result(timeout=LLM_TIMEOUT_SECONDS)
        except FuturesTimeoutError:
            future.cancel()
            executor.shutdown(wait=False, cancel_futures=True)
            elapsed = round(time.monotonic() - started_at, 2)
            msg = (
                f"LLM timeout after {LLM_TIMEOUT_SECONDS}s for {operation} "
                f"(model={self.model}, elapsed={elapsed}s)"
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

    # ── Planner Orchestration Loop (Phase 4) ───────────────────────────────────

    def orchestrate_bot_creation(
        self,
        chat_history: List[Dict[str, str]],
        trace_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Core Planner → MCP → Code Generator loop.

        Returns one of:
          {"status": "clarification_needed", "question": "<string>"}
          {"status": "ready", "intent": {...}, "output": {"thoughts": ..., "files": [...]}}
          {"status": "error", "message": "<string>"}
        """
        history = list(chat_history)  # local copy we mutate with MCP results

        for loop_idx in range(PLANNER_MAX_LOOPS):
            _log("INFO", f"Planner loop {loop_idx + 1}/{PLANNER_MAX_LOOPS}", trace_id)

            # ── Step 1: Ask Planner LLM ───────────────────────────────────────
            try:
                plan: PlannerState = self.planner.plan(history, trace_id=trace_id)
            except Exception as exc:
                _log("ERROR", f"Planner LLM failed: {exc}", trace_id)
                return {"status": "error", "message": str(exc)}

            _log(
                "INFO",
                f"Plan: strategy={plan.strategy_type} "
                f"ready={plan.is_ready_for_code_generation} "
                f"mcp_needed={plan.verification_step.needs_mcp_query if plan.verification_step else False} "
                f"missing={plan.missing_parameters}",
                trace_id,
            )

            # ── Step 2: On-Chain Verification via Initia MCP ──────────────────
            vs = plan.verification_step
            if vs and vs.needs_mcp_query and vs.mcp_payload:
                purpose = vs.verification_purpose or "on-chain verification"
                _log("INFO", f"Querying Initia MCP for: {purpose}", trace_id)
                _log(
                    "INFO",
                    f"MCP payload: {json.dumps(vs.mcp_payload, separators=(',', ':'))}",
                    trace_id,
                )

                try:
                    mcp_result = self.mcp_client.move_view(vs.mcp_payload)
                    summary    = summarise_mcp_result(purpose, vs.mcp_payload, mcp_result)
                    _log("INFO", f"MCP result summary: {summary}", trace_id)
                except Exception as exc:
                    # MCP unreachable or returned error — inject as warning and continue
                    summary = (
                        f"MCP Verification [{purpose}] FAILED: {exc}. "
                        "The planner should proceed without this verification or ask the user."
                    )
                    _log("WARN", summary, trace_id)

                # Inject MCP result back into history for the next Planner loop
                history.append({"role": "system", "content": summary})
                continue  # Re-run Planner with enriched context

            # ── Step 3: Human-in-the-Loop — missing parameters ────────────────
            if not plan.is_ready_for_code_generation:
                question = (
                    plan.clarifying_question_for_user
                    or "Could you provide more details about the addresses or parameters needed?"
                )
                _log("INFO", f"Clarification needed: {question}", trace_id)
                return {"status": "clarification_needed", "question": question}

            # ── Step 4: Code Generation — all params collected and verified ────
            if plan.is_ready_for_code_generation:
                enriched = plan.enriched_prompt or history[-1].get("content", "")
                _log("INFO", "All parameters verified. Proceeding to code generation.", trace_id)
                return self._generate_code_with_plan(plan, enriched, trace_id)

        # Exhausted loops without resolution
        _log(
            "WARN",
            f"Planner loop limit ({PLANNER_MAX_LOOPS}) reached without resolution.",
            trace_id,
        )
        return {
            "status": "clarification_needed",
            "question": (
                "I need a bit more information to build your bot correctly. "
                "Could you describe the specific pools, tokens, or addresses you want to use?"
            ),
        }

    # ── Code Generation ────────────────────────────────────────────────────────

    def _generate_code_with_plan(
        self,
        plan: PlannerState,
        enriched_prompt: str,
        trace_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Invoke the code generator with a verified, enriched prompt."""
        # Build intent from the plan
        intent = {
            "chain": "initia",
            "network": plan.collected_parameters.get("INITIA_NETWORK", "initia-testnet"),
            "strategy": plan.strategy_type,
            "mcps": ["initia"],
            "bot_name": self._derive_bot_name(plan.strategy_type),
            "requires_openai": plan.strategy_type == "sentiment",
            "collected_parameters": plan.collected_parameters,
        }

        chain_ctx = self._chain_context("initia", intent["network"], ["initia"], plan.strategy_type)
        user_msg  = (
            f"Bot name: {intent['bot_name']}\n"
            f"Chain: initia | Network: {intent['network']}\n"
            f"Strategy: {plan.strategy_type}\n"
            f"MCP servers to use: initia\n"
            f"Verified on-chain parameters:\n"
            + "\n".join(f"  {k}={v}" for k, v in plan.collected_parameters.items())
            + f"\n\nOriginal user intent: {enriched_prompt}\n\n{chain_ctx}\n\nGenerate the 2 files now."
        )

        _log(
            "INFO",
            f"_generate_code_with_plan: generator_prompt_chars={len(user_msg)}",
            trace_id,
        )
        raw    = self._llm(GENERATOR_SYSTEM, user_msg, temperature=0.1, max_tokens=self.max_tokens)
        parsed = self._parse_response(raw)

        if "files" not in parsed:
            parsed["files"] = []

        files          = self._normalize_files(parsed.get("files", []))
        files          = self._inject_bridge_files(files, plan.strategy_type)
        files          = self._ensure_required_files(files)
        wanted         = {"package.json", "src/index.ts", "src/mcp_bridge.ts", "src/ons_resolver.ts"}
        final_files    = [f for f in files if str(f.get("filepath", "")) in wanted]

        _log("INFO", f"Generated files: {[f.get('filepath') for f in final_files]}", trace_id)

        return {
            "status": "ready",
            "intent": intent,
            "output": {
                "thoughts": parsed.get("thoughts", ""),
                "files": final_files,
            },
        }

    # ── Public entry points ────────────────────────────────────────────────────

    def classify_intent(self, prompt: str, trace_id: Optional[str] = None) -> Dict[str, Any]:
        """
        Quick intent classification (used when Planner is disabled or for the
        first turn of a single-shot /create-bot call).
        """
        _log("INFO", f"classify_intent: prompt_chars={len(prompt)}", trace_id)
        raw = self._llm(
            CLASSIFIER_SYSTEM,
            prompt,
            temperature=0.0,
            max_tokens=512,
            operation="classify_intent",
            trace_id=trace_id,
        )
        raw = re.sub(r"```(?:json)?\s*|\s*```", "", raw).strip()
        try:
            intent = json.loads(raw)
        except Exception:
            intent = {
                "chain": "initia",
                "network": "initia-testnet",
                "strategy": "custom_utility",
                "mcps": ["initia"],
                "bot_name": "Custom Utility Initia Bot",
                "requires_openai": False,
            }

        mcps      = [str(m).strip().lower() for m in intent.get("mcps", []) if str(m).strip()]
        strategy  = _normalize_strategy(str(intent.get("strategy", "")))
        intent["chain"]    = "initia"
        intent["strategy"] = strategy
        intent["mcps"]     = ["initia"]

        intent["network"] = "initia-testnet"
        return intent

    def build_bot(self, prompt: str, trace_id: Optional[str] = None) -> Dict[str, Any]:
        """
        Single-shot entry point (used by /create-bot without chat history).
        Wraps the Planner Orchestration Loop with a seeded single-turn history.
        """
        _log("INFO", f"build_bot: prompt_chars={len(prompt)}", trace_id)

        if PLANNER_ENABLED:
            # Seed the orchestration loop with the user prompt as the first turn
            initial_history: List[Dict[str, str]] = [{"role": "user", "content": prompt}]
            result = self.orchestrate_bot_creation(initial_history, trace_id=trace_id)

            if result.get("status") == "ready":
                return result

            if result.get("status") == "clarification_needed":
                # In single-shot mode, fall through to direct generation rather
                # than returning a mid-generation pause (the caller doesn't support it).
                _log(
                    "WARN",
                    "Planner requested clarification in single-shot mode — "
                    "falling back to direct generation.",
                    trace_id,
                )
                # Fall through to legacy direct generation below

        # ── Legacy direct generation (Planner disabled or clarification fallback)
        intent     = self.classify_intent(prompt, trace_id=trace_id)
        strategy   = str(intent.get("strategy", "unknown"))
        network    = str(intent.get("network", "initia-testnet"))
        mcps       = ["initia"]
        bot_name   = str(intent.get("bot_name", "Agentia Initia Bot"))
        chain_ctx  = self._chain_context("initia", network, mcps, strategy)

        user_msg = (
            f"Bot name: {bot_name}\n"
            f"Chain: initia | Network: {network}\n"
            f"Strategy: {strategy}\n"
            f"MCP servers to use: initia\n"
            f"Original user intent: {prompt}\n\n"
            f"{chain_ctx}\n\nGenerate the 2 files now."
        )

        _log(
            "INFO",
            f"build_bot(legacy): generator_prompt_chars={len(user_msg)}",
            trace_id,
        )
        raw    = self._llm(GENERATOR_SYSTEM, user_msg, temperature=0.1, max_tokens=self.max_tokens)
        parsed = self._parse_response(raw)

        if "files" not in parsed:
            parsed["files"] = []

        files       = self._normalize_files(parsed.get("files", []))
        files       = self._inject_bridge_files(files, strategy)
        files       = self._ensure_required_files(files)
        wanted      = {"package.json", "src/index.ts", "src/mcp_bridge.ts", "src/ons_resolver.ts"}
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

    def build_bot_with_history(
        self,
        chat_history: List[Dict[str, str]],
        trace_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Multi-turn entry point used by the /create-bot-chat endpoint.
        Passes the full conversation history through the Planner loop.
        """
        _log("INFO", f"build_bot_with_history: turns={len(chat_history)}", trace_id)
        return self.orchestrate_bot_creation(chat_history, trace_id=trace_id)

    # ── File assembly helpers ──────────────────────────────────────────────────

    def _normalize_files(self, raw_files: Any) -> List[Dict[str, Any]]:
        normalized: List[Dict[str, Any]] = []
        for raw_file in raw_files if isinstance(raw_files, list) else []:
            if not isinstance(raw_file, dict):
                continue
            path = _normalize_generated_filepath(raw_file.get("filepath"))
            if not path:
                continue
            normalized.append({**raw_file, "filepath": path})
        return normalized

    def _inject_bridge_files(
        self, files: List[Dict[str, Any]], strategy: str
    ) -> List[Dict[str, Any]]:
        existing = {str(f.get("filepath", "")) for f in files}

        # Always enforce canonical mcp_bridge
        patched = []
        for f in files:
            if str(f.get("filepath", "")) == "src/mcp_bridge.ts":
                patched.append({**f, "content": MCP_BRIDGE_CONTENT})
            else:
                patched.append(f)
        files = patched

        existing = {str(f.get("filepath", "")) for f in files}

        if "src/mcp_bridge.ts" not in existing:
            files.append({"filepath": "src/mcp_bridge.ts", "content": MCP_BRIDGE_CONTENT})
        if "src/ons_resolver.ts" not in existing:
            files.append({"filepath": "src/ons_resolver.ts", "content": ONS_RESOLVER_CONTENT})
        return files

    def _ensure_required_files(self, files: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        existing = {str(f.get("filepath", "")) for f in files}

        if "package.json" not in existing:
            files.append({
                "filepath": "package.json",
                "content": json.dumps(
                    {
                        "name": "agentia-initia-bot",
                        "version": "1.0.0",
                        "type": "module",
                        "scripts": {"start": "tsx src/index.ts", "dev": "tsx src/index.ts"},
                        "dependencies": {"dotenv": "^16.4.0"},
                        "devDependencies": {
                            "typescript": "^5.4.0",
                            "@types/node": "^20.0.0",
                            "tsx": "^4.7.0",
                        },
                    },
                    indent=2,
                ),
            })

        if "src/index.ts" not in existing:
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
        return files

    # ── Response parsing ───────────────────────────────────────────────────────

    def _parse_response(self, raw: str) -> Dict[str, Any]:
        start = raw.find("{")
        end   = raw.rfind("}")
        if start != -1 and end != -1:
            raw = raw[start : end + 1]
        raw = re.sub(r",\s*([}\]])", r"\1", raw)
        try:
            from json_repair import loads as repair_loads  # type: ignore
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

    # ── Helpers ────────────────────────────────────────────────────────────────

    @staticmethod
    def _derive_bot_name(strategy: str) -> str:
        names = {
            "yield":                  "Cross-Rollup Yield Sweeper",
            "yield_sweeper":          "Cross-Rollup Yield Sweeper",
            "arbitrage":              "Cross-Rollup Spread Scanner",
            "cross_chain_liquidation":"Omni-Chain Liquidation Sniper",
            "cross_chain_arbitrage":  "Flash-Bridge Spatial Arbitrageur",
            "cross_chain_sweep":      "Omni-Chain Yield Nomad",
            "sentiment":              "Initia Sentiment Bot",
            "custom_utility":         "Custom Utility Initia Bot",
        }
        return names.get(strategy, "Agentia Initia Bot")

    def _chain_context(
        self, chain: str, network: str, mcps: List[str], strategy: str
    ) -> str:
        if chain != "initia":
            return ""
        strategy_lc = str(strategy or "").lower()
        is_yield    = strategy_lc in {"yield", "yield_sweeper"}
        is_cross    = "cross_chain" in strategy_lc

        mcp_hints = (
            "\nWrite: callMcpTool('initia', 'move_execute', {network, address, module, function, type_args, args})"
            "\nRead:  callMcpTool('initia', 'move_view', {network, address, module, function, type_args, args})"
            "\nRule:  type_args must always be explicit (use [] when none)."
            "\nRule:  move_view returns a JSON Object — NEVER use .forEach() on it."
            "\nCRITICAL RULE FOR FA BALANCES: To check a token balance via 'primary_fungible_store', the module 'address' MUST strictly be '0x1'. NEVER use the token metadata address as the contract address. Instead, pass the user wallet and the metadata address inside the 'args' array."
        )

        bridge_schema = ""
        if is_yield or is_cross:
            bridge_schema = """
Interwoven Bridge schema:
  Module address: 0x1
  Module: opinit_bridge (L1→Minitia) | interwoven_bridge (Minitia→L1)
  Function: initiate_token_deposit | sweep_to_l1
  Chain IDs: "minimove-1", "miniwasm-1", "initiation-2"
"""

        return f"""
CHAIN CONTEXT — INITIA ({network})
Network IDs: initia-testnet=initiation-2

MCP tool signatures:
{mcp_hints}
{bridge_schema}
Required env vars:
  INITIA_POOL_A_ADDRESS, INITIA_POOL_B_ADDRESS, USER_WALLET_ADDRESS,
  INITIA_BRIDGE_ADDRESS, INITIA_USDC_METADATA_ADDRESS,
    INITIA_SWAP_ROUTER_ADDRESS, INITIA_EXECUTION_AMOUNT_USDC,
    INITIA_MOCK_ORACLE_ADDRESS, INITIA_MOCK_LENDING_ADDRESS,
    INITIA_LIQUIDATION_WATCHLIST

Initia read pattern: move_view only for verified modules/functions.
Initia write pattern: one move_execute per on-chain action — no batching.
"""