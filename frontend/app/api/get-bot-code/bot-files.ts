export interface BotFile {
  filepath: string;
  content: string;
}

export function assembleBotFiles(): BotFile[] {
  return assembleInitiaBotFiles();
}

export function assembleInitiaBotFiles(): BotFile[] {
  return [
    { filepath: "package.json", content: INITIA_PACKAGE_JSON },
    { filepath: "tsconfig.json", content: INITIA_TSCONFIG },
    { filepath: ".env.example", content: INITIA_ENV_EXAMPLE },
    { filepath: "src/config.ts", content: INITIA_CONFIG_TS },
    { filepath: "src/mcp_bridge.ts", content: INITIA_MCP_BRIDGE_TS },
    { filepath: "src/ons_resolver.ts", content: INITIA_ONS_RESOLVER_TS },
    { filepath: "src/index.ts", content: INITIA_INDEX_TS },
  ];
}

const INITIA_PACKAGE_JSON = JSON.stringify(
  {
    name: "initia-bot",
    version: "1.0.0",
    type: "module",
    scripts: {
      start: "tsx src/index.ts",
      dev: "tsx src/index.ts",
    },
    dependencies: {
      dotenv: "^16.4.0",
    },
    devDependencies: {
      typescript: "^5.4.0",
      "@types/node": "^20.0.0",
      tsx: "^4.7.0",
    },
  },
  null,
  2,
);

const INITIA_TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "bundler",
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
    },
    include: ["src/**/*"],
  },
  null,
  2,
);

const INITIA_ENV_EXAMPLE = `MCP_GATEWAY_URL=http://localhost:8000/mcp
SIGNING_RELAY_BASE=
INITIA_RPC_URL=
INITIA_NETWORK=initia-testnet
# USER_WALLET_ADDRESS accepts either a raw address (init1...) or a .init name
USER_WALLET_ADDRESS=yourname.init
INITIA_BRIDGE_ADDRESS=
INITIA_POOL_A_ADDRESS=
INITIA_POOL_B_ADDRESS=
INITIA_FLASH_POOL_ADDRESS=
INITIA_SWAP_ROUTER_ADDRESS=
INITIA_SWAP_ROUTER_MODULE=
INITIA_SWAP_ROUTER_FUNCTION=
INITIA_SWAP_ROUTER_TYPE_ARGS=
INITIA_SWAP_ROUTER_ARGS=$buyEndpoint,$sellEndpoint,$amount
INITIA_USDC_METADATA_ADDRESS=
ONS_REGISTRY_ADDRESS=0x1
SIMULATION_MODE=true
POLL_INTERVAL=15
`;

const INITIA_CONFIG_TS = `import "dotenv/config";

export const config = {
  MCP_GATEWAY_URL: process.env.MCP_GATEWAY_URL ?? (() => { throw new Error("MCP_GATEWAY_URL not set"); })(),
  MCP_GATEWAY_UPSTREAM_URL: process.env.MCP_GATEWAY_UPSTREAM_URL ?? "",
  SIGNING_RELAY_BASE: process.env.SIGNING_RELAY_BASE ?? "",
  SESSION_KEY_MODE: process.env.SESSION_KEY_MODE ?? "false",
  INITIA_RPC_URL: process.env.INITIA_RPC_URL ?? "",
  // ONS: USER_WALLET_ADDRESS may be a .init name (e.g. "adarsh.init")
  // The bot resolves it automatically at startup via the ONS registry.
  ONS_REGISTRY_ADDRESS: process.env.ONS_REGISTRY_ADDRESS ?? "0x1",
  INITIA_NETWORK: process.env.INITIA_NETWORK ?? "initia-testnet",
  USER_WALLET_ADDRESS: process.env.USER_WALLET_ADDRESS ?? "",
  INITIA_BRIDGE_ADDRESS: process.env.INITIA_BRIDGE_ADDRESS ?? "",
  INITIA_POOL_A_ADDRESS: process.env.INITIA_POOL_A_ADDRESS ?? "",
  INITIA_POOL_B_ADDRESS: process.env.INITIA_POOL_B_ADDRESS ?? "",
  INITIA_FLASH_POOL_ADDRESS: process.env.INITIA_FLASH_POOL_ADDRESS ?? "",
  INITIA_SWAP_ROUTER_ADDRESS: process.env.INITIA_SWAP_ROUTER_ADDRESS ?? "",
  INITIA_SWAP_ROUTER_MODULE: process.env.INITIA_SWAP_ROUTER_MODULE ?? process.env.INITIA_SWAP_MODULE ?? "",
  INITIA_SWAP_ROUTER_FUNCTION: process.env.INITIA_SWAP_ROUTER_FUNCTION ?? process.env.INITIA_SWAP_FUNCTION ?? "",
  INITIA_SWAP_ROUTER_TYPE_ARGS: process.env.INITIA_SWAP_ROUTER_TYPE_ARGS ?? process.env.INITIA_SWAP_TYPE_ARGS ?? "",
  INITIA_SWAP_ROUTER_ARGS: process.env.INITIA_SWAP_ROUTER_ARGS ?? process.env.INITIA_SWAP_ARGS ?? "$buyEndpoint,$sellEndpoint,$amount",
  INITIA_USDC_METADATA_ADDRESS: process.env.INITIA_USDC_METADATA_ADDRESS ?? "0x1::coin::uinit",
  SIMULATION_MODE: process.env.SIMULATION_MODE !== "false",
  POLL_MS: Math.max(15000, (parseInt(process.env.POLL_INTERVAL ?? "15", 10) || 15) * 1000),
} as const;

export const CONFIG = config;
`;

const INITIA_MCP_BRIDGE_TS = `import * as configModule from "./config.js";

const CONFIG = ((configModule as Record<string, unknown>).CONFIG ?? (configModule as Record<string, unknown>).config ?? {}) as Record<string, unknown>;
const SIGNING_RELAY_BASE = String(CONFIG.SIGNING_RELAY_BASE ?? process.env.SIGNING_RELAY_BASE ?? "").trim();

function normalizeGatewayBase(raw: string): string {
  const value = String(raw || "").trim().replace(/\/+$/, "");
  if (!value) return "http://localhost:8000/mcp";
  return /\/mcp$/i.test(value) ? value : value + "/mcp";
}

function isProxyGateway(value: string): boolean {
  return /\/api\/mcp-proxy\/?$/i.test(String(value || ""));
}

function deriveRelayBase(): string {
  if (SIGNING_RELAY_BASE) {
    if (isProxyGateway(SIGNING_RELAY_BASE)) return SIGNING_RELAY_BASE.replace(/\/api\/mcp-proxy\/?$/i, "");
    try {
      const relayUrl = new URL(SIGNING_RELAY_BASE);
      return relayUrl.origin;
    } catch {
      return SIGNING_RELAY_BASE;
    }
  }

  const raw = String(CONFIG.MCP_GATEWAY_URL ?? "").trim();
  if (!raw) return "http://localhost:3000";
  if (isProxyGateway(raw)) return raw.replace(/\/api\/mcp-proxy\/?$/i, "");
  try {
    const url = new URL(raw);
    return url.origin;
  } catch {
    return "http://localhost:3000";
  }
}

const RELAY_BASE = deriveRelayBase();

function buildCandidateUrls(base: string, server: string, tool: string): string[] {
  const withMcp = /\/mcp$/i.test(base) ? base : base + "/mcp";
  const withoutMcp = withMcp.replace(/\/mcp$/i, "");
  return [withMcp + "/" + server + "/" + tool, withoutMcp + "/" + server + "/" + tool];
}

async function callGateway(server: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
  const base = normalizeGatewayBase(String(CONFIG.MCP_GATEWAY_URL ?? ""));
  const urls = buildCandidateUrls(base, server, tool);

  let lastError = "unknown error";
  for (const url of urls) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "ngrok-skip-browser-warning": "true",
        "Bypass-Tunnel-Reminder": "true",
        ...(CONFIG.MCP_GATEWAY_UPSTREAM_URL ? { "x-mcp-upstream-url": String(CONFIG.MCP_GATEWAY_UPSTREAM_URL) } : {}),
      },
      body: JSON.stringify(args ?? {}),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      lastError = "MCP call failed: " + res.status + " " + body;
      if (res.status === 404) {
        continue;
      }
      throw new Error(lastError);
    }
    return res.json();
  }
  throw new Error(lastError);
}

const RELAY_POLL_INTERVAL_MS = 600;
const RELAY_TIMEOUT_MS = 90_000;

function isRelayUnavailableError(message: string): boolean {
  const value = String(message || "");
  return /fetch failed|network|econnrefused|enotfound|Endpoint not found|Signing relay submit failed \(404\)|Signing relay poll failed \(404\)/i.test(value);
}

async function callSigningRelay(args: Record<string, unknown>): Promise<unknown> {
  const submitUrl = RELAY_BASE + "/api/signing-relay";
  const submitRes = await fetch(submitUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      network: args.network ?? "initia-testnet",
      moduleAddress: args.address,
      moduleName: args.module,
      functionName: args.function,
      typeArgs: args.type_args ?? [],
      args: args.args ?? [],
    }),
  });

  if (!submitRes.ok) {
    const errText = await submitRes.text().catch(() => "");
    throw new Error("Signing relay submit failed (" + submitRes.status + "): " + errText.slice(0, 200));
  }

  const payload = (await submitRes.json()) as { requestId?: string };
  const requestId = String(payload.requestId ?? "").trim();
  if (!requestId) throw new Error("Signing relay did not return a requestId.");

  const deadline = Date.now() + RELAY_TIMEOUT_MS;
  const resultUrl = RELAY_BASE + "/api/signing-relay/" + requestId;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, RELAY_POLL_INTERVAL_MS));
    const pollRes = await fetch(resultUrl, { headers: { "Cache-Control": "no-store" } });
    if (!pollRes.ok) {
      throw new Error("Signing relay poll failed (" + pollRes.status + ").");
    }

    const data = (await pollRes.json()) as { status: string; result?: { txHash?: string; error?: string } };
    if (data.status === "signed" && data.result?.txHash) {
      return { txHash: data.result.txHash, success: true };
    }
    if (data.status === "failed") {
      throw new Error("Signing failed: " + (data.result?.error ?? "unknown error"));
    }
    if (data.status === "timeout") {
      throw new Error("Signing request timed out. Ensure AutoSign is enabled in the browser.");
    }
  }

  throw new Error("Signing relay timed out after " + (RELAY_TIMEOUT_MS / 1000) + "s. Check that the browser tab is open with AutoSign enabled.");
}

export async function callMcpTool(server: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
  if (server === "initia" && tool === "move_execute") {
    try {
      return await callSigningRelay(args);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (!isRelayUnavailableError(msg)) {
        throw error;
      }
      // Fallback for local WebContainer runs where browser relay origin is unreachable.
      return callGateway(server, tool, args);
    }
  }
  return callGateway(server, tool, args);
}
`;

const INITIA_ONS_RESOLVER_TS = `import { callMcpTool } from "./mcp_bridge.js";
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
            // fall through to raw text parsing
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

  console.log("[ONS] Resolving " + normalized + "...");

  const response = await callMcpTool("initia", "move_view", {
    network: String(CONFIG.INITIA_NETWORK ?? "initia-testnet"),
    address: String(process.env.ONS_REGISTRY_ADDRESS ?? CONFIG.ONS_REGISTRY_ADDRESS ?? "0x1"),
    module: "initia_names",
    function: "resolve",
    type_args: [],
    args: [normalized],
  });

  const resolved = extractAddressFromPayload(response);
  if (!resolved) {
    throw new Error("ONS registry returned no address for '" + normalized + "'");
  }

  console.log("[ONS] Resolved " + normalized + " -> " + resolved);
  _resolvedCache.set(normalized, resolved);
  return resolved;
}
`;

const INITIA_INDEX_TS = `import { CONFIG } from "./config.js";
import { callMcpTool } from "./mcp_bridge.js";
import { resolveAddress } from "./ons_resolver.js";

function log(level: "INFO" | "WARN" | "ERROR", message: string): void {
  console.log("[" + new Date().toISOString() + "] [" + level + "] " + message);
}

let inFlight = false;

async function resolveWalletAddress(): Promise<string> {
  const configured = String(CONFIG.USER_WALLET_ADDRESS ?? "").trim();
  if (!configured) {
    throw new Error("USER_WALLET_ADDRESS is required");
  }
  return resolveAddress(configured);
}

async function runCycle(): Promise<void> {
  const wallet = await resolveWalletAddress();
  const bridge = CONFIG.INITIA_BRIDGE_ADDRESS;
  if (!wallet || !bridge) {
    throw new Error("USER_WALLET_ADDRESS and INITIA_BRIDGE_ADDRESS are required");
  }
  const usdcType = String(CONFIG.INITIA_USDC_METADATA_ADDRESS || "0x1::coin::uinit").trim();

  const view = await callMcpTool("initia", "move_view", {
    network: CONFIG.INITIA_NETWORK,
    address: "0x1",
    module: "coin",
    function: "balance",
    type_args: [usdcType],
    args: [wallet],
  });

  const payload = view as { result?: { content?: Array<{ text?: string }> }; balance?: string; amount?: string };
  const raw = payload.balance ?? payload.amount ?? payload.result?.content?.[0]?.text ?? "0";
  const numeric = String(raw).replace(/[^0-9]/g, "");
  const balance = BigInt(numeric || "0");
  log("INFO", "balance=" + balance.toString());

  if (balance <= 1000000n) return;

  const exec = await callMcpTool("initia", "move_execute", {
    network: CONFIG.INITIA_NETWORK,
    address: bridge,
    module: "interwoven_bridge",
    function: "sweep_to_l1",
    args: [balance.toString()],
  });

  log("INFO", "sweep result=" + JSON.stringify(exec));
}

async function tick(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    await runCycle();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log("ERROR", msg);
  } finally {
    inFlight = false;
    setTimeout(() => { void tick(); }, CONFIG.POLL_MS);
  }
}

void tick();
`;
