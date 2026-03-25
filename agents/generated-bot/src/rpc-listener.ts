// ============================================================
// FILE: src/rpc-listener.ts
// EVM WebSocket block subscription via QuickNode (arbitrum)
// ============================================================

import { ethers } from "ethers";

/**
 * Subscribes to new blocks on arbitrum via WebSocket provider.
 * Fires callback on each new block with full block data.
 */
export function startBlockListener(
  wsEndpoint: string,
  onNewBlock: (blockNumber: number) => Promise<void>
): ethers.WebSocketProvider {
  const provider = new ethers.WebSocketProvider(wsEndpoint);

  provider.on("block", async (blockNumber: number) => {
    console.log(`[RPC] New block: ${blockNumber}`);
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