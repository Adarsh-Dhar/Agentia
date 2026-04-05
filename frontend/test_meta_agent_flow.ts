import "dotenv/config";

type Json = Record<string, unknown>;

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const META_AGENT_URL = process.env.META_AGENT_URL ?? "http://127.0.0.1:8000";
const PROMPT =
  process.env.TEST_PROMPT ??
  "Write a flash-bridge spatial arbitrage bot in TypeScript that compares two Initia Minitia pools, bridges through L1 using opinit_bridge::initiate_token_deposit, and sells the spread once it is profitable";
const MAX_ATTEMPTS = Number(process.env.TEST_MAX_ATTEMPTS ?? "3");
const GENERATE_TIMEOUT_MS = Number(process.env.TEST_GENERATE_TIMEOUT_MS ?? "420000");

const requiredGeneratedFiles = [
  "package.json",
  "src/config.ts",
  "src/mcp_bridge.ts",
  "src/index.ts",
];

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function fetchJsonWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ status: number; data: Json; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    let data: Json = {};
    try {
      data = text ? (JSON.parse(text) as Json) : {};
    } catch {
      data = { raw: text };
    }
    return { status: res.status, data, text };
  } finally {
    clearTimeout(timer);
  }
}

async function run(): Promise<void> {
  console.log("\n=== Meta-Agent End-to-End Debug Test ===");
  console.log(`BASE_URL=${BASE_URL}`);
  console.log(`META_AGENT_URL=${META_AGENT_URL}`);
  console.log(`PROMPT=${PROMPT}`);
  console.log(`MAX_ATTEMPTS=${MAX_ATTEMPTS}\n`);

  const health = await fetchJsonWithTimeout(
    `${META_AGENT_URL}/health`,
    { method: "GET", headers: { accept: "application/json" } },
    3000,
  );

  assert(
    health.status === 200,
    `Meta-Agent health failed (${health.status}): ${health.text.slice(0, 300)}`,
  );

  console.log("[ok] Meta-Agent health:", health.data);

  const classify = await fetchJsonWithTimeout(
    `${BASE_URL}/api/classify-intent`,
    {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ prompt: PROMPT }),
    },
    60000,
  );

  assert(
    classify.status === 200,
    `classify-intent failed (${classify.status}): ${classify.text.slice(0, 600)}`,
  );

  const expandedPrompt = String((classify.data.expandedPrompt as string) ?? PROMPT);
  assert(expandedPrompt.trim().length > 0, "expandedPrompt is empty");
  console.log(`[ok] classify-intent returned expanded prompt (${expandedPrompt.length} chars)`);

  let lastError = "";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const started = Date.now();
    console.log(`\n[attempt ${attempt}/${MAX_ATTEMPTS}] calling /api/generate-bot ...`);

    const generate = await fetchJsonWithTimeout(
      `${BASE_URL}/api/generate-bot`,
      {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          prompt: PROMPT,
          expandedPrompt,
          envConfig: {},
        }),
      },
      GENERATE_TIMEOUT_MS,
    );

    const elapsedSec = ((Date.now() - started) / 1000).toFixed(1);

    if (generate.status === 200) {
      const files = Array.isArray(generate.data.files) ? (generate.data.files as Array<Json>) : [];
      const filepaths = new Set(
        files
          .map((f) => f.filepath)
          .filter((p): p is string => typeof p === "string"),
      );

      const missing = requiredGeneratedFiles.filter((p) => !filepaths.has(p));
      const mcpBridge = files.find((f) => f.filepath === "src/mcp_bridge.ts");
      const mcpBridgeContent = typeof mcpBridge?.content === "string" ? mcpBridge.content : "";
      const indexFile = files.find((f) => f.filepath === "src/index.ts");
      const indexContent = typeof indexFile?.content === "string" ? indexFile.content : "";
      const packageFile = files.find((f) => f.filepath === "package.json");
      const packageContent = typeof packageFile?.content === "string" ? packageFile.content : "";
      const loweredIndex = indexContent.toLowerCase();

      const intent = (generate.data.intent ?? {}) as Json;
      const strategy = String(intent.strategy ?? "").toLowerCase();
      const chain = String(intent.chain ?? "").toLowerCase();

      assert(typeof generate.data.agentId === "string", "agentId missing in success response");
      assert(files.length > 0, "files list is empty in success response");
      assert(missing.length === 0, `missing required generated files: ${missing.join(", ")}`);
      assert(chain === "initia", `expected chain=initia but got ${chain || "<empty>"}`);
      assert(strategy === "cross_chain_arbitrage", `expected strategy=cross_chain_arbitrage but got ${strategy || "<empty>"}`);
      assert(/"type"\s*:\s*"module"/.test(packageContent), "package.json should use ESM modules");
      assert(/"start"\s*:\s*"tsx src\/index\.ts"/.test(packageContent), "package.json should start with tsx src/index.ts");
      assert(/"dotenv"/.test(packageContent), "package.json should include dotenv");
      assert(/"typescript"/.test(packageContent), "package.json should include typescript");
      assert(/"tsx"/.test(packageContent), "package.json should include tsx");
      assert(!packageContent.includes("viem"), "package.json should avoid non-Initia client SDKs for Initia bots");
      assert(!packageContent.includes("web3.js"), "package.json should not include external web3 SDKs for Initia bots");
      assert(!packageContent.includes("bs58"), "package.json should not include bs58 for Initia bots");
      assert(
        mcpBridgeContent.includes("ngrok-skip-browser-warning") &&
          mcpBridgeContent.includes("Bypass-Tunnel-Reminder"),
        "generated src/mcp_bridge.ts is missing required tunnel bypass headers",
      );
      assert(/callmcptool\s*\(\s*["']initia["']\s*,\s*["']move_execute["']/.test(loweredIndex), "generated index must use initia/move_execute");
      assert(loweredIndex.includes('module: "opinit_bridge"') || loweredIndex.includes("module: 'opinit_bridge'"), "generated index must execute opinit_bridge module");
      assert(loweredIndex.includes('function: "initiate_token_deposit"') || loweredIndex.includes("function: 'initiate_token_deposit'"), "generated index must execute initiate_token_deposit function");
      assert(loweredIndex.includes('module: "interwoven_bridge"') || loweredIndex.includes("module: 'interwoven_bridge'"), "generated index must execute interwoven_bridge module");
      assert(loweredIndex.includes('function: "sweep_to_l1"') || loweredIndex.includes("function: 'sweep_to_l1'"), "generated index must execute sweep_to_l1 function");
      assert(!loweredIndex.includes("amm_oracle"), "generated index must not use amm_oracle");
      assert(!/callmcptool\s*\(\s*["']pyth["']/.test(loweredIndex), "generated index must not call pyth for cross-chain arbitrage");
      assert(!loweredIndex.includes("0xinitia_pool_a"), "generated index must not include fake pool placeholder addresses");
      assert(!loweredIndex.includes("0xinitia_pool_b"), "generated index must not include fake pool placeholder addresses");
      assert(!loweredIndex.includes("bypassing oracle fetch"), "generated index must not inject fake oracle bypass logic");
      assert(!loweredIndex.includes("fake pool a price"), "generated index must not inject fake pool prices");

      console.log(`[ok] generate-bot success in ${elapsedSec}s`);
      console.log("agentId:", generate.data.agentId);
      console.log("files:", files.length);
        assert(!loweredIndex.includes("getwalletprivatekey"), "generated index must not try to extract a private key");
        assert(!loweredIndex.includes("callsigningrelay"), "generated index must not inline signing relay logic into src/index.ts");
        assert(!loweredIndex.includes("deriverelaybase"), "generated index must not inline relay base helpers into src/index.ts");
        assert(!loweredIndex.includes("buildcandidateurls"), "generated index must not inline MCP bridge URL helpers into src/index.ts");
      return;
    }

    const msg = typeof generate.data.error === "string" ? generate.data.error : generate.text;
    lastError = `status=${generate.status}; error=${msg.slice(0, 800)}`;
    console.log(`[warn] generation failed in ${elapsedSec}s -> ${lastError}`);
  }

  throw new Error(`All attempts failed. Last error: ${lastError}`);
}

run().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error("\n[FAIL]", message);
  process.exit(1);
});
