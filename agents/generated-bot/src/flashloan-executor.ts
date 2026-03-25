// ============================================================
// FILE: src/flashloan-executor.ts
// Agent-side executor that calls the deployed FlashLoanArbitrageur contract
// Library: ethers
// ============================================================

import { ethers } from "ethers";
import * as dotenv from "dotenv";
dotenv.config();

// ABI — only the functions we need
const ARBITRAGEUR_ABI = [
  "function executeArbitrage((address tokenBorrow, address tokenInterim, uint256 amountBorrow, uint24 feeDexA, uint24 feeDexB, uint256 minProfit)) external",
  "function withdrawProfit(address token) external",
  "event ArbitrageExecuted(address indexed tokenBorrow, uint256 amountBorrowed, uint256 profit)",
];

export interface ArbitrageParams {
  tokenBorrow: string;    // ERC20 token address to borrow
  tokenInterim: string;   // Intermediate swap token address
  amountBorrow: bigint;   // Amount in token's native decimals
  feeDexA: number;        // Uniswap fee tier: 500 | 3000 | 10000
  feeDexB: number;        // SushiSwap fee tier
  minProfit: bigint;      // Minimum profit in tokenBorrow decimals (safety floor)
}

export class FlashLoanExecutor {
  private provider: ethers.JsonRpcProvider;
  private signer: ethers.Wallet;
  private contract: ethers.Contract;
  private dryRun: boolean;

  constructor() {
    this.provider = new ethers.JsonRpcProvider(process.env.EVM_RPC_URL);
    this.signer = new ethers.Wallet(process.env.EVM_PRIVATE_KEY!, this.provider);
    this.contract = new ethers.Contract(
      process.env.ARBITRAGEUR_CONTRACT_ADDRESS!,
      ARBITRAGEUR_ABI,
      this.signer
    );
    this.dryRun = process.env.DRY_RUN === "true";
  }

  /**
   * Simulates the arbitrage transaction via eth_call before submitting.
   * If simulation fails, the actual tx would revert — we skip it.
   */
  async simulate(params: ArbitrageParams): Promise<boolean> {
    try {
      await this.contract.executeArbitrage.staticCall(params);
      console.log("[FlashLoan] Simulation PASSED ✓");
      return true;
    } catch (err: any) {
      console.log(`[FlashLoan] Simulation FAILED: ${err.message}`);
      return false;
    }
  }

  /**
   * Execute the flash loan arbitrage on-chain.
   * Always simulates first; only submits if simulation passes.
   */
  async execute(params: ArbitrageParams): Promise<{
    success: boolean;
    txHash?: string;
    profit?: string;
    error?: string;
  }> {
    console.log("[FlashLoan] Preparing arbitrage execution...");
    console.log(`  Borrow: ${ethers.formatUnits(params.amountBorrow, 6)} USDC`);

    // Step 1: Always simulate first
    const simPassed = await this.simulate(params);
    if (!simPassed) {
      return { success: false, error: "Simulation failed — tx would revert" };
    }

    if (this.dryRun) {
      console.log("[FlashLoan] DRY RUN MODE — skipping actual submission");
      return { success: true, txHash: "dry-run-" + Date.now() };
    }

    // Step 2: Estimate gas with 20% buffer
    const gasEstimate = await this.contract.executeArbitrage.estimateGas(params);
    const gasLimit = (gasEstimate * BigInt(120)) / BigInt(100);

    // Step 3: Submit transaction
    try {
      const tx = await this.contract.executeArbitrage(params, { gasLimit });
      console.log(`[FlashLoan] TX submitted: ${tx.hash}`);

      const receipt = await tx.wait();
      
      // Parse profit from event logs
      const event = receipt.logs
        .map((log: any) => {
          try { return this.contract.interface.parseLog(log); } catch { return null; }
        })
        .find((e: any) => e?.name === "ArbitrageExecuted");

      const profitFormatted = event 
        ? ethers.formatUnits(event.args.profit, 6) 
        : "unknown";

      console.log(`[FlashLoan] SUCCESS! Profit: $${profitFormatted} USDC`);
      return { success: true, txHash: tx.hash, profit: profitFormatted };

    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Withdraw accumulated profits to your wallet.
   */
  async withdrawProfit(tokenAddress: string) {
    const tx = await this.contract.withdrawProfit(tokenAddress);
    await tx.wait();
    console.log(`[FlashLoan] Profits withdrawn: ${tx.hash}`);
  }
}