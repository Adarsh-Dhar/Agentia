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
INITIA_KEY=replace_me
INITIA_RPC_URL=
INITIA_NETWORK=initia-testnet
# USER_WALLET_ADDRESS accepts either a raw address (init1...) or a .init name
USER_WALLET_ADDRESS=yourname.init
INITIA_BRIDGE_ADDRESS=
INITIA_POOL_A_ADDRESS=
INITIA_POOL_B_ADDRESS=
INITIA_FLASH_POOL_ADDRESS=
INITIA_SWAP_ROUTER_ADDRESS=
ONS_REGISTRY_ADDRESS=0x1
SIMULATION_MODE=true
POLL_INTERVAL=15
`;

const INITIA_CONFIG_TS = `import "dotenv/config";

export const CONFIG = {
  MCP_GATEWAY_URL: process.env.MCP_GATEWAY_URL ?? (() => { throw new Error("MCP_GATEWAY_URL not set"); })(),
  INITIA_KEY: process.env.INITIA_KEY ?? "",
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
  SIMULATION_MODE: process.env.SIMULATION_MODE !== "false",
  POLL_MS: Math.max(15000, (parseInt(process.env.POLL_INTERVAL ?? "15", 10) || 15) * 1000),
} as const;
`;

const INITIA_MCP_BRIDGE_TS = `import { CONFIG } from "./config.js";

function normalizeGatewayBase(raw: string): string {
  const value = String(raw || "").trim().replace(/\\/+$/, "");
  return /\\/mcp$/i.test(value) ? value : value + "/mcp";
}

export async function callMcpTool(server: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
  if (server === "initia" && tool === "move_execute" && !CONFIG.INITIA_KEY) {
    throw new Error("INITIA_KEY missing for move_execute. Enable AutoSign session key mode and relaunch.");
  }
  const base = normalizeGatewayBase(CONFIG.MCP_GATEWAY_URL);
  const url = base + "/" + server + "/" + tool;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(CONFIG.INITIA_KEY ? { "x-session-key": CONFIG.INITIA_KEY } : {}),
      "ngrok-skip-browser-warning": "true",
      "Bypass-Tunnel-Reminder": "true",
    },
    body: JSON.stringify(args ?? {}),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error("MCP call failed: " + res.status + " " + body);
  }
  return res.json();
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

  console.log(`[ONS] Resolving ${normalized}...`);

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

  console.log(`[ONS] Resolved ${normalized} -> ${resolved}`);
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

  const view = await callMcpTool("initia", "move_view", {
    network: CONFIG.INITIA_NETWORK,
    address: "0x1",
    module: "coin",
    function: "balance",
    args: [wallet, "uusdc"],
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
