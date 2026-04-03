import "dotenv/config";
import { shouldUseInitiaDeterministicFallback } from "./lib/intent/mcp-sanitizer.ts";

type Json = Record<string, unknown>;

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const META_AGENT_URL = process.env.META_AGENT_URL ?? "http://127.0.0.1:8000";

const INITIA_PROMPT =
  process.env.TEST_INITIA_PROMPT ??
  "Write a Cross-Rollup Yield Sweeper bot in TypeScript: every 15s read 0x1::coin::balance for USER_WALLET_ADDRESS and call interwoven_bridge::sweep_to_l1 when balance > 1000000n";

const INITIA_ALLOWED_MCPS = new Set(["initia", "lunarcrush", "pyth"]);

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
  assert(String(intent.strategy ?? "").toLowerCase() === "yield", "intent should classify to strategy=yield");
  assert(shouldUseInitiaDeterministicFallback(intent), "intent should use initia deterministic fallback");
  const mcps = asStringArray(intent.mcps);
  for (const mcp of mcps) {
    assert(INITIA_ALLOWED_MCPS.has(mcp), `intent should include only initia-compatible MCPs: found ${mcp}`);
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

async function testCustomUtilityPromptStaysInitiaOnly(): Promise<void> {
  const response = await fetchJson(
    `${BASE_URL}/api/classify-intent`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Intent: custom. Strategy: custom. Build a custom utility bot for Initia that polls balances and executes Move actions." }),
    },
    60_000,
  );

  assert(response.status === 200, `custom classify-intent failed (${response.status}): ${response.text.slice(0, 400)}`);
  const intent = (response.data.intent ?? {}) as Json;
  assert(String(intent.chain ?? "").toLowerCase() === "initia", "custom utility prompt should classify to chain=initia");
  assert(String(intent.strategy ?? "").toLowerCase() === "custom_utility", "custom utility prompt should classify to strategy=custom_utility");
  const mcps = asStringArray(intent.mcps);
  assert(mcps.length === 1 && mcps[0] === "initia", "custom utility prompt should stay initia-only");
  console.log("[ok] custom utility prompt stays initia-only smoke test passed");
}

async function testInitiaMoveViewContract(): Promise<void> {
  const wallet = process.env.USER_WALLET_ADDRESS ?? "0xuser_wallet";
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
        address: "0x1",
        module: "coin",
        function: "balance",
        args: [wallet, "uusdc"],
      }),
    },
    10_000,
  );

  assert(response.status === 200, `move_view failed (${response.status}): ${response.text.slice(0, 400)}`);
  const payload = parseMcpTextEnvelope(response.data);

  assert(payload.ok === true, "move_view payload ok should be true");
  assert(payload.tool === "move_view", "move_view payload tool mismatch");
  assert(typeof payload.network === "string" && payload.network.length > 0, "move_view payload missing network");
  assert(payload.address === "0x1", "move_view payload address should be 0x1");
  assert(payload.module === "coin", "move_view payload module should be coin");
  assert(payload.function === "balance", "move_view payload function should be balance");
  const args = payload.args as unknown;
  assert(Array.isArray(args), "move_view payload args should be an array");
  assert(String((args as unknown[])[1] ?? "") === "uusdc", "move_view payload args should include uusdc denom");
  assert(typeof payload.source === "string" && payload.source === "mcp-http-compat", "move_view payload source mismatch");
  assert(typeof payload.timestamp === "string" && Number.isFinite(Date.parse(payload.timestamp)), "move_view payload timestamp invalid");

  console.log("[ok] /mcp/initia/move_view schema contract test passed");
}

async function testInitiaMoveExecuteContract(): Promise<void> {
  const bridgeAddress = process.env.INITIA_BRIDGE_ADDRESS ?? "0xinitia_bridge";
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
        address: bridgeAddress,
        module: "interwoven_bridge",
        function: "sweep_to_l1",
        args: ["1500000"],
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
  assert(request.module === "interwoven_bridge", "move_execute request module should be interwoven_bridge");
  assert(request.function === "sweep_to_l1", "move_execute request function should be sweep_to_l1");
  const args = request.args as unknown;
  assert(Array.isArray(args) && String((args as unknown[])[0] ?? "") === "1500000", "move_execute args should contain sweep amount");

  console.log("[ok] /mcp/initia/move_execute schema contract test passed");
}

async function run(): Promise<void> {
  console.log("\n=== Initia Smoke + MCP Contract Tests ===");
  console.log(`BASE_URL=${BASE_URL}`);
  console.log(`META_AGENT_URL=${META_AGENT_URL}`);

  await testInitiaIntentAndFallbackSelection();
  await testGenericPromptStillPinsInitia();
  await testCustomUtilityPromptStaysInitiaOnly();
  await testInitiaMoveViewContract();
  await testInitiaMoveExecuteContract();

  console.log("\n[pass] all Initia smoke checks passed");
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("\n[FAIL]", message);
  process.exit(1);
});
