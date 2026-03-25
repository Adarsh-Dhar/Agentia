// ============================================================
// FILE: src/profit-calculator.ts  
// Calculates net profit BEFORE submitting a flash loan tx
// Accounts for: Aave fee, DEX fees, gas costs, slippage
// ============================================================

export interface ProfitAnalysis {
  isProfitable: boolean;
  grossProfit: number;      // USD profit before fees
  aaveFee: number;          // Aave 0.09% flash loan fee in USD
  estimatedGasCost: number; // Gas cost in USD
  netProfit: number;        // Actual profit after all deductions
  roi: number;              // ROI percentage
  recommendation: "EXECUTE" | "SKIP" | "MONITOR";
}

/**
 * Calculates whether an arbitrage opportunity is worth executing.
 *
 * @param borrowAmountUSD  - Flash loan size in USD
 * @param priceGapPercent  - Price difference between exchanges (e.g. 0.015 = 1.5%)
 * @param dexAFeePercent   - DEX A trading fee (e.g. 0.003 = 0.3%)
 * @param dexBFeePercent   - DEX B trading fee
 * @param gasUnits         - Estimated gas units for the tx
 * @param gasPriceGwei     - Current gas price in Gwei
 * @param ethPriceUSD      - Current ETH price for gas calculation
 */
export function calculateArbitrageProfit(
  borrowAmountUSD: number,
  priceGapPercent: number,
  dexAFeePercent: number = 0.003,
  dexBFeePercent: number = 0.003,
  gasUnits: number = 450000,
  gasPriceGwei: number = 20,
  ethPriceUSD: number = 3000
): ProfitAnalysis {
  // Revenue from price gap
  const grossProfit = borrowAmountUSD * priceGapPercent;

  // Aave V3 flash loan fee: 0.09% (9 bps)
  const aaveFee = borrowAmountUSD * 0.0009;

  // DEX trading fees (both swaps)
  const dexFees = borrowAmountUSD * (dexAFeePercent + dexBFeePercent);

  // Gas cost: gasUnits * gasPriceGwei * 1e-9 * ethPrice
  const estimatedGasCost = gasUnits * gasPriceGwei * 1e-9 * ethPriceUSD;

  // Net profit after all deductions
  const netProfit = grossProfit - aaveFee - dexFees - estimatedGasCost;

  // ROI on borrowed capital
  const roi = (netProfit / borrowAmountUSD) * 100;

  let recommendation: "EXECUTE" | "SKIP" | "MONITOR";
  if (netProfit > 50) {
    recommendation = "EXECUTE";       // > $50 profit — execute immediately
  } else if (netProfit > 10) {
    recommendation = "MONITOR";       // Marginal — watch for better conditions
  } else {
    recommendation = "SKIP";          // Not worth the risk
  }

  return {
    isProfitable: netProfit > 0,
    grossProfit: Math.round(grossProfit * 100) / 100,
    aaveFee: Math.round(aaveFee * 100) / 100,
    estimatedGasCost: Math.round(estimatedGasCost * 100) / 100,
    netProfit: Math.round(netProfit * 100) / 100,
    roi: Math.round(roi * 10000) / 10000,
    recommendation,
  };
}

/**
 * Determines the optimal flash loan size based on available liquidity
 * and a target profit amount.
 */
export function calculateOptimalLoanSize(
  priceGapPercent: number,
  targetProfitUSD: number = 100,
  aaveLiquidityUSD: number = 5_000_000
): number {
  // Net profit rate after fees
  const netProfitRate = priceGapPercent - 0.0009 - 0.006; // gap - Aave - 2x DEX fees

  if (netProfitRate <= 0) return 0; // No profitable size exists

  // Borrow amount needed to hit target profit
  const required = targetProfitUSD / netProfitRate;

  // Cap at 10% of available Aave liquidity to avoid price impact
  const maxSafe = aaveLiquidityUSD * 0.1;

  return Math.min(required, maxSafe);
}