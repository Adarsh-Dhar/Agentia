// ============================================================
// swap-aggregators.ts — Jupiter (Solana) | 1inch | 0x (EVM)
// ============================================================
//
// Swap aggregators find the best price routes across dozens of DEXs.
// This is where the arbitrage "spread profit" is actually captured.
//
// Docs:
//   Jupiter: https://dev.jup.ag/docs/
//   1inch:   https://docs.1inch.io/docs/aggregation-protocol/api/
//   0x:      https://0x.org/docs/api
// ============================================================

import type { ChainId, Address, PriceQuote, Token } from "../types";

// ── Shared Quote Interface ────────────────────────────────────────────────────

export interface SwapQuoteRequest {
  inputMint: string;    // token address / mint
  outputMint: string;
  amount: bigint;       // raw input amount
  slippageBps?: number; // e.g. 50 = 0.5%
  userAddress?: string;
}

export interface SwapQuoteResponse {
  inputMint: string;
  outputMint: string;
  inAmount: bigint;
  outAmount: bigint;
  priceImpactPct: number;
  routePlan: RouteLeg[];
  otherAmountThreshold: bigint; // min received / max sent with slippage
  swapMode: "ExactIn" | "ExactOut";
  fees?: { amount: bigint; mint: string }[];
  /** Raw tx data returned by the aggregator (ready to sign & send) */
  txData?: string;
}

export interface RouteLeg {
  dexLabel: string;
  percent: number;       // % of input routed through this leg
  inputMint: string;
  outputMint: string;
}

// ── Jupiter API (Solana) ──────────────────────────────────────────────────────

const JUPITER_QUOTE_API = "https://quote-api.jup.ag/v6/quote";
const JUPITER_SWAP_API  = "https://quote-api.jup.ag/v6/swap";

/**
 * Fetch a swap quote from Jupiter (Solana).
 *
 * @example
 * const quote = await jupiterGetQuote({
 *   inputMint:  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
 *   outputMint: "So11111111111111111111111111111111111111112",     // SOL
 *   amount:     1_000_000n,  // 1 USDC (6 decimals)
 *   slippageBps: 50,
 * });
 */
export async function jupiterGetQuote(req: SwapQuoteRequest): Promise<SwapQuoteResponse> {
  const url = new URL(JUPITER_QUOTE_API);
  url.searchParams.set("inputMint",   req.inputMint);
  url.searchParams.set("outputMint",  req.outputMint);
  url.searchParams.set("amount",      req.amount.toString());
  url.searchParams.set("slippageBps", String(req.slippageBps ?? 50));

  console.log(`[Jupiter] Quote: ${req.amount} ${req.inputMint} → ${req.outputMint}`);

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`[Jupiter] Quote API error: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();

  return {
    inputMint:            (data as any).inputMint,
    outputMint:           (data as any).outputMint,
    inAmount:             BigInt((data as any).inAmount),
    outAmount:            BigInt((data as any).outAmount),
    priceImpactPct:       parseFloat((data as any).priceImpactPct ?? "0"),
    otherAmountThreshold: BigInt((data as any).otherAmountThreshold ?? "0"),
    swapMode:             (data as any).swapMode ?? "ExactIn",
    routePlan: ((data as any).routePlan ?? []).map((leg: Record<string, unknown>) => ({
      dexLabel:   (leg.swapInfo as Record<string, unknown>)?.label ?? "unknown",
      percent:    Number(leg.percent ?? 100),
      inputMint:  (leg.swapInfo as Record<string, unknown>)?.inputMint ?? req.inputMint,
      outputMint: (leg.swapInfo as Record<string, unknown>)?.outputMint ?? req.outputMint,
    })),
  };
}

/**
 * Get a signed swap transaction from Jupiter (Solana).
 * Returns base64-encoded transaction ready to send via sendRawTransaction.
 *
 * @example
 * const { swapTransaction } = await jupiterGetSwapTx(quote, userPublicKey);
 * await connection.sendRawTransaction(Buffer.from(swapTransaction, "base64"));
 */
export async function jupiterGetSwapTx(
  quote: SwapQuoteResponse,
  userPublicKey: string,
  options?: { wrapUnwrapSOL?: boolean; prioritizationFeeLamports?: number }
): Promise<{ swapTransaction: string; lastValidBlockHeight: number }> {
  console.log(`[Jupiter] Building swap tx for ${userPublicKey}`);

  const body = {
    quoteResponse: quote,
    userPublicKey,
    wrapAndUnwrapSol: options?.wrapUnwrapSOL ?? true,
    prioritizationFeeLamports: options?.prioritizationFeeLamports ?? 10_000,
  };

  const res = await fetch(JUPITER_SWAP_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`[Jupiter] Swap API error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return { swapTransaction: (data as any).swapTransaction, lastValidBlockHeight: (data as any).lastValidBlockHeight };
}

// ── 1inch Aggregation API (EVM) ───────────────────────────────────────────────

const ONEINCH_API_BASE = "https://api.1inch.dev/swap/v6.0";

/**
 * Fetch a swap quote from 1inch.
 * Requires an API key: https://portal.1inch.dev/
 *
 * @example
 * const quote = await oneInchGetQuote(1, {
 *   inputMint:  "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
 *   outputMint: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH
 *   amount:     1_000_000_000n, // 1000 USDC
 * }, "YOUR_1INCH_API_KEY");
 */
export async function oneInchGetQuote(
  chainId: ChainId,
  req: SwapQuoteRequest,
  apiKey: string
): Promise<SwapQuoteResponse> {
  const url = new URL(`${ONEINCH_API_BASE}/${chainId}/quote`);
  url.searchParams.set("src",    req.inputMint);
  url.searchParams.set("dst",    req.outputMint);
  url.searchParams.set("amount", req.amount.toString());

  console.log(`[1inch] Quote on chain ${chainId}: ${req.amount} ${req.inputMint} → ${req.outputMint}`);

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`[1inch] Quote error: ${res.status} ${await res.text()}`);
  const data = await res.json();

  const protocols: RouteLeg[] = ((data as any).protocols ?? [[]]).flat(2).map((p: Record<string, unknown>) => ({
    dexLabel:   String(p.name ?? "unknown"),
    percent:    Number(p.part ?? 100),
    inputMint:  req.inputMint,
    outputMint: req.outputMint,
  }));

  return {
    inputMint:            req.inputMint,
    outputMint:           req.outputMint,
    inAmount:             req.amount,
    outAmount:            BigInt((data as any).dstAmount ?? "0"),
    priceImpactPct:       0, // 1inch doesn't expose this directly at quote stage
    otherAmountThreshold: 0n,
    swapMode:             "ExactIn",
    routePlan:            protocols,
  };
}

/**
 * Get calldata for a 1inch swap (ready to broadcast).
 *
 * @example
 * const tx = await oneInchGetSwapTx(1, req, "0xYourAddress", "API_KEY");
 * await wallet.sendTransaction({ to: tx.to, data: tx.data, value: tx.value });
 */
export async function oneInchGetSwapTx(
  chainId: ChainId,
  req: SwapQuoteRequest,
  fromAddress: Address,
  apiKey: string
): Promise<{ to: Address; data: string; value: bigint; gas: bigint }> {
  const url = new URL(`${ONEINCH_API_BASE}/${chainId}/swap`);
  url.searchParams.set("src",        req.inputMint);
  url.searchParams.set("dst",        req.outputMint);
  url.searchParams.set("amount",     req.amount.toString());
  url.searchParams.set("from",       fromAddress);
  url.searchParams.set("slippage",   String((req.slippageBps ?? 50) / 100));
  url.searchParams.set("disableEstimate", "false");

  console.log(`[1inch] Building swap tx from ${fromAddress}`);

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`[1inch] Swap tx error: ${res.status} ${await res.text()}`);
  const data = await res.json();

  return {
    to:    (data as any).tx.to as Address,
    data:  (data as any).tx.data as string,
    value: BigInt((data as any).tx.value ?? "0"),
    gas:   BigInt((data as any).tx.gas ?? "0"),
  };
}

// ── 0x API (EVM) ─────────────────────────────────────────────────────────────

const ZRX_API_BASE = "https://api.0x.org";

/**
 * Get a price quote from 0x.
 * Requires header: 0x-api-key
 * Docs: https://0x.org/docs/api#tag/Swap/operation/swap::permit2::getPrice
 *
 * @example
 * const quote = await zeroXGetQuote(1, {
 *   inputMint:  "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
 *   outputMint: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
 *   amount:     500_000_000_000n,
 * }, "YOUR_0X_API_KEY");
 */
export async function zeroXGetQuote(
  chainId: ChainId,
  req: SwapQuoteRequest,
  apiKey: string
): Promise<SwapQuoteResponse & { permit2?: unknown }> {
  const url = new URL(`${ZRX_API_BASE}/swap/permit2/price`);
  url.searchParams.set("chainId",   String(chainId));
  url.searchParams.set("sellToken", req.inputMint);
  url.searchParams.set("buyToken",  req.outputMint);
  url.searchParams.set("sellAmount", req.amount.toString());
  if (req.slippageBps) url.searchParams.set("slippagePercentage", String(req.slippageBps / 100 / 100));

  console.log(`[0x] Price quote on chain ${chainId}`);

  const res = await fetch(url.toString(), {
    headers: { "0x-api-key": apiKey, "0x-version": "v2" },
  });
  if (!res.ok) throw new Error(`[0x] Price error: ${res.status} ${await res.text()}`);
  const data = await res.json();

  return {
    inputMint:            req.inputMint,
    outputMint:           req.outputMint,
    inAmount:             BigInt((data as any).sellAmount ?? req.amount),
    outAmount:            BigInt((data as any).buyAmount ?? "0"),
    priceImpactPct:       parseFloat((data as any).estimatedPriceImpact ?? "0"),
    otherAmountThreshold: 0n,
    swapMode:             "ExactIn",
    routePlan:            [], // detailed routing available in /quote endpoint
    fees:                 (data as any).fees ? [{ amount: BigInt((data as any).fees.integratorFee?.amount ?? "0"), mint: req.outputMint }] : [],
  };
}

/**
 * Get a full 0x swap quote with calldata (Permit2 flow).
 */
export async function zeroXGetSwapTx(
  chainId: ChainId,
  req: SwapQuoteRequest & { takerAddress: Address },
  apiKey: string
): Promise<{ to: Address; data: string; value: bigint; permit2?: unknown }> {
  const url = new URL(`${ZRX_API_BASE}/swap/permit2/quote`);
  url.searchParams.set("chainId",    String(chainId));
  url.searchParams.set("sellToken",  req.inputMint);
  url.searchParams.set("buyToken",   req.outputMint);
  url.searchParams.set("sellAmount", req.amount.toString());
  url.searchParams.set("taker",      req.takerAddress);

  const res = await fetch(url.toString(), {
    headers: { "0x-api-key": apiKey, "0x-version": "v2" },
  });
  if (!res.ok) throw new Error(`[0x] Quote error: ${res.status} ${await res.text()}`);
  const data = await res.json();

  return {
    to:      (data as any).transaction?.to as Address,
    data:    (data as any).transaction?.data as string,
    value:   BigInt((data as any).transaction?.value ?? "0"),
    permit2: (data as any).permit2,
  };
}

// ── Best-Price Router ─────────────────────────────────────────────────────────

/**
 * Query all available aggregators and return the best output amount.
 *
 * @example
 * const best = await getBestSwapQuote("evm", 1, req, { oneInchKey: "...", zeroXKey: "..." });
 * console.log(`Best: ${best.aggregator} → ${best.quote.outAmount}`);
 */
export async function getBestSwapQuote(
  chain: "evm" | "solana",
  chainId: ChainId,
  req: SwapQuoteRequest,
  keys: { oneInchKey?: string; zeroXKey?: string }
): Promise<{ aggregator: string; quote: SwapQuoteResponse }> {
  const results: Array<{ aggregator: string; quote: SwapQuoteResponse }> = [];

  if (chain === "solana") {
    const quote = await jupiterGetQuote(req);
    results.push({ aggregator: "Jupiter", quote });
  } else {
    const pending: Promise<void>[] = [];

    if (keys.oneInchKey) {
      pending.push(
        oneInchGetQuote(chainId, req, keys.oneInchKey)
          .then((quote) => { results.push({ aggregator: "1inch", quote }); })
          .catch((e) => console.warn("[BestQuote] 1inch failed:", e.message))
      );
    }

    if (keys.zeroXKey) {
      pending.push(
        zeroXGetQuote(chainId, req, keys.zeroXKey)
          .then((quote) => { results.push({ aggregator: "0x", quote }); })
          .catch((e) => console.warn("[BestQuote] 0x failed:", e.message))
      );
    }

    await Promise.allSettled(pending);
  }

  if (!results.length) throw new Error("[BestQuote] No aggregator returned a valid quote.");

  results.sort((a, b) => (b.quote.outAmount > a.quote.outAmount ? 1 : -1));
  const best = results[0];
  console.log(`[BestQuote] Winner: ${best.aggregator} → outAmount: ${best.quote.outAmount}`);
  return best;
}

// ── Example Usage ─────────────────────────────────────────────────────────────

/*
// Solana
const solQuote = await jupiterGetQuote({
  inputMint:  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  outputMint: "So11111111111111111111111111111111111111112",
  amount:     5_000_000n,
  slippageBps: 30,
});
console.log(solQuote.routePlan);

// EVM — best price across 1inch and 0x
const best = await getBestSwapQuote("evm", 1, {
  inputMint:  "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  outputMint: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  amount:     10_000_000_000n,
}, { oneInchKey: "KEY1", zeroXKey: "KEY2" });
console.log(best);
*/