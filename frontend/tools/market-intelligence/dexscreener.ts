// ============================================================
// dexscreener.ts — DexScreener API: Real-Time Price & Liquidity
// ============================================================
//
// DexScreener is your agent's "eyes" — it tracks real-time price,
// volume, and liquidity data for token pairs across every chain
// and DEX, letting the agent detect arbitrage discrepancies.
//
// Base URL: https://api.dexscreener.com/latest/dex
// Docs:     https://docs.dexscreener.com/api/reference
// Rate limit: ~300 req/min (no key required for standard endpoints)
// ============================================================

import type { ChainId, Address, ArbitrageOpportunity, Token } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Response Types (mirrors DexScreener API schema exactly)
// ─────────────────────────────────────────────────────────────────────────────

export interface DexScreenerPair {
  chainId: string;
  dexId: string;
  url: string;
  pairAddress: Address;
  labels?: string[];            // e.g. ["v3"], ["stable"]
  baseToken: {
    address: Address;
    name: string;
    symbol: string;
  };
  quoteToken: {
    address: Address;
    name: string;
    symbol: string;
  };
  priceNative: string;          // price denominated in quote token
  priceUsd?: string;            // price in USD (may be absent for very new pairs)
  txns: {
    m5:  { buys: number; sells: number };
    h1:  { buys: number; sells: number };
    h6:  { buys: number; sells: number };
    h24: { buys: number; sells: number };
  };
  volume: {
    h24: number;
    h6:  number;
    h1:  number;
    m5:  number;
  };
  priceChange: {
    m5:  number;
    h1:  number;
    h6:  number;
    h24: number;
  };
  liquidity?: {
    usd:   number;
    base:  number;
    quote: number;
  };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;       // unix ms
  info?: {
    imageUrl?: string;
    websites?: Array<{ url: string }>;
    socials?: Array<{ type: string; url: string }>;
  };
}

export interface DexScreenerTokenProfile {
  url: string;
  chainId: string;
  tokenAddress: Address;
  icon?: string;
  header?: string;
  description?: string;
  links?: Array<{ type: string; label: string; url: string }>;
}

export interface DexScreenerBoost {
  url: string;
  chainId: string;
  tokenAddress: Address;
  amount: number;
  totalAmount: number;
  icon?: string;
  description?: string;
  links?: Array<{ type: string; label: string; url: string }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP Client
// ─────────────────────────────────────────────────────────────────────────────

const BASE = "https://api.dexscreener.com";

async function dexFetch<T>(path: string): Promise<T> {
  const url = `${BASE}${path}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`[DexScreener] HTTP ${res.status} for ${path}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Token Lookup
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch all trading pairs for one or more token addresses (max 30 per call).
 * Returns pairs across ALL chains where the token trades.
 *
 * @example
 * const pairs = await getPairsByTokenAddress([
 *   "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
 * ]);
 */
export async function getPairsByTokenAddress(
  tokenAddresses: string | string[]
): Promise<DexScreenerPair[]> {
  const addresses = Array.isArray(tokenAddresses)
    ? tokenAddresses.slice(0, 30).join(",")
    : tokenAddresses;

  const data = await dexFetch<{ schemaVersion: string; pairs: DexScreenerPair[] | null }>(
    `/latest/dex/tokens/${addresses}`
  );
  return data.pairs ?? [];
}

/**
 * Fetch a specific pair by its on-chain pair address.
 * Supports multiple pair addresses (max 30).
 *
 * @example
 * const pairs = await getPairsByAddress("ethereum", [
 *   "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640", // USDC/ETH Uniswap v3
 * ]);
 */
export async function getPairsByAddress(
  chainId: string,
  pairAddresses: string | string[]
): Promise<DexScreenerPair[]> {
  const addresses = Array.isArray(pairAddresses)
    ? pairAddresses.slice(0, 30).join(",")
    : pairAddresses;

  const data = await dexFetch<{ schemaVersion: string; pairs: DexScreenerPair[] | null }>(
    `/latest/dex/pairs/${chainId}/${addresses}`
  );
  return data.pairs ?? [];
}

/**
 * Search for pairs by token symbol, name, or address string.
 *
 * @example
 * const pairs = await searchPairs("PEPE");
 * const pairs = await searchPairs("0xA0b86991");
 */
export async function searchPairs(query: string): Promise<DexScreenerPair[]> {
  const data = await dexFetch<{ schemaVersion: string; pairs: DexScreenerPair[] | null }>(
    `/latest/dex/search?q=${encodeURIComponent(query)}`
  );
  return data.pairs ?? [];
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Token Profiles & Boosts
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch the latest token profiles (recently updated token metadata).
 */
export async function getLatestTokenProfiles(): Promise<DexScreenerTokenProfile[]> {
  return dexFetch<DexScreenerTokenProfile[]>("/token-profiles/latest/v1");
}

/**
 * Fetch the latest tokens with active boosts (paid promotion).
 * Useful as a signal for newly launched tokens.
 */
export async function getLatestBoostedTokens(): Promise<DexScreenerBoost[]> {
  return dexFetch<DexScreenerBoost[]>("/token-boosts/latest/v1");
}

/**
 * Fetch the top tokens by boost amount (most promoted).
 */
export async function getTopBoostedTokens(): Promise<DexScreenerBoost[]> {
  return dexFetch<DexScreenerBoost[]>("/token-boosts/top/v1");
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Pair Filters & Sorting Utilities
// ─────────────────────────────────────────────────────────────────────────────

export interface PairFilterOptions {
  /** Only include pairs on this chain */
  chainId?: string;
  /** Only include pairs on this DEX */
  dexId?: string;
  /** Minimum liquidity in USD */
  minLiquidityUsd?: number;
  /** Minimum 24h volume in USD */
  minVolume24h?: number;
  /** Exclude pairs with price impact warnings */
  excludeLowLiquidity?: boolean;
  /** Only include pairs created after this unix timestamp */
  createdAfter?: number;
}

/**
 * Filter a list of pairs by various criteria.
 *
 * @example
 * const filtered = filterPairs(allPairs, {
 *   chainId: "ethereum",
 *   minLiquidityUsd: 100_000,
 *   minVolume24h: 50_000,
 * });
 */
export function filterPairs(
  pairs: DexScreenerPair[],
  options: PairFilterOptions
): DexScreenerPair[] {
  return pairs.filter((p) => {
    if (options.chainId && p.chainId !== options.chainId) return false;
    if (options.dexId && p.dexId !== options.dexId) return false;
    if (options.minLiquidityUsd && (p.liquidity?.usd ?? 0) < options.minLiquidityUsd) return false;
    if (options.minVolume24h && p.volume.h24 < options.minVolume24h) return false;
    if (options.createdAfter && (p.pairCreatedAt ?? 0) < options.createdAfter) return false;
    return true;
  });
}

export type PairSortKey = "liquidityUsd" | "volume24h" | "priceChangeH24" | "txns24h" | "priceUsd";

/**
 * Sort pairs by a given metric (descending by default).
 *
 * @example
 * const byLiquidity = sortPairs(pairs, "liquidityUsd");
 */
export function sortPairs(
  pairs: DexScreenerPair[],
  by: PairSortKey,
  direction: "asc" | "desc" = "desc"
): DexScreenerPair[] {
  const getValue = (p: DexScreenerPair): number => {
    switch (by) {
      case "liquidityUsd":   return p.liquidity?.usd ?? 0;
      case "volume24h":      return p.volume.h24;
      case "priceChangeH24": return p.priceChange.h24;
      case "txns24h":        return p.txns.h24.buys + p.txns.h24.sells;
      case "priceUsd":       return parseFloat(p.priceUsd ?? "0");
    }
  };

  return [...pairs].sort((a, b) => {
    const diff = getValue(b) - getValue(a);
    return direction === "desc" ? diff : -diff;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Arbitrage Opportunity Detection
// ─────────────────────────────────────────────────────────────────────────────

export interface ArbScanOptions {
  /** Minimum price spread % between the cheapest and most expensive DEX */
  minSpreadPct?: number;
  /** Minimum per-pair liquidity in USD (both sides must meet this) */
  minLiquidityUsd?: number;
  /** Minimum 24h volume on both pairs */
  minVolume24h?: number;
  /** Maximum price impact allowed (filters out illiquid pairs) */
  maxPriceImpactPct?: number;
}

/**
 * Detect cross-DEX arbitrage opportunities for a token by finding
 * pairs where the same token trades at materially different prices.
 *
 * Returns opportunities sorted by spread (largest first).
 *
 * @example
 * const opps = await scanForArbitrageOpportunities(
 *   "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
 *   { minSpreadPct: 0.3, minLiquidityUsd: 100_000 }
 * );
 */
export async function scanForArbitrageOpportunities(
  tokenAddress: string,
  options: ArbScanOptions = {}
): Promise<ArbitrageOpportunity[]> {
  const {
    minSpreadPct = 0.2,
    minLiquidityUsd = 50_000,
    minVolume24h = 10_000,
  } = options;

  const allPairs = await getPairsByTokenAddress(tokenAddress);

  // Keep only liquid, active pairs
  const liquidPairs = filterPairs(allPairs, { minLiquidityUsd, minVolume24h });

  console.log(
    `[DexScreener] ${allPairs.length} pairs found → ${liquidPairs.length} pass liquidity filter`
  );

  const opportunities: ArbitrageOpportunity[] = [];

  for (let i = 0; i < liquidPairs.length; i++) {
    for (let j = i + 1; j < liquidPairs.length; j++) {
      const pairA = liquidPairs[i];
      const pairB = liquidPairs[j];

      // Only compare pairs that share the same base token
      const sameBase =
        pairA.baseToken.address.toLowerCase() === pairB.baseToken.address.toLowerCase();
      if (!sameBase) continue;

      const priceA = parseFloat(pairA.priceUsd ?? "0");
      const priceB = parseFloat(pairB.priceUsd ?? "0");
      if (!priceA || !priceB) continue;

      const [cheapPair, expPair, buyPrice, sellPrice] =
        priceA <= priceB
          ? [pairA, pairB, priceA, priceB]
          : [pairB, pairA, priceB, priceA];

      const spreadPct = ((sellPrice - buyPrice) / buyPrice) * 100;

      if (spreadPct < minSpreadPct) continue;

      // Capital limited by the smaller side's liquidity
      const maxCapitalUsd =
        Math.min(cheapPair.liquidity?.usd ?? 0, expPair.liquidity?.usd ?? 0) * 0.05;

      const estimatedProfitUsd = maxCapitalUsd * (spreadPct / 100);

      opportunities.push({
        tokenIn: {
          address: cheapPair.quoteToken.address,
          symbol:  cheapPair.quoteToken.symbol,
          decimals: 6,
          chainId: cheapPair.chainId as unknown as ChainId,
        },
        tokenOut: {
          address: cheapPair.baseToken.address,
          symbol:  cheapPair.baseToken.symbol,
          decimals: 18,
          chainId: cheapPair.chainId as unknown as ChainId,
        },
        buyDex:              cheapPair.dexId,
        sellDex:             expPair.dexId,
        buyPrice,
        sellPrice,
        spreadPct,
        estimatedProfitUsd,
        requiredCapitalUsd:  maxCapitalUsd,
        chainId:             cheapPair.chainId as unknown as ChainId,
        detectedAt:          Date.now(),
      });
    }
  }

  opportunities.sort((a, b) => b.spreadPct - a.spreadPct);
  console.log(
    `[DexScreener] ${opportunities.length} arb opportunities found (min spread: ${minSpreadPct}%)`
  );
  return opportunities;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Price Monitor (Polling)
// ─────────────────────────────────────────────────────────────────────────────

export interface PriceAlert {
  pair: DexScreenerPair;
  type: "PRICE_UP" | "PRICE_DOWN" | "VOLUME_SPIKE" | "LIQUIDITY_DROP" | "ARB_DETECTED";
  value: number;
  threshold: number;
  timestamp: number;
}

export interface PriceMonitorOptions {
  /** How often to poll in milliseconds (min 5000 to respect rate limits) */
  intervalMs?: number;
  /** Emit alert if price moves more than this % between polls */
  priceChangeThresholdPct?: number;
  /** Emit alert if volume spikes more than this multiplier vs rolling avg */
  volumeSpikeMultiplier?: number;
  /** Callback fired on each refresh with updated pairs */
  onUpdate?: (pairs: DexScreenerPair[]) => void;
  /** Callback fired when an alert condition is triggered */
  onAlert?: (alert: PriceAlert) => void;
}

/**
 * Start a polling price monitor for a set of token addresses.
 * Fires callbacks on price moves, volume spikes, and arb signals.
 *
 * Returns a stop() function to cancel monitoring.
 *
 * @example
 * const stop = startPriceMonitor(
 *   ["0xA0b86991..."],
 *   {
 *     intervalMs: 10_000,
 *     priceChangeThresholdPct: 0.5,
 *     onAlert: alert => console.log("ALERT:", alert.type, alert.pair.pairAddress),
 *   }
 * );
 * setTimeout(stop, 60_000 * 5); // run for 5 minutes
 */
export function startPriceMonitor(
  tokenAddresses: string[],
  options: PriceMonitorOptions = {}
): () => void {
  const {
    intervalMs = 10_000,
    priceChangeThresholdPct = 0.5,
    volumeSpikeMultiplier = 3,
    onUpdate,
    onAlert,
  } = options;

  const effectiveInterval = Math.max(intervalMs, 5_000);
  let active = true;
  const prevPrices = new Map<string, number>();   // pairAddress → last price
  const prevVolumes = new Map<string, number[]>(); // pairAddress → rolling volume samples

  const tick = async () => {
    if (!active) return;

    try {
      const pairs = await getPairsByTokenAddress(tokenAddresses);

      onUpdate?.(pairs);

      for (const pair of pairs) {
        const currentPrice = parseFloat(pair.priceUsd ?? "0");
        const prevPrice = prevPrices.get(pair.pairAddress);

        // Price change alert
        if (prevPrice && onAlert) {
          const changePct = Math.abs((currentPrice - prevPrice) / prevPrice) * 100;
          if (changePct >= priceChangeThresholdPct) {
            onAlert({
              pair,
              type: currentPrice > prevPrice ? "PRICE_UP" : "PRICE_DOWN",
              value: changePct,
              threshold: priceChangeThresholdPct,
              timestamp: Date.now(),
            });
          }
        }

        prevPrices.set(pair.pairAddress, currentPrice);

        // Volume spike alert
        if (onAlert) {
          const samples = prevVolumes.get(pair.pairAddress) ?? [];
          samples.push(pair.volume.m5);
          if (samples.length > 6) samples.shift(); // keep 30-min rolling window
          prevVolumes.set(pair.pairAddress, samples);

          if (samples.length >= 3) {
            const avg = samples.slice(0, -1).reduce((s, v) => s + v, 0) / (samples.length - 1);
            if (avg > 0 && pair.volume.m5 > avg * volumeSpikeMultiplier) {
              onAlert({
                pair,
                type: "VOLUME_SPIKE",
                value: pair.volume.m5 / avg,
                threshold: volumeSpikeMultiplier,
                timestamp: Date.now(),
              });
            }
          }
        }
      }
    } catch (err) {
      console.warn(`[DexScreener:Monitor] Tick error:`, (err as Error).message);
    }

    if (active) setTimeout(tick, effectiveInterval);
  };

  tick();
  console.log(
    `[DexScreener:Monitor] Started — polling ${tokenAddresses.length} token(s) every ${effectiveInterval / 1000}s`
  );

  return () => {
    active = false;
    console.log(`[DexScreener:Monitor] Stopped`);
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Analytics Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Summarise a token's market presence across all DEXs.
 *
 * @example
 * const summary = await getTokenMarketSummary("0xA0b86991...");
 */
export async function getTokenMarketSummary(tokenAddress: string): Promise<{
  totalLiquidityUsd: number;
  totalVolume24h: number;
  totalPairs: number;
  chains: string[];
  dexes: string[];
  priceRange: { low: number; high: number; spread: number };
  mostLiquidPair: DexScreenerPair | null;
}> {
  const pairs = await getPairsByTokenAddress(tokenAddress);

  if (!pairs.length) {
    return {
      totalLiquidityUsd: 0, totalVolume24h: 0, totalPairs: 0,
      chains: [], dexes: [], priceRange: { low: 0, high: 0, spread: 0 },
      mostLiquidPair: null,
    };
  }

  const prices = pairs.map((p) => parseFloat(p.priceUsd ?? "0")).filter(Boolean);
  const low  = Math.min(...prices);
  const high = Math.max(...prices);

  return {
    totalLiquidityUsd: pairs.reduce((s, p) => s + (p.liquidity?.usd ?? 0), 0),
    totalVolume24h:    pairs.reduce((s, p) => s + p.volume.h24, 0),
    totalPairs:        pairs.length,
    chains:            [...new Set(pairs.map((p) => p.chainId))],
    dexes:             [...new Set(pairs.map((p) => p.dexId))],
    priceRange:        { low, high, spread: high && low ? ((high - low) / low) * 100 : 0 },
    mostLiquidPair:    sortPairs(pairs, "liquidityUsd")[0] ?? null,
  };
}

/**
 * Get recently launched tokens (pairs created within `withinHours`).
 *
 * @example
 * const newTokens = await getNewlyLaunchedTokens("ethereum", 2);
 */
export async function getNewlyLaunchedTokens(
  chain: string,
  withinHours = 24,
  minLiquidityUsd = 10_000
): Promise<DexScreenerPair[]> {
  const cutoffMs = Date.now() - withinHours * 60 * 60 * 1000;
  const boosts = await getLatestBoostedTokens();

  const addresses = boosts.filter((b) => b.chainId === chain).map((b) => b.tokenAddress);
  if (!addresses.length) return [];

  const pairs = await getPairsByTokenAddress(addresses);

  return filterPairs(pairs, {
    chainId:       chain,
    minLiquidityUsd,
    createdAfter:  cutoffMs,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Example Usage
// ─────────────────────────────────────────────────────────────────────────────

/*
import {
  getPairsByTokenAddress,
  searchPairs,
  scanForArbitrageOpportunities,
  startPriceMonitor,
  getTokenMarketSummary,
} from "./dexscreener";

// 1. Get all pairs for USDC
const pairs = await getPairsByTokenAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
console.log(pairs.length, "pairs found");

// 2. Scan for arb opportunities
const opps = await scanForArbitrageOpportunities(
  "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  { minSpreadPct: 0.3, minLiquidityUsd: 100_000 }
);
opps.forEach(o =>
  console.log(`${o.buyDex} → ${o.sellDex}: ${o.spreadPct.toFixed(3)}% spread, ~$${o.estimatedProfitUsd.toFixed(2)} profit`)
);

// 3. Market summary
const summary = await getTokenMarketSummary("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
console.log(summary);

// 4. Live price monitor with alerts
const stop = startPriceMonitor(
  ["0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"],
  {
    intervalMs: 8_000,
    priceChangeThresholdPct: 0.4,
    onAlert: (alert) => {
      console.log(`[ALERT] ${alert.type} on ${alert.pair.dexId}: ${alert.value.toFixed(2)}%`);
    },
    onUpdate: (pairs) => {
      console.log(`[Update] ${pairs.length} pairs refreshed at`, new Date().toISOString());
    },
  }
);
setTimeout(stop, 5 * 60 * 1000); // monitor for 5 minutes
*/