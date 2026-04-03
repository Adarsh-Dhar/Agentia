import "dotenv/config";

type Json = Record<string, unknown>;

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const META_AGENT_URL = process.env.META_AGENT_URL ?? "http://127.0.0.1:8000";
const PROMPT = process.env.TEST_PROMPT ?? "Solana sentiment bot with strict risk controls";
const MAX_ATTEMPTS = Number(process.env.TEST_MAX_ATTEMPTS ?? "3");
const GENERATE_TIMEOUT_MS = Number(process.env.TEST_GENERATE_TIMEOUT_MS ?? "420000");

const requiredGeneratedFiles = [
  "package.json",
  "tsconfig.json",
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

      assert(typeof generate.data.agentId === "string", "agentId missing in success response");
      assert(files.length > 0, "files list is empty in success response");
      assert(missing.length === 0, `missing required generated files: ${missing.join(", ")}`);
      assert(
        mcpBridgeContent.includes("ngrok-skip-browser-warning") &&
          mcpBridgeContent.includes("Bypass-Tunnel-Reminder"),
        "generated src/mcp_bridge.ts is missing required tunnel bypass headers",
      );

      console.log(`[ok] generate-bot success in ${elapsedSec}s`);
      console.log("agentId:", generate.data.agentId);
      console.log("files:", files.length);
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
