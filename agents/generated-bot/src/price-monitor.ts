// ============================================================
// FILE: src/price-monitor.ts
// DexScreener Price Monitor — detects arbitrage opportunities
// Polls every 3000ms, flags gaps > 0.5%
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
  const url = `${DEXSCREENER_BASE}/tokens/${tokenAddress}`;
  
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
    console.error(`[DexScreener] Failed to fetch ${tokenAddress}: ${err}`);
    return [];
  }
}

/**
 * Searches for pairs by token symbol/name query.
 */
export async function searchPairs(query: string): Promise<PairData[]> {
  const url = `${DEXSCREENER_BASE}/search?q=${encodeURIComponent(query)}`;
  const { data } = await axios.get(url, { timeout: 5000 });
  return data.pairs || [];
}

/**
 * Detects price discrepancies across DEXs for the same token.
 * Returns opportunities where gap exceeds 0.5%.
 */
export function detectArbitrageOpportunities(
  pairs: PairData[],
  minGapPercent: number = 0.5,
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
  pollingIntervalMs: number = 3000
): Promise<void> {
  console.log(`[PriceMonitor] Starting — watching ${watchlist.length} tokens every ${pollingIntervalMs}ms`);

  const monitor = async () => {
    for (const tokenAddress of watchlist) {
      try {
        const pairs = await fetchTokenPairs(tokenAddress);
        const opportunities = detectArbitrageOpportunities(pairs);

        for (const opp of opportunities) {
          console.log(
            `[PriceMonitor] 🎯 ${opp.tokenSymbol}: ${opp.gapPercent}% gap | Est. profit: ${opp.estimatedProfitUSD} | Buy: ${opp.buyOn.dexId} @ ${opp.buyOn.priceUsd} | Sell: ${opp.sellOn.dexId} @ ${opp.sellOn.priceUsd}`
          );
          await onOpportunity(opp);
        }
      } catch (err) {
        console.error(`[PriceMonitor] Error scanning ${tokenAddress}:`, err);
      }
    }
  };

  // Run immediately, then on interval
  await monitor();
  setInterval(monitor, pollingIntervalMs);
}