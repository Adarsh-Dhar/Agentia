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

export function shouldUseInitiaDeterministicFallback(): boolean {
  return true;
}

export function sanitizeIntentMcpLists(intent: Record<string, unknown>): Record<string, unknown> {
  const strategy = normalizeMcp(intent.strategy);
  const botType = normalizeMcp(intent.bot_type) ?? "";
  const botName = normalizeMcp(intent.bot_name) ?? "";
  const botLabel = `${botType} ${botName}`;
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
    .filter((name) => INITIA_ALLOWED_MCPS.has(name))
    .filter((name, index, arr) => arr.indexOf(name) === index);

  const isYieldSweeper = strategy === "yield" || /sweep|consolidator|consolidate/.test(botLabel);
  const isSpreadScanner = /spread/.test(botLabel) && /scanner/.test(botLabel);
  const isCustomUtility = strategy === "custom_utility" || /custom utility|custom bot|custom workflow/.test(botLabel);

  if (isYieldSweeper || isSpreadScanner || isCustomUtility || strategy === "arbitrage") {
    const initiaOnly = nextMcps.filter((name) => name === "initia");
    nextMcps.length = 0;
    nextMcps.push(...initiaOnly);
  }

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
  };
}