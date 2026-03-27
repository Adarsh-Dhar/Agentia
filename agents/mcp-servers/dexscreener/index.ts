/**
 * MCP Server: dexscreener
 *
 * FIXED: Now actually calls the DexScreener API and returns live data.
 * Previous version only returned code strings — useless for an autonomous agent.
 *
 * Tools:
 *   scan_live_opportunities  – fetch real arbitrage gaps right now
 *   get_token_pairs          – get all DEX pairs for a token address
 *   get_pair_detail          – fetch one specific pair by address
 *   get_price_monitor_code   – (kept) code template for continuous monitoring
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "dexscreener-mcp", version: "2.0.0" },
  { capabilities: { tools: {} } }
);

// ─── Types ────────────────────────────────────────────────────────────────────

interface DexPair {
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
  url: string;
}

interface ArbitrageOpportunity {
  tokenSymbol: string;
  tokenAddress: string;
  buyOn: { dex: string; chain: string; priceUsd: string; pair: string };
  sellOn: { dex: string; chain: string; priceUsd: string; pair: string };
  gapPercent: number;
  grossProfitUsd: number;
  netProfitEstimateUsd: number; // after ~0.9% fees (Aave + 2×DEX)
  viable: boolean;
}

// ─── Shared fetch helper (no axios needed — use native fetch in Node 18+) ──────

async function dexFetch(url: string): Promise<any> {
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`DexScreener HTTP ${res.status}: ${url}`);
  return res.json();
}

// ─── Core logic ───────────────────────────────────────────────────────────────

async function fetchPairsForToken(tokenAddress: string): Promise<DexPair[]> {
  const data = await dexFetch(
    `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`
  );
  return (data.pairs ?? []).filter(
    (p: DexPair) =>
      p.liquidity?.usd > 50_000 &&
      p.volume?.h24 > 10_000 &&
      parseFloat(p.priceUsd ?? "0") > 0
  );
}

function detectOpportunities(
  pairs: DexPair[],
  tradeAmountUsd: number,
  minGapPct: number
): ArbitrageOpportunity[] {
  // Group by base-token address (same token, different DEXes)
  const byToken = new Map<string, DexPair[]>();
  for (const p of pairs) {
    const key = `${p.chainId}:${p.baseToken.address.toLowerCase()}`;
    if (!byToken.has(key)) byToken.set(key, []);
    byToken.get(key)!.push(p);
  }

  const opportunities: ArbitrageOpportunity[] = [];

  byToken.forEach((tokenPairs) => {
    if (tokenPairs.length < 2) return;

    const sorted = [...tokenPairs]
      .map((p) => ({ p, price: parseFloat(p.priceUsd) }))
      .filter((x) => x.price > 0)
      .sort((a, b) => a.price - b.price);

    const cheapest = sorted[0];
    const priciest = sorted[sorted.length - 1];
    const gapPct =
      ((priciest.price - cheapest.price) / cheapest.price) * 100;

    if (gapPct < minGapPct) return;

    // Rough profit: gap minus Aave 0.09% + 2× 0.3% DEX fees = 0.69% total fees
    const grossProfit = (tradeAmountUsd * gapPct) / 100;
    const fees = tradeAmountUsd * 0.0069;
    const netProfit = grossProfit - fees;

    opportunities.push({
      tokenSymbol: cheapest.p.baseToken.symbol,
      tokenAddress: cheapest.p.baseToken.address,
      buyOn: {
        dex: cheapest.p.dexId,
        chain: cheapest.p.chainId,
        priceUsd: cheapest.p.priceUsd,
        pair: cheapest.p.pairAddress,
      },
      sellOn: {
        dex: priciest.p.dexId,
        chain: priciest.p.chainId,
        priceUsd: priciest.p.priceUsd,
        pair: priciest.p.pairAddress,
      },
      gapPercent: Math.round(gapPct * 100) / 100,
      grossProfitUsd: Math.round(grossProfit * 100) / 100,
      netProfitEstimateUsd: Math.round(netProfit * 100) / 100,
      viable: netProfit > 0,
    });
  });

  return opportunities.sort((a, b) => b.gapPercent - a.gapPercent);
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS: Tool[] = [
  {
    name: "scan_live_opportunities",
    description:
      "LIVE: Queries DexScreener right now and returns real arbitrage opportunities for the given token addresses. Returns actual price gaps, estimated profit, and which DEXs to use.",
    inputSchema: {
      type: "object",
      properties: {
        tokenAddresses: {
          type: "array",
          items: { type: "string" },
          description: "List of token contract addresses to scan",
        },
        tradeAmountUsd: {
          type: "number",
          description: "Flash loan size in USD (used to estimate profit)",
          default: 10000,
        },
        minGapPercent: {
          type: "number",
          description: "Minimum price gap % to report (default 0.5)",
          default: 0.5,
        },
      },
      required: ["tokenAddresses"],
    },
  },
  {
    name: "get_token_pairs",
    description:
      "LIVE: Returns all active DEX pairs for a token address from DexScreener, filtered for adequate liquidity and volume.",
    inputSchema: {
      type: "object",
      properties: {
        tokenAddress: { type: "string", description: "Token contract address" },
      },
      required: ["tokenAddress"],
    },
  },
  {
    name: "get_pair_detail",
    description:
      "LIVE: Returns full detail for a specific DEX pair by its pair address.",
    inputSchema: {
      type: "object",
      properties: {
        pairAddress: { type: "string" },
        chain: {
          type: "string",
          description: "Chain slug, e.g. ethereum, solana, arbitrum",
          default: "ethereum",
        },
      },
      required: ["pairAddress"],
    },
  },
  {
    name: "get_price_monitor_code",
    description:
      "Returns TypeScript boilerplate for a continuous price-monitoring loop (code template, not live data).",
    inputSchema: {
      type: "object",
      properties: {
        pollingIntervalMs: { type: "number", default: 3000 },
        minGapPercent: { type: "number", default: 0.5 },
      },
    },
  },
];

// ─── Request handlers ─────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    // ── LIVE: scan multiple tokens and return real opportunities ──────────────
    case "scan_live_opportunities": {
      const addresses: string[] = (args as any)?.tokenAddresses ?? [];
      const tradeAmt: number = (args as any)?.tradeAmountUsd ?? 10_000;
      const minGap: number = (args as any)?.minGapPercent ?? 0.5;

      if (addresses.length === 0) {
        return {
          content: [
            { type: "text", text: JSON.stringify({ error: "No token addresses provided" }) },
          ],
        };
      }

      const allPairs: DexPair[] = [];
      const errors: string[] = [];

      for (const addr of addresses) {
        try {
          const pairs = await fetchPairsForToken(addr);
          allPairs.push(...pairs);
        } catch (e: any) {
          errors.push(`${addr}: ${e.message}`);
        }
      }

      const opportunities = detectOpportunities(allPairs, tradeAmt, minGap);

      const result = {
        scannedAt: new Date().toISOString(),
        tokensScanned: addresses.length,
        pairsFound: allPairs.length,
        opportunitiesFound: opportunities.length,
        viable: opportunities.filter((o) => o.viable).length,
        opportunities,
        errors,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    // ── LIVE: get all pairs for one token ─────────────────────────────────────
    case "get_token_pairs": {
      const addr: string = (args as any)?.tokenAddress;
      if (!addr) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "tokenAddress required" }) }],
        };
      }

      try {
        const pairs = await fetchPairsForToken(addr);
        const summary = pairs.map((p) => ({
          dex: p.dexId,
          chain: p.chainId,
          pair: p.pairAddress,
          priceUsd: p.priceUsd,
          liquidityUsd: p.liquidity?.usd,
          volume24h: p.volume?.h24,
          priceChange1h: p.priceChange?.h1,
          url: p.url,
        }));

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ token: addr, pairsFound: pairs.length, pairs: summary }, null, 2),
            },
          ],
        };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: e.message }) }],
        };
      }
    }

    // ── LIVE: get one pair by address ─────────────────────────────────────────
    case "get_pair_detail": {
      const pairAddr: string = (args as any)?.pairAddress;
      const chain: string = (args as any)?.chain ?? "ethereum";

      try {
        const data = await dexFetch(
          `https://api.dexscreener.com/latest/dex/pairs/${chain}/${pairAddr}`
        );
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: e.message }) }],
        };
      }
    }

    // ── Code generator (kept for reference) ──────────────────────────────────
    case "get_price_monitor_code": {
      const interval = (args as any)?.pollingIntervalMs ?? 3000;
      const minGap = (args as any)?.minGapPercent ?? 0.5;

      return {
        content: [
          {
            type: "text",
            text: `
// FILE: src/price-monitor.ts
// Continuous price-monitoring loop using the dexscreener MCP server
// Tip: use the scan_live_opportunities MCP tool directly from your agent instead.

import { McpClient } from "@modelcontextprotocol/sdk/client/index.js";

export async function startPriceMonitor(
  mcpClient: McpClient,
  watchlist: string[],
  onOpportunity: (opp: any) => Promise<void>,
  pollingIntervalMs = ${interval}
) {
  const poll = async () => {
    const result = await mcpClient.callTool("scan_live_opportunities", {
      tokenAddresses: watchlist,
      tradeAmountUsd: 10000,
      minGapPercent: ${minGap},
    });
    const data = JSON.parse((result.content[0] as any).text);
    for (const opp of data.opportunities.filter((o: any) => o.viable)) {
      await onOpportunity(opp);
    }
  };

  await poll();
  setInterval(poll, pollingIntervalMs);
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

// ─── Start ────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[dexscreener-mcp v2] Server running — live API mode");
}

main().catch(console.error);