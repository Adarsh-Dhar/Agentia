/**
 * MCP Server: goat-solana
 * 
 * Provides code generation tools for GOAT SDK + Solana wallet setup.
 * The Meta-Agent calls these tools to get boilerplate for on-chain execution.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "goat-solana-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// ─── Tool Definitions ────────────────────────────────────────────────────────

const TOOLS: Tool[] = [
  {
    name: "get_goat_initialization",
    description:
      "Returns TypeScript code to initialize GOAT SDK with a Solana wallet and connection. Use this as the foundation of any Solana on-chain bot.",
    inputSchema: {
      type: "object",
      properties: {
        includeJupiter: {
          type: "boolean",
          description: "Whether to include Jupiter plugin for swap execution",
        },
        includeSessionKey: {
          type: "boolean",
          description: "Whether to include Biconomy session key setup",
        },
      },
    },
  },
  {
    name: "get_goat_tool_binding",
    description:
      "Returns the TypeScript code for binding GOAT on-chain tools to a LangChain/LangGraph agent.",
    inputSchema: {
      type: "object",
      properties: {
        agentFramework: {
          type: "string",
          enum: ["langgraph", "langchain"],
          description: "Which agent framework to bind tools to",
        },
      },
      required: ["agentFramework"],
    },
  },
  {
    name: "get_dependencies",
    description:
      "Returns the exact npm install command with all required GOAT + Solana dependencies.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_env_template",
    description:
      "Returns the .env file template required for GOAT Solana bot to function.",
    inputSchema: { type: "object", properties: {} },
  },
];

// ─── Tool Handlers ────────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "get_goat_initialization": {
      const includeJupiter = (args as any)?.includeJupiter ?? true;
      const includeSessionKey = (args as any)?.includeSessionKey ?? false;

      return {
        content: [
          {
            type: "text",
            text: `
// ============================================================
// FILE: src/wallet.ts
// GOAT SDK + Solana Wallet Initialization
// Dependencies: @goat-sdk/core @goat-sdk/wallet-solana @solana/web3.js
// ============================================================

import { getOnChainTools } from "@goat-sdk/core";
import { solana } from "@goat-sdk/wallet-solana";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
${includeJupiter ? 'import { jupiter } from "@goat-sdk/plugin-jupiter";' : ""}
${includeSessionKey ? 'import { biconomySessionKey } from "@goat-sdk/plugin-biconomy";' : ""}

/**
 * Initializes the Solana connection and GOAT wallet adapter.
 * Private key is NEVER hardcoded — always sourced from environment variables.
 */
export async function initializeWallet() {
  // Validate required environment variables
  if (!process.env.SOLANA_RPC_URL) throw new Error("SOLANA_RPC_URL not set");
  if (!process.env.WALLET_PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY not set");

  // Create Solana connection (use commitment 'confirmed' for speed)
  const connection = new Connection(process.env.SOLANA_RPC_URL, {
    commitment: "confirmed",
    wsEndpoint: process.env.SOLANA_WS_URL,
  });

  // Reconstruct keypair from base58 or JSON byte array
  let keypair: Keypair;
  try {
    // Try JSON array format first: [12, 34, 56, ...]
    const parsed = JSON.parse(process.env.WALLET_PRIVATE_KEY);
    keypair = Keypair.fromSecretKey(Uint8Array.from(parsed));
  } catch {
    // Fall back to base58 string format
    const { bs58 } = await import("bs58");
    keypair = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
  }

  console.log(\`[GOAT] Wallet initialized: \${keypair.publicKey.toBase58()}\`);

  // Initialize GOAT on-chain tools with selected plugins
  const tools = await getOnChainTools({
    wallet: solana(connection, keypair),
    plugins: [
      ${includeJupiter ? "jupiter({ slippageBps: 50 }), // 0.5% slippage" : "// Add plugins here: jupiter(), etc."}
      ${includeSessionKey ? "biconomySessionKey({ sessionKeyConfig: process.env.SESSION_KEY_CONFIG })," : ""}
    ],
  });

  return { tools, connection, keypair, publicKey: keypair.publicKey };
}

/**
 * Returns the wallet's current SOL and token balances.
 */
export async function getWalletBalances(
  connection: Connection,
  publicKey: PublicKey
) {
  const solBalance = await connection.getBalance(publicKey);
  return {
    sol: solBalance / 1e9,
    publicKey: publicKey.toBase58(),
  };
}
            `,
          },
        ],
      };
    }

    case "get_goat_tool_binding": {
      const framework = (args as any)?.agentFramework ?? "langgraph";

      if (framework === "langgraph") {
        return {
          content: [
            {
              type: "text",
              text: `
// ============================================================
// FILE: src/agent-tools.ts  
// GOAT Tool Binding for LangGraph
// ============================================================

import { initializeWallet } from "./wallet.js";
import { DynamicStructuredTool } from "@langchain/core/tools";

/**
 * Converts GOAT SDK tools into LangChain-compatible DynamicStructuredTools
 * that can be passed directly into a LangGraph StateGraph node.
 */
export async function getAgentTools(): Promise<DynamicStructuredTool[]> {
  const { tools } = await initializeWallet();

  // GOAT automatically creates properly typed LangChain tools
  // Each tool has: name, description, schema, and an async execute function
  return tools as unknown as DynamicStructuredTool[];
}

/**
 * Tool inventory helper — logs all available on-chain tools to console.
 * Useful for debugging what capabilities the agent has loaded.
 */
export async function listAvailableTools() {
  const tools = await getAgentTools();
  console.log("[GOAT] Available on-chain tools:");
  tools.forEach((t) => console.log(\`  - \${t.name}: \${t.description}\`));
  return tools.map((t) => ({ name: t.name, description: t.description }));
}
              `,
            },
          ],
        };
      }

      // langchain fallback
      return {
        content: [
          {
            type: "text",
            text: `
// LangChain AgentExecutor binding
import { AgentExecutor, createOpenAIFunctionsAgent } from "langchain/agents";
import { getAgentTools } from "./agent-tools.js";

const tools = await getAgentTools();
const agent = await createOpenAIFunctionsAgent({ llm, tools, prompt });
const executor = new AgentExecutor({ agent, tools, verbose: true });
            `,
          },
        ],
      };
    }

    case "get_dependencies": {
      return {
        content: [
          {
            type: "text",
            text: `
# GOAT + Solana Dependencies
# Run this command in your bot project root:

npm install \\
  @goat-sdk/core \\
  @goat-sdk/wallet-solana \\
  @goat-sdk/plugin-jupiter \\
  @solana/web3.js \\
  @solana/spl-token \\
  bs58 \\
  dotenv

# TypeScript types:
npm install -D @types/node typescript ts-node

# Verify installation:
# node -e "require('@goat-sdk/core'); console.log('GOAT OK')"
            `,
          },
        ],
      };
    }

    case "get_env_template": {
      return {
        content: [
          {
            type: "text",
            text: `
# ============================================================
# FILE: .env.template
# Copy to .env and fill in your values
# NEVER commit .env to version control
# ============================================================

# Solana RPC endpoint (use QuickNode or Alchemy for production)
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
SOLANA_WS_URL=wss://api.mainnet-beta.solana.com

# Wallet private key (JSON byte array format recommended)
# Generate with: node -e "const k=require('@solana/web3.js').Keypair.generate(); console.log(JSON.stringify(Array.from(k.secretKey)))"
WALLET_PRIVATE_KEY=[1,2,3,...] 

# (Optional) Biconomy Session Key config JSON
SESSION_KEY_CONFIG={}

# Bot execution params
MAX_TRADE_SIZE_USD=1000
SLIPPAGE_BPS=50
DRY_RUN=true
            `,
          },
        ],
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// ─── Start Server ─────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[goat-solana-mcp] Server running on stdio");
}

main().catch(console.error);