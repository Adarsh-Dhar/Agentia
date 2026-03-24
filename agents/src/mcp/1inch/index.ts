/**
 * MCP Server: oneinch
 *
 * Code generator for 1inch aggregator integration on EVM chains.
 * Provides best-route swap execution for the EVM-side arbitrage leg.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "oneinch-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

const TOOLS: Tool[] = [
  {
    name: "get_swap_code",
    description:
      "Returns TypeScript code for executing EVM token swaps via 1inch Aggregation Router V5 with optimal routing.",
    inputSchema: {
      type: "object",
      properties: {
        chainId: { type: "number", description: "EVM chain ID (1=eth, 137=polygon, 42161=arbitrum)" },
        includeApproval: { type: "boolean", description: "Include ERC20 token approval logic" },
      },
      required: ["chainId"],
    },
  },
  {
    name: "get_quote_code",
    description:
      "Returns TypeScript code for fetching 1inch swap quotes to check prices before execution.",
    inputSchema: {
      type: "object",
      properties: { chainId: { type: "number" } },
      required: ["chainId"],
    },
  },
  {
    name: "get_fusion_swap_code",
    description:
      "Returns TypeScript code for 1inch Fusion swaps — gasless, MEV-protected order execution via resolvers.",
    inputSchema: { type: "object", properties: {} },
  },
];

const ONEINCH_ROUTERS: Record<number, string> = {
  1: "0x1111111254EEB25477B68fb85Ed929f73A960582",
  137: "0x1111111254EEB25477B68fb85Ed929f73A960582",
  42161: "0x1111111254EEB25477B68fb85Ed929f73A960582",
  56: "0x1111111254EEB25477B68fb85Ed929f73A960582",
};

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "get_swap_code": {
      const chainId = (args as any)?.chainId ?? 42161;
      const includeApproval = (args as any)?.includeApproval ?? true;
      const routerAddress = ONEINCH_ROUTERS[chainId];

      return {
        content: [
          {
            type: "text",
            text: `
// ============================================================
// FILE: src/oneinch-swap.ts
// 1inch Aggregator V5 — EVM swap execution
// Chain ID: ${chainId} | Router: ${routerAddress}
// ============================================================

import axios from "axios";
import { ethers } from "ethers";

const ONEINCH_API = "https://api.1inch.dev/swap/v6.0/${chainId}";
const ROUTER_ADDRESS = "${routerAddress}";

// API key from 1inch dev portal (https://portal.1inch.dev/)
const API_KEY = process.env.ONEINCH_API_KEY!;

export interface OneInchSwapParams {
  fromTokenAddress: string;
  toTokenAddress: string;
  amount: string;          // In fromToken's smallest unit (wei for 18-decimal tokens)
  fromAddress: string;     // The wallet that will execute the swap
  slippage: number;        // 0.5 = 0.5% slippage tolerance
  disableEstimate?: boolean;
}

${includeApproval ? `
/**
 * Approves the 1inch router to spend your tokens.
 * Call once before the first swap with a given token.
 */
export async function approveToken(
  signer: ethers.Signer,
  tokenAddress: string,
  amount: bigint = ethers.MaxUint256  // Infinite approval (common DeFi practice)
): Promise<string> {
  const ERC20_ABI = [
    "function approve(address spender, uint256 amount) returns (bool)",
    "function allowance(address owner, address spender) view returns (uint256)",
  ];
  
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
  const walletAddress = await signer.getAddress();

  // Check existing allowance first
  const existing = await token.allowance(walletAddress, ROUTER_ADDRESS);
  if (existing >= amount) {
    console.log("[1inch] Token already approved");
    return "already-approved";
  }

  const tx = await token.approve(ROUTER_ADDRESS, amount);
  await tx.wait();
  console.log(\`[1inch] Token approved: \${tx.hash}\`);
  return tx.hash;
}
` : ""}

/**
 * Fetches swap transaction data from 1inch API.
 * Returns calldata ready to be submitted to the router contract.
 */
export async function getSwapTransaction(
  params: OneInchSwapParams
): Promise<{
  to: string;
  data: string;
  value: string;
  gas: number;
  fromTokenAmount: string;
  toTokenAmount: string;
}> {
  const { data } = await axios.get(\`\${ONEINCH_API}/swap\`, {
    headers: { Authorization: \`Bearer \${API_KEY}\` },
    params: {
      src: params.fromTokenAddress,
      dst: params.toTokenAddress,
      amount: params.amount,
      from: params.fromAddress,
      slippage: params.slippage,
      disableEstimate: params.disableEstimate ?? false,
      allowPartialFill: false,
    },
  });

  return {
    to: data.tx.to,
    data: data.tx.data,
    value: data.tx.value,
    gas: data.tx.gas,
    fromTokenAmount: data.fromTokenAmount,
    toTokenAmount: data.toTokenAmount,
  };
}

/**
 * Executes a 1inch swap.
 * Approves token if needed, then submits the swap transaction.
 */
export async function executeSwap(
  signer: ethers.Signer,
  params: OneInchSwapParams
): Promise<{ success: boolean; txHash?: string; outputAmount?: string; error?: string }> {
  try {
    // Get optimized swap calldata from 1inch
    const swapData = await getSwapTransaction(params);

    console.log(\`[1inch] Swapping: input=\${params.amount} | expected output=\${swapData.toTokenAmount}\`);

    // Submit transaction
    const tx = await signer.sendTransaction({
      to: swapData.to,
      data: swapData.data,
      value: BigInt(swapData.value || "0"),
      gasLimit: BigInt(Math.ceil(swapData.gas * 1.2)), // 20% buffer
    });

    console.log(\`[1inch] TX submitted: \${tx.hash}\`);
    const receipt = await tx.wait();
    
    if (receipt?.status === 0) {
      return { success: false, txHash: tx.hash, error: "Transaction reverted" };
    }

    return { 
      success: true, 
      txHash: tx.hash,
      outputAmount: swapData.toTokenAmount,
    };

  } catch (err: any) {
    return { success: false, error: err.response?.data?.description || err.message };
  }
}
            `,
          },
        ],
      };
    }

    case "get_quote_code": {
      const chainId = (args as any)?.chainId ?? 42161;

      return {
        content: [
          {
            type: "text",
            text: `
// FILE: src/oneinch-quote.ts
// 1inch price quotes for profitability checking

import axios from "axios";

export async function get1inchQuote(
  chainId: number,
  fromToken: string,
  toToken: string,
  amount: string
): Promise<{ outputAmount: string; estimatedGas: number }> {
  const { data } = await axios.get(
    \`https://api.1inch.dev/swap/v6.0/\${chainId}/quote\`,
    {
      headers: { Authorization: \`Bearer \${process.env.ONEINCH_API_KEY}\` },
      params: { src: fromToken, dst: toToken, amount },
    }
  );
  return { outputAmount: data.dstAmount, estimatedGas: data.gas };
}
            `,
          },
        ],
      };
    }

    case "get_fusion_swap_code": {
      return {
        content: [
          {
            type: "text",
            text: `
// FILE: src/oneinch-fusion.ts
// 1inch Fusion — gasless, MEV-protected swaps via resolvers

import { FusionSDK, NetworkEnum, PrivateKeyProviderConnector } from "@1inch/fusion-sdk";
import { ethers } from "ethers";

export async function executeFusionSwap(
  fromToken: string,
  toToken: string,
  amount: string,
  walletAddress: string
) {
  const sdk = new FusionSDK({
    url: "https://fusion.1inch.io",
    network: NetworkEnum.ETHEREUM,
    authKey: process.env.ONEINCH_API_KEY!,
    blockchainProvider: new PrivateKeyProviderConnector(
      process.env.EVM_PRIVATE_KEY!,
      new ethers.JsonRpcProvider(process.env.RPC_URL)
    ),
  });

  const params = await sdk.getQuote({
    fromTokenAddress: fromToken,
    toTokenAddress: toToken,
    amount,
    walletAddress,
  });

  const order = await sdk.placeOrder(params);
  console.log(\`[FusionSwap] Order placed: \${order.orderHash}\`);
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
  console.error("[oneinch-mcp] Server running on stdio");
}

main().catch(console.error);