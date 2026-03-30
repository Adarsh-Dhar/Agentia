/**
 * frontend/app/api/generate-bot/route.ts
 *
 * Receives a structured BotConfig from the configurator chat,
 * calls the Python Meta-Agent server to scaffold the bot code,
 * then saves it as an Agent + files in the database.
 *
 * Key change: the `intent` object returned by the orchestrator is now
 * saved inside the agent's `configuration` field so that the Bot IDE
 * can read it back and render the correct env-var fields and strategy badges.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { encryptEnvConfig } from "@/lib/crypto-env";
import type { BotConfig } from "@/lib/types";

const META_AGENT_URL = process.env.META_AGENT_URL ?? "http://127.0.0.1:8000";

// ─── Build .env plaintext from BotConfig ─────────────────────────────────────

function buildEnvPlaintext(config: BotConfig): string {
  return [
    `SIMULATION_MODE=${config.simulationMode}`,
    `ONEINCH_API_KEY=${config.oneInchApiKey ?? ""}`,
    `WEBACY_API_KEY=${config.webacyApiKey ?? ""}`,
    `RPC_PROVIDER_URL=${config.rpcUrl ?? ""}`,
    `WALLET_PRIVATE_KEY=${config.privateKey ?? ""}`,
    `BORROW_AMOUNT_HUMAN=${config.borrowAmountHuman}`,
    `POLL_INTERVAL=${config.pollingIntervalSec}`,
    // Always include MCP gateway URL so the bot can reach the server
    `MCP_GATEWAY_URL=${process.env.MCP_GATEWAY_URL ?? "http://localhost:8000/mcp"}`,
  ].join("\n") + "\n";
}

// ─── Build the prompt from BotConfig ─────────────────────────────────────────

function buildPrompt(cfg: BotConfig): string {
  const chainMap: Record<string, { chainId: number; rpc: string }> = {
    "base-sepolia": { chainId: 84532, rpc: "https://base-sepolia.g.alchemy.com/v2/YOUR_KEY" },
    "base-mainnet": { chainId: 8453,  rpc: "https://mainnet.base.org" },
    "arbitrum":     { chainId: 42161, rpc: "https://arb1.arbitrum.io/rpc" },
  };

  const tokenAddresses: Record<string, Record<string, string>> = {
    USDC:  {
      "base-sepolia": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "base-mainnet": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "arbitrum":     "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    },
    USDT:  {
      "base-sepolia": "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",
      "base-mainnet": "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",
      "arbitrum":     "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
    },
    WETH:  {
      "base-sepolia": "0x4200000000000000000000000000000000000006",
      "base-mainnet": "0x4200000000000000000000000000000000000006",
      "arbitrum":     "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    },
    CBBTC: {
      "base-sepolia": "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
      "base-mainnet": "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
      "arbitrum":     "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
    },
    AERO:  {
      "base-sepolia": "0x940181a94A35A4569E4529A3CDfB74e38FD98631",
      "base-mainnet": "0x940181a94A35A4569E4529A3CDfB74e38FD98631",
      "arbitrum":     "",
    },
  };

  const chainInfo  = chainMap[cfg.chain]  ?? chainMap["base-sepolia"];
  const baseAddr   = tokenAddresses[cfg.baseToken]?.[cfg.chain]   ?? "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const targetAddr = tokenAddresses[cfg.targetToken]?.[cfg.chain] ?? "0x4200000000000000000000000000000000000006";

  const securityInstructions =
    cfg.securityProvider === "none"
      ? "// Skip token risk checks entirely for maximum speed."
      : cfg.securityProvider === "webacy"
      ? `If profitable, verify BOTH tokens with Webacy get_token_risk (chain="${cfg.chain}"). Only proceed if both tokens pass: risk=="low" OR score<${cfg.maxRiskScore}.`
      : `If profitable, verify BOTH tokens with GoPlus Security. Only proceed if both tokens are safe.`;

  return `
Write an autonomous arbitrage bot named "${cfg.botName}" for ${cfg.chain} (Chain ID: ${chainInfo.chainId}).

CONFIGURATION:
- Base Token (flash loan asset): ${cfg.baseToken} (${baseAddr})
- Target Token (arbitrage target): ${cfg.targetToken} (${targetAddr})
- DEX / Aggregator: ${cfg.dex}
- Flash Loan Provider: Aave V3
- Borrow Amount: ${cfg.borrowAmountHuman} ${cfg.baseToken}
- Minimum Net Profit to Execute: ${cfg.minProfitUsd} ${cfg.baseToken}
- Gas Buffer: ${cfg.gasBufferUsdc} ${cfg.baseToken}
- Loop Interval: Every ${cfg.pollingIntervalSec} seconds
- Simulation Mode default: ${cfg.simulationMode ? "true (no real transactions)" : "false (live execution)"}

STRATEGY:
Run a continuous async loop every ${cfg.pollingIntervalSec} seconds.
Use ${cfg.dex} get_quote to check the ${cfg.baseToken}->${cfg.targetToken}->${cfg.baseToken} round-trip price.
Calculate net profit after the 0.09% Aave flash loan fee and the gas buffer.
All math must use integers (base units) only.
${securityInstructions}
Get swap calldata from ${cfg.dex} get_swap_data using tokenIn/tokenOut keys.
Execute via goat_evm write_contract using the "address" key (not contractAddress).
Use structured logging. Call convert_to_base_units at startup for ALL token amounts.
Include SIMULATION_MODE toggle (read from env var).
`.trim();
}

// ─── Route Handler ────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const body   = await req.json();
    const config = body.config as BotConfig;

    if (!config || !config.chain || !config.baseToken || !config.targetToken) {
      return NextResponse.json({ error: "Invalid bot configuration." }, { status: 400 });
    }

    const envPlaintext = buildEnvPlaintext(config);
    const encryptedEnv = encryptEnvConfig(envPlaintext);
    const prompt       = buildPrompt(config);

    // ── Call Meta-Agent ───────────────────────────────────────────────────────
    let metaResponse: Response | null = null;
    let metaData:     Record<string, unknown> | null = null;

    try {
      metaResponse = await fetch(`${META_AGENT_URL}/create-bot`, {
        method:  "POST",
        headers: { "Content-Type": "application/json", accept: "application/json" },
        body:    JSON.stringify({ prompt }),
        signal:  AbortSignal.timeout(180_000),
      });

      if (metaResponse.ok) {
        metaData = await metaResponse.json() as Record<string, unknown>;
      }
    } catch {
      // Fall through to fallback
    }

    if (metaData) {
      return await saveMetaAgentBot(config, metaData, encryptedEnv);
    }

    return generateWebContainerFallback(config, envPlaintext, encryptedEnv);

  } catch (err) {
    console.error("[POST /api/generate-bot]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error." },
      { status: 500 }
    );
  }
}

// ─── Save Meta-Agent output ───────────────────────────────────────────────────

async function saveMetaAgentBot(
  config:      BotConfig,
  metaData:    Record<string, unknown>,
  encryptedEnv: string,
): Promise<NextResponse> {
  const output = (metaData.output ?? {}) as Record<string, unknown>;

  // The orchestrator now returns the classified intent in metaData.intent
  const intent = (metaData.intent ?? null) as Record<string, unknown> | null;

  let files = ((output.files ?? []) as Array<{ filepath: string; content: string; language?: string }>)
    .filter(f => ![".env", ".env.example"].includes(f.filepath));

  const userId = "public-user";
  await prisma.user.upsert({
    where:  { id: userId },
    update: {},
    create: { id: userId, email: `${userId}@placeholder.agentia`, walletAddress: "" },
  });

  const botName      = config.botName || "ArbitrageBot";
  const configRecord = {
    // Base config
    chain:              config.chain,
    baseToken:          config.baseToken,
    targetToken:        config.targetToken,
    dex:                config.dex,
    securityProvider:   config.securityProvider,
    borrowAmountHuman:  config.borrowAmountHuman,
    minProfitUsd:       config.minProfitUsd,
    gasBufferUsdc:      config.gasBufferUsdc,
    pollingIntervalSec: config.pollingIntervalSec,
    simulationMode:     config.simulationMode,
    generatedAt:        new Date().toISOString(),
    // ✅ Save intent so the IDE can render the correct env fields and badges
    intent,
    // Tools used by the Meta-Agent
    toolsUsed: Array.isArray(metaData.tools_used) ? metaData.tools_used : [],
  };

  const agent = await prisma.agent.create({
    data: {
      name:          botName,
      userId,
      status:        "STOPPED",
      configuration: configRecord as any,
      envConfig:     encryptedEnv,
      files: {
        create: files.map(f => ({
          filepath: f.filepath,
          content:  f.content,
          language: f.language || (f.filepath.endsWith(".py") ? "python" : "plaintext"),
        })),
      },
    },
    include: { files: true },
  });

  return NextResponse.json({
    agentId:  agent.id,
    botName,
    files,
    thoughts: (output.thoughts as string) ?? "",
    config:   configRecord,
    intent,
  });
}

// ─── Fallback: WebContainer TypeScript Bot ────────────────────────────────────

async function generateWebContainerFallback(
  config:      BotConfig,
  envPlaintext: string,
  encryptedEnv: string,
): Promise<NextResponse> {
  const chainIds: Record<string, number> = {
    "base-sepolia": 84532,
    "base-mainnet": 8453,
    "arbitrum":     42161,
  };
  const tokenAddr: Record<string, Record<string, string>> = {
    USDC:  {
      "base-sepolia": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "base-mainnet": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "arbitrum":     "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    },
    USDT:  {
      "base-sepolia": "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",
      "base-mainnet": "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",
      "arbitrum":     "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
    },
    WETH:  {
      "base-sepolia": "0x4200000000000000000000000000000000000006",
      "base-mainnet": "0x4200000000000000000000000000000000000006",
      "arbitrum":     "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    },
    CBBTC: {
      "base-sepolia": "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
      "base-mainnet": "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
      "arbitrum":     "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
    },
    AERO:  {
      "base-sepolia": "0x940181a94A35A4569E4529A3CDfB74e38FD98631",
      "base-mainnet": "0x940181a94A35A4569E4529A3CDfB74e38FD98631",
      "arbitrum":     "",
    },
  };

  const chainId  = chainIds[config.chain]  ?? 84532;
  const baseAddr = tokenAddr[config.baseToken]?.[config.chain]   ?? "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const tgtAddr  = tokenAddr[config.targetToken]?.[config.chain] ?? "0x4200000000000000000000000000000000000006";
  const baseDec  = config.baseToken === "WETH" ? 18 : 6;
  const tgtDec   = config.targetToken === "WETH" || config.targetToken === "AERO" ? 18
                 : config.targetToken === "CBBTC" ? 8 : 6;

  const configTs = `import "dotenv/config";
import { ethers } from "ethers";

export const BASE_TOKEN_ADDRESS   = "${baseAddr}";
export const TARGET_TOKEN_ADDRESS = "${tgtAddr}";
export const ARB_BOT_ADDRESS      = process.env.ARB_BOT_ADDRESS ?? "0x6b7b81e04D024259b87a6C0F5ab5Eb04d9539102";
export const ONE_INCH_ROUTER      = "0x111111125421cA6dc452d289314280a0f8842A65";
export const CHAIN_ID             = ${chainId};
export const BASE_DECIMALS        = ${baseDec};
export const TARGET_DECIMALS      = ${tgtDec};

export const MCP_GATEWAY_URL      = process.env.MCP_GATEWAY_URL ?? "http://localhost:8000/mcp";
export const AAVE_FEE_BPS         = 9n;
export const BORROW_AMOUNT_HUMAN  = process.env.BORROW_AMOUNT_HUMAN ?? "${config.borrowAmountHuman}";
export const MIN_PROFIT_HUMAN     = ${config.minProfitUsd};
export const GAS_BUFFER_BASE      = ${config.gasBufferUsdc}_000_000n;
export const POLL_INTERVAL_MS     = ${config.pollingIntervalSec * 1000};

export const SIMULATION_MODE      = (process.env.SIMULATION_MODE ?? "${config.simulationMode}") !== "false";
export const WEBACY_API_KEY       = process.env.WEBACY_API_KEY ?? "";
export const ONEINCH_API_KEY      = process.env.ONEINCH_API_KEY ?? "";
export const WALLET_PRIVATE_KEY   = process.env.WALLET_PRIVATE_KEY ?? "";
export const RPC_PROVIDER_URL     = process.env.RPC_PROVIDER_URL ?? "";

export function parseBaseUnits(human: string, decimals: number): bigint {
  return BigInt(Math.round(parseFloat(human) * 10 ** decimals));
}
export function createProvider() {
  if (!RPC_PROVIDER_URL) throw new Error("RPC_PROVIDER_URL is not set");
  return new ethers.JsonRpcProvider(RPC_PROVIDER_URL);
}
export function createSigner(provider: ethers.JsonRpcProvider) {
  if (!WALLET_PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY is not set");
  const key = WALLET_PRIVATE_KEY.startsWith("0x") ? WALLET_PRIVATE_KEY : \`0x\${WALLET_PRIVATE_KEY}\`;
  return new ethers.Wallet(key, provider);
}

export const FLASHLOAN_ABI = [
  { inputs:[{internalType:"address",name:"_addressProvider",type:"address"}], stateMutability:"nonpayable", type:"constructor" },
  { inputs:[{internalType:"address",name:"asset",type:"address"},{internalType:"uint256",name:"amount",type:"uint256"},{internalType:"uint256",name:"premium",type:"uint256"},{internalType:"address",name:"initiator",type:"address"},{internalType:"bytes",name:"params",type:"bytes"}], name:"executeOperation", outputs:[{internalType:"bool",name:"",type:"bool"}], stateMutability:"nonpayable", type:"function" },
  { inputs:[{internalType:"address",name:"tokenToBorrow",type:"address"},{internalType:"uint256",name:"amountToBorrow",type:"uint256"},{internalType:"address",name:"routerTarget",type:"address"},{internalType:"bytes",name:"swapData",type:"bytes"}], name:"requestArbitrage", outputs:[], stateMutability:"nonpayable", type:"function" },
  { inputs:[{internalType:"address",name:"token",type:"address"}], name:"withdrawProfit", outputs:[], stateMutability:"nonpayable", type:"function" },
] as const;
`;

  const secNote = config.securityProvider === "none"
    ? `async function verifyTokens(): Promise<boolean> { return true; }`
    : `async function isTokenSafe(addr: string): Promise<boolean> {
  try {
    const res = await fetch(
      \`https://api.webacy.com/addresses/\${addr}?chain=${config.chain}\`,
      { headers: { "x-api-key": WEBACY_API_KEY, Accept: "application/json" } }
    );
    if (!res.ok) return false;
    const d = await res.json() as { risk?: string; score?: number };
    return (d.risk ?? "unknown").toLowerCase() === "low" || (d.score ?? 100) < ${config.maxRiskScore ?? 20};
  } catch { return false; }
}
async function verifyTokens(): Promise<boolean> {
  const [b, t] = await Promise.all([isTokenSafe(BASE_TOKEN_ADDRESS), isTokenSafe(TARGET_TOKEN_ADDRESS)]);
  return b && t;
}`;

  const indexTs = `import "dotenv/config";
import {
  SIMULATION_MODE, BORROW_AMOUNT_HUMAN, POLL_INTERVAL_MS,
  WALLET_PRIVATE_KEY, RPC_PROVIDER_URL, WEBACY_API_KEY, ONEINCH_API_KEY,
  BASE_TOKEN_ADDRESS, TARGET_TOKEN_ADDRESS, ARB_BOT_ADDRESS, ONE_INCH_ROUTER,
  AAVE_FEE_BPS, GAS_BUFFER_BASE, MIN_PROFIT_HUMAN, BASE_DECIMALS, CHAIN_ID,
  FLASHLOAN_ABI, parseBaseUnits, createProvider, createSigner,
} from "./config.js";

const API_BASE = \`https://api.1inch.dev/swap/v6.0/\${CHAIN_ID}\`;
const C = { reset:"\\x1b[0m",cyan:"\\x1b[36m",green:"\\x1b[32m",red:"\\x1b[31m",yellow:"\\x1b[33m",dim:"\\x1b[2m",bold:"\\x1b[1m" };

function log(level: "INFO"|"WARN"|"ERROR"|"EXEC", msg: string) {
  const ts  = new Date().toISOString().replace("T"," ").slice(0,19);
  const col = level==="INFO"?C.cyan:level==="EXEC"?C.green:level==="WARN"?C.yellow:C.red;
  console.log(\`\${C.dim}\${ts}\${C.reset} [\${col}\${level}\${C.reset}] \${msg}\`);
}

async function oneInchFetch(path: string): Promise<unknown> {
  const res = await fetch(\`\${API_BASE}\${path}\`, {
    headers: { Authorization: \`Bearer \${ONEINCH_API_KEY}\`, Accept: "application/json" },
  });
  if (!res.ok) {
    const body = await res.text().catch(()=>"");
    let msg = body.slice(0,200);
    try { const p = JSON.parse(body) as {description?:string;error?:string}; msg=p.description??p.error??msg; } catch {}
    throw new Error(\`1inch \${res.status}: \${msg}\`);
  }
  return res.json();
}

async function getQuote(src:string,dst:string,amount:bigint):Promise<bigint>{
  const qs=new URLSearchParams({src,dst,amount:amount.toString()});
  const data=await oneInchFetch(\`/quote?\${qs}\`) as {dstAmount:string};
  if(!data.dstAmount) throw new Error("1inch quote: missing dstAmount");
  return BigInt(data.dstAmount);
}

async function getSwapData(src:string,dst:string,amount:bigint,from:string):Promise<string>{
  const qs=new URLSearchParams({src,dst,amount:amount.toString(),from,slippage:"1",disableEstimate:"true",allowPartialFill:"false"});
  const d=await oneInchFetch(\`/swap?\${qs}\`) as {tx:{data:string}};
  if(!d?.tx?.data) throw new Error("1inch swap: missing tx.data");
  return d.tx.data;
}

${secNote}

function validate():void{
  const errs:string[]=[];
  if(!ONEINCH_API_KEY) errs.push("ONEINCH_API_KEY not set  → https://portal.1inch.dev");
  ${config.securityProvider==="webacy" ? 'if(!WEBACY_API_KEY) errs.push("WEBACY_API_KEY not set   → https://webacy.com");' : ""}
  if(!SIMULATION_MODE){
    if(!RPC_PROVIDER_URL)   errs.push("RPC_PROVIDER_URL required for live mode");
    if(!WALLET_PRIVATE_KEY) errs.push("WALLET_PRIVATE_KEY required for live mode");
  }
  if(errs.length){ errs.forEach(e=>log("ERROR",e)); process.exit(1); }
}

log("INFO",\`${config.botName} | ${config.baseToken}→${config.targetToken} | ${config.chain} | chainId \${CHAIN_ID}\`);
validate();

const BORROW_BASE = parseBaseUnits(BORROW_AMOUNT_HUMAN, BASE_DECIMALS);
const MIN_PROFIT  = parseBaseUnits(String(MIN_PROFIT_HUMAN), BASE_DECIMALS);
const provider    = !SIMULATION_MODE ? createProvider() : null;
const signer      = !SIMULATION_MODE && provider ? createSigner(provider) : null;

if(SIMULATION_MODE) log("WARN","SIMULATION MODE — no real transactions will broadcast");
else                log("WARN",\`LIVE MODE on ${config.chain} (chainId \${CHAIN_ID})\`);

let cycle=0;
async function runCycle():Promise<void>{
  cycle++;
  try{
    const targetAmt   = await getQuote(BASE_TOKEN_ADDRESS,TARGET_TOKEN_ADDRESS,BORROW_BASE);
    const grossReturn = await getQuote(TARGET_TOKEN_ADDRESS,BASE_TOKEN_ADDRESS,targetAmt);
    const fee         = (BORROW_BASE*AAVE_FEE_BPS)/10_000n;
    const netProfit   = grossReturn-BORROW_BASE-fee-GAS_BUFFER_BASE;
    const netH        = (Number(netProfit)/10**BASE_DECIMALS).toFixed(6);
    if(netProfit>MIN_PROFIT){
      log("INFO",\`Cycle #\${cycle} ✓ net +\${netH} ${config.baseToken}\`);
      const tokensOk=await verifyTokens();
      if(!tokensOk){ log("WARN",\`Cycle #\${cycle} Token risk check failed\`); return; }
      if(SIMULATION_MODE){
        log("EXEC",\`[SIM] Cycle #\${cycle} Would flash loan. Net: +\${netH} ${config.baseToken}\`);
      } else {
        if(!signer){ log("ERROR","No signer"); return; }
        const {ethers}=await import("ethers");
        const calldata=await getSwapData(BASE_TOKEN_ADDRESS,TARGET_TOKEN_ADDRESS,BORROW_BASE,ARB_BOT_ADDRESS);
        const contract=new ethers.Contract(ARB_BOT_ADDRESS,FLASHLOAN_ABI,signer);
        const tx=await contract.requestArbitrage(BASE_TOKEN_ADDRESS,BORROW_BASE,ONE_INCH_ROUTER,calldata);
        const rc=await tx.wait(1);
        if(!rc||rc.status!==1) throw new Error(\`TX reverted: \${tx.hash}\`);
        log("EXEC",\`Cycle #\${cycle} ✓ TX: \${tx.hash}\`);
      }
    } else {
      log("INFO",\`Cycle #\${cycle} No opportunity. Net: \${netH} ${config.baseToken}\`);
    }
  } catch(err:unknown){
    log("ERROR",\`Cycle #\${cycle}: \${(err as Error).message}\`);
  }
}

runCycle();
const timer=setInterval(runCycle,POLL_INTERVAL_MS);
process.on("SIGINT",()=>{ clearInterval(timer); process.exit(0); });
process.on("SIGTERM",()=>{ clearInterval(timer); process.exit(0); });
`;

  const packageJson = JSON.stringify({
    name:    config.botName.toLowerCase().replace(/\s+/g, "-"),
    version: "1.0.0",
    type:    "module",
    description: `${config.baseToken}→${config.targetToken} flash loan arbitrage on ${config.chain}`,
    scripts: { start: "tsx src/index.ts", dev: "tsx src/index.ts" },
    dependencies:    { ethers: "^6.13.0", dotenv: "^16.4.0" },
    devDependencies: { typescript: "^5.4.0", "@types/node": "^20.0.0", tsx: "^4.7.0" },
  }, null, 2);

  const files = [
    { filepath: "package.json",  content: packageJson,  language: "json"       },
    { filepath: "src/config.ts", content: configTs,     language: "typescript" },
    { filepath: "src/index.ts",  content: indexTs,      language: "typescript" },
  ];

  // ── Fallback intent ────────────────────────────────────────────────────────
  const fallbackIntent = {
    chain:           "evm",
    network:          config.chain,
    strategy:        "arbitrage",
    execution_model: "polling",
    required_mcps:   ["one_inch", ...(config.securityProvider === "webacy" ? ["webacy"] : [])],
    bot_type:        `${config.botName} — Fallback`,
    requires_openai_key:    false,
    requires_solana_wallet: false,
  };

  const configRecord = {
    chain:             config.chain,
    baseToken:         config.baseToken,
    targetToken:       config.targetToken,
    dex:               config.dex,
    securityProvider:  config.securityProvider,
    borrowAmountHuman: config.borrowAmountHuman,
    minProfitUsd:      config.minProfitUsd,
    simulationMode:    config.simulationMode,
    generatedAt:       new Date().toISOString(),
    source:            "fallback",
    // ✅ Always save intent even for fallback bots
    intent:            fallbackIntent,
  };

  try {
    const userId = "public-user";
    await prisma.user.upsert({
      where:  { id: userId },
      update: {},
      create: { id: userId, email: `${userId}@placeholder.agentia`, walletAddress: "" },
    });

    const agent = await prisma.agent.create({
      data: {
        name:          config.botName,
        userId,
        status:        "STOPPED",
        configuration: configRecord,
        envConfig:     encryptedEnv,
        files: {
          create: files.map(f => ({
            filepath: f.filepath,
            content:  f.content,
            language: f.language,
          })),
        },
      },
      include: { files: true },
    });

    return NextResponse.json({
      agentId:  agent.id,
      botName:  config.botName,
      files,
      thoughts: `${config.botName}: ${config.baseToken}→${config.targetToken} on ${config.chain} via ${config.dex}. ${config.simulationMode ? "Simulation." : "Live."}`,
      config:   configRecord,
      intent:   fallbackIntent,
      source:   "fallback",
    });
  } catch {
    return NextResponse.json({
      agentId:  "offline-" + Date.now(),
      botName:  config.botName,
      files,
      thoughts: `${config.botName} generated offline (DB unavailable).`,
      config:   configRecord,
      intent:   fallbackIntent,
      source:   "offline-fallback",
    });
  }
}