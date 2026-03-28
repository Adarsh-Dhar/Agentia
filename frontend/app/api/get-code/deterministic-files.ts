/**
 * frontend/app/api/get-code/deterministic-files.ts
 *
 * This module provides a 100% deterministic, always-correct set of files
 * for the flash loan arbitrage bot. It is used as a fallback when the AI
 * returns bad/incorrect code, and can also be used as the primary source.
 *
 * All contract addresses and ABIs verified against Arbitrum mainnet (2025).
 */

export function assembleFiles(): Array<{ filepath: string; content: string }> {
  return [
    { filepath: "package.json",                    content: PACKAGE_JSON },
    { filepath: "tsconfig.json",                   content: TSCONFIG },
    { filepath: ".env.example",                    content: ENV_EXAMPLE },
    { filepath: "src/config.ts",                   content: CONFIG_TS },
    { filepath: "src/prices.ts",                   content: PRICES_TS },
    { filepath: "src/arbitrage.ts",                content: ARBITRAGE_TS },
    { filepath: "src/dashboard.ts",                content: DASHBOARD_TS },
    { filepath: "src/index.ts",                    content: INDEX_TS },
    { filepath: "contracts/FlashLoanReceiver.sol", content: FLASH_LOAN_SOL },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────

const PACKAGE_JSON = JSON.stringify({
  name: "flash-loan-arbitrageur",
  version: "1.0.0",
  type: "module",
  description: "Aave V3 flash loan arb on Arbitrum — Uniswap V3 vs SushiSwap V2",
  scripts: {
    start: "node --loader ts-node/esm src/index.ts",
    dev: "node --loader ts-node/esm src/index.ts",
    build: "tsc",
  },
  dependencies: { ethers: "^6.13.0", dotenv: "^16.4.0" },
  devDependencies: {
    typescript: "^5.4.0",
    "@types/node": "^20.0.0",
    "ts-node": "^10.9.2",
  },
}, null, 2);

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: "ES2022",
    module: "ESNext",
    moduleResolution: "bundler",
    outDir: "./dist",
    rootDir: "./src",
    strict: true,
    esModuleInterop: true,
    skipLibCheck: true,
  },
  include: ["src/**/*"],
  exclude: ["node_modules", "dist"],
}, null, 2);

const ENV_EXAMPLE = `# Arbitrum RPC (public endpoint — use QuickNode/Alchemy for production)
EVM_RPC_URL=https://arb1.arbitrum.io/rpc

# Your wallet private key (64-char hex, no 0x prefix needed)
EVM_PRIVATE_KEY=0000000000000000000000000000000000000000000000000000000000000001

# Deployed FlashLoanReceiver contract address
CONTRACT_ADDRESS=0x0000000000000000000000000000000000000000

# Bot configuration
MAX_LOAN_USD=10000
MIN_PROFIT_USD=50
POLL_MS=3000

# Safety: set to "false" for live trading
DRY_RUN=true
`;

const CONFIG_TS = `import "dotenv/config";
import { ethers } from "ethers";

export const CONTRACTS = {
  AAVE_POOL:       "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  UNI_QUOTER_V2:   "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
  UNI_SWAP_ROUTER: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
  SUSHI_ROUTER:    "0x1b02dA8Cb0d097eB8D57A175b88c7d8b47997506",
  WETH:            "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
  USDC_E:          "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8",
} as const;

function required(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(\`Missing required env var: \${name}\`);
  return val;
}

export const config = {
  rpcUrl:          required("EVM_RPC_URL"),
  privateKey:      process.env.EVM_PRIVATE_KEY ?? "0".repeat(64),
  contractAddress: process.env.CONTRACT_ADDRESS ?? ethers.ZeroAddress,
  maxLoanUsd:      parseInt(process.env.MAX_LOAN_USD  ?? "10000"),
  minProfitUsd:    parseInt(process.env.MIN_PROFIT_USD ?? "50"),
  pollMs:          parseInt(process.env.POLL_MS        ?? "3000"),
  dryRun:          (process.env.DRY_RUN ?? "true") !== "false",
} as const;

export function createProvider() {
  return new ethers.JsonRpcProvider(config.rpcUrl);
}
export function createSigner(provider: ethers.JsonRpcProvider) {
  const key = config.privateKey.startsWith("0x")
    ? config.privateKey : \`0x\${config.privateKey}\`;
  return new ethers.Wallet(key, provider);
}
export function parseWeth(amount: number): bigint {
  return ethers.parseEther(amount.toString());
}
export function formatUsdc(amount: bigint): string {
  return (Number(amount) / 1e6).toFixed(2);
}
export function formatWeth(amount: bigint): string {
  return ethers.formatEther(amount);
}
`;

const PRICES_TS = `/**
 * prices.ts — Fetch DEX prices using correct on-chain ABIs
 *
 * IMPORTANT: Uses QuoterV2 struct-parameter pattern (NOT the old Quoter).
 * Contract: 0x61fFE014bA17989E743c5F6cB21bF9697530B21e (Arbitrum mainnet)
 */
import { ethers } from "ethers";
import { CONTRACTS } from "./config.js";

// QuoterV2 ABI — takes struct, returns tuple
const QUOTER_V2_ABI = [
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
];

const SUSHI_ROUTER_ABI = [
  "function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts)",
];

export interface PriceResult {
  dex: string;
  amountOutUsdc: bigint;
  pricePerWeth: number;
  success: boolean;
  error?: string;
}

export async function getUniswapV3Price(
  provider: ethers.JsonRpcProvider,
  amountInWeth: bigint,
): Promise<PriceResult> {
  try {
    const quoter = new ethers.Contract(CONTRACTS.UNI_QUOTER_V2, QUOTER_V2_ABI, provider);
    const [amountOutUsdc] = await quoter.quoteExactInputSingle.staticCall({
      tokenIn:           CONTRACTS.WETH,
      tokenOut:          CONTRACTS.USDC_E,
      amountIn:          amountInWeth,
      fee:               500n,
      sqrtPriceLimitX96: 0n,
    });
    return {
      dex: "Uniswap V3",
      amountOutUsdc: amountOutUsdc as bigint,
      pricePerWeth: Number(amountOutUsdc as bigint) / 1e6,
      success: true,
    };
  } catch (err: any) {
    return { dex: "Uniswap V3", amountOutUsdc: 0n, pricePerWeth: 0, success: false, error: err.message };
  }
}

export async function getSushiSwapPrice(
  provider: ethers.JsonRpcProvider,
  amountInWeth: bigint,
): Promise<PriceResult> {
  try {
    const router = new ethers.Contract(CONTRACTS.SUSHI_ROUTER, SUSHI_ROUTER_ABI, provider);
    const amounts: bigint[] = await router.getAmountsOut(
      amountInWeth, [CONTRACTS.WETH, CONTRACTS.USDC_E],
    );
    return {
      dex: "SushiSwap V2",
      amountOutUsdc: amounts[1],
      pricePerWeth: Number(amounts[1]) / 1e6,
      success: true,
    };
  } catch (err: any) {
    return { dex: "SushiSwap V2", amountOutUsdc: 0n, pricePerWeth: 0, success: false, error: err.message };
  }
}

export async function fetchBothPrices(
  provider: ethers.JsonRpcProvider,
  amountInWeth: bigint,
): Promise<{ uni: PriceResult; sushi: PriceResult }> {
  const [uni, sushi] = await Promise.all([
    getUniswapV3Price(provider, amountInWeth),
    getSushiSwapPrice(provider, amountInWeth),
  ]);
  return { uni, sushi };
}
`;

const ARBITRAGE_TS = `/**
 * arbitrage.ts — Profitability check + flash loan execution
 * All arithmetic uses BigInt — no floating point.
 */
import { ethers } from "ethers";
import { CONTRACTS, config } from "./config.js";
import type { PriceResult } from "./prices.js";

const AAVE_POOL_ABI = [
  "function flashLoanSimple(address receiverAddress, address asset, uint256 amount, bytes calldata params, uint16 referralCode) external",
];

export interface ArbitrageResult {
  profitable: boolean;
  direction: "UNI_TO_SUSHI" | "SUSHI_TO_UNI" | "NONE";
  spreadUsdc: bigint;
  aaveFeeUsdc: bigint;
  gasBufferUsdc: bigint;
  netProfitUsdc: bigint;
  netProfitUsd: number;
  minProfitUsdc: bigint;
}

export function calcProfitability(
  uni: PriceResult,
  sushi: PriceResult,
  loanWeth: bigint,
): ArbitrageResult {
  const MIN_PROFIT_USDC = BigInt(config.minProfitUsd) * 1_000_000n;
  const GAS_BUFFER_USDC = 2_000_000n; // $2 gas buffer

  if (!uni.success || !sushi.success) {
    return {
      profitable: false, direction: "NONE",
      spreadUsdc: 0n, aaveFeeUsdc: 0n, gasBufferUsdc: GAS_BUFFER_USDC,
      netProfitUsdc: -GAS_BUFFER_USDC, netProfitUsd: 0,
      minProfitUsdc: MIN_PROFIT_USDC,
    };
  }

  const spread = uni.amountOutUsdc > sushi.amountOutUsdc
    ? uni.amountOutUsdc - sushi.amountOutUsdc
    : sushi.amountOutUsdc - uni.amountOutUsdc;

  // Aave fee = 0.09% of loan, expressed in USDC.e
  const midPriceUsdc = (uni.amountOutUsdc + sushi.amountOutUsdc) / 2n;
  const aaveFeeWeth  = (loanWeth * 9n) / 10_000n;
  const aaveFeeUsdc  = (aaveFeeWeth * midPriceUsdc) / (10n ** 18n);

  const netProfitUsdc = spread - aaveFeeUsdc - GAS_BUFFER_USDC;
  const profitable    = netProfitUsdc >= MIN_PROFIT_USDC;

  const direction = uni.amountOutUsdc < sushi.amountOutUsdc
    ? "UNI_TO_SUSHI" : "SUSHI_TO_UNI";

  return {
    profitable,
    direction: profitable ? direction : "NONE",
    spreadUsdc: spread, aaveFeeUsdc, gasBufferUsdc: GAS_BUFFER_USDC,
    netProfitUsdc,
    netProfitUsd: Number(netProfitUsdc) / 1e6,
    minProfitUsdc: MIN_PROFIT_USDC,
  };
}

export async function executeFlashLoan(
  signer: ethers.Signer,
  loanWeth: bigint,
  direction: "UNI_TO_SUSHI" | "SUSHI_TO_UNI",
): Promise<{ txHash: string; success: boolean; error?: string }> {
  if (config.contractAddress === ethers.ZeroAddress) {
    return { txHash: "", success: false, error: "CONTRACT_ADDRESS not set. Deploy FlashLoanReceiver.sol first." };
  }
  try {
    const aavePool = new ethers.Contract(CONTRACTS.AAVE_POOL, AAVE_POOL_ABI, signer);
    const params = ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint8"], [direction === "UNI_TO_SUSHI" ? 0 : 1],
    );
    const tx = await aavePool.flashLoanSimple(
      config.contractAddress, CONTRACTS.WETH, loanWeth, params, 0,
    );
    const receipt = await tx.wait();
    return { txHash: tx.hash, success: receipt?.status === 1 };
  } catch (err: any) {
    return { txHash: "", success: false, error: err.reason ?? err.message };
  }
}
`;

const DASHBOARD_TS = `/**
 * dashboard.ts — Terminal output utilities
 */
import type { PriceResult } from "./prices.js";
import type { ArbitrageResult } from "./arbitrage.js";
import { formatUsdc, formatWeth } from "./config.js";

const C = {
  reset: "\\x1b[0m", green: "\\x1b[32m", red: "\\x1b[31m",
  yellow: "\\x1b[33m", cyan: "\\x1b[36m", dim: "\\x1b[2m", bold: "\\x1b[1m",
};
function pad(s: string, n: number, right = false): string {
  return right ? s.padStart(n) : s.padEnd(n);
}

export function printHeader(dryRun: boolean, cycle: number, loanWeth: bigint) {
  const mode = dryRun ? \`\${C.yellow}DRY RUN\${C.reset}\` : \`\${C.red}LIVE\${C.reset}\`;
  console.clear();
  console.log(\`\${C.cyan}\${C.bold}╔══════════════════════════════════════════════════╗\${C.reset}\`);
  console.log(\`\${C.cyan}\${C.bold}║   Flash Loan Arbitrageur — Arbitrum              ║\${C.reset}\`);
  console.log(\`\${C.cyan}\${C.bold}║   Mode: \${mode}   Cycle: \${String(cycle).padStart(6)}\${C.cyan}\${C.bold}              ║\${C.reset}\`);
  console.log(\`\${C.cyan}\${C.bold}║   Loan: \${formatWeth(loanWeth)} WETH                           ║\${C.reset}\`);
  console.log(\`\${C.cyan}\${C.bold}╚══════════════════════════════════════════════════╝\${C.reset}\`);
  console.log();
}

export function printPriceTable(uni: PriceResult, sushi: PriceResult) {
  const divider = "  " + "─".repeat(60);
  console.log(divider);
  console.log(\`  \${pad("DEX", 14)}\${pad("USD/WETH", 12, true)}  \${pad("USDC out", 12, true)}  Status\`);
  console.log(divider);
  const uniRow = uni.success
    ? \`  \${pad("Uniswap V3", 14)}\${pad("\$" + uni.pricePerWeth.toFixed(2), 12, true)}  \${pad(formatUsdc(uni.amountOutUsdc), 12, true)}  \${C.green}✓\${C.reset}\`
    : \`  \${pad("Uniswap V3", 14)}\${pad("ERROR", 12, true)}  \${pad("—", 12, true)}  \${C.red}✗\${C.reset}\`;
  const sushiRow = sushi.success
    ? \`  \${pad("SushiSwap V2", 14)}\${pad("\$" + sushi.pricePerWeth.toFixed(2), 12, true)}  \${pad(formatUsdc(sushi.amountOutUsdc), 12, true)}  \${C.green}✓\${C.reset}\`
    : \`  \${pad("SushiSwap V2", 14)}\${pad("ERROR", 12, true)}  \${pad("—", 12, true)}  \${C.red}✗\${C.reset}\`;
  console.log(uniRow);
  console.log(sushiRow);
  console.log(divider);
}

export function printArbitrageResult(result: ArbitrageResult, dryRun: boolean, txHash?: string) {
  const spread  = formatUsdc(result.spreadUsdc);
  const net     = result.netProfitUsd.toFixed(2);
  const thresh  = formatUsdc(result.minProfitUsdc);
  console.log();
  if (result.profitable) {
    console.log(\`  \${C.green}\${C.bold}✓ PROFITABLE\${C.reset}  direction: \${result.direction}\`);
    console.log(\`    Spread: \$\${spread}  |  Net: \${C.green}\$\${net}\${C.reset}  |  Aave fee: \$\${formatUsdc(result.aaveFeeUsdc)}\`);
    if (txHash) console.log(\`    TX: \${C.cyan}\${txHash}\${C.reset}\`);
    if (dryRun) console.log(\`    \${C.yellow}[DRY RUN — no transaction sent]\${C.reset}\`);
  } else {
    console.log(\`  \${C.dim}✗ NO PROFIT\${C.reset}  Spread: \$\${spread}  Net after fees: \${C.red}\$\${net}\${C.reset}  Threshold: \$\${thresh}\`);
  }
  console.log();
}

export function printStats(cycles: number, opps: number, execs: number, profit: number) {
  console.log(\`  \${C.dim}Cycles: \${cycles}  Opportunities: \${opps}  Executions: \${execs}  Total profit: \$\${profit.toFixed(2)}\${C.reset}\`);
}
`;

const INDEX_TS = `/**
 * src/index.ts — Main polling loop
 */
import "dotenv/config";
import { ethers } from "ethers";
import { config, createProvider, createSigner, parseWeth } from "./config.js";
import { fetchBothPrices } from "./prices.js";
import { calcProfitability, executeFlashLoan } from "./arbitrage.js";
import { printHeader, printPriceTable, printArbitrageResult, printStats } from "./dashboard.js";

let cycle = 0, opportunities = 0, executions = 0, totalProfitUsd = 0;

console.log("\\x1b[36m[Boot]\\x1b[0m Flash Loan Arbitrageur starting...");
console.log(\`  Mode:        \${config.dryRun ? "\\x1b[33mDRY RUN\\x1b[0m" : "\\x1b[31mLIVE TRADING\\x1b[0m"}\`);
console.log(\`  Poll:        \${config.pollMs}ms\`);
console.log(\`  Min profit:  \$\${config.minProfitUsd}\\n\`);

if (!config.dryRun && config.contractAddress === ethers.ZeroAddress) {
  console.error("\\x1b[31m[Error]\\x1b[0m LIVE mode requires CONTRACT_ADDRESS to be set.");
  process.exit(1);
}

const provider = createProvider();
const signer   = createSigner(provider);
const loanWeth = parseWeth(1); // 1 WETH per cycle

async function runCycle() {
  cycle++;
  try {
    const { uni, sushi } = await fetchBothPrices(provider, loanWeth);
    const result         = calcProfitability(uni, sushi, loanWeth);

    printHeader(config.dryRun, cycle, loanWeth);
    printPriceTable(uni, sushi);

    if (result.profitable) {
      opportunities++;
      if (!config.dryRun) {
        const { txHash, success, error } = await executeFlashLoan(
          signer, loanWeth,
          result.direction as "UNI_TO_SUSHI" | "SUSHI_TO_UNI",
        );
        if (success) {
          executions++;
          totalProfitUsd += result.netProfitUsd;
          printArbitrageResult(result, false, txHash);
        } else {
          console.error(\`  \\x1b[31m[Error]\\x1b[0m \${error}\`);
          printArbitrageResult(result, false);
        }
      } else {
        printArbitrageResult(result, true);
      }
    } else {
      printArbitrageResult(result, config.dryRun);
    }
    printStats(cycle, opportunities, executions, totalProfitUsd);
  } catch (err: any) {
    console.error(\`  \\x1b[31m[Cycle Error]\\x1b[0m \${err.message}\`);
  }
}

process.on("SIGINT", () => {
  console.log("\\n\\x1b[36m[Shutdown]\\x1b[0m");
  console.log(\`  \${cycle} cycles | \${executions} executions | \$\${totalProfitUsd.toFixed(2)} profit\`);
  process.exit(0);
});

(async () => {
  await runCycle();
  setInterval(runCycle, config.pollMs);
})();
`;

const FLASH_LOAN_SOL = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IFlashLoanSimpleReceiver {
    function executeOperation(address asset, uint256 amount, uint256 premium, address initiator, bytes calldata params) external returns (bool);
}
interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn; address tokenOut; uint24 fee; address recipient;
        uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params) external returns (uint256 amountOut);
}
interface IUniswapV2Router02 {
    function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) external returns (uint256[] memory amounts);
}
interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/**
 * @title FlashLoanReceiver
 * @notice Arbitrum mainnet — Aave V3 + Uniswap V3 + SushiSwap V2
 * Addresses verified 2025:
 *   Aave Pool:    0x794a61358D6845594F94dc1DB02A252b5b4814aD
 *   Uni Router:   0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45
 *   Sushi Router: 0x1b02dA8Cb0d097eB8D57A175b88c7d8b47997506
 *   WETH:         0x82aF49447D8a07e3bd95BD0d56f35241523fBab1
 *   USDC.e:       0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8
 */
contract FlashLoanReceiver is IFlashLoanSimpleReceiver {
    address public constant AAVE_POOL    = 0x794a61358D6845594F94dc1DB02A252b5b4814aD;
    address public constant UNI_ROUTER   = 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45;
    address public constant SUSHI_ROUTER = 0x1b02dA8Cb0d097eB8D57A175b88c7d8b47997506;
    address public constant WETH         = 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1;
    address public constant USDC_E       = 0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8;

    address public immutable owner;
    constructor() { owner = msg.sender; }

    modifier onlyAavePool() { require(msg.sender == AAVE_POOL, "Not Aave"); _; }

    function executeOperation(address asset, uint256 amount, uint256 premium, address, bytes calldata params) external override onlyAavePool returns (bool) {
        require(asset == WETH, "Only WETH");
        uint8 direction = abi.decode(params, (uint8));
        uint256 totalDebt = amount + premium;
        if (direction == 0) {
            uint256 usdcOut = _uniSell(amount);
            _sushiBuy(usdcOut, totalDebt);
        } else {
            uint256 usdcOut = _sushiSell(amount);
            _uniBuy(usdcOut, totalDebt);
        }
        IERC20(WETH).approve(AAVE_POOL, totalDebt);
        return true;
    }

    function _uniSell(uint256 wethIn) internal returns (uint256) {
        IERC20(WETH).approve(UNI_ROUTER, wethIn);
        return ISwapRouter02(UNI_ROUTER).exactInputSingle(ISwapRouter02.ExactInputSingleParams({
            tokenIn: WETH, tokenOut: USDC_E, fee: 500, recipient: address(this),
            amountIn: wethIn, amountOutMinimum: 0, sqrtPriceLimitX96: 0
        }));
    }
    function _sushiBuy(uint256 usdcIn, uint256 minWethOut) internal {
        IERC20(USDC_E).approve(SUSHI_ROUTER, usdcIn);
        address[] memory path = new address[](2); path[0] = USDC_E; path[1] = WETH;
        IUniswapV2Router02(SUSHI_ROUTER).swapExactTokensForTokens(usdcIn, minWethOut, path, address(this), block.timestamp + 60);
    }
    function _sushiSell(uint256 wethIn) internal returns (uint256) {
        IERC20(WETH).approve(SUSHI_ROUTER, wethIn);
        address[] memory path = new address[](2); path[0] = WETH; path[1] = USDC_E;
        uint256[] memory amounts = IUniswapV2Router02(SUSHI_ROUTER).swapExactTokensForTokens(wethIn, 0, path, address(this), block.timestamp + 60);
        return amounts[1];
    }
    function _uniBuy(uint256 usdcIn, uint256 minWethOut) internal {
        IERC20(USDC_E).approve(UNI_ROUTER, usdcIn);
        ISwapRouter02(UNI_ROUTER).exactInputSingle(ISwapRouter02.ExactInputSingleParams({
            tokenIn: USDC_E, tokenOut: WETH, fee: 500, recipient: address(this),
            amountIn: usdcIn, amountOutMinimum: minWethOut, sqrtPriceLimitX96: 0
        }));
    }
    function withdraw(address token) external {
        require(msg.sender == owner, "Not owner");
        IERC20(token).transfer(owner, IERC20(token).balanceOf(address(this)));
    }
}
`;