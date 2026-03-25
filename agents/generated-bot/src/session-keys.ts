// ============================================================
// FILE: src/session-keys.ts
// Biconomy Session Keys — Autonomous agent trading
// Max spend: $50000 USD | Duration: 24 hours
//
// SECURITY MODEL:
// - User creates smart account (one-time setup with main wallet)
// - User grants session key with strict spending limits
// - Agent uses session key to trade WITHOUT user signing each tx
// - Session expires automatically after 24 hours
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
        sessionPublicKey: sessionConfig.sessionKeyAddress as `0x${string}`,
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

  console.log(`[SessionKey] ✓ Session created — bot can now trade up to $50000 autonomously`);
  console.log(`[SessionKey]   Expires in 24 hours`);

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
    { to: contractAddress as `0x${string}`, data: calldata as `0x${string}` },
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
  const maxAmountWei = parseUnits("50000", tokenDecimals);
  const expiresAt = Math.floor(Date.now() / 1000) + (24 * 3600);

  return {
    sessionKeyAddress: sessionKeyWalletAddress,
    tokenAddress,
    maxAmountWei,
    expiresAt,
  };
}