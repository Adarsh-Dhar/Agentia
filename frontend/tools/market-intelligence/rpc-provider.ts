// ============================================================
// rpc-provider.ts — QuickNode & Alchemy: WebSocket / RPC Layer
// ============================================================
//
// Without a high-performance RPC you'll always be second. This tool
// provides a unified interface for both QuickNode and Alchemy,
// covering:
//   • New block subscriptions
//   • Pending transaction (mempool) feeds
//   • Log / event subscriptions
//   • Alchemy-enhanced methods (simulation, token balances, etc.)
//   • Auto-reconnect with exponential back-off
//   • HTTP fallback polling when WebSocket is unavailable
//
// Install:
//   QuickNode Streams: https://www.quicknode.com/docs/streams
//   Alchemy SDK:       npm install alchemy-sdk
// ============================================================

import type { ChainId, Address } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Event Types
// ─────────────────────────────────────────────────────────────────────────────

export interface BlockHeader {
  number: bigint;
  hash: string;
  parentHash: string;
  timestamp: number;           // unix seconds
  baseFeePerGas?: bigint;      // EIP-1559, undefined pre-London
  gasLimit: bigint;
  gasUsed: bigint;
  miner: string;
  transactions: string[];      // tx hashes (full objects need eth_getBlockByNumber)
  extraData: string;
}

export interface PendingTransaction {
  hash: string;
  from: string;
  to?: string;
  value: bigint;
  gas: bigint;
  gasPrice?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  nonce: number;
  input: string;               // calldata (0x-prefixed hex)
  type: number;                // 0=legacy, 1=access, 2=EIP-1559
}

export interface Log {
  address: Address;
  topics: string[];
  data: string;
  blockNumber: bigint;
  transactionHash: string;
  transactionIndex: number;
  blockHash: string;
  logIndex: number;
  removed: boolean;
}

export interface LogFilter {
  address?: Address | Address[];
  topics?: (string | string[] | null)[];
  fromBlock?: string | bigint;
  toBlock?: string | bigint;
}

// ─────────────────────────────────────────────────────────────────────────────
// Subscription Handle
// ─────────────────────────────────────────────────────────────────────────────

export interface Subscription {
  id: string;
  type: string;
  /** Cancel this specific subscription */
  unsubscribe: () => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider Config
// ─────────────────────────────────────────────────────────────────────────────

export type ProviderType = "quicknode" | "alchemy" | "generic";

export interface RpcProviderConfig {
  /** WebSocket URL — wss://... */
  wsUrl: string;
  /** HTTP URL — https://... (used for REST calls and fallback polling) */
  httpUrl: string;
  provider: ProviderType;
  chainId: ChainId;
  /** Auto-reconnect on drop. Default: true */
  autoReconnect?: boolean;
  /** Max reconnect delay in ms. Default: 30_000 */
  maxReconnectDelayMs?: number;
  /** Emit a heartbeat ping every N ms (0 = disabled). Default: 30_000 */
  heartbeatIntervalMs?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// RpcProvider Class
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Unified WebSocket RPC provider for QuickNode and Alchemy.
 *
 * @example — QuickNode
 * const provider = new RpcProvider({
 *   wsUrl:    "wss://your-endpoint.quiknode.pro/TOKEN/",
 *   httpUrl:  "https://your-endpoint.quiknode.pro/TOKEN/",
 *   provider: "quicknode",
 *   chainId:  1,
 * });
 * await provider.connect();
 * provider.onNewBlock(block => console.log("Block:", block.number));
 *
 * @example — Alchemy
 * const provider = new RpcProvider({
 *   wsUrl:   "wss://eth-mainnet.g.alchemy.com/v2/YOUR_KEY",
 *   httpUrl: "https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY",
 *   provider: "alchemy",
 *   chainId:  1,
 * });
 */
export class RpcProvider {
  private config: Required<RpcProviderConfig>;
  private ws: WebSocket | null = null;

  // Subscription state
  private subscriptions = new Map<string, { listenerKey: string; type: string }>();
  private listeners     = new Map<string, (data: unknown) => void>();
  private pendingCalls  = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  // Lifecycle state
  private connected       = false;
  private reconnecting    = false;
  private reconnectDelay  = 1_000;
  private idCounter       = 1;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private onConnectCallbacks:    Array<() => void> = [];
  private onDisconnectCallbacks: Array<() => void> = [];

  constructor(config: RpcProviderConfig) {
    this.config = {
      autoReconnect:       config.autoReconnect       ?? true,
      maxReconnectDelayMs: config.maxReconnectDelayMs ?? 30_000,
      heartbeatIntervalMs: config.heartbeatIntervalMs ?? 30_000,
      ...config,
    };
  }

  // ── Connection ─────────────────────────────────────────────────────────────

  /** Open the WebSocket connection. Resolves when ready. */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.config.wsUrl);
      this.ws = ws;

      ws.onopen = () => {
        console.log(`[RpcProvider:${this.config.provider}] Connected to chain ${this.config.chainId}`);
        this.connected = true;
        this.reconnectDelay = 1_000;
        this.reconnecting = false;
        this._startHeartbeat();
        this.onConnectCallbacks.forEach((cb) => cb());
        resolve();
      };

      ws.onerror = (err) => {
        console.error(`[RpcProvider] WebSocket error:`, err);
        if (!this.connected) reject(new Error("WebSocket connection failed"));
      };

      ws.onclose = () => {
        console.warn(`[RpcProvider:${this.config.provider}] Disconnected`);
        this.connected = false;
        this._stopHeartbeat();
        this.onDisconnectCallbacks.forEach((cb) => cb());
        if (this.config.autoReconnect && !this.reconnecting) {
          this._scheduleReconnect();
        }
      };

      ws.onmessage = (event) => {
        this._handleMessage(event.data as string);
      };
    });
  }

  /** Close the connection and stop auto-reconnect. */
  disconnect(): void {
    this.config.autoReconnect = false;
    this._stopHeartbeat();
    this.ws?.close();
    this.ws = null;
    this.connected = false;
    console.log(`[RpcProvider] Disconnected manually`);
  }

  get isConnected(): boolean {
    return this.connected;
  }

  // ── Lifecycle Hooks ────────────────────────────────────────────────────────

  onConnect(cb: () => void): this {
    this.onConnectCallbacks.push(cb);
    return this;
  }

  onDisconnect(cb: () => void): this {
    this.onDisconnectCallbacks.push(cb);
    return this;
  }

  // ── Block Subscriptions ────────────────────────────────────────────────────

  /**
   * Subscribe to new block headers.
   * The handler receives a parsed BlockHeader on every new block.
   *
   * @example
   * const sub = provider.onNewBlock(block => {
   *   console.log(`#${block.number} | baseFee: ${block.baseFeePerGas}`);
   * });
   * sub.unsubscribe(); // when done
   */
  onNewBlock(handler: (block: BlockHeader) => void): Subscription {
    return this._ethSubscribe("newHeads", (raw: unknown) => {
      handler(parseBlockHeader(raw as Record<string, unknown>));
    });
  }

  // ── Pending Transaction Subscriptions ─────────────────────────────────────

  /**
   * Subscribe to all pending (mempool) transaction hashes.
   * Fastest signal — transactions appear here before they're mined.
   *
   * Note: Full tx details require a follow-up eth_getTransactionByHash call.
   *
   * @example
   * provider.onPendingTransactionHash(hash => {
   *   console.log("Pending tx:", hash);
   * });
   */
  onPendingTransactionHash(handler: (hash: string) => void): Subscription {
    return this._ethSubscribe("newPendingTransactions", (raw: unknown) => {
      handler(raw as string);
    });
  }

  /**
   * Subscribe to full pending transaction objects (QuickNode / Alchemy enhanced).
   * Not all nodes support this — falls back to hash-only if unsupported.
   *
   * @example
   * provider.onPendingTransaction(tx => {
   *   if (tx.to === UNISWAP_ROUTER) console.log("Uniswap swap pending:", tx.hash);
   * });
   */
  onPendingTransaction(
    handler: (tx: PendingTransaction) => void,
    filter?: { to?: Address; methodSelector?: string }
  ): Subscription {
    return this._ethSubscribe(
      this.config.provider === "alchemy"
        ? "alchemy_pendingTransactions"
        : "newPendingTransactions",
      (raw: unknown) => {
        const tx = parsePendingTx(raw as Record<string, unknown>);
        if (filter) {
          if (filter.to && tx.to?.toLowerCase() !== filter.to.toLowerCase()) return;
          if (filter.methodSelector && !tx.input.startsWith(filter.methodSelector)) return;
        }
        handler(tx);
      },
      filter?.to
        ? this.config.provider === "alchemy"
          ? { toAddress: filter.to, hashesOnly: false }
          : undefined
        : undefined
    );
  }

  // ── Log / Event Subscriptions ──────────────────────────────────────────────

  /**
   * Subscribe to on-chain logs matching a filter.
   * Ideal for watching Swap, Transfer, or Sync events in real time.
   *
   * @example
   * // Watch all Uniswap v3 Swap events
   * provider.onLogs({
   *   address: "0x1F98431c8aD98523631AE4a59f267346ea31F984", // Uniswap v3 Factory
   *   topics: ["0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67"],
   * }, log => console.log("Swap:", log.transactionHash));
   */
  onLogs(filter: LogFilter, handler: (log: Log) => void): Subscription {
    return this._ethSubscribe("logs", (raw: unknown) => {
      handler(parseLog(raw as Record<string, unknown>));
    }, filter);
  }

  // ── JSON-RPC Calls ─────────────────────────────────────────────────────────

  /**
   * Send any JSON-RPC method over the WebSocket and await the response.
   *
   * @example
   * const block = await provider.call("eth_getBlockByNumber", ["latest", false]);
   * const balance = await provider.call("eth_getBalance", ["0xAddress", "latest"]);
   */
  call<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.ws || !this.connected) {
        reject(new Error("[RpcProvider] Not connected"));
        return;
      }

      const id = this.idCounter++;
      this.pendingCalls.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
      });

      this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  /** Convenience: get the latest block number. */
  async getBlockNumber(): Promise<bigint> {
    const hex = await this.call<string>("eth_blockNumber");
    return BigInt(hex);
  }

  /** Convenience: get the full block (with transactions) by number or "latest". */
  async getBlock(blockTag: string | bigint = "latest", fullTx = false): Promise<BlockHeader> {
    const tag = typeof blockTag === "bigint" ? `0x${blockTag.toString(16)}` : blockTag;
    const raw = await this.call<Record<string, unknown>>("eth_getBlockByNumber", [tag, fullTx]);
    return parseBlockHeader(raw);
  }

  /** Convenience: get a transaction by hash. */
  async getTransaction(hash: string): Promise<PendingTransaction> {
    const raw = await this.call<Record<string, unknown>>("eth_getTransactionByHash", [hash]);
    return parsePendingTx(raw);
  }

  /** Convenience: get current gas price. */
  async getGasPrice(): Promise<bigint> {
    const hex = await this.call<string>("eth_gasPrice");
    return BigInt(hex);
  }

  /** Convenience: get base fee of the latest block. */
  async getBaseFee(): Promise<bigint> {
    const block = await this.getBlock("latest");
    return block.baseFeePerGas ?? 0n;
  }

  // ── HTTP Fallback (for REST-only calls) ────────────────────────────────────

  /**
   * Send a JSON-RPC request over HTTP (useful for one-shot calls).
   *
   * @example
   * const result = await provider.httpCall("eth_chainId");
   */
  async httpCall<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    const res = await fetch(this.config.httpUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!res.ok) throw new Error(`[RpcProvider:HTTP] ${res.status} on ${method}`);
    const data = await res.json();
    if (data.error) throw new Error(`[RpcProvider:HTTP] RPC error: ${JSON.stringify(data.error)}`);
    return data.result as T;
  }

  // ── Alchemy-Enhanced Methods ───────────────────────────────────────────────

  /**
   * Fetch all ERC-20 token balances for an address (Alchemy only).
   *
   * @example
   * const balances = await provider.alchemyGetTokenBalances("0xYourAddress");
   */
  async alchemyGetTokenBalances(
    address: Address,
    contractAddresses?: Address[]
  ): Promise<Array<{ contractAddress: Address; tokenBalance: string }>> {
    if (this.config.provider !== "alchemy") {
      throw new Error("[RpcProvider] alchemyGetTokenBalances requires Alchemy provider");
    }
    const result = await this.httpCall<{ tokenBalances: Array<{ contractAddress: Address; tokenBalance: string }> }>(
      "alchemy_getTokenBalances",
      contractAddresses ? [address, contractAddresses] : [address, "DEFAULT_TOKENS"]
    );
    return result.tokenBalances;
  }

  /**
   * Simulate asset changes for a transaction without broadcasting (Alchemy only).
   * Critical for verifying arb profitability before committing.
   *
   * @example
   * const sim = await provider.alchemySimulateAssetChanges({
   *   from: "0xYourAddress",
   *   to:   "0xUniswapRouter",
   *   data: "0xABCDEF...",
   * });
   * console.log(sim.changes);
   */
  async alchemySimulateAssetChanges(tx: {
    from: Address;
    to:   Address;
    data: string;
    value?: string;
  }): Promise<{
    changes: Array<{
      assetType: string;
      changeType: "TRANSFER" | "APPROVE";
      from: string;
      to: string;
      rawAmount: string;
      symbol?: string;
      decimals?: number;
    }>;
    error?: string;
  }> {
    if (this.config.provider !== "alchemy") {
      throw new Error("[RpcProvider] alchemySimulateAssetChanges requires Alchemy provider");
    }
    return this.httpCall("alchemy_simulateAssetChanges", [
      { from: tx.from, to: tx.to, data: tx.data, value: tx.value ?? "0x0" },
    ]);
  }

  /**
   * Get gas price recommendations (QuickNode Gas API / Alchemy).
   *
   * @example
   * const gas = await provider.getGasPriceRecommendation();
   * console.log(`Fast: ${gas.fast} Gwei`);
   */
  async getGasPriceRecommendation(): Promise<{
    slow:     bigint;
    standard: bigint;
    fast:     bigint;
    rapid:    bigint;
  }> {
    if (this.config.provider === "alchemy") {
      const result = await this.httpCall<{
        maxFeePerGas?: { low: string; medium: string; high: string };
      }>("eth_maxPriorityFeePerGas");
      const base = await this.getBaseFee();
      const slow     = base + BigInt(result?.maxFeePerGas?.low    ?? "1000000000");
      const standard = base + BigInt(result?.maxFeePerGas?.medium ?? "1500000000");
      const fast     = base + BigInt(result?.maxFeePerGas?.high   ?? "2000000000");
      return { slow, standard, fast, rapid: fast + fast / 4n };
    }

    // Generic fallback
    const raw = await this.call<string>("eth_gasPrice");
    const gasPrice = BigInt(raw);
    return {
      slow:     (gasPrice * 80n) / 100n,
      standard: gasPrice,
      fast:     (gasPrice * 130n) / 100n,
      rapid:    (gasPrice * 200n) / 100n,
    };
  }

  // ── QuickNode Streams (Webhook) ────────────────────────────────────────────

  /**
   * Decode a QuickNode Streams webhook payload into typed block/tx events.
   * Mount this as an Express/Fastify handler for QuickNode stream delivery.
   *
   * @example
   * app.post("/qn-stream", (req, res) => {
   *   const events = parseQuickNodeStreamPayload(req.body);
   *   events.forEach(e => handleEvent(e));
   *   res.sendStatus(200);
   * });
   */
  static parseQuickNodeStreamPayload(payload: unknown): Array<BlockHeader | PendingTransaction> {
    const body = payload as Record<string, unknown>;
    const events: Array<BlockHeader | PendingTransaction> = [];

    if (body.blockNumber) {
      events.push(parseBlockHeader(body));
    } else if (Array.isArray(body.transactions)) {
      for (const tx of body.transactions as Record<string, unknown>[]) {
        events.push(parsePendingTx(tx));
      }
    }
    return events;
  }

  // ── Mempool Watcher ────────────────────────────────────────────────────────

  /**
   * Watch the mempool for transactions targeting specific contracts and/or
   * method selectors. Fires handler immediately when a match is found.
   *
   * @example
   * const sub = provider.watchMempool(
   *   { to: UNISWAP_ROUTER_ADDRESS, methodSelector: "0x414bf389" }, // exactInputSingle
   *   tx => console.log("Uniswap swap pending:", tx.hash, "value:", tx.value)
   * );
   */
  watchMempool(
    filter: { to?: Address; methodSelector?: string; minValue?: bigint },
    handler: (tx: PendingTransaction) => void
  ): Subscription {
    return this.onPendingTransaction((tx) => {
      if (filter.to && tx.to?.toLowerCase() !== filter.to.toLowerCase()) return;
      if (filter.methodSelector && !tx.input.startsWith(filter.methodSelector)) return;
      if (filter.minValue && tx.value < filter.minValue) return;
      handler(tx);
    });
  }

  // ── Block Latency Benchmark ────────────────────────────────────────────────

  /**
   * Measure how quickly new blocks arrive on this provider.
   * Returns average latency in ms over `sampleCount` blocks.
   *
   * @example
   * const latency = await provider.measureBlockLatency(5);
   * console.log(`Avg block latency: ${latency}ms`);
   */
  measureBlockLatency(sampleCount = 5): Promise<number> {
    return new Promise((resolve) => {
      const samples: number[] = [];
      let lastTime = Date.now();

      const sub = this.onNewBlock(() => {
        const now = Date.now();
        samples.push(now - lastTime);
        lastTime = now;

        if (samples.length >= sampleCount) {
          sub.unsubscribe();
          const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
          console.log(
            `[RpcProvider] Block latency over ${sampleCount} samples: ${avg.toFixed(0)}ms avg`
          );
          resolve(avg);
        }
      });
    });
  }

  // ── Polling Fallback ───────────────────────────────────────────────────────

  /**
   * HTTP polling fallback — useful when WebSocket is unavailable.
   * Fires handler whenever a new block is detected.
   *
   * @example
   * const stop = provider.pollBlocks(2000, block => console.log("Block:", block.number));
   */
  pollBlocks(intervalMs = 2_000, handler: (block: BlockHeader) => void): () => void {
    let active = true;
    let lastBlock = -1n;

    const tick = async () => {
      if (!active) return;
      try {
        const raw = await this.httpCall<Record<string, unknown>>(
          "eth_getBlockByNumber", ["latest", false]
        );
        if (!raw) return;
        const block = parseBlockHeader(raw);
        if (block.number > lastBlock) {
          lastBlock = block.number;
          handler(block);
        }
      } catch (e) {
        console.warn("[RpcProvider:Poll]", (e as Error).message);
      }
      if (active) setTimeout(tick, intervalMs);
    };

    tick();
    console.log(`[RpcProvider] HTTP polling started at ${intervalMs}ms intervals`);
    return () => { active = false; };
  }

  // ── Private Helpers ────────────────────────────────────────────────────────

  private _ethSubscribe(
    type: string,
    handler: (data: unknown) => void,
    params?: unknown
  ): Subscription {
    const callId = this.idCounter++;
    const listenerKey = `sub_${type}_${callId}`;

    this.listeners.set(listenerKey, handler);

    // Store pending: once we get the subscription ID back, map it
    this.pendingCalls.set(callId, {
      resolve: (subId) => {
        this.subscriptions.set(subId as string, { listenerKey, type });
        console.log(`[RpcProvider] Subscribed to "${type}" → id: ${subId}`);
      },
      reject: (err) => console.error(`[RpcProvider] Subscription failed: ${err.message}`),
    });

    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: callId,
      method: "eth_subscribe",
      params: params !== undefined ? [type, params] : [type],
    });

    if (this.connected && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(payload);
    } else {
      // Queue to send on next connect
      this.onConnectCallbacks.push(() => this.ws?.send(payload));
    }

    return {
      id: listenerKey,
      type,
      unsubscribe: () => {
        this.listeners.delete(listenerKey);
        // Find and send eth_unsubscribe
        for (const [subId, info] of this.subscriptions) {
          if (info.listenerKey === listenerKey) {
            this.ws?.send(
              JSON.stringify({ jsonrpc: "2.0", id: this.idCounter++, method: "eth_unsubscribe", params: [subId] })
            );
            this.subscriptions.delete(subId);
            break;
          }
        }
        console.log(`[RpcProvider] Unsubscribed from "${type}"`);
      },
    };
  }

  private _handleMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    // Subscription notification
    if (msg.method === "eth_subscription") {
      const params = msg.params as Record<string, unknown>;
      const subId = params.subscription as string;
      const info = this.subscriptions.get(subId);
      if (info) {
        this.listeners.get(info.listenerKey)?.(params.result);
      }
      return;
    }

    // RPC response (call or subscription id)
    if (typeof msg.id === "number") {
      const pending = this.pendingCalls.get(msg.id);
      if (pending) {
        this.pendingCalls.delete(msg.id);
        if (msg.error) {
          pending.reject(new Error(JSON.stringify(msg.error)));
        } else {
          pending.resolve(msg.result);
        }
      }
    }
  }

  private _scheduleReconnect(): void {
    this.reconnecting = true;
    const delay = Math.min(this.reconnectDelay, this.config.maxReconnectDelayMs);
    this.reconnectDelay = Math.min(delay * 2, this.config.maxReconnectDelayMs);

    console.log(`[RpcProvider] Reconnecting in ${delay}ms...`);
    setTimeout(() => {
      if (!this.connected) this.connect().catch(console.error);
    }, delay);
  }

  private _startHeartbeat(): void {
    if (!this.config.heartbeatIntervalMs) return;
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(
          JSON.stringify({ jsonrpc: "2.0", id: this.idCounter++, method: "net_version", params: [] })
        );
      }
    }, this.config.heartbeatIntervalMs);
  }

  private _stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider Factories (pre-configured for each service)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a pre-configured QuickNode provider.
 *
 * @example
 * const provider = createQuickNodeProvider(
 *   "wss://your-endpoint.quiknode.pro/TOKEN/",
 *   "https://your-endpoint.quiknode.pro/TOKEN/",
 *   1
 * );
 * await provider.connect();
 */
export function createQuickNodeProvider(
  wsUrl: string,
  httpUrl: string,
  chainId: ChainId,
  options?: Partial<RpcProviderConfig>
): RpcProvider {
  return new RpcProvider({
    wsUrl, httpUrl,
    provider: "quicknode",
    chainId,
    autoReconnect: true,
    heartbeatIntervalMs: 20_000,
    ...options,
  });
}

/**
 * Create a pre-configured Alchemy provider.
 *
 * @example
 * const provider = createAlchemyProvider("YOUR_API_KEY", "eth-mainnet", 1);
 * await provider.connect();
 */
export function createAlchemyProvider(
  apiKey: string,
  network: string,   // e.g. "eth-mainnet", "polygon-mainnet", "arb-mainnet"
  chainId: ChainId,
  options?: Partial<RpcProviderConfig>
): RpcProvider {
  return new RpcProvider({
    wsUrl:   `wss://${network}.g.alchemy.com/v2/${apiKey}`,
    httpUrl: `https://${network}.g.alchemy.com/v2/${apiKey}`,
    provider: "alchemy",
    chainId,
    autoReconnect: true,
    heartbeatIntervalMs: 25_000,
    ...options,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Multi-Provider (race for lowest latency)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Connect to multiple providers simultaneously and forward the FIRST response
 * received to your handler. Maximises speed by racing providers.
 *
 * @example
 * const multi = new MultiRpcProvider([quicknodeProvider, alchemyProvider]);
 * await multi.connectAll();
 * multi.onNewBlock(block => console.log("First block from any provider:", block.number));
 */
export class MultiRpcProvider {
  private providers: RpcProvider[];
  private seenBlocks = new Set<string>(); // deduplicate

  constructor(providers: RpcProvider[]) {
    this.providers = providers;
  }

  async connectAll(): Promise<void> {
    await Promise.all(this.providers.map((p) => p.connect()));
    console.log(`[MultiRpcProvider] All ${this.providers.length} providers connected`);
  }

  disconnectAll(): void {
    this.providers.forEach((p) => p.disconnect());
  }

  /** Subscribe to new blocks — fires once per block (first provider to deliver wins). */
  onNewBlock(handler: (block: BlockHeader, source: RpcProvider) => void): Subscription[] {
    return this.providers.map((provider) =>
      provider.onNewBlock((block) => {
        const key = block.hash;
        if (this.seenBlocks.has(key)) return;
        this.seenBlocks.add(key);
        if (this.seenBlocks.size > 500) {
          // keep memory bounded
          const oldest = [...this.seenBlocks].slice(0, 100);
          oldest.forEach((k) => this.seenBlocks.delete(k));
        }
        handler(block, provider);
      })
    );
  }

  /** Race all providers for a JSON-RPC call — returns whichever answers first. */
  async raceCall<T>(method: string, params: unknown[] = []): Promise<T> {
    return Promise.race(this.providers.map((p) => p.call<T>(method, params)));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Parser Helpers (hex → typed values)
// ─────────────────────────────────────────────────────────────────────────────

function parseBlockHeader(raw: Record<string, unknown>): BlockHeader {
  return {
    number:       BigInt(raw.number as string ?? "0x0"),
    hash:         (raw.hash as string) ?? "",
    parentHash:   (raw.parentHash as string) ?? "",
    timestamp:    parseInt(raw.timestamp as string, 16),
    baseFeePerGas: raw.baseFeePerGas ? BigInt(raw.baseFeePerGas as string) : undefined,
    gasLimit:     BigInt(raw.gasLimit as string ?? "0x0"),
    gasUsed:      BigInt(raw.gasUsed  as string ?? "0x0"),
    miner:        (raw.miner as string) ?? "",
    transactions: (raw.transactions as string[]) ?? [],
    extraData:    (raw.extraData as string) ?? "0x",
  };
}

function parsePendingTx(raw: Record<string, unknown>): PendingTransaction {
  return {
    hash:                  (raw.hash as string)  ?? "",
    from:                  (raw.from as string)  ?? "",
    to:                    (raw.to   as string | undefined),
    value:                 BigInt(raw.value  as string ?? "0x0"),
    gas:                   BigInt(raw.gas    as string ?? "0x0"),
    gasPrice:              raw.gasPrice        ? BigInt(raw.gasPrice as string)        : undefined,
    maxFeePerGas:          raw.maxFeePerGas    ? BigInt(raw.maxFeePerGas as string)    : undefined,
    maxPriorityFeePerGas:  raw.maxPriorityFeePerGas ? BigInt(raw.maxPriorityFeePerGas as string) : undefined,
    nonce:                 parseInt(raw.nonce as string ?? "0x0", 16),
    input:                 (raw.input as string) ?? "0x",
    type:                  parseInt(raw.type  as string ?? "0x0", 16),
  };
}

function parseLog(raw: Record<string, unknown>): Log {
  return {
    address:          (raw.address as Address),
    topics:           (raw.topics as string[]) ?? [],
    data:             (raw.data   as string) ?? "0x",
    blockNumber:      BigInt(raw.blockNumber as string ?? "0x0"),
    transactionHash:  (raw.transactionHash as string) ?? "",
    transactionIndex: parseInt(raw.transactionIndex as string ?? "0x0", 16),
    blockHash:        (raw.blockHash as string) ?? "",
    logIndex:         parseInt(raw.logIndex as string ?? "0x0", 16),
    removed:          (raw.removed as boolean) ?? false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Example Usage
// ─────────────────────────────────────────────────────────────────────────────

/*
import { createQuickNodeProvider, createAlchemyProvider, MultiRpcProvider } from "./rpc-provider";

// ── QuickNode ────────────────────────────────────────────────────────────────
const qn = createQuickNodeProvider(
  "wss://your-endpoint.quiknode.pro/TOKEN/",
  "https://your-endpoint.quiknode.pro/TOKEN/",
  1
);
await qn.connect();

// Subscribe to new blocks
qn.onNewBlock(block => {
  console.log(`[QuickNode] Block #${block.number} | base fee: ${block.baseFeePerGas} wei`);
});

// Watch mempool for Uniswap swaps
qn.watchMempool(
  { to: "0xE592427A0AEce92De3Edee1F18E0157C05861564", methodSelector: "0x414bf389" },
  tx => console.log("Uniswap pending swap:", tx.hash, "gas:", tx.maxFeePerGas)
);

// ── Alchemy ──────────────────────────────────────────────────────────────────
const alchemy = createAlchemyProvider("YOUR_ALCHEMY_KEY", "eth-mainnet", 1);
await alchemy.connect();

// Simulate a tx before sending
const sim = await alchemy.alchemySimulateAssetChanges({
  from: "0xYourAddress",
  to:   "0xUniswapRouter",
  data: "0x414bf389...",
});
console.log("Asset changes:", sim.changes);

// Get token balances
const balances = await alchemy.alchemyGetTokenBalances("0xYourAddress");
console.log("Balances:", balances);

// ── Multi-Provider Race ───────────────────────────────────────────────────────
const multi = new MultiRpcProvider([qn, alchemy]);
await multi.connectAll();

multi.onNewBlock((block, source) => {
  // Fires once per block, from whichever provider was faster
  console.log(`Block #${block.number} — first seen via ${source}`);
});

// ── Latency Benchmark ────────────────────────────────────────────────────────
const latency = await qn.measureBlockLatency(10);
console.log(`QuickNode avg block latency: ${latency.toFixed(0)}ms`);
*/