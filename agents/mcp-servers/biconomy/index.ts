/**
 * MCP Server: biconomy
 *
 * Code generator for Biconomy Smart Account + Session Keys.
 * Allows the agent to execute trades autonomously within
 * pre-approved spending limits without user signatures each time.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "biconomy-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

const TOOLS: Tool[] = [
  {
    name: "get_smart_account_setup",
    description:
      "Returns TypeScript code for creating a Biconomy Smart Account (ERC-4337 compatible). Required for session key functionality.",
    inputSchema: {
      type: "object",
      properties: {
        network: { type: "string", enum: ["polygon", "arbitrum", "base", "ethereum"] },
      },
      required: ["network"],
    },
  },
  {
    name: "get_session_key_setup",
    description:
      "Returns TypeScript code for creating and using Session Keys that allow the bot to execute trades autonomously within defined limits.",
    inputSchema: {
      type: "object",
      properties: {
        maxSpendPerSessionUSD: {
          type: "number",
          description: "Maximum USD value the bot can trade per session",
        },
        sessionDurationHours: {
          type: "number",
          description: "How long the session key is valid",
        },
      },
    },
  },
  {
    name: "get_gasless_tx_code",
    description:
      "Returns code for sponsoring gas via Biconomy Paymaster (gasless transactions for the bot).",
    inputSchema: { type: "object", properties: {} },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "get_smart_account_setup": {
      const network = (args as any)?.network ?? "polygon";

      return {
        content: [
          {
            type: "text",
            text: `
// ============================================================
// FILE: src/smart-account.ts
// Biconomy Smart Account (ERC-4337) Setup — ${network}
// Dependencies: @biconomy/account @biconomy/bundler @biconomy/paymaster
// ============================================================

import { createSmartAccountClient, BiconomySmartAccountV2 } from "@biconomy/account";
import { createBundler } from "@biconomy/bundler";
import { createPaymaster } from "@biconomy/paymaster";
import { ethers } from "ethers";

// Chain IDs for Biconomy
const CHAIN_IDS: Record<string, number> = {
  ethereum: 1,
  polygon: 137,
  arbitrum: 42161,
  base: 8453,
};

const CHAIN_ID = CHAIN_IDS["${network}"];

/**
 * Creates a Biconomy Smart Account for the agent.
 * This account supports session keys and gasless transactions.
 */
export async function createAgentSmartAccount(
  signerPrivateKey: string
): Promise<BiconomySmartAccountV2> {
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const signer = new ethers.Wallet(signerPrivateKey, provider);

  // Biconomy Bundler — handles UserOperation submission
  const bundler = await createBundler({
    bundlerUrl: \`https://bundler.biconomy.io/api/v2/\${CHAIN_ID}/\${process.env.BICONOMY_BUNDLER_KEY}\`,
    chainId: CHAIN_ID,
    entryPointAddress: "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789",
  });

  // Biconomy Paymaster — optional gas sponsorship
  const paymaster = await createPaymaster({
    paymasterUrl: \`https://paymaster.biconomy.io/api/v1/\${CHAIN_ID}/\${process.env.BICONOMY_PAYMASTER_KEY}\`,
  });

  // Create Smart Account
  const smartAccount = await createSmartAccountClient({
    signer,
    chainId: CHAIN_ID,
    bundler,
    paymaster,
    biconomyPaymasterApiKey: process.env.BICONOMY_PAYMASTER_KEY!,
    rpcUrl: process.env.RPC_URL!,
  });

  const address = await smartAccount.getAccountAddress();
  console.log(\`[Biconomy] Smart Account: \${address}\`);
  console.log(\`[Biconomy] Fund this address with MATIC/ETH to pay gas, or enable paymaster\`);

  return smartAccount;
}
            `,
          },
        ],
      };
    }

    case "get_session_key_setup": {
      const maxSpend = (args as any)?.maxSpendPerSessionUSD ?? 5000;
      const durationHours = (args as any)?.sessionDurationHours ?? 24;

      return {
        content: [
          {
            type: "text",
            text: `
// ============================================================
// FILE: src/session-keys.ts
// Biconomy Session Keys — Autonomous agent trading
// Max spend: $${maxSpend} USD | Duration: ${durationHours} hours
//
// SECURITY MODEL:
// - User creates smart account (one-time setup with main wallet)
// - User grants session key with strict spending limits
// - Agent uses session key to trade WITHOUT user signing each tx
// - Session expires automatically after ${durationHours} hours
// ============================================================

import {
  createSessionKeyManagerModule,
  DEFAULT_SESSION_KEY_MANAGER_MODULE,
  getSingleSessionTxParams,
} from "@biconomy/modules";
import { ethers, parseUnits } from "ethers";
import type { BiconomySmartAccountV2 } from "@biconomy/account";

// ERC20 ABI for spend limit validation
const ERC20_ABI = [
  "function transfer(address to, uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

export interface SessionConfig {
  sessionKeyAddress: string;    // The bot's dedicated session key wallet address
  tokenAddress: string;         // Which token the session can spend
  maxAmountWei: bigint;         // Max total spend for this session
  expiresAt: number;            // Unix timestamp when session expires
}

/**
 * Creates a session key that allows the bot to autonomously execute
 * specific operations (swaps) within the defined limits.
 * 
 * IMPORTANT: The user (main wallet) must call this once to grant permissions.
 */
export async function createSessionKey(
  smartAccount: BiconomySmartAccountV2,
  sessionConfig: SessionConfig
): Promise<{ sessionId: string; sessionStorageClient: any }> {
  console.log("[SessionKey] Creating session key module...");

  // Enable the Session Key Manager module on the smart account
  const sessionModule = await createSessionKeyManagerModule({
    moduleAddress: DEFAULT_SESSION_KEY_MANAGER_MODULE,
    smartAccountAddress: await smartAccount.getAccountAddress(),
  });

  const { wait, session } = await smartAccount.createSession(
    sessionModule,
    [
      {
        sessionValidationModule: process.env.ERC20_SESSION_VALIDATION_MODULE!,
        sessionPublicKey: sessionConfig.sessionKeyAddress as \`0x\${string}\`,
        sessionKeyData: new ethers.AbiCoder().encode(
          ["address", "address", "uint256", "uint48", "uint48"],
          [
            sessionConfig.sessionKeyAddress,  // Session key address
            sessionConfig.tokenAddress,        // Allowed token
            sessionConfig.maxAmountWei,        // Spending cap
            Math.floor(Date.now() / 1000),     // Valid from now
            sessionConfig.expiresAt,           // Valid until
          ]
        ),
      },
    ],
    null,
    [ethers.ZeroHash]
  );

  const { success } = await wait();
  if (!success) throw new Error("Failed to create session key");

  console.log(\`[SessionKey] ✓ Session created — bot can now trade up to $${maxSpend} autonomously\`);
  console.log(\`[SessionKey]   Expires in ${durationHours} hours\`);

  return { sessionId: session.sessionIDInfo[0], sessionStorageClient: session };
}

/**
 * Executes a transaction using the session key (no user signature needed).
 * The agent calls this for each swap during arbitrage execution.
 */
export async function executeWithSessionKey(
  smartAccount: BiconomySmartAccountV2,
  sessionStorageClient: any,
  sessionId: string,
  contractAddress: string,
  calldata: string
): Promise<string> {
  const sessionParams = await getSingleSessionTxParams(
    sessionStorageClient,
    smartAccount.chainId!,
    0
  );

  const { wait } = await smartAccount.sendTransaction(
    { to: contractAddress as \`0x\${string}\`, data: calldata as \`0x\${string}\` },
    { params: sessionParams }
  );

  const { success, receipt } = await wait();
  if (!success) throw new Error("Session key transaction failed");
  
  return receipt.transactionHash;
}

/**
 * Generates session config for the arbitrage bot.
 * Call this when setting up the agent for the first time.
 */
export function generateSessionConfig(
  sessionKeyWalletAddress: string,
  tokenAddress: string,
  tokenDecimals: number = 6  // USDC has 6 decimals
): SessionConfig {
  const maxAmountWei = parseUnits("${maxSpend}", tokenDecimals);
  const expiresAt = Math.floor(Date.now() / 1000) + (${durationHours} * 3600);

  return {
    sessionKeyAddress: sessionKeyWalletAddress,
    tokenAddress,
    maxAmountWei,
    expiresAt,
  };
}
            `,
          },
        ],
      };
    }

    case "get_gasless_tx_code": {
      return {
        content: [
          {
            type: "text",
            text: `
// FILE: src/gasless.ts
// Biconomy Paymaster — sponsor gas so the bot wallet doesn't need native tokens

import type { BiconomySmartAccountV2 } from "@biconomy/account";
import { PaymasterMode } from "@biconomy/paymaster";

/**
 * Sends a gasless transaction using Biconomy's ERC-4337 Paymaster.
 * The Biconomy Paymaster pays gas on behalf of the smart account.
 * Requires a funded Biconomy dashboard account.
 */
export async function sendGaslessTransaction(
  smartAccount: BiconomySmartAccountV2,
  to: string,
  data: string
): Promise<string> {
  const { wait } = await smartAccount.sendTransaction(
    { to, data },
    {
      paymasterServiceData: {
        mode: PaymasterMode.SPONSORED,  // Biconomy pays the gas
      },
    }
  );

  const { success, receipt } = await wait();
  if (!success) throw new Error("Gasless transaction failed");
  return receipt.transactionHash;
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
  console.error("[biconomy-mcp] Server running on stdio");
}

main().catch(console.error);