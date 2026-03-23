// ============================================================
// biconomy.ts — Smart Accounts via MEE (Modular Execution Env)
// ============================================================
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { http } from "viem"; // <-- ADDED: We need this for the network transport
import type { Address } from "../types";

export interface WalletSetupResult {
  smartAccountAddress: Address;
  meeClient: any; 
}

/**
 * Creates a Biconomy Nexus Smart Account using the new MEE architecture.
 */
export async function setupSmartAccountAndSessionKey(
  userPrivateKey: `0x${string}`
): Promise<WalletSetupResult> {
  console.log("[Biconomy MEE] Starting Wallet Setup...");

  // Dynamically import ALL required Biconomy ESM modules
  const { 
    createMeeClient, 
    toMultichainNexusAccount,
    getMEEVersion,
    MEEVersion
  } = await import("@biconomy/abstractjs");

  // 1. Initialize User's EOA (The "Signer")
  const ownerAccount = privateKeyToAccount(userPrivateKey);

  try {
    // 2. Create the Multichain Nexus Account
    const nexusAccount = await toMultichainNexusAccount({
      signer: ownerAccount,
      // 🌟 FIX: Biconomy explicitly requires this exact array structure 🌟
      chainConfigurations: [
        {
          chain: baseSepolia,
          transport: http(),
          version: getMEEVersion(MEEVersion.V2_1_0) // Ensures version compatibility
        }
      ],
    });

    // 3. Initialize the MEE Client
    const meeClient = await createMeeClient({ account: nexusAccount });

    // Extract the Smart Account Address safely
    const saAddress = nexusAccount.addressOn(baseSepolia.id); 
    console.log(`✅ [Biconomy MEE] Smart Account Ready: ${saAddress}`);

    return {
      smartAccountAddress: saAddress as Address,
      meeClient: meeClient
    };

  } catch (error) {
    console.error("❌ [Biconomy MEE] Failed to initialize MEE Client:", error);
    throw error;
  }
}