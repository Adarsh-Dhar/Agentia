const INITIA_EXCLUDED_MCPS = new Set([
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
]);

const INITIA_ALLOWED_MCPS = new Set(["initia", "lunarcrush", "pyth"]);
const INITIA_NETWORKS = new Set(["initia-mainnet", "initia-testnet"]);

function defaultInitiaNetwork(): string {
  const envNetwork = normalizeMcp(process.env.DEFAULT_INITIA_NETWORK ?? process.env.INITIA_NETWORK);
  return envNetwork && INITIA_NETWORKS.has(envNetwork) ? envNetwork : "initia-testnet";
}

function normalizeMcp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function asMcpList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const normalized = normalizeMcp(item);
    if (!normalized) continue;
    if (!out.includes(normalized)) out.push(normalized);
  }
  return out;
}

function isInitiaChain(chain: unknown): boolean {
  return typeof chain === "string" && chain.trim().toLowerCase() === "initia";
}

export function shouldUseInitiaDeterministicFallback(intent: Record<string, unknown>): boolean {
  return true;
}

export function sanitizeIntentMcpLists(intent: Record<string, unknown>): Record<string, unknown> {
  const strategy = normalizeMcp(intent.strategy);
  const requestedChain = normalizeMcp(intent.chain);
  const requestedNetwork = normalizeMcp(intent.network);
  const required = asMcpList(intent.required_mcps);
  const mcps = asMcpList(intent.mcps);
  const network = requestedChain === "initia" && requestedNetwork && INITIA_NETWORKS.has(requestedNetwork)
    ? requestedNetwork
    : defaultInitiaNetwork();

  const nextRequired = ["initia"];

  const seedMcps = [...required, ...mcps];
  const nextMcps = seedMcps
    .filter((name) => !INITIA_EXCLUDED_MCPS.has(name))
    .filter((name) => INITIA_ALLOWED_MCPS.has(name));

  if (!nextMcps.includes("initia")) nextMcps.unshift("initia");
  if (strategy === "sentiment" && !nextMcps.includes("lunarcrush")) {
    nextMcps.push("lunarcrush");
  }

  return {
    ...intent,
    chain: "initia",
    network,
    required_mcps: nextRequired,
    mcps: nextMcps,
    requires_solana_wallet: false,
  };
}