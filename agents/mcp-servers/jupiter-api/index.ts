/**
 * MCP Server: jupiter-api
 *
 * Code generator for Jupiter Aggregator (Solana's best swap aggregator).
 * Provides quote-fetching, swap execution, and route optimization code.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "jupiter-api-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

const TOOLS: Tool[] = [
  {
    name: "get_jupiter_swap_code",
    description:
      "Returns TypeScript code for executing token swaps through Jupiter Aggregator on Solana with best-route optimization.",
    inputSchema: {
      type: "object",
      properties: {
        useVersionedTx: {
          type: "boolean",
          description: "Use Solana versioned transactions (recommended)",
        },
      },
    },
  },
  {
    name: "get_jupiter_quote_code",
    description:
      "Returns TypeScript code for fetching swap quotes from Jupiter API without executing — use this for price checking before arbitrage.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_jupiter_price_api_code",
    description:
      "Returns TypeScript code for the Jupiter Price API — faster than quote API for real-time price monitoring.",
    inputSchema: { type: "object", properties: {} },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "get_jupiter_swap_code": {
      return {
        content: [
          {
            type: "text",
            text: `
// ============================================================
// FILE: src/jupiter-swap.ts
// Jupiter Aggregator V6 — Best-route swap execution on Solana
// ============================================================

import {
  Connection,
  Keypair,
  VersionedTransaction,
  PublicKey,
  TransactionMessage,
} from "@solana/web3.js";
import axios from "axios";

const JUPITER_API_V6 = "https://quote-api.jup.ag/v6";

export interface SwapParams {
  inputMint: string;        // Token to sell (e.g., USDC mint address)
  outputMint: string;       // Token to buy
  amount: number;           // Amount in input token's smallest unit (e.g., lamports/micro-USDC)
  slippageBps: number;      // Slippage tolerance in basis points (50 = 0.5%)
  onlyDirectRoutes?: boolean;
  asLegacyTransaction?: boolean;
}

export interface SwapResult {
  success: boolean;
  txSignature?: string;
  inputAmount: number;
  outputAmount: number;
  priceImpactPct: number;
  error?: string;
}

/**
 * Fetches the best swap route from Jupiter.
 * Always call this before execute() to verify the route is profitable.
 */
export async function getSwapQuote(params: SwapParams) {
  const url = new URL(\`\${JUPITER_API_V6}/quote\`);
  url.searchParams.set("inputMint", params.inputMint);
  url.searchParams.set("outputMint", params.outputMint);
  url.searchParams.set("amount", params.amount.toString());
  url.searchParams.set("slippageBps", params.slippageBps.toString());
  if (params.onlyDirectRoutes) url.searchParams.set("onlyDirectRoutes", "true");

  const { data: quoteResponse } = await axios.get(url.toString());
  
  console.log(\`[Jupiter] Best route: \${quoteResponse.routePlan?.map((r: any) => r.swapInfo?.label).join(" → ")}\`);
  console.log(\`[Jupiter] Price impact: \${quoteResponse.priceImpactPct}%\`);
  
  return quoteResponse;
}

/**
 * Executes a swap via Jupiter using a versioned transaction.
 */
export async function executeSwap(
  connection: Connection,
  keypair: Keypair,
  params: SwapParams
): Promise<SwapResult> {
  try {
    // Step 1: Get the best route
    const quoteResponse = await getSwapQuote(params);
    
    if (parseFloat(quoteResponse.priceImpactPct) > 2) {
      console.warn(\`[Jupiter] High price impact: \${quoteResponse.priceImpactPct}% — aborting\`);
      return {
        success: false,
        inputAmount: params.amount,
        outputAmount: 0,
        priceImpactPct: parseFloat(quoteResponse.priceImpactPct),
        error: "Price impact too high",
      };
    }

    // Step 2: Get serialized transaction from Jupiter
    const { data: swapResponse } = await axios.post(\`\${JUPITER_API_V6}/swap\`, {
      quoteResponse,
      userPublicKey: keypair.publicKey.toString(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,   // Optimize compute units automatically
      prioritizationFeeLamports: "auto", // Auto-set priority fee for fast landing
    });

    // Step 3: Deserialize and sign the transaction
    const swapTransactionBuf = Buffer.from(swapResponse.swapTransaction, "base64");
    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
    transaction.sign([keypair]);

    // Step 4: Submit with preflight disabled for speed (transaction pre-verified by Jupiter)
    const rawTransaction = transaction.serialize();
    const txid = await connection.sendRawTransaction(rawTransaction, {
      skipPreflight: true,
      maxRetries: 3,
    });

    console.log(\`[Jupiter] TX submitted: https://solscan.io/tx/\${txid}\`);

    // Step 5: Wait for confirmation
    const { value } = await connection.confirmTransaction(
      { signature: txid, ...await connection.getLatestBlockhash() },
      "confirmed"
    );

    if (value.err) {
      return {
        success: false,
        txSignature: txid,
        inputAmount: params.amount,
        outputAmount: 0,
        priceImpactPct: parseFloat(quoteResponse.priceImpactPct),
        error: JSON.stringify(value.err),
      };
    }

    return {
      success: true,
      txSignature: txid,
      inputAmount: parseInt(quoteResponse.inAmount),
      outputAmount: parseInt(quoteResponse.outAmount),
      priceImpactPct: parseFloat(quoteResponse.priceImpactPct),
    };

  } catch (err: any) {
    return {
      success: false,
      inputAmount: params.amount,
      outputAmount: 0,
      priceImpactPct: 0,
      error: err.message,
    };
  }
}

// ─── Common Token Mints on Solana ─────────────────────────────────────────────

export const SOLANA_TOKENS = {
  SOL:  "So11111111111111111111111111111111111111112",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  BONK: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  JUP:  "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
  RAY:  "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
  ORCA: "orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE",
};
            `,
          },
        ],
      };
    }

    case "get_jupiter_quote_code": {
      return {
        content: [
          {
            type: "text",
            text: `
// ============================================================
// FILE: src/jupiter-quote.ts
// Lightweight quote fetcher — no execution, just price checking
// ============================================================

import axios from "axios";

const JUPITER_PRICE_API = "https://price.jup.ag/v6/price";
const JUPITER_QUOTE_API = "https://quote-api.jup.ag/v6/quote";

/**
 * Fetches current USD price for a Solana token using Jupiter Price API.
 * Much faster than the quote API — ideal for continuous monitoring.
 */
export async function getTokenPrice(
  mintAddress: string,
  vsToken: string = "USDC"
): Promise<number> {
  const { data } = await axios.get(JUPITER_PRICE_API, {
    params: { ids: mintAddress, vsToken },
    timeout: 3000,
  });
  
  return data.data[mintAddress]?.price ?? 0;
}

/**
 * Compares prices across a route to detect arbitrage opportunities.
 * Returns the expected output for a given input without executing.
 */
export async function getExpectedOutput(
  inputMint: string,
  outputMint: string,
  inputAmount: number,
  slippageBps: number = 50
): Promise<{
  expectedOutput: number;
  priceImpact: number;
  route: string[];
}> {
  const { data } = await axios.get(JUPITER_QUOTE_API, {
    params: {
      inputMint,
      outputMint,
      amount: inputAmount,
      slippageBps,
    },
    timeout: 5000,
  });

  return {
    expectedOutput: parseInt(data.outAmount),
    priceImpact: parseFloat(data.priceImpactPct),
    route: data.routePlan?.map((r: any) => r.swapInfo?.label) ?? [],
  };
}
            `,
          },
        ],
      };
    }

    case "get_jupiter_price_api_code": {
      return {
        content: [
          {
            type: "text",
            text: `
// Jupiter Price API — ultra-fast price feed for real-time monitoring
// Endpoint: https://price.jup.ag/v6/price

export async function getBatchPrices(mintAddresses: string[]): Promise<Map<string, number>> {
  const ids = mintAddresses.join(",");
  const { data } = await fetch(\`https://price.jup.ag/v6/price?ids=\${ids}\`).then(r => r.json());
  
  const prices = new Map<string, number>();
  mintAddresses.forEach(mint => {
    if (data.data[mint]) prices.set(mint, data.data[mint].price);
  });
  return prices;
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
  console.error("[jupiter-api-mcp] Server running on stdio");
}

main().catch(console.error);