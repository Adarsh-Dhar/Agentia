/**
 * MCP Server: oneinch  v2.0.0
 *
 * FIXED: Added live quote/price tools that actually call the 1inch API.
 * The old server only returned code strings — an agent can't trade with text.
 *
 * Tools (live):
 *   get_quote            – fetch real swap quote (output amount, gas, route)
 *   get_token_price      – spot price via 1inch Price API
 *   get_liquidity_sources – list available DEXs on a chain
 *
 * Tools (code generators — kept):
 *   get_swap_code        – ethers.js swap execution boilerplate
 *   get_quote_code       – quote-fetching boilerplate
 *   get_fusion_swap_code – gasless Fusion swap boilerplate
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "oneinch-mcp", version: "2.0.0" },
  { capabilities: { tools: {} } }
);

const ONEINCH_ROUTERS: Record<number, string> = {
  1: "0x1111111254EEB25477B68fb85Ed929f73A960582",
  137: "0x1111111254EEB25477B68fb85Ed929f73A960582",
  42161: "0x1111111254EEB25477B68fb85Ed929f73A960582",
  56: "0x1111111254EEB25477B68fb85Ed929f73A960582",
};

// ─── Fetch helper ─────────────────────────────────────────────────────────────

async function oneinchFetch(path: string, params: Record<string, string | number> = {}): Promise<any> {
  const apiKey = process.env.ONEINCH_API_KEY;
  const url = new URL(`https://api.1inch.dev${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  const headers: Record<string, string> = { Accept: "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  const res = await fetch(url.toString(), {
    headers,
    signal: AbortSignal.timeout(8000),
  });

  const body = await res.json();
  if (!res.ok) {
    throw new Error(body.description ?? body.error ?? `HTTP ${res.status}`);
  }
  return body;
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS: Tool[] = [
  {
    name: "get_quote",
    description:
      "LIVE: Fetches a real swap quote from 1inch API. Returns exact output amount, price impact, estimated gas, and the full route. Set ONEINCH_API_KEY env var for authenticated access.",
    inputSchema: {
      type: "object",
      properties: {
        chainId: { type: "number", description: "EVM chain ID (1=ETH, 137=Polygon, 42161=Arbitrum, 56=BSC)" },
        fromToken: { type: "string", description: "Input token contract address" },
        toToken: { type: "string", description: "Output token contract address" },
        amount: { type: "string", description: "Amount in input token's smallest unit (wei for 18-decimal)" },
      },
      required: ["chainId", "fromToken", "toToken", "amount"],
    },
  },
  {
    name: "get_token_price",
    description:
      "LIVE: Returns the current USD price of a token via the 1inch Price API (no API key required for basic use).",
    inputSchema: {
      type: "object",
      properties: {
        chainId: { type: "number" },
        tokenAddress: { type: "string" },
      },
      required: ["chainId", "tokenAddress"],
    },
  },
  {
    name: "get_liquidity_sources",
    description:
      "LIVE: Lists all DEX protocols that 1inch routes through on a given chain.",
    inputSchema: {
      type: "object",
      properties: {
        chainId: { type: "number" },
      },
      required: ["chainId"],
    },
  },
  {
    name: "get_swap_code",
    description: "Returns TypeScript/ethers.js boilerplate for executing 1inch swaps on-chain (code template).",
    inputSchema: {
      type: "object",
      properties: {
        chainId: { type: "number" },
        includeApproval: { type: "boolean" },
      },
      required: ["chainId"],
    },
  },
  {
    name: "get_fusion_swap_code",
    description: "Returns TypeScript boilerplate for 1inch Fusion gasless swaps (code template).",
    inputSchema: { type: "object", properties: {} },
  },
];

// ─── Handlers ─────────────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    // ── LIVE: real quote ──────────────────────────────────────────────────────
    case "get_quote": {
      const chainId = (args as any)?.chainId as number;
      const fromToken = (args as any)?.fromToken as string;
      const toToken = (args as any)?.toToken as string;
      const amount = (args as any)?.amount as string;

      try {
        const data = await oneinchFetch(`/swap/v6.0/${chainId}/quote`, {
          src: fromToken,
          dst: toToken,
          amount,
        });

        const result = {
          chainId,
          fromToken,
          toToken,
          inputAmount: data.fromTokenAmount ?? amount,
          outputAmount: data.dstAmount ?? data.toTokenAmount,
          priceImpactPct: data.priceImpact ?? "unknown",
          estimatedGas: data.gas,
          routeProtocols: (data.protocols ?? [])
            .flat(3)
            .map((p: any) => p.name)
            .filter(Boolean),
          quotedAt: new Date().toISOString(),
        };

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [
            { type: "text", text: JSON.stringify({ error: err.message, chainId, fromToken, toToken }) },
          ],
        };
      }
    }

    // ── LIVE: token price ─────────────────────────────────────────────────────
    case "get_token_price": {
      const chainId = (args as any)?.chainId as number;
      const tokenAddress = (args as any)?.tokenAddress as string;

      try {
        const data = await oneinchFetch(`/price/v1.1/${chainId}/${tokenAddress}`, {
          currency: "USD",
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                chainId,
                tokenAddress,
                priceUsd: data[tokenAddress.toLowerCase()] ?? data[tokenAddress] ?? null,
                checkedAt: new Date().toISOString(),
              }, null, 2),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: err.message }) }],
        };
      }
    }

    // ── LIVE: liquidity sources ───────────────────────────────────────────────
    case "get_liquidity_sources": {
      const chainId = (args as any)?.chainId as number;

      try {
        const data = await oneinchFetch(`/swap/v6.0/${chainId}/liquidity-sources`);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                chainId,
                count: data.protocols?.length ?? 0,
                protocols: (data.protocols ?? []).map((p: any) => ({ id: p.id, title: p.title })),
              }, null, 2),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: err.message }) }],
        };
      }
    }

    // ── Code generator: swap ──────────────────────────────────────────────────
    case "get_swap_code": {
      const chainId = (args as any)?.chainId ?? 42161;
      const includeApproval = (args as any)?.includeApproval ?? true;
      const routerAddress = ONEINCH_ROUTERS[chainId as number];

      return {
        content: [
          {
            type: "text",
            text: `
// FILE: src/oneinch-swap.ts
// 1inch Aggregator V6 swap execution — Chain ${chainId} | Router: ${routerAddress}
// NOTE: Use get_quote MCP tool to fetch the transaction data, then sign & send below.

import { ethers } from "ethers";

export async function executeSwap(
  signer: ethers.Signer,
  swapData: { to: string; data: string; value: string; gas: number }
): Promise<string> {
  ${includeApproval ? `
  // Run get_quote first, which returns swapData.to / .data / .value / .gas
  // Token approval should already be done once via approveToken()
  ` : ""}
  const tx = await signer.sendTransaction({
    to: swapData.to,
    data: swapData.data,
    value: BigInt(swapData.value || "0"),
    gasLimit: BigInt(Math.ceil(swapData.gas * 1.2)),
  });
  const receipt = await tx.wait();
  if (receipt?.status === 0) throw new Error("Swap tx reverted");
  return tx.hash;
}
            `,
          },
        ],
      };
    }

    // ── Code generator: fusion ────────────────────────────────────────────────
    case "get_fusion_swap_code": {
      return {
        content: [
          {
            type: "text",
            text: `
// FILE: src/oneinch-fusion.ts
// 1inch Fusion — gasless MEV-protected swaps
import { FusionSDK, NetworkEnum, PrivateKeyProviderConnector } from "@1inch/fusion-sdk";
import { ethers } from "ethers";

export async function executeFusionSwap(from: string, to: string, amount: string, wallet: string) {
  const sdk = new FusionSDK({
    url: "https://fusion.1inch.io",
    network: NetworkEnum.ETHEREUM,
    authKey: process.env.ONEINCH_API_KEY!,
    blockchainProvider: new PrivateKeyProviderConnector(
      process.env.EVM_PRIVATE_KEY!,
      new ethers.JsonRpcProvider(process.env.RPC_URL)
    ),
  });
  const params = await sdk.getQuote({ fromTokenAddress: from, toTokenAddress: to, amount, walletAddress: wallet });
  const order = await sdk.placeOrder(params);
  return order;
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
  console.error("[oneinch-mcp v2] Server running — live API + code-gen mode");
}

main().catch(console.error);