/**
 * MCP Server: jupiter-api  v2.0.0
 *
 * FIXED: Now actually calls Jupiter Price API and Quote API.
 * Previous version only returned code strings.
 *
 * Tools (live):
 *   get_token_price      – real-time USD price from Jupiter Price API
 *   get_batch_prices     – prices for multiple tokens at once
 *   get_quote            – real swap quote (output amount, price impact, route)
 *
 * Tools (code generators — kept):
 *   get_jupiter_swap_code       – versioned-tx swap boilerplate
 *   get_jupiter_price_api_code  – price-feed boilerplate
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "jupiter-api-mcp", version: "2.0.0" },
  { capabilities: { tools: {} } }
);

// Well-known Solana token mints (for convenience)
export const SOLANA_TOKENS: Record<string, string> = {
  SOL:  "So11111111111111111111111111111111111111112",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  BONK: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  JUP:  "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
  RAY:  "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
  ORCA: "orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE",
};

// ─── Fetch helper ─────────────────────────────────────────────────────────────

async function jupFetch(url: string): Promise<any> {
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Jupiter API HTTP ${res.status}`);
  return res.json();
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS: Tool[] = [
  {
    name: "get_token_price",
    description:
      "LIVE: Returns the current USD price of a Solana token from Jupiter Price API. Accepts token mint address or symbol (SOL/USDC/USDT/BONK/JUP/RAY/ORCA).",
    inputSchema: {
      type: "object",
      properties: {
        tokenMintOrSymbol: { type: "string", description: "Mint address or known symbol" },
      },
      required: ["tokenMintOrSymbol"],
    },
  },
  {
    name: "get_batch_prices",
    description:
      "LIVE: Returns current USD prices for multiple Solana tokens in a single call. Pass mint addresses or known symbols.",
    inputSchema: {
      type: "object",
      properties: {
        tokensOrMints: {
          type: "array",
          items: { type: "string" },
          description: "Array of mint addresses or symbols (e.g. ['SOL','USDC','BONK'])",
        },
      },
      required: ["tokensOrMints"],
    },
  },
  {
    name: "get_quote",
    description:
      "LIVE: Fetches a real Jupiter swap quote. Returns exact output amount, price impact %, best route, and estimated fee. Use this to check if a Solana arbitrage is still profitable before executing.",
    inputSchema: {
      type: "object",
      properties: {
        inputMint: { type: "string", description: "Input token mint address or symbol" },
        outputMint: { type: "string", description: "Output token mint address or symbol" },
        amount: { type: "number", description: "Input amount in token's smallest unit (e.g. lamports for SOL, micro-USDC for USDC)" },
        slippageBps: { type: "number", description: "Slippage tolerance in basis points (50 = 0.5%)", default: 50 },
        onlyDirectRoutes: { type: "boolean", default: false },
      },
      required: ["inputMint", "outputMint", "amount"],
    },
  },
  {
    name: "get_jupiter_swap_code",
    description: "Returns TypeScript boilerplate for executing a Jupiter swap using a versioned transaction (code template, not a live call).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_jupiter_price_api_code",
    description: "Returns TypeScript boilerplate for a batch price feed (code template).",
    inputSchema: { type: "object", properties: {} },
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveMint(tokenOrMint: string): string {
  // If it looks like a mint address (long base58), use as-is
  if (tokenOrMint.length > 20) return tokenOrMint;
  return SOLANA_TOKENS[tokenOrMint.toUpperCase()] ?? tokenOrMint;
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    // ── LIVE: single token price ──────────────────────────────────────────────
    case "get_token_price": {
      const input: string = (args as any)?.tokenMintOrSymbol;
      const mint = resolveMint(input);

      try {
        const data = await jupFetch(
          `https://price.jup.ag/v6/price?ids=${mint}`
        );
        const entry = data.data?.[mint];

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                input,
                mint,
                priceUsd: entry?.price ?? null,
                confidence: entry?.confidenceLevel ?? null,
                checkedAt: new Date().toISOString(),
              }, null, 2),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: err.message, mint }) }],
        };
      }
    }

    // ── LIVE: batch token prices ──────────────────────────────────────────────
    case "get_batch_prices": {
      const inputs: string[] = (args as any)?.tokensOrMints ?? [];
      const mints = inputs.map(resolveMint);

      try {
        const data = await jupFetch(
          `https://price.jup.ag/v6/price?ids=${mints.join(",")}`
        );

        const prices: Record<string, number | null> = {};
        for (let i = 0; i < mints.length; i++) {
          const mint = mints[i];
          prices[inputs[i]] = data.data?.[mint]?.price ?? null;
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ prices, checkedAt: new Date().toISOString() }, null, 2),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: err.message }) }],
        };
      }
    }

    // ── LIVE: real swap quote ─────────────────────────────────────────────────
    case "get_quote": {
      const inputMint = resolveMint((args as any)?.inputMint);
      const outputMint = resolveMint((args as any)?.outputMint);
      const amount = (args as any)?.amount as number;
      const slippageBps = (args as any)?.slippageBps ?? 50;
      const onlyDirect = (args as any)?.onlyDirectRoutes ?? false;

      try {
        const url = `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}&onlyDirectRoutes=${onlyDirect}`;
        const data = await jupFetch(url);

        const inAmt = parseInt(data.inAmount ?? amount);
        const outAmt = parseInt(data.outAmount ?? "0");
        const impact = parseFloat(data.priceImpactPct ?? "0");

        const route = (data.routePlan ?? [])
          .map((step: any) => step.swapInfo?.label ?? "?")
          .join(" → ");

        const result = {
          inputMint,
          outputMint,
          inputAmount: inAmt,
          outputAmount: outAmt,
          priceImpactPct: impact,
          slippageBps,
          route: route || "direct",
          otherAmountThreshold: data.otherAmountThreshold,
          contextSlot: data.contextSlot,
          timeTaken: data.timeTaken,
          profitable:
            impact < 1 && outAmt > 0
              ? "LIKELY — low price impact"
              : impact >= 2
              ? "RISKY — high price impact"
              : "MARGINAL",
          quotedAt: new Date().toISOString(),
        };

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: err.message, inputMint, outputMint }) }],
        };
      }
    }

    // ── Code generators (kept) ────────────────────────────────────────────────
    case "get_jupiter_swap_code": {
      return {
        content: [
          {
            type: "text",
            text: `
// FILE: src/jupiter-swap.ts
// Execute a Jupiter swap using a versioned transaction.
// Step 1: call the get_quote MCP tool to get quoteResponse.
// Step 2: POST to /swap to get serialized tx, then sign & send.

import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";

export async function executeJupiterSwap(
  connection: Connection,
  keypair: Keypair,
  quoteResponse: any
): Promise<string> {
  const { swapTransaction } = await fetch("https://quote-api.jup.ag/v6/swap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse,
      userPublicKey: keypair.publicKey.toString(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: "auto",
    }),
  }).then(r => r.json());

  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
  tx.sign([keypair]);
  const txid = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
  await connection.confirmTransaction({ signature: txid, ...await connection.getLatestBlockhash() }, "confirmed");
  return txid;
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
// Tip: use get_batch_prices MCP tool instead of this boilerplate.
// The MCP tool calls Jupiter Price API directly and returns structured data.

export async function getBatchPrices(mints: string[]): Promise<Map<string, number>> {
  const data = await fetch(\`https://price.jup.ag/v6/price?ids=\${mints.join(",")}\`).then(r => r.json());
  return new Map(mints.map(m => [m, data.data[m]?.price ?? 0]));
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
  console.error("[jupiter-api-mcp v2] Server running — live API + code-gen mode");
}

main().catch(console.error);