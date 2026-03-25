/**
 * MCP Server: dexscreener
 *
 * Provides code generation tools for DexScreener API integration.
 * This is the "eyes" of the arbitrageur — real-time price monitoring
 * across all chains and DEX pairs.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "dexscreener-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

const TOOLS: Tool[] = [
  {
    name: "get_price_monitor_code",
    description:
      "Returns TypeScript code for monitoring token prices across multiple DEXs using DexScreener API. Detects price discrepancies for arbitrage.",
    inputSchema: {
      type: "object",
      properties: {
        pollingIntervalMs: {
          type: "number",
          description: "How often to poll prices in milliseconds (default: 3000)",
        },
        minGapPercent: {
          type: "number",
          description: "Minimum price gap % to flag as opportunity (default: 0.5)",
        },
      },
    },
  },
  {
    name: "get_pair_search_code",
    description:
      "Returns TypeScript code for searching token pair data via DexScreener API.",
    inputSchema: {
      type: "object",
      properties: {
        includeFilters: {
          type: "boolean",
          description: "Include liquidity and volume filters",
        },
      },
    },
  },
  {
    name: "get_multi_chain_scanner",
    description:
      "Returns TypeScript code that scans the same token pair across multiple chains simultaneously to find cross-chain arbitrage opportunities.",
    inputSchema: { type: "object", properties: {} },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "get_price_monitor_code": {
      const interval = (args as any)?.pollingIntervalMs ?? 3000;
      const minGap = (args as any)?.minGapPercent ?? 0.5;

      return {
        content: [
          {
            type: "text",
            text: `
// ============================================================
// FILE: src/price-monitor.ts
// DexScreener Price Monitor — detects arbitrage opportunities
// Polls every ${interval}ms, flags gaps > ${minGap}%
// ============================================================

import axios from "axios";

const DEXSCREENER_BASE = "https://api.dexscreener.com/latest/dex";

export interface PairData {
  pairAddress: string;
  dexId: string;
  chainId: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  priceNative: string;
  priceUsd: string;
  txns: { h24: { buys: number; sells: number } };
  volume: { h24: number };
  liquidity: { usd: number };
  priceChange: { h1: number; h24: number };
}

export interface ArbitrageOpportunity {
  tokenSymbol: string;
  tokenAddress: string;
  buyOn: PairData;    // Lower price — buy here
  sellOn: PairData;   // Higher price — sell here
  gapPercent: number;
  estimatedProfitUSD: number;
  timestamp: number;
}

/**
 * Fetches all pairs for a given token address from DexScreener.
 * Returns pairs sorted by liquidity (highest first).
 */
export async function fetchTokenPairs(tokenAddress: string): Promise<PairData[]> {
  const url = \`\${DEXSCREENER_BASE}/tokens/\${tokenAddress}\`;
  
  try {
    const { data } = await axios.get(url, { timeout: 5000 });
    
    if (!data.pairs || data.pairs.length === 0) return [];

    return data.pairs
      .filter((p: PairData) => 
        p.liquidity?.usd > 50000 &&  // Min $50k liquidity
        p.volume?.h24 > 10000        // Min $10k daily volume
      )
      .sort((a: PairData, b: PairData) => 
        (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)
      );
  } catch (err) {
    console.error(\`[DexScreener] Failed to fetch \${tokenAddress}: \${err}\`);
    return [];
  }
}

/**
 * Searches for pairs by token symbol/name query.
 */
export async function searchPairs(query: string): Promise<PairData[]> {
  const url = \`\${DEXSCREENER_BASE}/search?q=\${encodeURIComponent(query)}\`;
  const { data } = await axios.get(url, { timeout: 5000 });
  return data.pairs || [];
}

/**
 * Detects price discrepancies across DEXs for the same token.
 * Returns opportunities where gap exceeds ${minGap}%.
 */
export function detectArbitrageOpportunities(
  pairs: PairData[],
  minGapPercent: number = ${minGap},
  tradeAmountUSD: number = 10000
): ArbitrageOpportunity[] {
  const opportunities: ArbitrageOpportunity[] = [];

  // Group pairs by base token
  const byToken = new Map<string, PairData[]>();
  pairs.forEach((p) => {
    const key = p.baseToken.address.toLowerCase();
    if (!byToken.has(key)) byToken.set(key, []);
    byToken.get(key)!.push(p);
  });

  // For each token with multiple pairs, find price gaps
  byToken.forEach((tokenPairs) => {
    if (tokenPairs.length < 2) return;

    const prices = tokenPairs
      .map((p) => ({ pair: p, price: parseFloat(p.priceUsd) }))
      .filter((x) => x.price > 0)
      .sort((a, b) => a.price - b.price);

    const cheapest = prices[0];
    const mostExpensive = prices[prices.length - 1];
    
    const gapPercent =
      ((mostExpensive.price - cheapest.price) / cheapest.price) * 100;

    if (gapPercent >= minGapPercent) {
      // Rough profit estimate (before fees and gas)
      const estimatedProfitUSD = (tradeAmountUSD * gapPercent) / 100;

      opportunities.push({
        tokenSymbol: cheapest.pair.baseToken.symbol,
        tokenAddress: cheapest.pair.baseToken.address,
        buyOn: cheapest.pair,
        sellOn: mostExpensive.pair,
        gapPercent: Math.round(gapPercent * 100) / 100,
        estimatedProfitUSD: Math.round(estimatedProfitUSD * 100) / 100,
        timestamp: Date.now(),
      });
    }
  });

  return opportunities.sort((a, b) => b.gapPercent - a.gapPercent);
}

/**
 * Continuous monitoring loop — polls DexScreener and emits opportunities.
 */
export async function startPriceMonitor(
  watchlist: string[],  // Array of token addresses to monitor
  onOpportunity: (opp: ArbitrageOpportunity) => Promise<void>,
  pollingIntervalMs: number = ${interval}
): Promise<void> {
  console.log(\`[PriceMonitor] Starting — watching \${watchlist.length} tokens every \${pollingIntervalMs}ms\`);

  const monitor = async () => {
    for (const tokenAddress of watchlist) {
      try {
        const pairs = await fetchTokenPairs(tokenAddress);
        const opportunities = detectArbitrageOpportunities(pairs);

        for (const opp of opportunities) {
          console.log(
            \`[PriceMonitor] 🎯 \${opp.tokenSymbol}: \${opp.gapPercent}% gap | Est. profit: \${opp.estimatedProfitUSD} | Buy: \${opp.buyOn.dexId} @ \${opp.buyOn.priceUsd} | Sell: \${opp.sellOn.dexId} @ \${opp.sellOn.priceUsd}\`
          );
          await onOpportunity(opp);
        }
      } catch (err) {
        console.error(\`[PriceMonitor] Error scanning \${tokenAddress}:\`, err);
      }
    }
  };

  // Run immediately, then on interval
  await monitor();
  setInterval(monitor, pollingIntervalMs);
}
            `,
          },
        ],
      };
    }

    case "get_pair_search_code": {
      return {
        content: [
          {
            type: "text",
            text: `
// ============================================================
// FILE: src/pair-search.ts
// Finds the best pairs to monitor based on liquidity + volume
// ============================================================

import axios from "axios";

/**
 * Finds top arbitrage candidate tokens by scanning DexScreener
 * for tokens listed on 3+ DEXs with sufficient liquidity.
 */
export async function findArbitrageCandidates(options: {
  chain: string;          // e.g. "ethereum", "solana", "arbitrum"
  minLiquidityUSD: number;
  minVolume24h: number;
  minDexCount: number;    // Token must be on at least this many DEXs
}): Promise<{ address: string; symbol: string; dexCount: number }[]> {
  const { chain, minLiquidityUSD, minVolume24h, minDexCount } = options;

  // Search DexScreener for recently active pairs on this chain
  const url = \`https://api.dexscreener.com/latest/dex/search?q=USDC \${chain}\`;
  const { data } = await axios.get(url);

  const pairsByToken = new Map<string, any[]>();
  
  (data.pairs || [])
    .filter((p: any) => 
      p.chainId === chain &&
      p.liquidity?.usd >= minLiquidityUSD &&
      p.volume?.h24 >= minVolume24h
    )
    .forEach((p: any) => {
      const key = p.baseToken.address;
      if (!pairsByToken.has(key)) pairsByToken.set(key, []);
      pairsByToken.get(key)!.push(p);
    });

  return Array.from(pairsByToken.entries())
    .filter(([, pairs]) => pairs.length >= minDexCount)
    .map(([address, pairs]) => ({
      address,
      symbol: pairs[0].baseToken.symbol,
      dexCount: pairs.length,
    }))
    .sort((a, b) => b.dexCount - a.dexCount);
}
            `,
          },
        ],
      };
    }

    case "get_multi_chain_scanner": {
      return {
        content: [
          {
            type: "text",
            text: `
// ============================================================
// FILE: src/multi-chain-scanner.ts
// Scans the same token across multiple chains simultaneously
// ============================================================

import { fetchTokenPairs } from "./price-monitor.js";

const CHAIN_BRIDGE_TOKENS: Record<string, string[]> = {
  USDC: [
    "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // Ethereum
    "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", // Polygon
    "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8", // Arbitrum
    "0x7F5c764cBc14f9669B88837ca1490cCa17c31607", // Optimism
  ],
};

export async function scanMultiChain(tokenSymbol: string) {
  const addresses = CHAIN_BRIDGE_TOKENS[tokenSymbol];
  if (!addresses) throw new Error(\`No known addresses for \${tokenSymbol}\`);

  const results = await Promise.all(
    addresses.map(async (addr) => {
      const pairs = await fetchTokenPairs(addr);
      return { address: addr, pairs };
    })
  );

  return results;
}
            `,
          },
        ],
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[dexscreener-mcp] Server running on stdio");
}

main().catch(console.error);