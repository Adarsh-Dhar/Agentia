/**
 * MCP Server: quicknode
 *
 * Code generator for QuickNode/Alchemy RPC + WebSocket infrastructure.
 * High-performance mempool listening and block monitoring for the agent.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "quicknode-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

const TOOLS: Tool[] = [
  {
    name: "get_websocket_listener_code",
    description:
      "Returns TypeScript code for subscribing to Solana or EVM block updates via WebSocket RPC. Essential for catching arbitrage opportunities in real-time.",
    inputSchema: {
      type: "object",
      properties: {
        chain: { type: "string", enum: ["solana", "ethereum", "arbitrum"] },
        listenFor: {
          type: "string",
          enum: ["new_blocks", "pending_txns", "log_events"],
        },
      },
      required: ["chain"],
    },
  },
  {
    name: "get_rpc_provider_code",
    description:
      "Returns TypeScript code for initializing a high-performance RPC provider with automatic failover.",
    inputSchema: {
      type: "object",
      properties: {
        chain: { type: "string", enum: ["solana", "ethereum", "arbitrum"] },
        withFallback: {
          type: "boolean",
          description: "Include Alchemy as fallback RPC",
        },
      },
      required: ["chain"],
    },
  },
  {
    name: "get_gas_tracker_code",
    description:
      "Returns code for monitoring real-time gas prices to include in profitability calculations.",
    inputSchema: { type: "object", properties: {} },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "get_websocket_listener_code": {
      const chain = (args as any)?.chain ?? "solana";
      const listenFor = (args as any)?.listenFor ?? "new_blocks";

      if (chain === "solana") {
        return {
          content: [
            {
              type: "text",
              text: `
// ============================================================
// FILE: src/rpc-listener.ts
// Solana WebSocket block subscription via QuickNode
// Triggers price scan on every new confirmed block
// ============================================================

import { Connection } from "@solana/web3.js";

/**
 * Subscribes to Solana slot/block updates via WebSocket.
 * Callback fires on every new confirmed slot (~400ms on Solana).
 */
export function startBlockListener(
  wsEndpoint: string,
  onNewSlot: (slot: number) => Promise<void>
): () => void {
  const connection = new Connection(wsEndpoint, {
    commitment: "confirmed",
    wsEndpoint,
  });

  console.log("[RPC] Connecting to Solana WebSocket...");

  const subscriptionId = connection.onSlotChange(async (slotInfo) => {
    console.log(\`[RPC] New slot: \${slotInfo.slot}\`);
    await onNewSlot(slotInfo.slot).catch(console.error);
  });

  console.log(\`[RPC] Subscribed to slot changes (id: \${subscriptionId})\`);

  // Return unsubscribe function
  return () => {
    connection.removeSlotChangeListener(subscriptionId);
    console.log("[RPC] Unsubscribed from slot changes");
  };
}

/**
 * Listens for specific program logs (e.g., Jupiter swap events).
 * Use this to detect large swaps that create arbitrage windows.
 */
export function watchProgramLogs(
  connection: Connection,
  programAddress: string,
  onLog: (logs: string[], signature: string) => void
): () => void {
  const subscriptionId = connection.onLogs(
    programAddress,
    ({ logs, signature }) => {
      onLog(logs, signature);
    },
    "confirmed"
  );

  return () => connection.removeOnLogsListener(subscriptionId);
}
              `,
            },
          ],
        };
      }

      // EVM chain
      return {
        content: [
          {
            type: "text",
            text: `
// ============================================================
// FILE: src/rpc-listener.ts
// EVM WebSocket block subscription via QuickNode (${chain})
// ============================================================

import { ethers } from "ethers";

/**
 * Subscribes to new blocks on ${chain} via WebSocket provider.
 * Fires callback on each new block with full block data.
 */
export function startBlockListener(
  wsEndpoint: string,
  onNewBlock: (blockNumber: number) => Promise<void>
): ethers.WebSocketProvider {
  const provider = new ethers.WebSocketProvider(wsEndpoint);

  provider.on("block", async (blockNumber: number) => {
    console.log(\`[RPC] New block: \${blockNumber}\`);
    await onNewBlock(blockNumber).catch(console.error);
  });

  // Keep WebSocket alive with periodic pings
  const pingInterval = setInterval(() => {
    provider.getBlockNumber().catch(() => {
      console.error("[RPC] WebSocket ping failed — reconnecting");
      clearInterval(pingInterval);
      startBlockListener(wsEndpoint, onNewBlock);
    });
  }, 30000);

  return provider;
}

${listenFor === "pending_txns" ? `
/**
 * Monitors pending transactions (mempool) for large swaps.
 * Requires QuickNode's "Filters" addon enabled.
 */
export function watchPendingSwaps(
  provider: ethers.WebSocketProvider,
  routerAddress: string,
  minValueEth: number = 10
) {
  provider.on("pending", async (txHash: string) => {
    try {
      const tx = await provider.getTransaction(txHash);
      if (!tx || tx.to?.toLowerCase() !== routerAddress.toLowerCase()) return;
      if (Number(tx.value) < ethers.parseEther(minValueEth.toString())) return;
      
      console.log(\`[Mempool] Large swap detected: \${txHash} | Value: \${ethers.formatEther(tx.value)} ETH\`);
    } catch {}
  });
}
` : ""}
            `,
          },
        ],
      };
    }

    case "get_rpc_provider_code": {
      const chain = (args as any)?.chain ?? "ethereum";
      const withFallback = (args as any)?.withFallback ?? true;

      return {
        content: [
          {
            type: "text",
            text: `
// ============================================================
// FILE: src/rpc-provider.ts
// High-availability RPC provider${withFallback ? " with Alchemy fallback" : ""}
// ============================================================

import { ethers } from "ethers";

/**
 * Creates a resilient RPC provider that automatically falls back
 * to secondary endpoint on failure.
 */
export function createProvider(): ethers.FallbackProvider {
  const primary = new ethers.JsonRpcProvider(process.env.QUICKNODE_RPC_URL);
  ${withFallback ? `const fallback = new ethers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL);
  
  return new ethers.FallbackProvider([
    { provider: primary, priority: 1, stallTimeout: 1000 },
    { provider: fallback, priority: 2, stallTimeout: 2000 },
  ], 1);` : "return primary as any;"}
}

// Required env vars:
// QUICKNODE_RPC_URL=https://your-endpoint.quiknode.pro/TOKEN/
// QUICKNODE_WS_URL=wss://your-endpoint.quiknode.pro/TOKEN/
${withFallback ? "// ALCHEMY_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/KEY" : ""}
            `,
          },
        ],
      };
    }

    case "get_gas_tracker_code": {
      return {
        content: [
          {
            type: "text",
            text: `
// FILE: src/gas-tracker.ts
// Real-time gas price monitoring for profitability calculations

import { ethers } from "ethers";

export interface GasData {
  baseFee: number;     // Current base fee in Gwei
  priorityFee: number; // Suggested priority fee (tip) in Gwei
  totalGwei: number;   // Total gas price in Gwei
  costUSD: number;     // Estimated cost of arbitrage tx in USD
}

export async function getCurrentGasPrice(
  provider: ethers.Provider,
  ethPriceUSD: number = 3000,
  gasUnits: number = 450000
): Promise<GasData> {
  const feeData = await provider.getFeeData();
  
  const baseFee = Number(ethers.formatUnits(feeData.gasPrice || 0n, "gwei"));
  const priorityFee = Number(ethers.formatUnits(feeData.maxPriorityFeePerGas || 0n, "gwei"));
  const totalGwei = baseFee + priorityFee;
  const costUSD = (gasUnits * totalGwei * 1e-9) * ethPriceUSD;

  return { baseFee, priorityFee, totalGwei, costUSD };
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
  console.error("[quicknode-mcp] Server running on stdio");
}

main().catch(console.error);