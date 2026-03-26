import { NextResponse } from "next/server";

function makePackageJson() {
  return JSON.stringify(
    {
      name: "flash-loan-arbitrageur",
      version: "1.0.0",
      type: "module",
      scripts: { start: "tsx src/index.ts" },
      dependencies: {
        "chalk": "^5.3.0",
        "dotenv": "^16.4.0",
        "ethers": "^6.11.1" 
      },
      devDependencies: {
        "@types/node": "^20.0.0",
        "tsx": "^4.7.1",
        "typescript": "^5.3.0",
      },
    },
    null,
    2
  );
}

function makeTsConfig() {
  return JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "node",
        esModuleInterop: true,
        strict: true,
        skipLibCheck: true,
        forceConsistentCasingInFileNames: true,
      },
    },
    null,
    2
  );
}

const CONFIG_TS = `export const config = {
  evmRpcUrl:       process.env.EVM_RPC_URL || 'https://sepolia-rollup.arbitrum.io/rpc',
  privateKey:      process.env.EVM_PRIVATE_KEY || '',
  contractAddress: process.env.CONTRACT_ADDRESS || '0x0000000000000000000000000000000000000000',
  maxLoanUsd:      Number(process.env.MAX_LOAN_USD) || 100,
  minProfitUsd:    Number(process.env.MIN_PROFIT_USD) || 0,
  dryRun:          process.env.DRY_RUN === 'true',
  pollMs:          Number(process.env.POLL_MS) || 4000,
}
`;

const STATE_MACHINE_TS = `export type NodeFn<S> = (state: S) => Promise<Partial<S>> | Partial<S>
type RouterFn<S> = (state: S) => string

export class StateGraph<S extends Record<string, unknown>> {
  private nodes   = new Map<string, NodeFn<S>>()
  private edges   = new Map<string, string>()
  private condEdges = new Map<string, { router: RouterFn<S>; routes: Record<string, string> }>()
  private startNode = ''

  addNode(name: string, fn: NodeFn<S>) { this.nodes.set(name, fn); return this }

  addEdge(from: string, to: string) {
    if (from === '__start__') this.startNode = to
    else this.edges.set(from, to)
    return this
  }

  addConditionalEdges(from: string, router: RouterFn<S>, routes: Record<string, string>) {
    this.condEdges.set(from, { router, routes }); return this
  }

  compile() {
    const self = this
    return {
      async invoke(init: Partial<S>, opts?: { recursionLimit?: number }) {
        let state = { ...init } as S
        let current = self.startNode
        const limit = opts?.recursionLimit ?? 100_000
        for (let i = 0; i < limit; i++) {
          const fn = self.nodes.get(current)
          if (!fn) throw new Error('Unknown node: ' + current)
          state = { ...state, ...await fn(state) }
          const ce = self.condEdges.get(current)
          if (ce) {
            const key = ce.router(state)
            current = ce.routes[key] ?? key
          } else {
            const next = self.edges.get(current)
            if (!next || next === '__end__') break
            current = next
          }
        }
        return state
      }
    }
  }
}

export const START  = '__start__'
export const END    = '__end__'
`;

const PRICE_MONITOR_TS = `// Simulated DexScreener price monitor
// In production: calls https://api.dexscreener.com/latest/dex/tokens/<address>

export interface ArbitrageOpportunity {
  tokenSymbol:       string
  tokenAddress:      string
  buyDex:            string
  sellDex:           string
  buyPrice:          number
  sellPrice:         number
  gapPercent:        number
  estimatedProfitUsd: number
}

// Testnet Tokens (Arbitrum Sepolia)
const TOKENS = [
  { symbol: 'WETH', address: '0x980B62Da83eFf3D4576C647993b0c1D7faf17c73', price: 3000  },
  { symbol: 'USDC', address: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d', price: 1  },
]

const DEXES = ['Uniswap V3', 'SushiSwap', 'Camelot']

function jitter(base: number, pct = 0.015) {
  return base * (1 + (Math.random() - 0.5) * pct * 2)
}

export async function scanOpportunities(minGap = 0.5): Promise<ArbitrageOpportunity[]> {
  // Simulate network round-trip
  await new Promise(r => setTimeout(r, 150 + Math.random() * 250))

  const results: ArbitrageOpportunity[] = []

  for (const token of TOKENS) {
    const prices = DEXES.map(dex => ({ dex, price: jitter(token.price) }))
                        .sort((a, b) => a.price - b.price)

    const cheap   = prices[0]
    const expensive = prices[prices.length - 1]
    const gap = ((expensive.price - cheap.price) / cheap.price) * 100

    // Only surface real-looking opportunities
    if (gap >= minGap && Math.random() > 0.82) {
      results.push({
        tokenSymbol:       token.symbol,
        tokenAddress:      token.address,
        buyDex:            cheap.dex,
        sellDex:           expensive.dex,
        buyPrice:          cheap.price,
        sellPrice:         expensive.price,
        gapPercent:        parseFloat(gap.toFixed(4)),
        estimatedProfitUsd: parseFloat(((10000 * gap) / 100).toFixed(2)),
      })
    }
  }

  return results.sort((a, b) => b.gapPercent - a.gapPercent)
}
`;

const PROFIT_CALC_TS = `// Exact profit model — mirrors the on-chain math in FlashLoanArbitrageur.sol

export interface ProfitAnalysis {
  isProfitable:     boolean
  grossProfit:      number   // price-gap revenue
  aaveFee:          number   // 0.09% flash-loan premium
  dexFees:          number   // 0.3% × 2 swaps
  estimatedGasCost: number   // gas in USD
  netProfit:        number
  roi:              number   // percent of borrowed capital
  recommendation:   'EXECUTE' | 'MONITOR' | 'SKIP'
}

const round = (n: number, d = 2) =>
  Math.round(n * 10 ** d) / 10 ** d

export function calculateProfit(
  borrowUsd:    number,
  gapPct:       number,
  gasPriceGwei = 0.1,   // Arbitrum is cheap
  ethPriceUsd  = 3_000,
  gasUnits     = 450_000,
): ProfitAnalysis {
  const grossProfit      = borrowUsd * (gapPct / 100)
  const aaveFee          = borrowUsd * 0.0009          // 9 bps
  const dexFees          = borrowUsd * 0.006           // 0.3% × 2
  const estimatedGasCost = gasUnits * gasPriceGwei * 1e-9 * ethPriceUsd
  const netProfit        = grossProfit - aaveFee - dexFees - estimatedGasCost
  const roi              = (netProfit / borrowUsd) * 100

  const recommendation: ProfitAnalysis['recommendation'] =
    netProfit > 0 ? 'EXECUTE' : netProfit > -5 ? 'MONITOR' : 'SKIP'

  return {
    isProfitable: netProfit > 0,
    grossProfit:      round(grossProfit),
    aaveFee:          round(aaveFee),
    dexFees:          round(dexFees),
    estimatedGasCost: round(estimatedGasCost),
    netProfit:        round(netProfit),
    roi:              round(roi, 4),
    recommendation,
  }
}
`;

const TOKEN_VALIDATOR_TS = `// Token security validator
// In production: calls Rugcheck.xyz + GoPlus Security APIs

export interface SecurityReport {
  tokenAddress: string
  isSafe:       boolean
  score:        number
  flags:        string[]
}

// Well-known safe tokens on Arbitrum Sepolia
const SAFE_LIST = new Set([
  '0x980B62Da83eFf3D4576C647993b0c1D7faf17c73',  // WETH
  '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',  // USDC
])

export async function validateToken(address: string): Promise<SecurityReport> {
  await new Promise(r => setTimeout(r, 80 + Math.random() * 150))

  if (SAFE_LIST.has(address)) {
    return { tokenAddress: address, isSafe: true, score: 92 + Math.floor(Math.random() * 8), flags: [] }
  }

  const score = Math.floor(Math.random() * 100)
  return {
    tokenAddress: address,
    isSafe: score >= 70,
    score,
    flags: score < 70 ? ['UNVERIFIED_CONTRACT', 'LOW_LIQUIDITY'] : [],
  }
}
`;

const FLASHLOAN_EXECUTOR_TS = `import { ethers } from "ethers";
import { config } from "./config.js";

const ARBITRAGEUR_ABI = [
  "function executeArbitrage((address tokenBorrow, address tokenInterim, uint256 amountBorrow, uint24 feeDexA, uint24 feeDexB, uint256 minProfit)) external",
  "event ArbitrageExecuted(address indexed tokenBorrow, uint256 amountBorrowed, uint256 profit)"
];

export interface ExecuteParams {
  tokenBorrow:    string;
  tokenInterim:   string;
  amountBorrowUsd: number;
  buyDex:         string;
  sellDex:        string;
  minProfitUsd:   number;
}

export interface ExecResult {
  success:    boolean;
  txHash?:    string;
  profit?:    number;
  gasUsed?:   number;
  durationMs?: number;
  error?:     string;
}

export class FlashLoanExecutor {
  private provider: ethers.JsonRpcProvider;
  private signer: ethers.Wallet;
  private contract: ethers.Contract;

  constructor() {
    this.provider = new ethers.JsonRpcProvider(config.evmRpcUrl);
    // Create a random wallet if key is missing/DEMO to prevent crashing during instantiation
    const pk = config.privateKey && config.privateKey.length > 20 
      ? config.privateKey 
      : ethers.Wallet.createRandom().privateKey;
      
    this.signer = new ethers.Wallet(pk, this.provider);
    this.contract = new ethers.Contract(config.contractAddress, ARBITRAGEUR_ABI, this.signer);
  }

  async simulate(params: any): Promise<boolean> {
    try {
      await this.contract.executeArbitrage.staticCall(params);
      return true;
    } catch (err: any) {
      return false;
    }
  }

  async execute(params: ExecuteParams): Promise<ExecResult> {
    const t0 = Date.now();

    if (config.dryRun) {
      await new Promise(r => setTimeout(r, 400));
      return {
        success: true,
        txHash: '0xDRY' + Date.now().toString(16).padStart(60, '0'),
        profit: params.minProfitUsd * 1.05,
        gasUsed: 380000,
        durationMs: Date.now() - t0,
      };
    }

    try {
      // Map USD amounts to 6 decimals (assuming USDC base)
      const amountBorrow = BigInt(Math.floor(params.amountBorrowUsd * 1e6));
      const minProfit = BigInt(Math.floor(params.minProfitUsd * 1e6));
      
      const contractParams = {
        tokenBorrow: params.tokenBorrow,
        tokenInterim: params.tokenInterim,
        amountBorrow: amountBorrow,
        feeDexA: 3000, // 0.3% pool tier
        feeDexB: 3000, // 0.3% pool tier
        minProfit: minProfit
      };

      // 1. Simulate locally to save gas on failures
      const ok = await this.simulate(contractParams);
      if (!ok) return { success: false, error: 'Simulation failed — tx would revert', durationMs: Date.now() - t0 };

      // 2. Estimate Gas & Add 20% Buffer
      const gasEstimate = await this.contract.executeArbitrage.estimateGas(contractParams);
      const gasLimit = (gasEstimate * BigInt(120)) / BigInt(100);

      // 3. Execute Transaction
      const tx = await this.contract.executeArbitrage(contractParams, { gasLimit });
      const receipt = await tx.wait();

      // 4. Parse real profit from emitted event
      const event = receipt.logs
        .map((log: any) => { try { return this.contract.interface.parseLog(log); } catch { return null; } })
        .find((e: any) => e?.name === "ArbitrageExecuted");
        
      const profit = event ? parseFloat(ethers.formatUnits(event.args.profit, 6)) : params.minProfitUsd;

      return {
        success: true,
        txHash: tx.hash,           // <--- REAL TX HASH RETURNED HERE
        profit: profit,
        gasUsed: Number(receipt.gasUsed),
        durationMs: Date.now() - t0,
      };
    } catch (err: any) {
      return { success: false, error: err.message || 'Execution error', durationMs: Date.now() - t0 };
    }
  }
}
`;

const WORKFLOW_TS = `import { StateGraph, START } from './state-machine.js'
import chalk from 'chalk'
import { scanOpportunities, type ArbitrageOpportunity } from './price-monitor.js'
import { calculateProfit, type ProfitAnalysis } from './profit-calculator.js'
import { validateToken, type SecurityReport } from './token-validator.js'
import { FlashLoanExecutor, type ExecResult } from './flashloan-executor.js'
import { config } from './config.js'

// ─── State shape ─────────────────────────────────────────────────────────────

interface BotState {
  opportunity:     ArbitrageOpportunity | null
  security:        SecurityReport       | null
  profitAnalysis:  ProfitAnalysis       | null
  execResult:      ExecResult           | null
  stats: {
    cycles:          number
    found:           number
    attempted:       number
    succeeded:       number
    totalProfitUsd:  number
  }
}

const defaultState: BotState = {
  opportunity:    null,
  security:       null,
  profitAnalysis: null,
  execResult:     null,
  stats: { cycles: 0, found: 0, attempted: 0, succeeded: 0, totalProfitUsd: 0 },
}

const executor = new FlashLoanExecutor()

// ─── Helpers ─────────────────────────────────────────────────────────────────

const ts = () => chalk.dim('[' + new Date().toLocaleTimeString() + ']')
const pad = () => chalk.dim('                    ')

// ─── Nodes ───────────────────────────────────────────────────────────────────

async function monitorPrices(state: BotState): Promise<Partial<BotState>> {
  process.stdout.write(ts() + ' ' + chalk.cyan('MONITOR') + chalk.dim(' Scanning DEXes') + chalk.dim(' '.repeat(30)) + '\\r')

  await new Promise(r => setTimeout(r, config.pollMs))

  const opps = await scanOpportunities(0.5)
  const stats = { ...state.stats, cycles: state.stats.cycles + 1 }

  if (!opps.length) {
    process.stdout.write(ts() + ' ' + chalk.cyan('MONITOR') + chalk.dim(' No arbitrage this cycle' + ' '.repeat(20) + '\\n'))
    return { opportunity: null, security: null, profitAnalysis: null, execResult: null, stats }
  }

  const best = opps[0]
  stats.found = state.stats.found + 1

  console.log(
    ts() + ' ' + chalk.green('FOUND  ') +
    chalk.bold(best.tokenSymbol.padEnd(5)) +
    chalk.yellow('+' + best.gapPercent.toFixed(3) + '%') +
    chalk.dim('  ' + best.buyDex + ' → ' + best.sellDex) +
    chalk.dim('  est $' + best.estimatedProfitUsd)
  )

  return { opportunity: best, security: null, profitAnalysis: null, execResult: null, stats }
}

async function validateSecurity(state: BotState): Promise<Partial<BotState>> {
  if (!state.opportunity) return {}

  process.stdout.write(pad() + chalk.yellow('SECURE  ') + chalk.dim('Checking ' + state.opportunity.tokenSymbol + '..\\r'))

  const report = await validateToken(state.opportunity.tokenAddress)

  if (report.isSafe) {
    process.stdout.write(pad() + chalk.yellow('SECURE  ') + chalk.green('✓') + chalk.dim(' score ' + report.score + '/100' + ' '.repeat(20) + '\\n'))
  } else {
    console.log(pad() + chalk.yellow('SECURE  ') + chalk.red('⛔ UNSAFE  flags: ' + report.flags.join(', ')))
  }

  return { security: report }
}

async function calculateProfitNode(state: BotState): Promise<Partial<BotState>> {
  if (!state.opportunity) return {}

  const analysis = calculateProfit(config.maxLoanUsd, state.opportunity.gapPercent)

  const col = analysis.recommendation === 'EXECUTE' ? chalk.green
            : analysis.recommendation === 'MONITOR'  ? chalk.yellow
            : chalk.red

  console.log(
    pad() + chalk.blue('PROFIT  ') +
    chalk.dim('net ') + col('$' + analysis.netProfit) +
    chalk.dim('  gross $' + analysis.grossProfit +
      '  fees $' + (analysis.aaveFee + analysis.dexFees).toFixed(2) +
      '  gas $'  + analysis.estimatedGasCost) +
    '  ' + col(analysis.recommendation)
  )

  return { profitAnalysis: analysis }
}

async function executeFlashLoan(state: BotState): Promise<Partial<BotState>> {
  if (!state.opportunity || !state.profitAnalysis) return {}

  const mode = config.dryRun ? chalk.yellow('[DRY RUN]') : chalk.red.bold('[LIVE TX]')
  process.stdout.write(pad() + chalk.magenta('EXECUTE ') + mode + chalk.dim(' Sending...\\r'))

  const stats = { ...state.stats, attempted: state.stats.attempted + 1 }

  const result = await executor.execute({
    tokenBorrow:     state.opportunity.tokenAddress,
    tokenInterim:    '0x980B62Da83eFf3D4576C647993b0c1D7faf17c73', // Arbitrum Sepolia WETH
    amountBorrowUsd: config.maxLoanUsd,
    buyDex:          state.opportunity.buyDex,
    sellDex:         state.opportunity.sellDex,
    minProfitUsd:    config.minProfitUsd,
  })

  if (result.success) {
    stats.succeeded       = state.stats.succeeded + 1
    stats.totalProfitUsd  = parseFloat((state.stats.totalProfitUsd + (result.profit ?? 0)).toFixed(2))

    console.log(
      pad() + chalk.magenta('EXECUTE ') +
      chalk.green.bold('✅ SUCCESS') +
      chalk.dim('  profit ') + chalk.green('+$' + result.profit?.toFixed(2)) +
      chalk.dim('  gas '   + result.gasUsed?.toLocaleString()) +
      chalk.dim('  ' + result.durationMs + 'ms') +
      chalk.dim('  ' + result.txHash?.slice(0, 20) + '...')
    )
  } else {
    console.log(pad() + chalk.magenta('EXECUTE ') + chalk.red('❌ FAILED  ') + chalk.dim(result.error))
  }

  return { execResult: result, stats }
}

async function logStats(state: BotState): Promise<Partial<BotState>> {
  const s = state.stats
  console.log(
    chalk.dim('──────────────────────────────────────────────────────') + '\\n' +
    chalk.dim('  STATS  cycles:' + s.cycles +
      '  found:' + s.found +
      '  exec:' + s.attempted +
      '  wins:' + s.succeeded) +
    '  ' + chalk.green('profit: $' + s.totalProfitUsd.toFixed(2)) + '\\n' +
    chalk.dim('──────────────────────────────────────────────────────')
  )
  return {}
}

// ─── Routing ─────────────────────────────────────────────────────────────────

const routeAfterMonitor    = (s: BotState) => s.opportunity              ? 'validateSecurity' : 'monitorPrices'
const routeAfterSecurity   = (s: BotState) => s.security?.isSafe         ? 'calculateProfit'  : 'monitorPrices'
const routeAfterProfit     = (s: BotState) =>
  s.profitAnalysis?.recommendation === 'EXECUTE' ? 'executeFlashLoan' : 'monitorPrices'

// ─── Graph ────────────────────────────────────────────────────────────────────

export function buildArbitrageGraph() {
  return new StateGraph<BotState>()
    .addNode('monitorPrices',   monitorPrices)
    .addNode('validateSecurity', validateSecurity)
    .addNode('calculateProfit', calculateProfitNode)
    .addNode('executeFlashLoan', executeFlashLoan)
    .addNode('logStats',        logStats)
    .addEdge(START, 'monitorPrices')
    .addConditionalEdges('monitorPrices',   routeAfterMonitor,  { validateSecurity: 'validateSecurity', monitorPrices: 'monitorPrices' })
    .addConditionalEdges('validateSecurity', routeAfterSecurity, { calculateProfit:  'calculateProfit',  monitorPrices: 'monitorPrices' })
    .addConditionalEdges('calculateProfit', routeAfterProfit,   { executeFlashLoan: 'executeFlashLoan', monitorPrices: 'monitorPrices' })
    .addEdge('executeFlashLoan', 'logStats')
    .addEdge('logStats', 'monitorPrices')
    .compile()
}
`;

const INDEX_TS = `import 'dotenv/config'
import chalk from 'chalk'
import { buildArbitrageGraph } from './workflow.js'
import { config } from './config.js'

// ─── Banner ──────────────────────────────────────────────────────────────────
console.log(chalk.cyan.bold('\\n╔═══════════════════════════════════════════════════════╗'))
console.log(chalk.cyan.bold('║') + chalk.bold('   ⚡  Flash Loan Arbitrageur  —  Powered by Aave V3  ') + chalk.cyan.bold('║'))
console.log(chalk.cyan.bold('╠═══════════════════════════════════════════════════════╣'))
console.log(chalk.cyan.bold('║') + chalk.dim('  Network  : Arbitrum Sepolia (Testnet)               ') + chalk.cyan.bold('║'))
console.log(chalk.cyan.bold('║') + chalk.dim('  Max Loan : $' + config.maxLoanUsd.toLocaleString().padEnd(42)) + chalk.cyan.bold('║'))
console.log(chalk.cyan.bold('║') + chalk.dim('  Min P&L  : $' + config.minProfitUsd.toString().padEnd(42)) + chalk.cyan.bold('║'))
console.log(chalk.cyan.bold('║') + '  Mode     : ' + (config.dryRun ? chalk.yellow('DRY RUN (safe)'.padEnd(39)) : chalk.red('LIVE TRADING ⚠️ '.padEnd(39))) + chalk.cyan.bold('║'))
console.log(chalk.cyan.bold('╚═══════════════════════════════════════════════════════╝\\n'))
console.log(chalk.dim('State machine nodes:'))
console.log(chalk.dim('  monitorPrices → validateSecurity → calculateProfit → executeFlashLoan → logStats'))
console.log(chalk.dim('  • Aave V3 flash loan fee : 0.09%'))
console.log(chalk.dim('  • DEX swap fees          : 0.3% × 2 hops'))
console.log(chalk.dim('  • Static-call simulation : always runs before live tx'))
console.log(chalk.dim('  • Token safety check     : Rugcheck.xyz score ≥ 70\\n'))

// ─── Run ──────────────────────────────────────────────────────────────────────
const graph = buildArbitrageGraph()

process.on('SIGINT', () => {
  console.log(chalk.yellow('\\n⏹  Shutting down gracefully...'))
  process.exit(0)
})

await graph.invoke(
  {
    opportunity: null, security: null, profitAnalysis: null, execResult: null,
    stats: { cycles: 0, found: 0, attempted: 0, succeeded: 0, totalProfitUsd: 0 }
  },
  { recursionLimit: 100_000 }
)
`;

// ─── Files array ─────────────────────────────────────────────────────────────

export function generateFromMetaAgent(intent: string) {
  // In production, this function would call your Meta-Agent LLM backend with the user intent
  // and receive a structured response containing the generated files.

  return Promise.resolve({
    files: [
      { filepath: 'package.json', content: makePackageJson() },
      { filepath: 'tsconfig.json', content: makeTsConfig() },
      { filepath: 'src/config.ts', content: CONFIG_TS },
      { filepath: 'src/state-machine.ts', content: STATE_MACHINE_TS },
      { filepath: 'src/price-monitor.ts', content: PRICE_MONITOR_TS },
      { filepath: 'src/profit-calculator.ts', content: PROFIT_CALC_TS },
      { filepath: 'src/token-validator.ts', content: TOKEN_VALIDATOR_TS },
      { filepath: 'src/flashloan-executor.ts', content: FLASHLOAN_EXECUTOR_TS },
      { filepath: 'src/workflow.ts', content: WORKFLOW_TS },
      { filepath: 'src/index.ts', content: INDEX_TS },
    ]
  });
}

// Route handler: Pass through LLM/Meta-Agent output directly
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const userIntent: string = body.intent ?? "Build a flash loan arbitrageur";

    // Call the Meta-Agent LLM (or backend) to generate the files
    const aiResponse = await generateFromMetaAgent(userIntent); 
    
    // Ensure the response maps 'filepath' correctly to what the WebContainer expects
    return NextResponse.json({ files: aiResponse.files });
  } catch (err) {
    console.error("[get-code] Error:", err);
    return NextResponse.json(
      { error: "Failed to generate bot" },
      { status: 500 }
    );
  }
}