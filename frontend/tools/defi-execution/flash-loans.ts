// ============================================================
// flash-loans.ts — Flash Loan Execution: Aave v3 & Compound III
// ============================================================
//
// Flash loans let an agent borrow millions without collateral,
// provided the full amount + fee is repaid in the same transaction.
//
// Install: npm install ethers viem  (for ABI encoding)
//          npm install @aave/core-v3  (for Aave ABIs)
// Docs:
//   Aave:    https://docs.aave.com/developers/guides/flash-loans
//   Compound: https://docs.compound.finance/
// ============================================================

import type { ChainId, Address, Token, TxReceipt } from "../types";

// ── Flash Loan Types ──────────────────────────────────────────────────────────

export interface FlashLoanParams {
  /** Token(s) to borrow */
  assets: Address[];
  /** Raw amounts to borrow per token */
  amounts: bigint[];
  /** Encoded data forwarded to your receiver contract's executeOperation() */
  params?: string;
  /** 0 = no debt (must repay in same tx), 1 = stable debt, 2 = variable debt */
  modes?: number[];
}

export interface FlashLoanReceipt {
  txHash: string;
  protocol: "aave-v3" | "compound-iii";
  assets: Address[];
  amounts: bigint[];
  fees: bigint[];
  netProfit?: bigint;
  status: "success" | "reverted";
}

export interface FlashLoanCallback {
  /**
   * Called inside the flash loan transaction by your receiver contract.
   * Perform swaps / arbitrage here, then ensure repayment before returning.
   *
   * @param assets   — borrowed token addresses
   * @param amounts  — borrowed amounts (raw)
   * @param premiums — fees owed (raw); repay amounts[i] + premiums[i]
   * @param params   — arbitrary bytes your initiator encoded
   */
  onFlashLoan: (
    assets: Address[],
    amounts: bigint[],
    premiums: bigint[],
    params: string
  ) => Promise<boolean>; // return true to approve repayment
}

// ── Aave v3 Flash Loan ────────────────────────────────────────────────────────

/** Aave v3 Pool contract addresses per chain */
const AAVE_V3_POOL: Partial<Record<ChainId, Address>> = {
  1:     "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2", // Ethereum
  10:    "0x794a61358D6845594F94dc1DB02A252b5b4814aD", // Optimism
  137:   "0x794a61358D6845594F94dc1DB02A252b5b4814aD", // Polygon
  42161: "0x794a61358D6845594F94dc1DB02A252b5b4814aD", // Arbitrum
  8453:  "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5", // Base
};

/** Aave v3 flash loan fee: 0.05% (5 bps) */
const AAVE_FLASH_LOAN_FEE_BPS = 5n;

/**
 * Calculate the repayment amount (principal + Aave fee) for a given borrow.
 *
 * @example
 * const repay = calcAaveRepayment(1_000_000n * 10n**6n); // 1M USDC → repay 1,000,500 USDC
 */
export function calcAaveRepayment(amount: bigint): { principal: bigint; fee: bigint; total: bigint } {
  const fee = (amount * AAVE_FLASH_LOAN_FEE_BPS) / 10_000n;
  return { principal: amount, fee, total: amount + fee };
}

/**
 * Initiate an Aave v3 flash loan.
 *
 * In production your `receiverAddress` is a deployed smart contract that
 * implements `IFlashLoanSimpleReceiver.executeOperation()`.
 * This function encodes and submits the `flashLoan()` calldata.
 *
 * @example
 * const receipt = await aaveFlashLoan(wallet, {
 *   assets:  ["0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"], // USDC
 *   amounts: [1_000_000n * 10n**6n],                         // 1M USDC
 *   params:  "0x",
 *   modes:   [0],
 * }, receiverContractAddress, myCallback);
 */
export async function aaveFlashLoan(
  wallet: { address: Address; chainId: ChainId; sendTransaction: (tx: { to: Address; data: string; value?: bigint }) => Promise<string> },
  params: FlashLoanParams,
  receiverAddress: Address,
  callback?: FlashLoanCallback
): Promise<FlashLoanReceipt> {
  const poolAddress = AAVE_V3_POOL[wallet.chainId];
  if (!poolAddress) {
    throw new Error(`[Aave Flash Loan] Chain ${wallet.chainId} not supported.`);
  }

  const { assets, amounts, modes = amounts.map(() => 0), params: callbackParams = "0x" } = params;

  console.log(`[Aave v3] Flash loan requested on chain ${wallet.chainId}`);
  console.log(`  Assets:  ${assets.join(", ")}`);
  console.log(`  Amounts: ${amounts.map(String).join(", ")}`);

  const repayments = amounts.map((a) => calcAaveRepayment(a));
  repayments.forEach((r, i) => {
    console.log(`  [${i}] Repay: ${r.total} (fee: ${r.fee})`);
  });

  // Simulate callback (real: called by Aave inside the EVM transaction)
  let callbackSuccess = true;
  if (callback) {
    const premiums = repayments.map((r) => r.fee);
    callbackSuccess = await callback.onFlashLoan(assets, amounts, premiums, callbackParams);
    console.log(`[Aave v3] Callback result: ${callbackSuccess ? "repayment approved" : "FAILED"}`);
  }

  if (!callbackSuccess) {
    return { txHash: "", protocol: "aave-v3", assets, amounts, fees: [], status: "reverted" };
  }

  // ── Real calldata encoding (uncomment with viem or ethers) ───────────────
  // import { encodeFunctionData } from "viem";
  // const data = encodeFunctionData({
  //   abi: AAVE_POOL_ABI,
  //   functionName: "flashLoan",
  //   args: [receiverAddress, assets, amounts, modes, wallet.address, callbackParams, 0],
  // });
  // ─────────────────────────────────────────────────────────────────────────
  const data = `0xab9c4b5d`; // flashLoan selector (placeholder)

  const txHash = await wallet.sendTransaction({ to: poolAddress, data });

  const fees = repayments.map((r) => r.fee);
  console.log(`[Aave v3] Flash loan tx submitted: ${txHash}`);

  return { txHash, protocol: "aave-v3", assets, amounts, fees, status: "success" };
}

// ── Compound III (Comet) Flash Loan ──────────────────────────────────────────

/** Compound III Comet proxy addresses per chain */
const COMPOUND_COMET: Partial<Record<ChainId, Address>> = {
  1:    "0xc3d688B66703497DAA19211EEdff47f25384cdc3", // cUSDCv3 on Mainnet
  137:  "0xF25212E676D1F7F89Cd72fFEe66158f541246445", // cUSDCv3 on Polygon
  8453: "0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf", // cUSDCv3 on Base
};

/**
 * Execute a Compound III "absorb + liquidate" flash-borrow pattern.
 * Compound III does not have a native flashLoan function; instead, agents
 * use ERC-3156 wrappers or custom smart contract patterns.
 *
 * This adapter provides the wrapper interface.
 */
export async function compoundFlashBorrow(
  wallet: { address: Address; chainId: ChainId; sendTransaction: (tx: { to: Address; data: string }) => Promise<string> },
  asset: Address,
  amount: bigint,
  callback?: FlashLoanCallback
): Promise<FlashLoanReceipt> {
  const cometAddress = COMPOUND_COMET[wallet.chainId];
  if (!cometAddress) {
    throw new Error(`[Compound III] Chain ${wallet.chainId} not supported.`);
  }

  console.log(`[Compound III] Flash borrow ${amount} of ${asset} on chain ${wallet.chainId}`);

  // Compound charges 0 fee for flash borrows (repay within same block)
  const fee = 0n;

  if (callback) {
    await callback.onFlashLoan([asset], [amount], [fee], "0x");
  }

  // Real: call your ERC-3156 wrapper contract
  const txHash = await wallet.sendTransaction({ to: cometAddress, data: "0x1232143a" });

  console.log(`[Compound III] Flash borrow tx: ${txHash}`);
  return { txHash, protocol: "compound-iii", assets: [asset], amounts: [amount], fees: [fee], status: "success" };
}

// ── Flash Loan Arbitrage Template ─────────────────────────────────────────────

export interface ArbFlashLoanParams {
  /** Token to borrow and start the arb with */
  borrowToken: Address;
  /** Amount to borrow in raw units */
  borrowAmount: bigint;
  /** DEX to buy on (lower price) */
  buyDex: { name: string; execute: (amountIn: bigint) => Promise<bigint> };
  /** DEX to sell on (higher price) */
  sellDex: { name: string; execute: (amountIn: bigint) => Promise<bigint> };
  /** Minimum profit in raw units before proceeding */
  minProfitThreshold: bigint;
  wallet: { address: Address; chainId: ChainId; sendTransaction: (tx: { to: Address; data: string }) => Promise<string> };
  protocol?: "aave-v3" | "compound-iii";
}

/**
 * Full flash-loan-backed arbitrage execution template.
 * 1. Calculates expected profit
 * 2. Borrows via Aave/Compound
 * 3. Executes buy on DEX A, sell on DEX B
 * 4. Repays loan + fee, keeps profit
 *
 * @example
 * const result = await executeArbFlashLoan({
 *   borrowToken: USDC_ADDRESS,
 *   borrowAmount: 1_000_000n * 10n**6n,
 *   buyDex:  { name: "Uniswap",  execute: uniswapBuy },
 *   sellDex: { name: "Curve",    execute: curveSell },
 *   minProfitThreshold: 50n * 10n**6n, // $50 minimum
 *   wallet,
 * });
 */
export async function executeArbFlashLoan(params: ArbFlashLoanParams): Promise<{
  attempted: boolean;
  profit?: bigint;
  receipt?: FlashLoanReceipt;
  reason?: string;
}> {
  const { borrowToken, borrowAmount, buyDex, sellDex, minProfitThreshold, wallet, protocol = "aave-v3" } = params;

  // Step 1: Pre-flight profit check
  const repay = calcAaveRepayment(borrowAmount);
  const boughtAmount = await buyDex.execute(borrowAmount);
  const finalAmount = await sellDex.execute(boughtAmount);
  const profit = finalAmount - repay.total;

  console.log(`[ArbFlashLoan] Profit estimate: ${profit} (threshold: ${minProfitThreshold})`);

  if (profit < minProfitThreshold) {
    return { attempted: false, reason: `Profit ${profit} below threshold ${minProfitThreshold}` };
  }

  // Step 2: Build callback — runs inside the flash loan tx
  const callback: FlashLoanCallback = {
    onFlashLoan: async (assets, amounts, premiums) => {
      console.log(`[ArbFlashLoan] Inside flash loan — executing arb`);
      const bought = await buyDex.execute(amounts[0]);
      console.log(`  Bought ${bought} on ${buyDex.name}`);
      const received = await sellDex.execute(bought);
      console.log(`  Sold   ${received} on ${sellDex.name}`);
      const repayAmount = amounts[0] + premiums[0];
      if (received < repayAmount) {
        console.error(`  ABORT: received ${received} < repay ${repayAmount}`);
        return false;
      }
      console.log(`  Net profit: ${received - repayAmount}`);
      return true;
    },
  };

  // Step 3: Execute flash loan
  const receipt =
    protocol === "aave-v3"
      ? await aaveFlashLoan(wallet, { assets: [borrowToken], amounts: [borrowAmount] }, wallet.address, callback)
      : await compoundFlashBorrow(wallet, borrowToken, borrowAmount, callback);

  return { attempted: true, profit, receipt };
}

// ── Example Usage ─────────────────────────────────────────────────────────────

/*
import { aaveFlashLoan, calcAaveRepayment, executeArbFlashLoan } from "./flash-loans";
import { createMockWallet } from "./goat";

const wallet = createMockWallet("0xYourAddress", 1);

// Simple repayment calculation
const { total, fee } = calcAaveRepayment(1_000_000n * 10n**6n);
console.log(`Repay: ${total} USDC (fee: ${fee} USDC)`);

// Full arb template
const result = await executeArbFlashLoan({
  borrowToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
  borrowAmount: 500_000n * 10n**6n,
  buyDex:  { name: "Uniswap", execute: async (a) => (a * 1002n) / 1000n },
  sellDex: { name: "Curve",   execute: async (a) => (a * 1001n) / 1000n },
  minProfitThreshold: 10n * 10n**6n,
  wallet,
});
console.log(result);
*/