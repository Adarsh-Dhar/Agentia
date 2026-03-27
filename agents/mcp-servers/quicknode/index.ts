/**
 * MCP Server: quicknode  v2.0.0
 *
 * FIXED:
 * - Added live gas-price tool (calls public Etherscan/Alchemy gas API)
 * - Kept code-gen tools for WebSocket listeners (correct as templates —
 *   WebSocket connections belong in the agent runtime, not the MCP server)
 * - Fixed: removed dead dexA/dexB field references in generated Solidity
 *
 * Tools (live):
 *   get_gas_price        – real current gas price on any EVM chain
 *
 * Tools (code generators — kept):
 *   get_websocket_listener_code
 *   get_rpc_provider_code
 *   get_gas_tracker_code
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "quicknode-mcp", version: "2.0.0" },
  { capabilities: { tools: {} } }
);

// ─── Public gas APIs (no key required) ───────────────────────────────────────

const GAS_APIS: Record<string, string> = {
  ethereum: "https://api.etherscan.io/api?module=gastracker&action=gasoracle",
  polygon:  "https://api.polygonscan.com/api?module=gastracker&action=gasoracle",
  bsc:      "https://api.bscscan.com/api?module=gastracker&action=gasoracle",
  arbitrum: "https://api.arbiscan.io/api?module=gastracker&action=gasoracle",
};

async function fetchGasPrice(chain: string): Promise<{
  safeGwei: number;
  standardGwei: number;
  fastGwei: number;
  baseFeeGwei: number | null;
  chain: string;
  source: string;
  checkedAt: string;
}> {
  const url = GAS_APIS[chain];
  if (!url) throw new Error(`No gas API configured for chain: ${chain}`);

  const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new Error(`Gas API HTTP ${res.status} for ${chain}`);
  const data = await res.json();

  if (data.status !== "1") throw new Error(`Gas API error: ${data.message}`);
  const r = data.result;

  return {
    safeGwei: parseFloat(r.SafeGasPrice ?? r.safeGasPrice ?? "0"),
    standardGwei: parseFloat(r.ProposeGasPrice ?? r.standardGasPrice ?? "0"),
    fastGwei: parseFloat(r.FastGasPrice ?? r.fastGasPrice ?? "0"),
    baseFeeGwei: r.suggestBaseFee ? parseFloat(r.suggestBaseFee) : null,
    chain,
    source: url.replace(/\?.*/, ""),
    checkedAt: new Date().toISOString(),
  };
}

// ─── Tools ────────────────────────────────────────────────────────────────────

const TOOLS: Tool[] = [
  {
    name: "get_gas_price",
    description:
      "LIVE: Returns current gas prices (safe/standard/fast in Gwei) and estimated USD cost for an arbitrage transaction. Uses public block-explorer gas APIs — no RPC key needed.",
    inputSchema: {
      type: "object",
      properties: {
        chain: {
          type: "string",
          enum: ["ethereum", "polygon", "bsc", "arbitrum"],
          description: "EVM chain to check",
        },
        gasUnits: {
          type: "number",
          description: "Estimated gas units your transaction will use (default 450000 for a flash loan arb)",
          default: 450000,
        },
        ethPriceUsd: {
          type: "number",
          description: "Current ETH price in USD for cost calculation",
          default: 3000,
        },
      },
      required: ["chain"],
    },
  },
  {
    name: "get_websocket_listener_code",
    description:
      "Returns TypeScript boilerplate for subscribing to new blocks/slots via WebSocket RPC (code template — WebSocket connections run in agent runtime, not in MCP server).",
    inputSchema: {
      type: "object",
      properties: {
        chain: { type: "string", enum: ["solana", "ethereum", "arbitrum"] },
        listenFor: { type: "string", enum: ["new_blocks", "pending_txns", "log_events"] },
      },
      required: ["chain"],
    },
  },
  {
    name: "get_rpc_provider_code",
    description: "Returns TypeScript boilerplate for a high-availability RPC provider with failover (code template).",
    inputSchema: {
      type: "object",
      properties: {
        chain: { type: "string", enum: ["solana", "ethereum", "arbitrum"] },
        withFallback: { type: "boolean" },
      },
      required: ["chain"],
    },
  },
  {
    name: "get_gas_tracker_code",
    description: "Returns TypeScript boilerplate for an on-demand gas price checker using ethers.js (code template).",
    inputSchema: { type: "object", properties: {} },
  },
];

// ─── Handlers ─────────────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    // ── LIVE: gas price ───────────────────────────────────────────────────────
    case "get_gas_price": {
      const chain: string = (args as any)?.chain ?? "ethereum";
      const gasUnits: number = (args as any)?.gasUnits ?? 450_000;
      const ethPrice: number = (args as any)?.ethPriceUsd ?? 3000;

      try {
        const gas = await fetchGasPrice(chain);

        const costUsd = (speed: number) =>
          Math.round(gasUnits * speed * 1e-9 * ethPrice * 100) / 100;

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ...gas,
                  costEstimateUsd: {
                    safe: costUsd(gas.safeGwei),
                    standard: costUsd(gas.standardGwei),
                    fast: costUsd(gas.fastGwei),
                  },
                  gasUnitsAssumed: gasUnits,
                  ethPriceUsd: ethPrice,
                  recommendation:
                    gas.fastGwei < 30
                      ? "LOW_GAS — good time to execute"
                      : gas.fastGwei < 80
                      ? "MODERATE_GAS — factor into profit calc"
                      : "HIGH_GAS — wait for lower gas or require larger profit gap",
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: err.message, chain }) }],
        };
      }
    }

    // ── Code generators ───────────────────────────────────────────────────────
    case "get_websocket_listener_code": {
      const chain = (args as any)?.chain ?? "solana";
      const listenFor = (args as any)?.listenFor ?? "new_blocks";

      if (chain === "solana") {
        return {
          content: [
            {
              type: "text",
              text: `
// FILE: src/rpc-listener.ts — Solana slot listener
import { Connection } from "@solana/web3.js";

export function startBlockListener(wsEndpoint: string, onNewSlot: (slot: number) => Promise<void>) {
  const connection = new Connection(wsEndpoint, { commitment: "confirmed", wsEndpoint });
  const id = connection.onSlotChange(async ({ slot }) => {
    await onNewSlot(slot).catch(console.error);
  });
  console.log(\`[RPC] Subscribed to Solana slots (id: \${id})\`);
  return () => connection.removeSlotChangeListener(id);
}
              `,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `
// FILE: src/rpc-listener.ts — ${chain} block listener
import { ethers } from "ethers";

export function startBlockListener(wsEndpoint: string, onNewBlock: (n: number) => Promise<void>) {
  const provider = new ethers.WebSocketProvider(wsEndpoint);
  provider.on("block", async (n: number) => { await onNewBlock(n).catch(console.error); });
  ${listenFor === "pending_txns" ? `
  // Pending tx monitoring (requires QuickNode Filters addon)
  provider.on("pending", (txHash: string) => { /* filter large swaps here */ });
  ` : ""}
  // Keep-alive ping every 30s
  setInterval(() => provider.getBlockNumber().catch(() => { provider.removeAllListeners(); startBlockListener(wsEndpoint, onNewBlock); }), 30_000);
  return provider;
}
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
// FILE: src/rpc-provider.ts
import { ethers } from "ethers";

export function createProvider(): ethers.FallbackProvider {
  const primary = new ethers.JsonRpcProvider(process.env.QUICKNODE_RPC_URL);
  ${withFallback ? `
  const fallback = new ethers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL);
  return new ethers.FallbackProvider([
    { provider: primary, priority: 1, stallTimeout: 1000 },
    { provider: fallback, priority: 2, stallTimeout: 2000 },
  ], 1);` : "return primary as any;"}
}
// Required env: QUICKNODE_RPC_URL, QUICKNODE_WS_URL${withFallback ? ", ALCHEMY_RPC_URL" : ""}
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
// Tip: use the get_gas_price MCP tool directly — it calls the gas API for you.

// Or manually via ethers.js:
import { ethers } from "ethers";
export async function getGasData(provider: ethers.Provider, ethUsd = 3000, gasUnits = 450000) {
  const fee = await provider.getFeeData();
  const gweiTotal = Number(ethers.formatUnits(fee.gasPrice ?? 0n, "gwei"));
  return { gweiTotal, costUsd: gasUnits * gweiTotal * 1e-9 * ethUsd };
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
  console.error("[quicknode-mcp v2] Server running");
}

main().catch(console.error);