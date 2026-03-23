// ============================================================
// market-intelligence.ts — DexScreener | QuickNode | Alchemy
// ============================================================
//
// "Eyes" and "ears" for the arbitrage agent:
//   • DexScreener — real-time price & liquidity across all DEXs
//   • QuickNode / Alchemy — WebSocket RPCs for mempool & block feeds
//
// Docs:
//   DexScreener: https://docs.dexscreener.com/api/reference
//   QuickNode:   https://www.quicknode.com/docs/
//   Alchemy:     https://docs.alchemy.com/
// ============================================================

import type { ChainId, Address, ArbitrageOpportunity, Token } from "../types";

// ── DexScreener ───────────────────────────────────────────────────────────────

const DEXSCREENER_API = "https://api.dexscreener.com/latest/dex";

export interface DexScreenerPair {
  chainId: string;
  dexId: string;
  pairAddress: Address;
  baseToken:  { address: Address; symbol: string; name: string };
  quoteToken: { address: Address; symbol: string; name: string };
  priceNative: string;
  priceUsd?: string;
  txns: { h24: { buys: number; sells: number } };
  volume: { h24: number; h6: number; h1: number; m5: number };
  priceChange: { h24: number; h6: number; h1: number; m5: number };
  liquidity?: { usd: number; base: number; quote: number };
  fdv?: number;
  pairCreatedAt?: number;
  labels?: string[];
}

export interface DexScreenerSearchResult {
  schemaVersion: string;
  pairs: DexScreenerPair[];
}

/**
 * Fetch real-time pair data for a token address from DexScreener.
 *
 * @example
 * const pairs = await dexScreenerGetPairs("ethereum", "0xA0b86991...");
 */
export async function dexScreenerGetPairs(
  chain: string,  // e.g. "ethereum", "solana", "polygon"
  tokenAddress: string
): Promise<DexScreenerPair[]> {
  const url = `${DEXSCREENER_API}/tokens/${tokenAddress}`;
  console.log(`[DexScreener] Fetching pairs for ${tokenAddress} on ${chain}`);

  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`[DexScreener] API error: ${res.status}`);

  const data: DexScreenerSearchResult = await res.json();
  const filtered = data.pairs?.filter((p) => p.chainId === chain) ?? [];

  console.log(`[DexScreener] Found ${filtered.length} pairs on ${chain}`);
  return filtered;
}

/**
 * Search DexScreener by token symbol or name.
 *
 * @example
 * const results = await dexScreenerSearch("PEPE");
 */
export async function dexScreenerSearch(query: string): Promise<DexScreenerPair[]> {
  const url = `${DEXSCREENER_API}/search?q=${encodeURIComponent(query)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`[DexScreener] Search error: ${res.status}`);
  const data: DexScreenerSearchResult = await res.json();
  return data.pairs ?? [];
}

/**
 * Get pairs for a specific DEX pair address.
 *
 * @example
 * const [pair] = await dexScreenerGetPairsByAddress("ethereum", "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640");
 */
export async function dexScreenerGetPairsByAddress(
  chain: string,
  pairAddresses: string | string[]
): Promise<DexScreenerPair[]> {
  const addresses = Array.isArray(pairAddresses) ? pairAddresses.join(",") : pairAddresses;
  const url = `${DEXSCREENER_API}/pairs/${chain}/${addresses}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`[DexScreener] Pairs error: ${res.status}`);
  const data = await res.json();
  return data.pairs ?? [];
}

/**
 * Detect arbitrage opportunities for a token across DEXs on DexScreener data.
 * Returns all pairs sorted by spread (largest first).
 *
 * @example
 * const opps = await detectArbOpportunities("ethereum", "0xA0b86991...", 0.3);
 */
export async function detectArbOpportunities(
  chain: string,
  tokenAddress: string,
  minSpreadPct = 0.3,
  minLiquidityUsd = 50_000
): Promise<ArbitrageOpportunity[]> {
  const pairs = await dexScreenerGetPairs(chain, tokenAddress);
  const liquidPairs = pairs.filter((p) => (p.liquidity?.usd ?? 0) >= minLiquidityUsd);

  const opportunities: ArbitrageOpportunity[] = [];

  for (let i = 0; i < liquidPairs.length; i++) {
    for (let j = i + 1; j < liquidPairs.length; j++) {
      const a = liquidPairs[i];
      const b = liquidPairs[j];

      const priceA = parseFloat(a.priceUsd ?? "0");
      const priceB = parseFloat(b.priceUsd ?? "0");

      if (!priceA || !priceB) continue;

      const [buyPair, sellPair, buyPrice, sellPrice] =
        priceA < priceB ? [a, b, priceA, priceB] : [b, a, priceB, priceA];

      const spreadPct = ((sellPrice - buyPrice) / buyPrice) * 100;

      if (spreadPct >= minSpreadPct) {
        opportunities.push({
          tokenIn:  { address: buyPair.quoteToken.address, symbol: buyPair.quoteToken.symbol, decimals: 6, chainId: chain as unknown as ChainId },
          tokenOut: { address: buyPair.baseToken.address,  symbol: buyPair.baseToken.symbol,  decimals: 18, chainId: chain as unknown as ChainId },
          buyDex:   buyPair.dexId,
          sellDex:  sellPair.dexId,
          buyPrice,
          sellPrice,
          spreadPct,
          estimatedProfitUsd: 0, // fill in with flash loan math
          requiredCapitalUsd: Math.min(buyPair.liquidity?.usd ?? 0, sellPair.liquidity?.usd ?? 0) * 0.1,
          chainId:  chain as unknown as ChainId,
          detectedAt: Date.now(),
        });
      }
    }
  }

  opportunities.sort((a, b) => b.spreadPct - a.spreadPct);
  console.log(`[DexScreener] Found ${opportunities.length} arb opportunities (min spread: ${minSpreadPct}%)`);
  return opportunities;
}

// ── WebSocket RPC — QuickNode ─────────────────────────────────────────────────

export interface RpcSubscription {
  id: string;
  unsubscribe: () => void;
}

export interface NewBlockEvent {
  number: bigint;
  hash: string;
  timestamp: number;
  baseFeePerGas?: bigint;
  transactions: string[];
}

export interface PendingTxEvent {
  hash: string;
  from: string;
  to?: string;
  value: bigint;
  gasPrice?: bigint;
  maxFeePerGas?: bigint;
  input: string;
}

/**
 * Connect to a QuickNode (or any EVM) WebSocket endpoint.
 * Returns helpers to subscribe to new blocks and pending txs.
 *
 * @example
 * const rpc = new EvmWebSocketRpc("wss://your-node.quiknode.pro/TOKEN/");
 * const sub = rpc.subscribeNewBlocks(block => console.log("New block:", block.number));
 */
export class EvmWebSocketRpc {
  private wsUrl: string;
  private ws: WebSocket | null = null;
  private listeners: Map<string, (data: unknown) => void> = new Map();
  private subscriptionMap: Map<string, string> = new Map(); // subscriptionId → listenerKey
  private idCounter = 1;

  constructor(wsUrl: string) {
    this.wsUrl = wsUrl;
  }

  /** Open the WebSocket connection. */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);

      this.ws.onopen = () => {
        console.log(`[QuickNode/Alchemy] WebSocket connected: ${this.wsUrl.split("/")[2]}`);
        resolve();
      };

      this.ws.onerror = (err) => {
        console.error(`[QuickNode/Alchemy] WebSocket error:`, err);
        reject(err);
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string);
          if (msg.method === "eth_subscription" && msg.params) {
            const subId = msg.params.subscription;
            const key = this.subscriptionMap.get(subId);
            if (key) this.listeners.get(key)?.(msg.params.result);
          } else if (msg.id && this.listeners.has(`result_${msg.id}`)) {
            this.listeners.get(`result_${msg.id}`)?.(msg.result);
          }
        } catch {
          // ignore parse errors
        }
      };

      this.ws.onclose = () => {
        console.warn(`[QuickNode/Alchemy] WebSocket disconnected`);
      };
    });
  }

  /** Subscribe to new block headers. */
  subscribeNewBlocks(handler: (block: NewBlockEvent) => void): RpcSubscription {
    return this._subscribe("newHeads", (raw: unknown) => {
      const b = raw as Record<string, unknown>;
      handler({
        number:       BigInt(b.number as string),
        hash:         b.hash as string,
        timestamp:    parseInt(b.timestamp as string, 16),
        baseFeePerGas: b.baseFeePerGas ? BigInt(b.baseFeePerGas as string) : undefined,
        transactions: (b.transactions as string[]) ?? [],
      });
    });
  }

  /** Subscribe to pending transactions (mempool). */
  subscribePendingTransactions(handler: (tx: PendingTxEvent) => void): RpcSubscription {
    return this._subscribe("newPendingTransactions", (raw: unknown) => {
      const t = raw as Record<string, unknown>;
      handler({
        hash:          t.hash as string,
        from:          t.from as string,
        to:            t.to as string | undefined,
        value:         BigInt((t.value as string) ?? "0"),
        gasPrice:      t.gasPrice ? BigInt(t.gasPrice as string) : undefined,
        maxFeePerGas:  t.maxFeePerGas ? BigInt(t.maxFeePerGas as string) : undefined,
        input:         (t.input as string) ?? "0x",
      });
    });
  }

  /** Subscribe to logs matching a filter. */
  subscribeLogs(
    filter: { address?: Address | Address[]; topics?: (string | null)[] },
    handler: (log: unknown) => void
  ): RpcSubscription {
    return this._subscribe("logs", handler, filter);
  }

  private _subscribe(
    subscriptionType: string,
    handler: (data: unknown) => void,
    params?: unknown
  ): RpcSubscription {
    const id = this.idCounter++;
    const listenerKey = `sub_${subscriptionType}_${id}`;
    this.listeners.set(listenerKey, handler);

    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "eth_subscribe",
      params: params ? [subscriptionType, params] : [subscriptionType],
    });

    this.ws?.send(payload);

    // Wait for the subscription ID response
    this.listeners.set(`result_${id}`, (subId: unknown) => {
      if (typeof subId === "string") {
        this.subscriptionMap.set(subId, listenerKey);
        console.log(`[RPC] Subscribed to "${subscriptionType}" → id: ${subId}`);
      }
    });

    return {
      id: listenerKey,
      unsubscribe: () => {
        this.listeners.delete(listenerKey);
        console.log(`[RPC] Unsubscribed from "${subscriptionType}"`);
      },
    };
  }

  /** Disconnect the WebSocket. */
  disconnect(): void {
    this.ws?.close();
    this.ws = null;
  }
}

// ── Alchemy Enhanced API ──────────────────────────────────────────────────────

const ALCHEMY_BASE = (network: string, apiKey: string) =>
  `https://${network}.g.alchemy.com/v2/${apiKey}`;

/**
 * Fetch token balances for an address using Alchemy's enhanced API.
 *
 * @example
 * const balances = await alchemyGetTokenBalances("eth-mainnet", "YOUR_KEY", "0xYourAddress");
 */
export async function alchemyGetTokenBalances(
  network: string,
  apiKey: string,
  address: Address,
  contractAddresses?: Address[]
): Promise<Array<{ contractAddress: Address; tokenBalance: string }>> {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "alchemy_getTokenBalances",
    params: contractAddresses ? [address, contractAddresses] : [address, "DEFAULT_TOKENS"],
  };

  const res = await fetch(ALCHEMY_BASE(network, apiKey), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`[Alchemy] Token balances error: ${res.status}`);
  const data = await res.json();
  return data.result?.tokenBalances ?? [];
}

/**
 * Simulate a transaction using Alchemy's alchemy_simulateAssetChanges.
 * Critical for verifying arb profit before committing.
 *
 * @example
 * const simulation = await alchemySimulateTx("eth-mainnet", "YOUR_KEY", {
 *   from: "0xYourAddress",
 *   to:   "0xUniswapRouter",
 *   data: "0xABCDEF...",
 *   value: "0x0",
 * });
 */
export async function alchemySimulateTx(
  network: string,
  apiKey: string,
  tx: { from: Address; to: Address; data: string; value?: string }
): Promise<{
  changes: Array<{ assetType: string; from: string; to: string; rawAmount: string; symbol?: string }>;
  error?: string;
}> {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "alchemy_simulateAssetChanges",
    params: [{ from: tx.from, to: tx.to, data: tx.data, value: tx.value ?? "0x0" }],
  };

  const res = await fetch(ALCHEMY_BASE(network, apiKey), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`[Alchemy] Simulation error: ${res.status}`);
  const data = await res.json();
  return { changes: data.result?.changes ?? [], error: data.error?.message };
}

// ── Block Watcher (polling fallback for HTTP RPCs) ────────────────────────────

/**
 * Poll for new blocks via standard JSON-RPC (fallback when WebSocket is unavailable).
 *
 * @example
 * const stop = pollNewBlocks("https://mainnet.infura.io/v3/YOUR_KEY", block => {
 *   console.log("Block", block.number);
 * }, 2000);
 * setTimeout(stop, 60_000);
 */
export function pollNewBlocks(
  httpRpcUrl: string,
  handler: (block: NewBlockEvent) => void,
  intervalMs = 2000
): () => void {
  let lastBlock = -1n;
  let active = true;

  const poll = async () => {
    if (!active) return;

    try {
      const res = await fetch(httpRpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: ["latest", false] }),
      });
      const data = await res.json();
      const b = data.result;
      if (!b) return;

      const num = BigInt(b.number);
      if (num > lastBlock) {
        lastBlock = num;
        handler({
          number: num,
          hash: b.hash,
          timestamp: parseInt(b.timestamp, 16),
          baseFeePerGas: b.baseFeePerGas ? BigInt(b.baseFeePerGas) : undefined,
          transactions: b.transactions ?? [],
        });
      }
    } catch (e) {
      console.warn(`[BlockPoller] Error:`, e);
    }

    if (active) setTimeout(poll, intervalMs);
  };

  poll();
  return () => { active = false; };
}

// ── Example Usage ─────────────────────────────────────────────────────────────

/*
// DexScreener: detect arb opportunities
const opps = await detectArbOpportunities("ethereum", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", 0.2);
opps.forEach(o => console.log(`${o.buyDex} → ${o.sellDex}: ${o.spreadPct.toFixed(2)}% spread`));

// QuickNode WebSocket
const rpc = new EvmWebSocketRpc("wss://your-node.quiknode.pro/TOKEN/");
await rpc.connect();
rpc.subscribeNewBlocks(block => {
  console.log(`New block: #${block.number} (base fee: ${block.baseFeePerGas})`);
});

// Alchemy simulation
const sim = await alchemySimulateTx("eth-mainnet", "YOUR_KEY", {
  from: "0xYourAddress",
  to:   "0xUniswapRouter",
  data: "0x...",
});
console.log(sim.changes);
*/