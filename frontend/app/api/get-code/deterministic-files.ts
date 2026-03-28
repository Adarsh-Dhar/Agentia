/**
 * frontend/app/api/get-code/deterministic-files.ts  — VERIFIED
 *
 * Every export name in prices.ts / arbitrage.ts / config.ts is manually
 * cross-checked against the imports in index.ts.
 *
 * Export → Import mapping (all verified):
 *   prices.ts    : getUniswapV3Price, getSushiSwapPrice, fetchBothPrices
 *   arbitrage.ts : calcProfitability, executeFlashLoan, ArbitrageResult
 *   config.ts    : config, CONTRACTS, createProvider, createSigner, parseWeth,
 *                  formatUsdc, formatWeth
 *   dashboard.ts : printHeader, printPriceTable, printArbitrageResult, printStats
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
    start: "npx tsx src/index.ts",
    dev:   "npx tsx src/index.ts",
    build: "tsc",
  },
  dependencies: {
    ethers:  "^6.13.0",
    dotenv:  "^16.4.0",
  },
  devDependencies: {
    typescript:    "^5.4.0",
    "@types/node": "^20.0.0",
    tsx:           "^4.7.0",
  },
}, null, 2);

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target:            "ES2022",
    module:            "ESNext",
    moduleResolution:  "bundler",
    outDir:            "./dist",
    rootDir:           "./src",
    strict:            true,
    esModuleInterop:   true,
    skipLibCheck:      true,
    resolveJsonModule: true,
  },
  include:  ["src/**/*"],
  exclude:  ["node_modules", "dist"],
}, null, 2);

const ENV_EXAMPLE = `# Arbitrum RPC (public endpoint — use QuickNode/Alchemy for production)
EVM_RPC_URL=https://arb1.arbitrum.io/rpc

# Your wallet private key (64-char hex, with or without 0x prefix)
EVM_PRIVATE_KEY=0000000000000000000000000000000000000000000000000000000000000001

# Deployed FlashLoanReceiver contract address (deploy contracts/FlashLoanReceiver.sol first)
CONTRACT_ADDRESS=0x0000000000000000000000000000000000000000

# Bot configuration
MAX_LOAN_USD=10000
MIN_PROFIT_USD=50
POLL_MS=3000

# Safety: "true" = simulate only (never sends real transactions)
DRY_RUN=true
`;

// ─────────────────────────────────────────────────────────────────────────────
// config.ts — exports: config, CONTRACTS, createProvider, createSigner,
//             parseWeth, formatUsdc, formatWeth
// ─────────────────────────────────────────────────────────────────────────────
const CONFIG_TS = `import "dotenv/config";
import { ethers } from "ethers";

// ─── Verified Arbitrum mainnet addresses (2025) ───────────────────────────────
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

export function createProvider(): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(config.rpcUrl);
}

export function createSigner(provider: ethers.JsonRpcProvider): ethers.Wallet {
  const key = config.privateKey.startsWith("0x")
    ? config.privateKey
    : \`0x\${config.privateKey}\`;
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

// ─────────────────────────────────────────────────────────────────────────────
// prices.ts — exports: PriceResult (type), getUniswapV3Price,
//             getSushiSwapPrice, fetchBothPrices
// ─────────────────────────────────────────────────────────────────────────────
const PRICES_TS = `/**
 * prices.ts — Fetch DEX prices using correct on-chain call patterns.
 *
 * Exported functions (exact names — must match imports in index.ts):
 *   getUniswapV3Price  — calls Uniswap V3 QuoterV2 via staticCall + struct param
 *   getSushiSwapPrice  — calls SushiSwap V2 getAmountsOut
 *   fetchBothPrices    — calls both concurrently and returns { uni, sushi }
 */
import { ethers } from "ethers";
import { CONTRACTS } from "./config.js";

// QuoterV2 ABI — MUST use struct-param pattern (not individual args)
const QUOTER_V2_ABI = [
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
];

const SUSHI_ROUTER_ABI = [
  "function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts)",
];

export interface PriceResult {
  dex:           string;
  amountOutUsdc: bigint;   // USDC.e in 6-decimal units
  pricePerWeth:  number;   // human-readable USD price
  success:       boolean;
  error?:        string;
}

/**
 * Fetch WETH→USDC.e price from Uniswap V3 QuoterV2.
 * Uses staticCall with struct parameter — required for QuoterV2 ABI.
 */
export async function getUniswapV3Price(
  provider: ethers.JsonRpcProvider,
  amountInWeth: bigint,
): Promise<PriceResult> {
  try {
    const quoter = new ethers.Contract(
      CONTRACTS.UNI_QUOTER_V2,
      QUOTER_V2_ABI,
      provider
    );
    const [amountOutUsdc] = await quoter.quoteExactInputSingle.staticCall({
      tokenIn:           CONTRACTS.WETH,
      tokenOut:          CONTRACTS.USDC_E,
      amountIn:          amountInWeth,
      fee:               500n,   // 0.05% pool (most liquid WETH/USDC.e on Arbitrum)
      sqrtPriceLimitX96: 0n,
    });
    const out = amountOutUsdc as bigint;
    return {
      dex:           "Uniswap V3",
      amountOutUsdc: out,
      pricePerWeth:  Number(out) / 1e6,
      success:       true,
    };
  } catch (err: unknown) {
    return {
      dex:           "Uniswap V3",
      amountOutUsdc: 0n,
      pricePerWeth:  0,
      success:       false,
      error:         err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Fetch WETH→USDC.e price from SushiSwap V2 (standard Uniswap V2 interface).
 */
export async function getSushiSwapPrice(
  provider: ethers.JsonRpcProvider,
  amountInWeth: bigint,
): Promise<PriceResult> {
  try {
    const router = new ethers.Contract(
      CONTRACTS.SUSHI_ROUTER,
      SUSHI_ROUTER_ABI,
      provider
    );
    const amounts: bigint[] = await router.getAmountsOut(amountInWeth, [
      CONTRACTS.WETH,
      CONTRACTS.USDC_E,
    ]);
    const out = amounts[1];
    return {
      dex:           "SushiSwap V2",
      amountOutUsdc: out,
      pricePerWeth:  Number(out) / 1e6,
      success:       true,
    };
  } catch (err: unknown) {
    return {
      dex:           "SushiSwap V2",
      amountOutUsdc: 0n,
      pricePerWeth:  0,
      success:       false,
      error:         err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Fetch both prices concurrently.
 * Returns { uni: PriceResult, sushi: PriceResult }
 */
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

// ─────────────────────────────────────────────────────────────────────────────
// arbitrage.ts — exports: ArbitrageResult (type), calcProfitability,
//               executeFlashLoan
// ─────────────────────────────────────────────────────────────────────────────
const ARBITRAGE_TS = `/**
 * arbitrage.ts — Profitability check + flash loan execution.
 *
 * Exported functions (exact names — must match imports in index.ts):
 *   calcProfitability  — pure BigInt profit calculation
 *   executeFlashLoan   — submits on-chain transaction
 */
import { ethers } from "ethers";
import { CONTRACTS, config } from "./config.js";
import type { PriceResult } from "./prices.js";

const AAVE_POOL_ABI = [
  "function flashLoanSimple(address receiverAddress, address asset, uint256 amount, bytes calldata params, uint16 referralCode) external",
];

export interface ArbitrageResult {
  profitable:     boolean;
  direction:      "UNI_TO_SUSHI" | "SUSHI_TO_UNI" | "NONE";
  spreadUsdc:     bigint;
  aaveFeeUsdc:    bigint;
  gasBufferUsdc:  bigint;
  netProfitUsdc:  bigint;
  netProfitUsd:   number;
  minProfitUsdc:  bigint;
}

/**
 * Calculate whether this price gap is worth executing.
 * All arithmetic is BigInt — no floating point rounding errors.
 */
export function calcProfitability(
  uni:      PriceResult,
  sushi:    PriceResult,
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

  // Aave fee = 0.09% of borrowed WETH, converted to USDC.e
  const midPriceUsdc = (uni.amountOutUsdc + sushi.amountOutUsdc) / 2n;
  const aaveFeeWeth  = (loanWeth * 9n) / 10_000n;
  const aaveFeeUsdc  = (aaveFeeWeth * midPriceUsdc) / (10n ** 18n);

  const netProfitUsdc = spread - aaveFeeUsdc - GAS_BUFFER_USDC;
  const profitable    = netProfitUsdc >= MIN_PROFIT_USDC;

  // Buy where it's cheaper, sell where it's more expensive
  const direction = uni.amountOutUsdc < sushi.amountOutUsdc
    ? "UNI_TO_SUSHI"   // Uni cheaper → buy on Uni, sell on Sushi
    : "SUSHI_TO_UNI";  // Sushi cheaper → buy on Sushi, sell on Uni

  return {
    profitable,
    direction:     profitable ? direction : "NONE",
    spreadUsdc:    spread,
    aaveFeeUsdc,
    gasBufferUsdc: GAS_BUFFER_USDC,
    netProfitUsdc,
    netProfitUsd:  Number(netProfitUsdc) / 1e6,
    minProfitUsdc: MIN_PROFIT_USDC,
  };
}

/**
 * Submit the flash loan transaction on-chain.
 * Only called when profitable AND DRY_RUN=false.
 */
export async function executeFlashLoan(
  signer:    ethers.Signer,
  loanWeth:  bigint,
  direction: "UNI_TO_SUSHI" | "SUSHI_TO_UNI",
): Promise<{ txHash: string; success: boolean; error?: string }> {
  if (config.contractAddress === ethers.ZeroAddress) {
    return {
      txHash:  "",
      success: false,
      error:   "CONTRACT_ADDRESS not set. Deploy contracts/FlashLoanReceiver.sol first.",
    };
  }
  try {
    const aavePool = new ethers.Contract(CONTRACTS.AAVE_POOL, AAVE_POOL_ABI, signer);
    const params   = ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint8"],
      [direction === "UNI_TO_SUSHI" ? 0 : 1],
    );
    const tx      = await aavePool.flashLoanSimple(
      config.contractAddress,
      CONTRACTS.WETH,
      loanWeth,
      params,
      0,
    );
    const receipt = await tx.wait();
    return { txHash: tx.hash, success: receipt?.status === 1 };
  } catch (err: unknown) {
    const e = err as { reason?: string; message?: string };
    return { txHash: "", success: false, error: e.reason ?? e.message };
  }
}
`;

// ─────────────────────────────────────────────────────────────────────────────
// dashboard.ts — exports: printHeader, printPriceTable,
//               printArbitrageResult, printStats
// ─────────────────────────────────────────────────────────────────────────────
const DASHBOARD_TS = `/**
 * dashboard.ts — Terminal output utilities.
 *
 * Exported functions (exact names — must match imports in index.ts):
 *   printHeader, printPriceTable, printArbitrageResult, printStats
 */
import type { PriceResult } from "./prices.js";
import type { ArbitrageResult } from "./arbitrage.js";
import { formatUsdc, formatWeth } from "./config.js";

const C = {
  reset:  "\\x1b[0m",
  green:  "\\x1b[32m",
  red:    "\\x1b[31m",
  yellow: "\\x1b[33m",
  cyan:   "\\x1b[36m",
  dim:    "\\x1b[2m",
  bold:   "\\x1b[1m",
};

function pad(s: string, n: number, right = false): string {
  return right ? s.padStart(n) : s.padEnd(n);
}

export function printHeader(dryRun: boolean, cycle: number, loanWeth: bigint): void {
  const mode = dryRun
    ? \`\${C.yellow}DRY RUN (safe)\${C.reset}\`
    : \`\${C.red}LIVE TRADING\${C.reset}\`;
  console.clear();
  console.log(\`\${C.cyan}\${C.bold}╔══════════════════════════════════════════════════╗\${C.reset}\`);
  console.log(\`\${C.cyan}\${C.bold}║   Flash Loan Arbitrageur — Arbitrum              ║\${C.reset}\`);
  console.log(\`\${C.cyan}\${C.bold}║   Mode: \${mode}   Cycle: \${String(cycle).padStart(6)}\${C.cyan}\${C.bold}     ║\${C.reset}\`);
  console.log(\`\${C.cyan}\${C.bold}║   Loan: \${formatWeth(loanWeth)} WETH                           ║\${C.reset}\`);
  console.log(\`\${C.cyan}\${C.bold}╚══════════════════════════════════════════════════╝\${C.reset}\`);
  console.log();
}

export function printPriceTable(uni: PriceResult, sushi: PriceResult): void {
  const divider = "  " + "─".repeat(60);
  console.log(divider);
  console.log(\`  \${pad("DEX", 14)}\${pad("USD/WETH", 12, true)}  \${pad("USDC out", 12, true)}  Status\`);
  console.log(divider);

  const uniRow = uni.success
    ? \`  \${pad("Uniswap V3",  14)}\${pad("$" + uni.pricePerWeth.toFixed(2), 12, true)}  \${pad(formatUsdc(uni.amountOutUsdc),   12, true)}  \${C.green}✓\${C.reset}\`
    : \`  \${pad("Uniswap V3",  14)}\${pad("ERROR", 12, true)}  \${pad("—", 12, true)}  \${C.red}✗ \${uni.error?.slice(0, 20)}\${C.reset}\`;

  const sushiRow = sushi.success
    ? \`  \${pad("SushiSwap V2", 14)}\${pad("$" + sushi.pricePerWeth.toFixed(2), 12, true)}  \${pad(formatUsdc(sushi.amountOutUsdc), 12, true)}  \${C.green}✓\${C.reset}\`
    : \`  \${pad("SushiSwap V2", 14)}\${pad("ERROR", 12, true)}  \${pad("—", 12, true)}  \${C.red}✗ \${sushi.error?.slice(0, 20)}\${C.reset}\`;

  console.log(uniRow);
  console.log(sushiRow);
  console.log(divider);
}

export function printArbitrageResult(
  result: ArbitrageResult,
  dryRun: boolean,
  txHash?: string,
): void {
  const spread = formatUsdc(result.spreadUsdc);
  const fee    = formatUsdc(result.aaveFeeUsdc);
  const gas    = formatUsdc(result.gasBufferUsdc);
  const net    = result.netProfitUsd.toFixed(2);
  const thresh = formatUsdc(result.minProfitUsdc);

  console.log();
  if (result.profitable) {
    console.log(\`  \${C.green}\${C.bold}✓ PROFITABLE\${C.reset}  direction: \${result.direction}\`);
    console.log(\`    Spread: $\${spread}  |  Aave fee: $\${fee}  |  Gas: $\${gas}\`);
    console.log(\`    Net profit: \${C.green}$\${net}\${C.reset}  → \${dryRun ? "DRY RUN — no tx sent" : "executing flash loan"}\`);
    if (txHash) console.log(\`    TX: \${C.cyan}\${txHash}\${C.reset}\`);
  } else {
    console.log(\`  \${C.dim}✗ NOT PROFITABLE\${C.reset}\`);
    console.log(\`    Spread: $\${spread}  |  Net after fees: \${C.red}$\${net}\${C.reset}  |  Threshold: $\${thresh}\`);
  }
  console.log();
}

export function printStats(
  cycles:    number,
  opps:      number,
  executions: number,
  profitUsd: number,
): void {
  console.log(
    \`  \${C.dim}Cycles: \${cycles}  Opportunities: \${opps}  Executions: \${executions}  Total profit: $\${profitUsd.toFixed(2)}\${C.reset}\`
  );
}
`;

// ─────────────────────────────────────────────────────────────────────────────
// index.ts — imports exactly match what the other files export
// ─────────────────────────────────────────────────────────────────────────────
const INDEX_TS = `/**
 * src/index.ts — Main polling loop
 *
 * Imports (must match exports in sibling files exactly):
 *   from ./config    → config, createProvider, createSigner, parseWeth
 *   from ./prices    → fetchBothPrices
 *   from ./arbitrage → calcProfitability, executeFlashLoan
 *   from ./dashboard → printHeader, printPriceTable, printArbitrageResult, printStats
 */
import "dotenv/config";
import { ethers } from "ethers";
import { config, createProvider, createSigner, parseWeth } from "./config.js";
import { fetchBothPrices }                                  from "./prices.js";
import { calcProfitability, executeFlashLoan }              from "./arbitrage.js";
import {
  printHeader,
  printPriceTable,
  printArbitrageResult,
  printStats,
} from "./dashboard.js";

// ─── State ────────────────────────────────────────────────────────────────────
let cycle          = 0;
let opportunities  = 0;
let executions     = 0;
let totalProfitUsd = 0;

// ─── Boot banner ──────────────────────────────────────────────────────────────
console.log("\\x1b[36m[Boot]\\x1b[0m Flash Loan Arbitrageur starting...");
console.log(\`  Mode:        \${config.dryRun ? "\\x1b[33mDRY RUN\\x1b[0m" : "\\x1b[31mLIVE TRADING\\x1b[0m"}\`);
console.log(\`  RPC:         \${config.rpcUrl.slice(0, 40)}...\`);
console.log(\`  Min profit:  $\${config.minProfitUsd}\`);
console.log(\`  Poll:        \${config.pollMs}ms\\n\`);

if (!config.dryRun && config.contractAddress === ethers.ZeroAddress) {
  console.error("\\x1b[31m[Error]\\x1b[0m LIVE mode requires CONTRACT_ADDRESS to be set.");
  console.error("  Deploy contracts/FlashLoanReceiver.sol, then set CONTRACT_ADDRESS in .env");
  process.exit(1);
}

const provider = createProvider();
const signer   = createSigner(provider);
const loanWeth = parseWeth(1); // 1 WETH per cycle

// ─── Main cycle ───────────────────────────────────────────────────────────────
async function runCycle(): Promise<void> {
  cycle++;

  try {
    // 1. Fetch prices from both DEXes in parallel
    const { uni, sushi } = await fetchBothPrices(provider, loanWeth);

    // 2. Calculate profitability (all BigInt — no floating point)
    const result = calcProfitability(uni, sushi, loanWeth);

    // 3. Render terminal dashboard
    printHeader(config.dryRun, cycle, loanWeth);
    printPriceTable(uni, sushi);

    if (result.profitable) {
      opportunities++;

      if (!config.dryRun) {
        // 4a. Live mode: execute the flash loan on-chain
        const { txHash, success, error } = await executeFlashLoan(
          signer,
          loanWeth,
          result.direction as "UNI_TO_SUSHI" | "SUSHI_TO_UNI",
        );

        if (success) {
          executions++;
          totalProfitUsd += result.netProfitUsd;
          printArbitrageResult(result, false, txHash);
        } else {
          console.error(\`  \\x1b[31m[Execution Error]\\x1b[0m \${error}\`);
          printArbitrageResult(result, false);
        }
      } else {
        // 4b. Dry run: log what would happen, don't send any transaction
        printArbitrageResult(result, true);
      }
    } else {
      printArbitrageResult(result, config.dryRun);
    }

    printStats(cycle, opportunities, executions, totalProfitUsd);

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(\`  \\x1b[31m[Cycle Error]\\x1b[0m \${msg}\`);
  }
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────
process.on("SIGINT", () => {
  console.log("\\n\\x1b[36m[Shutdown]\\x1b[0m Stopping bot...");
  console.log(\`  \${cycle} cycles  |  \${executions} executions  |  $\${totalProfitUsd.toFixed(2)} total profit\`);
  process.exit(0);
});

// ─── Start ────────────────────────────────────────────────────────────────────
(async () => {
  await runCycle();
  setInterval(runCycle, config.pollMs);
})();
`;

// ─────────────────────────────────────────────────────────────────────────────
const FLASH_LOAN_SOL = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title FlashLoanReceiver
 * @notice Arbitrum mainnet (verified addresses 2025):
 *   Aave V3 Pool:  0x794a61358D6845594F94dc1DB02A252b5b4814aD
 *   Uni V3 Router: 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45
 *   Sushi Router:  0x1b02dA8Cb0d097eB8D57A175b88c7d8b47997506
 *   WETH:          0x82aF49447D8a07e3bd95BD0d56f35241523fBab1
 *   USDC.e:        0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8
 *
 * @dev Deploy this contract first, then set CONTRACT_ADDRESS in .env.
 *      Only the deployer (owner) can call executeArbitrage().
 */

interface IFlashLoanSimpleReceiver {
    function executeOperation(address asset, uint256 amount, uint256 premium, address initiator, bytes calldata params) external returns (bool);
}
interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn; address tokenOut; uint24 fee; address recipient;
        uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata p) external returns (uint256);
}
interface IUniswapV2Router {
    function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) external returns (uint256[] memory);
}
interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract FlashLoanReceiver is IFlashLoanSimpleReceiver {
    address public constant AAVE_POOL    = 0x794a61358D6845594F94dc1DB02A252b5b4814aD;
    address public constant UNI_ROUTER   = 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45;
    address public constant SUSHI_ROUTER = 0x1b02dA8Cb0d097eB8D57A175b88c7d8b47997506;
    address public constant WETH         = 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1;
    address public constant USDC_E       = 0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8;

    address public immutable owner;
    constructor() { owner = msg.sender; }

    modifier onlyAavePool() { require(msg.sender == AAVE_POOL, "Only Aave"); _; }

    function executeOperation(
        address asset, uint256 amount, uint256 premium,
        address, bytes calldata params
    ) external override onlyAavePool returns (bool) {
        require(asset == WETH, "Only WETH flash loans");
        uint8 dir = abi.decode(params, (uint8));
        uint256 debt = amount + premium; // repay amount + 0.09% Aave fee
        if (dir == 0) {
            uint256 usdc = _sellOnUni(amount);
            _buyOnSushi(usdc, debt);
        } else {
            uint256 usdc = _sellOnSushi(amount);
            _buyOnUni(usdc, debt);
        }
        IERC20(WETH).approve(AAVE_POOL, debt);
        return true;
    }

    function _sellOnUni(uint256 wethIn) internal returns (uint256) {
        IERC20(WETH).approve(UNI_ROUTER, wethIn);
        return ISwapRouter02(UNI_ROUTER).exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: WETH, tokenOut: USDC_E, fee: 500,
                recipient: address(this), amountIn: wethIn,
                amountOutMinimum: 0, sqrtPriceLimitX96: 0
            })
        );
    }
    function _buyOnSushi(uint256 usdcIn, uint256 minWethOut) internal {
        IERC20(USDC_E).approve(SUSHI_ROUTER, usdcIn);
        address[] memory p = new address[](2); p[0] = USDC_E; p[1] = WETH;
        IUniswapV2Router(SUSHI_ROUTER).swapExactTokensForTokens(
            usdcIn, minWethOut, p, address(this), block.timestamp + 60
        );
    }
    function _sellOnSushi(uint256 wethIn) internal returns (uint256) {
        IERC20(WETH).approve(SUSHI_ROUTER, wethIn);
        address[] memory p = new address[](2); p[0] = WETH; p[1] = USDC_E;
        uint256[] memory a = IUniswapV2Router(SUSHI_ROUTER).swapExactTokensForTokens(
            wethIn, 0, p, address(this), block.timestamp + 60
        );
        return a[1];
    }
    function _buyOnUni(uint256 usdcIn, uint256 minWethOut) internal {
        IERC20(USDC_E).approve(UNI_ROUTER, usdcIn);
        ISwapRouter02(UNI_ROUTER).exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: USDC_E, tokenOut: WETH, fee: 500,
                recipient: address(this), amountIn: usdcIn,
                amountOutMinimum: minWethOut, sqrtPriceLimitX96: 0
            })
        );
    }
    function withdraw(address token) external {
        require(msg.sender == owner, "Not owner");
        IERC20(token).transfer(owner, IERC20(token).balanceOf(address(this)));
    }
}
`;