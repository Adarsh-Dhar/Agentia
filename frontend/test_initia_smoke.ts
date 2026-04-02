import "dotenv/config";
import { shouldUseInitiaDeterministicFallback } from "./lib/intent/mcp-sanitizer.ts";

type Json = Record<string, unknown>;

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const META_AGENT_URL = process.env.META_AGENT_URL ?? "http://127.0.0.1:8000";

const INITIA_PROMPT =
  process.env.TEST_INITIA_PROMPT ??
  "Build an Initia hot potato arbitrage bot that checks minitia prices and executes via Move";

const INITIA_EXCLUDED_MCPS = [
  "one_inch",
  "webacy",
  "goplus",
  "goat_evm",
  "alchemy",
  "rugcheck",
  "jupiter",
  "nansen",
  "hyperliquid",
  "debridge",
  "lifi",
  "uniswap",
  "chainlink",
];

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function parseJsonText(text: string): Json {
  try {
    return JSON.parse(text) as Json;
  } catch {
    return {};
  }
}

async function fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<{ status: number; text: string; data: Json }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    return { status: res.status, text, data: parseJsonText(text) };
  } finally {
    clearTimeout(timer);
  }
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string").map((item) => item.toLowerCase());
}

function parseMcpTextEnvelope(response: Json): Json {
  const result = response.result as Json | undefined;
  assert(Boolean(result), "missing result envelope");
  assert(result?.isError === false, "expected isError=false");

  const rawContent = result?.content as unknown;
  assert(Array.isArray(rawContent) && rawContent.length > 0, "missing result.content[]");

  const content = rawContent as unknown[];
  const first = content[0] as Json;
  assert(first?.type === "text", "expected result.content[0].type=text");
  assert(typeof first.text === "string", "expected text result content");

  try {
    return JSON.parse(first.text as string) as Json;
  } catch {
    return { text: first.text };
  }
}

async function testInitiaIntentAndFallbackSelection(): Promise<void> {
  const response = await fetchJson(
    `${BASE_URL}/api/classify-intent`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: INITIA_PROMPT }),
    },
    60_000,
  );

  assert(response.status === 200, `classify-intent failed (${response.status}): ${response.text.slice(0, 400)}`);
  const intent = (response.data.intent ?? {}) as Json;
  assert(String(intent.chain ?? "").toLowerCase() === "initia", "intent should classify to chain=initia");
  assert(shouldUseInitiaDeterministicFallback(intent), "intent should use initia deterministic fallback");
  const mcps = asStringArray(intent.mcps);
  for (const excluded of INITIA_EXCLUDED_MCPS) {
    assert(!mcps.includes(excluded), `intent should exclude ${excluded}`);
  }
  assert(mcps.includes("initia"), "intent should include initia MCP");
  console.log("[ok] Initia intent detection + fallback selection smoke test passed");
}

async function testGenericPromptStillPinsInitia(): Promise<void> {
  const response = await fetchJson(
    `${BASE_URL}/api/classify-intent`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Build a flash loan arbitrage bot on base" }),
    },
    60_000,
  );

  assert(response.status === 200, `generic classify-intent failed (${response.status}): ${response.text.slice(0, 400)}`);
  const intent = (response.data.intent ?? {}) as Json;
  assert(String(intent.chain ?? "").toLowerCase() === "initia", "generic prompt should still return chain=initia");
  assert(shouldUseInitiaDeterministicFallback(intent), "generic prompt should still choose initia deterministic fallback");
  console.log("[ok] generic prompt pin-to-initia smoke test passed");
}

async function testInitiaMoveViewContract(): Promise<void> {
  const response = await fetchJson(
    `${META_AGENT_URL}/mcp/initia/move_view`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        network: "initia-mainnet",
        address: "0xinitia_pool_a",
        module: "amm_oracle",
        function: "spot_price",
        args: ["uinit", "uusdc"],
      }),
    },
    10_000,
  );

  assert(response.status === 200, `move_view failed (${response.status}): ${response.text.slice(0, 400)}`);
  const payload = parseMcpTextEnvelope(response.data);

  assert(payload.ok === true, "move_view payload ok should be true");
  assert(payload.tool === "move_view", "move_view payload tool mismatch");
  assert(typeof payload.network === "string" && payload.network.length > 0, "move_view payload missing network");
  assert(typeof payload.address === "string" && payload.address.length > 0, "move_view payload missing address");
  assert(typeof payload.module === "string" && payload.module.length > 0, "move_view payload missing module");
  assert(typeof payload.function === "string" && payload.function.length > 0, "move_view payload missing function");

  const pair = payload.pair as unknown;
  assert(Array.isArray(pair) && pair.length === 2, "move_view payload pair should be [base, quote]");
  assert(
    typeof (pair as unknown[])[0] === "string" && typeof (pair as unknown[])[1] === "string",
    "move_view payload pair entries must be strings",
  );

  assert(typeof payload.price === "string" && /^\d+(?:\.\d+)?$/.test(payload.price), "move_view payload price should be numeric string");
  assert(typeof payload.price_num === "number" && Number.isFinite(payload.price_num), "move_view payload price_num should be finite number");
  assert(typeof payload.decimals === "number", "move_view payload decimals should be number");
  assert(typeof payload.source === "string" && payload.source === "mcp-http-compat", "move_view payload source mismatch");
  assert(typeof payload.timestamp === "string" && Number.isFinite(Date.parse(payload.timestamp)), "move_view payload timestamp invalid");

  console.log("[ok] /mcp/initia/move_view schema contract test passed");
}

async function testInitiaMoveExecuteContract(): Promise<void> {
  const response = await fetchJson(
    `${META_AGENT_URL}/mcp/initia/move_execute`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        network: "initia-mainnet",
        transaction: {
          calls: [
            {
              address: "0xinitia_flash_pool",
              module: "flash_loan",
              function: "borrow",
              type_args: ["uinit", "uusdc"],
              args: ["1000000"],
            },
            {
              address: "0xinitia_dex_router",
              module: "router",
              function: "swap_exact_in",
              type_args: ["uinit", "uusdc"],
              args: ["1000000", "995000"],
            },
            {
              address: "0xinitia_flash_pool",
              module: "flash_loan",
              function: "repay",
              type_args: ["uinit", "uusdc"],
              args: ["1000900"],
            },
          ],
        },
      }),
    },
    10_000,
  );

  assert(response.status === 200, `move_execute failed (${response.status}): ${response.text.slice(0, 400)}`);
  const payload = parseMcpTextEnvelope(response.data);

  assert(payload.ok === true, "move_execute payload ok should be true");
  assert(payload.tool === "move_execute", "move_execute payload tool mismatch");
  assert(payload.status === "executed", "move_execute payload status should be executed");
  assert(typeof payload.tx_hash === "string" && /^0xinitia[0-9a-f]{24}$/.test(payload.tx_hash), "move_execute tx_hash format mismatch");
  assert(typeof payload.network === "string" && payload.network.length > 0, "move_execute payload missing network");
  assert(payload.simulated === true, "move_execute payload simulated should be true");
  assert(typeof payload.source === "string" && payload.source === "mcp-http-compat", "move_execute payload source mismatch");
  assert(typeof payload.timestamp === "string" && Number.isFinite(Date.parse(payload.timestamp)), "move_execute payload timestamp invalid");

  const request = payload.request as Json;
  assert(Boolean(request), "move_execute payload missing request object");
  assert(typeof request.address === "string" && request.address.length > 0, "move_execute request missing address");
  assert(typeof request.module === "string" && request.module.length > 0, "move_execute request missing module");
  assert(typeof request.function === "string" && request.function.length > 0, "move_execute request missing function");
  const transaction = request.transaction as Json;
  assert(Boolean(transaction), "move_execute request missing transaction object");
  assert(Array.isArray(transaction.calls), "move_execute transaction.calls should be array");
  assert(transaction.calls.length === 3, "move_execute transaction.calls should include borrow, swap, repay");

  console.log("[ok] /mcp/initia/move_execute schema contract test passed");
}

async function run(): Promise<void> {
  console.log("\n=== Initia Smoke + MCP Contract Tests ===");
  console.log(`BASE_URL=${BASE_URL}`);
  console.log(`META_AGENT_URL=${META_AGENT_URL}`);

  await testInitiaIntentAndFallbackSelection();
  await testGenericPromptStillPinsInitia();
  await testInitiaMoveViewContract();
  await testInitiaMoveExecuteContract();

  console.log("\n[pass] all Initia smoke checks passed");
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("\n[FAIL]", message);
  process.exit(1);
});
