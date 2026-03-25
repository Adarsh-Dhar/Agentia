// ============================================================
// goat.ts — GOAT: Great Onchain Agent Toolkit
// ============================================================
//
// GOAT is the unified adapter layer that connects an AI agent to
// ANY on-chain protocol (Aave, Uniswap, Jupiter, etc.) without
// writing bespoke integration code for each one.
//
// Install: pnpm install @goat-sdk/core @goat-sdk/adapter-vercel-ai
//          pnpm install @goat-sdk/plugin-uniswap @goat-sdk/plugin-aave
// Docs: https://ohmygoat.dev/
// ============================================================

import type { ChainId, Address, Token, TxReceipt, PriceQuote } from "../types";

// ── Protocol Plugin Interface ─────────────────────────────────────────────────

export interface GoatPlugin {
  name: string;
  supportedChains: ChainId[];
  /** Return the list of tool-call definitions this plugin exposes to the LLM. */
  getTools(): GoatTool[];
}

export interface GoatToolParameter {
  name: string;
  type: "string" | "number" | "boolean" | "address" | "bigint";
  description: string;
  required: boolean;
}

export interface GoatTool {
  name: string;
  description: string;
  parameters: GoatToolParameter[];
  execute: (
    args: Record<string, unknown>,
    wallet: WalletClient
  ) => Promise<unknown>;
}

// ── Wallet Client Abstraction ─────────────────────────────────────────────────

export interface WalletClient {
  address: Address;
  chainId: ChainId;
  /** Sign & broadcast a transaction. Returns tx hash. */
  sendTransaction: (tx: UnsignedTx) => Promise<string>;
  /** Read-only call (no gas). */
  call: (tx: UnsignedTx) => Promise<string>;
  /** Current native balance in wei / lamports. */
  getBalance: () => Promise<bigint>;
}

export interface UnsignedTx {
  to: Address;
  data?: string;         // ABI-encoded calldata
  value?: bigint;        // native value to send
  gasLimit?: bigint;
}

// ── Mock Wallet (for testing without a real private key) ──────────────────────

/**
 * Create a read-only mock wallet for simulation and testing.
 *
 * @example
 * const wallet = createMockWallet("0xYourAddress", 1);
 */
export function createMockWallet(address: Address, chainId: ChainId): WalletClient {
  return {
    address,
    chainId,
    sendTransaction: async (tx) => {
      console.log(`[GOAT:MockWallet] Simulated tx → ${tx.to} | data: ${(tx.data ?? "0x").slice(0, 20)}...`);
      return `0xmock_tx_${Date.now().toString(16)}`;
    },
    call: async (tx) => {
      console.log(`[GOAT:MockWallet] Simulated call → ${tx.to}`);
      return "0x";
    },
    getBalance: async () => BigInt("1000000000000000000"), // 1 ETH
  };
}

// ── GOAT Toolkit ─────────────────────────────────────────────────────────────

export interface GoatToolkitOptions {
  wallet: WalletClient;
  plugins: GoatPlugin[];
}

/**
 * The central GOAT toolkit. Aggregates plugins and exposes a unified
 * tool registry for the LLM / agent framework to call.
 *
 * @example
 * const toolkit = new GoatToolkit({
 *   wallet: createMockWallet("0xAbc...", 1),
 *   plugins: [uniswapPlugin, aavePlugin],
 * });
 *
 * const tools = toolkit.getTools();  // pass these to LangChain / ElizaOS etc.
 * const result = await toolkit.executeTool("uniswap_swap", { ... });
 */
export class GoatToolkit {
  private wallet: WalletClient;
  private plugins: GoatPlugin[];
  private toolRegistry: Map<string, GoatTool> = new Map();

  constructor(options: GoatToolkitOptions) {
    this.wallet = options.wallet;
    this.plugins = options.plugins;
    this._registerAll();
  }

  private _registerAll(): void {
    for (const plugin of this.plugins) {
      const supported = plugin.supportedChains.includes(this.wallet.chainId);
      if (!supported) {
        console.warn(
          `[GOAT] Plugin "${plugin.name}" does not support chain ${this.wallet.chainId} — skipping.`
        );
        continue;
      }
      for (const tool of plugin.getTools()) {
        if (this.toolRegistry.has(tool.name)) {
          console.warn(`[GOAT] Tool name collision: "${tool.name}" — overwriting with ${plugin.name}`);
        }
        this.toolRegistry.set(tool.name, tool);
        console.log(`[GOAT] Registered tool: ${tool.name} (from ${plugin.name})`);
      }
    }
  }

  /** Get all registered tool definitions (pass to your LLM framework). */
  getTools(): GoatTool[] {
    return Array.from(this.toolRegistry.values());
  }

  /** Execute a single tool by name with raw args from the LLM. */
  async executeTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const tool = this.toolRegistry.get(name);
    if (!tool) throw new Error(`[GOAT] Unknown tool: "${name}". Available: ${[...this.toolRegistry.keys()].join(", ")}`);

    console.log(`[GOAT] Executing: ${name}`, JSON.stringify(args));
    const result = await tool.execute(args, this.wallet);
    console.log(`[GOAT] Result:`, result);
    return result;
  }

  /** Swap the active wallet (e.g. when a session key is provisioned). */
  switchWallet(newWallet: WalletClient): void {
    this.wallet = newWallet;
    console.log(`[GOAT] Wallet switched → ${newWallet.address} on chain ${newWallet.chainId}`);
  }

  listPlugins(): string[] {
    return this.plugins.map((p) => p.name);
  }

  hasPlugin(name: string): boolean {
    return this.plugins.some((p) => p.name === name);
  }
}

// ── Built-in Plugin Factories ─────────────────────────────────────────────────

/**
 * Create a Uniswap v3 plugin stub.
 * Real impl: pnpm install @goat-sdk/plugin-uniswap
 */
export function createUniswapPlugin(): GoatPlugin {
  return {
    name: "uniswap-v3",
    supportedChains: [1, 10, 137, 42161, 8453],
    getTools: () => [
      {
        name: "uniswap_get_quote",
        description: "Get a swap quote from Uniswap v3. Returns expected output amount and price impact.",
        parameters: [
          { name: "tokenIn",  type: "address", description: "Input token address",  required: true },
          { name: "tokenOut", type: "address", description: "Output token address", required: true },
          { name: "amountIn", type: "bigint",  description: "Amount in raw units",  required: true },
          { name: "fee",      type: "number",  description: "Pool fee tier: 500 | 3000 | 10000", required: false },
        ],
        execute: async (args, wallet) => {
          console.log(`[Uniswap] Quote: ${args.amountIn} of ${args.tokenIn} → ${args.tokenOut} on chain ${wallet.chainId}`);
          // Real: call Uniswap Quoter contract or the official API
          return {
            amountOut: BigInt("995000000"),
            priceImpact: 0.12,
            route: ["USDC", "ETH"],
            fee: args.fee ?? 3000,
          };
        },
      },
      {
        name: "uniswap_swap",
        description: "Execute a swap on Uniswap v3.",
        parameters: [
          { name: "tokenIn",     type: "address", description: "Input token address",        required: true },
          { name: "tokenOut",    type: "address", description: "Output token address",       required: true },
          { name: "amountIn",    type: "bigint",  description: "Amount in raw units",        required: true },
          { name: "slippagePct", type: "number",  description: "Max slippage %, e.g. 0.5",  required: false },
          { name: "recipient",   type: "address", description: "Recipient address",          required: false },
        ],
        execute: async (args, wallet) => {
          const recipient = (args.recipient as Address) ?? wallet.address;
          console.log(`[Uniswap] Swap ${args.amountIn} ${args.tokenIn} → ${args.tokenOut} for ${recipient}`);
          // Real: encode SwapRouter02 exactInputSingle calldata and call wallet.sendTransaction
          const txHash = await wallet.sendTransaction({
            to: "0xE592427A0AEce92De3Edee1F18E0157C05861564", // SwapRouter02
            data: `0x${Buffer.from(JSON.stringify(args)).toString("hex").slice(0, 64)}`,
            value: 0n,
          });
          return { txHash, status: "submitted" };
        },
      },
    ],
  };
}

/**
 * Create an Aave v3 plugin stub.
 * Real impl: pnpm install @goat-sdk/plugin-aave
 */
export function createAavePlugin(): GoatPlugin {
  return {
    name: "aave-v3",
    supportedChains: [1, 10, 137, 42161],
    getTools: () => [
      {
        name: "aave_supply",
        description: "Supply an asset to Aave v3 to earn yield.",
        parameters: [
          { name: "asset",  type: "address", description: "Token to supply",         required: true },
          { name: "amount", type: "bigint",  description: "Amount in raw token units", required: true },
        ],
        execute: async (args, wallet) => {
          console.log(`[Aave] Supplying ${args.amount} of ${args.asset}`);
          const txHash = await wallet.sendTransaction({
            to: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2", // Aave v3 Pool
            data: "0x617ba037", // supply(address,uint256,address,uint16)
          });
          return { txHash, asset: args.asset, amount: args.amount };
        },
      },
      {
        name: "aave_borrow",
        description: "Borrow an asset from Aave v3 against supplied collateral.",
        parameters: [
          { name: "asset",        type: "address", description: "Token to borrow",              required: true },
          { name: "amount",       type: "bigint",  description: "Amount in raw units",          required: true },
          { name: "interestMode", type: "number",  description: "1 = stable, 2 = variable",    required: false },
        ],
        execute: async (args, wallet) => {
          console.log(`[Aave] Borrowing ${args.amount} of ${args.asset}`);
          const txHash = await wallet.sendTransaction({
            to: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
            data: "0xa415bcad",
          });
          return { txHash, asset: args.asset, amount: args.amount, interestMode: args.interestMode ?? 2 };
        },
      },
    ],
  };
}

// ── Example Usage ─────────────────────────────────────────────────────────────

/*
import { GoatToolkit, createMockWallet, createUniswapPlugin, createAavePlugin } from "./goat";

const wallet  = createMockWallet("0xYourAddress", 1);
const toolkit = new GoatToolkit({
  wallet,
  plugins: [createUniswapPlugin(), createAavePlugin()],
});

const quote = await toolkit.executeTool("uniswap_get_quote", {
  tokenIn: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",  // USDC
  tokenOut: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH
  amountIn: BigInt("1000000000"), // 1000 USDC
});
console.log(quote);
*/