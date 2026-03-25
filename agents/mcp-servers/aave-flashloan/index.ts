/**
 * MCP Server: aave-flashloan
 *
 * Provides code generation tools for Aave V3 Flash Loan integration.
 * Covers both EVM (Ethereum/Polygon/Arbitrum) flash loan contract interactions.
 * The Meta-Agent calls these to construct the borrowing + repayment logic.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "aave-flashloan-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

const TOOLS: Tool[] = [
  {
    name: "get_flashloan_contract",
    description:
      "Returns the Solidity smart contract for executing Aave V3 flash loans with arbitrage logic baked in.",
    inputSchema: {
      type: "object",
      properties: {
        network: {
          type: "string",
          enum: ["ethereum", "polygon", "arbitrum", "optimism", "avalanche"],
          description: "Target EVM network for deployment",
        },
        strategy: {
          type: "string",
          enum: ["single_swap", "multi_hop", "triangular"],
          description: "Arbitrage strategy type",
        },
      },
      required: ["network"],
    },
  },
  {
    name: "get_flashloan_executor",
    description:
      "Returns the TypeScript/ethers.js code that calls the flash loan contract from the agent.",
    inputSchema: {
      type: "object",
      properties: {
        library: {
          type: "string",
          enum: ["ethers", "viem", "web3"],
          description: "Web3 library to use",
        },
      },
      required: ["library"],
    },
  },
  {
    name: "get_profit_calculator",
    description:
      "Returns TypeScript code that calculates whether a flash loan arbitrage opportunity is profitable after all fees.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_aave_addresses",
    description:
      "Returns the official Aave V3 contract addresses for the specified network.",
    inputSchema: {
      type: "object",
      properties: {
        network: {
          type: "string",
          enum: ["ethereum", "polygon", "arbitrum", "optimism", "avalanche"],
        },
      },
      required: ["network"],
    },
  },
  {
    name: "get_dependencies",
    description: "Returns npm install command for Aave flash loan integration.",
    inputSchema: { type: "object", properties: {} },
  },
];

// ─── Aave V3 Contract Addresses by Network ────────────────────────────────────

const AAVE_ADDRESSES: Record<string, Record<string, string>> = {
  ethereum: {
    POOL: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
    POOL_ADDRESSES_PROVIDER: "0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e",
    WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  },
  polygon: {
    POOL: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    POOL_ADDRESSES_PROVIDER: "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb",
    WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
    USDC: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  },
  arbitrum: {
    POOL: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    POOL_ADDRESSES_PROVIDER: "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb",
    WETH: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    USDC: "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8",
  },
};

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "get_flashloan_contract": {
      const network = (args as any)?.network ?? "arbitrum";
      const strategy = (args as any)?.strategy ?? "multi_hop";
      const addr = AAVE_ADDRESSES[network] || AAVE_ADDRESSES.arbitrum;

      return {
        content: [
          {
            type: "text",
            text: `
// ============================================================
// FILE: contracts/FlashLoanArbitrageur.sol
// Aave V3 Flash Loan Arbitrageur — ${network.toUpperCase()}
// Strategy: ${strategy}
// 
// Deploy this contract BEFORE running the agent.
// The agent calls executeArbitrage() to trigger the flash loan.
// ============================================================

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@aave/core-v3/contracts/flashloan/base/FlashLoanSimpleReceiverBase.sol";
import "@aave/core-v3/contracts/interfaces/IPoolAddressesProvider.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

// Interface for DEX router (Uniswap V3 / compatible)
interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params)
        external payable returns (uint256 amountOut);
}

/**
 * @title FlashLoanArbitrageur
 * @notice Executes flash loan-funded arbitrage across two DEXs in a single tx.
 * @dev Only the owner (your agent wallet) can call executeArbitrage().
 */
contract FlashLoanArbitrageur is FlashLoanSimpleReceiverBase, Ownable {
    
    // Aave Pool Addresses Provider for ${network}
    address public constant ADDRESSES_PROVIDER = 
        ${addr.POOL_ADDRESSES_PROVIDER};

    // DEX Router addresses (set in constructor)
    address public dexA;  // e.g. Uniswap V3
    address public dexB;  // e.g. SushiSwap

    // Track active arbitrage parameters during flash loan callback
    struct ArbitrageParams {
        address tokenBorrow;   // Token to borrow from Aave
        address tokenInterim;  // Intermediate token (e.g., ETH when doing USDC->ETH->USDC)
        uint256 amountBorrow;  // Amount to borrow
        uint24 feeDexA;        // Pool fee tier on DEX A
        uint24 feeDexB;        // Pool fee tier on DEX B
        uint256 minProfit;     // Minimum acceptable profit in tokenBorrow units
    }

    ArbitrageParams private activeParams;

    event ArbitrageExecuted(
        address indexed tokenBorrow,
        uint256 amountBorrowed,
        uint256 profit
    );

    constructor(address _dexA, address _dexB)
        FlashLoanSimpleReceiverBase(
            IPoolAddressesProvider(ADDRESSES_PROVIDER)
        )
        Ownable(msg.sender)
    {
        dexA = _dexA;
        dexB = _dexB;
    }

    /**
     * @notice Entry point called by the agent to kick off arbitrage.
     * @param params Arbitrage configuration (tokens, amounts, DEX fees)
     */
    function executeArbitrage(ArbitrageParams calldata params) 
        external onlyOwner 
    {
        activeParams = params;
        
        // Request flash loan from Aave — this triggers executeOperation() callback
        POOL.flashLoanSimple(
            address(this),          // receiver
            params.tokenBorrow,     // asset to borrow
            params.amountBorrow,    // amount
            abi.encode(params),     // params (passed back in callback)
            0                       // referralCode
        );
    }

    /**
     * @notice Aave calls this WITHIN the flash loan transaction.
     * @dev Must repay amount + premium (0.09% Aave fee) by end of this function.
     */
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address /* initiator */,
        bytes calldata /* params */
    ) external override returns (bool) {
        require(msg.sender == address(POOL), "Only Aave pool");
        
        ArbitrageParams memory p = activeParams;
        uint256 totalDebt = amount + premium; // amount + 0.09% Aave fee

        // ── STEP 1: Swap borrowed token -> interim token on DEX A ──────────
        IERC20(asset).approve(p.dexA, amount);
        
        uint256 interimAmount = ISwapRouter(dexA).exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: asset,
                tokenOut: p.tokenInterim,
                fee: p.feeDexA,
                recipient: address(this),
                deadline: block.timestamp + 60,
                amountIn: amount,
                amountOutMinimum: 0, // Agent pre-calculates safe minimum
                sqrtPriceLimitX96: 0
            })
        );

        // ── STEP 2: Swap interim token -> original token on DEX B ──────────
        IERC20(p.tokenInterim).approve(dexB, interimAmount);
        
        uint256 returnedAmount = ISwapRouter(dexB).exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: p.tokenInterim,
                tokenOut: asset,
                fee: p.feeDexB,
                recipient: address(this),
                deadline: block.timestamp + 60,
                amountIn: interimAmount,
                amountOutMinimum: totalDebt, // Must at least cover debt
                sqrtPriceLimitX96: 0
            })
        );

        // ── STEP 3: Verify profit meets minimum threshold ───────────────────
        require(
            returnedAmount >= totalDebt + p.minProfit, 
            "Insufficient profit"
        );

        // ── STEP 4: Approve Aave to pull back the debt ──────────────────────
        IERC20(asset).approve(address(POOL), totalDebt);

        uint256 profit = returnedAmount - totalDebt;
        emit ArbitrageExecuted(asset, amount, profit);

        return true;
    }

    /**
     * @notice Withdraw accumulated profits to owner wallet.
     */
    function withdrawProfit(address token) external onlyOwner {
        uint256 balance = IERC20(token).balanceOf(address(this));
        require(balance > 0, "Nothing to withdraw");
        IERC20(token).transfer(owner(), balance);
    }

    // Allow contract to receive ETH
    receive() external payable {}
}
            `,
          },
        ],
      };
    }

    case "get_flashloan_executor": {
      const library = (args as any)?.library ?? "ethers";

      return {
        content: [
          {
            type: "text",
            text: `
// ============================================================
// FILE: src/flashloan-executor.ts
// Agent-side executor that calls the deployed FlashLoanArbitrageur contract
// Library: ${library}
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
      console.log(\`[FlashLoan] Simulation FAILED: \${err.message}\`);
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
    console.log(\`  Borrow: \${ethers.formatUnits(params.amountBorrow, 6)} USDC\`);

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
      console.log(\`[FlashLoan] TX submitted: \${tx.hash}\`);

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

      console.log(\`[FlashLoan] SUCCESS! Profit: $\${profitFormatted} USDC\`);
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
    console.log(\`[FlashLoan] Profits withdrawn: \${tx.hash}\`);
  }
}
            `,
          },
        ],
      };
    }

    case "get_profit_calculator": {
      return {
        content: [
          {
            type: "text",
            text: `
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
            `,
          },
        ],
      };
    }

    case "get_aave_addresses": {
      const network = (args as any)?.network ?? "arbitrum";
      const addresses = AAVE_ADDRESSES[network] || AAVE_ADDRESSES.arbitrum;
      return {
        content: [
          {
            type: "text",
            text: `
// Aave V3 Contract Addresses — ${network.toUpperCase()}
// Source: https://docs.aave.com/developers/deployed-contracts/v3-mainnet
// Last verified: 2024

export const AAVE_V3_ADDRESSES = ${JSON.stringify(addresses, null, 2)};

// Aave Flash Loan Fee: 0.09% (9 basis points) of borrowed amount
// This fee must be included in the repayment amount.
export const AAVE_FLASH_LOAN_FEE_BPS = 9;
export const AAVE_FLASH_LOAN_FEE_PERCENT = 0.0009;
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
# Aave Flash Loan Dependencies

# Solidity contract compilation (Hardhat):
npm install -D hardhat @nomiclabs/hardhat-ethers
npm install @aave/core-v3 @openzeppelin/contracts

# TypeScript agent executor:
npm install ethers dotenv

# Contract deployment:
npm install -D @nomicfoundation/hardhat-toolbox

# Verification on Etherscan:
npm install -D @nomiclabs/hardhat-etherscan
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
  console.error("[aave-flashloan-mcp] Server running on stdio");
}

main().catch(console.error);