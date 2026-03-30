"""
agents/orchestrator.py

Universal Meta-Agent — two-step intent router + dynamic template injection.
Supports 20+ bot archetypes across EVM chains and Solana.

Pipeline:
  1. classify_intent()        → GPT-4o classifies chain / strategy / execution model
  2. _select_template()       → injects the correct base template (Polling / WSS / Agentic / Solana)
  3. _collect_sdk_snippets()  → RAG-injects relevant SDK docs (CoW, Jupiter, Nansen, …)
  4. build_bot_logic()        → GPT-4o generates the full bot with a narrowed context window
"""

import os
import json
from dotenv import load_dotenv
from mcp_client import MultiMCPClient
from azure.ai.inference import ChatCompletionsClient
from azure.ai.inference.models import SystemMessage, UserMessage
from azure.core.credentials import AzureKeyCredential

load_dotenv()


# ─────────────────────────────────────────────────────────────────────────────
# MCP Bridge instruction — injected into every generated bot's system prompt
# ─────────────────────────────────────────────────────────────────────────────

TS_MCP_BRIDGE = """
## FILE INSTRUCTION: src/mcp_bridge.ts
You MUST generate a file named `src/mcp_bridge.ts` to communicate with the host MCP servers.
Use exactly this implementation:

```typescript
// src/mcp_bridge.ts
export async function callMcpTool(
  server: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const MCP_GATEWAY = process.env.MCP_GATEWAY_URL ?? "http://localhost:8000/mcp";
  const response = await fetch(`${MCP_GATEWAY}/${server}/${tool}`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(args),
  });
  if (!response.ok) {
    throw new Error(`MCP Tool ${server}/${tool} failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}
```

Import and use `callMcpTool` in src/index.ts for all MCP server interactions.
Add `MCP_GATEWAY_URL=http://localhost:8000/mcp` to your .env.example file.
"""


# ─────────────────────────────────────────────────────────────────────────────
# Aave V3 Flash Loan ABI
# ─────────────────────────────────────────────────────────────────────────────

FLASHLOAN_ABI = [
    {
        "inputs": [
            {"internalType": "address", "name": "_addressProvider", "type": "address"}
        ],
        "stateMutability": "nonpayable",
        "type": "constructor",
    },
    {
        "inputs": [
            {"internalType": "address", "name": "asset",     "type": "address"},
            {"internalType": "uint256", "name": "amount",    "type": "uint256"},
            {"internalType": "uint256", "name": "premium",   "type": "uint256"},
            {"internalType": "address", "name": "initiator", "type": "address"},
            {"internalType": "bytes",   "name": "params",    "type": "bytes"},
        ],
        "name": "executeOperation",
        "outputs": [{"internalType": "bool", "name": "", "type": "bool"}],
        "stateMutability": "nonpayable",
        "type": "function",
    },
    {
        "inputs": [
            {"internalType": "address", "name": "tokenToBorrow",  "type": "address"},
            {"internalType": "uint256", "name": "amountToBorrow", "type": "uint256"},
            {"internalType": "address", "name": "routerTarget",   "type": "address"},
            {"internalType": "bytes",   "name": "swapData",       "type": "bytes"},
        ],
        "name": "requestArbitrage",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function",
    },
    {
        "inputs": [{"internalType": "address", "name": "token", "type": "address"}],
        "name": "withdrawProfit",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function",
    },
]


# ─────────────────────────────────────────────────────────────────────────────
# SDK Snippet Library  ── injected via RAG based on detected strategy / MCPs
# ─────────────────────────────────────────────────────────────────────────────

SDK_SNIPPETS: dict[str, str] = {

    "cow_protocol": """
## CoW Protocol — MEV-Protected Swap SDK Reference
CoW Protocol uses EIP-712 signed orders submitted to an off-chain orderbook.
The protocol guarantees Coincidence of Wants (CoW) or best on-chain execution — never sandwich-attackable.

Order submission flow:
  1. Build an order struct: sellToken, buyToken, sellAmount, buyAmount=0 (market), validTo, receiver.
  2. Encode with EIP-712 and sign with ethers.js _signTypedData().
  3. POST the signed order to the CoW API.
  4. Poll GET /api/v1/orders/{uid} until status === "fulfilled".

REST API base: https://api.cow.fi/{network}/api/v1
  networks: mainnet | xdai | arbitrum_one | base

Key endpoints:
  POST /orders       — submit a new order
  GET  /orders/{uid} — poll order status ("open" | "fulfilled" | "cancelled" | "expired")
  GET  /quote        — get fee + price estimate before submitting

TypeScript SDK (@cowprotocol/cow-sdk):
  import { CowSdk, OrderKind, OrderSigningUtils, SupportedChainId } from '@cowprotocol/cow-sdk';
  const cowSdk = new CowSdk(SupportedChainId.BASE, { signer });
  const order  = {
    sellToken: USDC_ADDRESS, buyToken: WETH_ADDRESS, sellAmount: amountIn.toString(),
    buyAmount: '0', receiver: walletAddress, validTo: Math.floor(Date.now()/1000) + 3600,
    appData: '0x0000000000000000000000000000000000000000000000000000000000000000',
    feeAmount: '0', kind: OrderKind.SELL, partiallyFillable: false,
  };
  const { signature, signingScheme } = await OrderSigningUtils.signOrder(order, chainId, signer);
  const { id: orderId } = await cowSdk.cowApi.sendOrder({ order, signature });

EIP-712 Domain (GPv2Settlement):
  name: "Gnosis Protocol", version: "v2", chainId: <int>
  verifyingContract: "0x9008D19f58AAbD9eD0D60971565AA8510560ab41"

MCP tools available (cow_protocol server):
  get_quote          args: { sellToken, buyToken, sellAmount, kind, from }
  create_order       args: { order, signature }
  get_order_status   args: { orderId }
""",

    "lunarcrush_sentiment": """
## LunarCrush — Social Sentiment SDK Reference
LunarCrush tracks social metrics for crypto: posts, engagement, sentiment, galaxy score.

MCP tools available (lunarcrush server — prefer these over REST):
  get_coins_list      — ranked list of assets by social activity
  get_coin_of_the_day — top trending asset right now
  get_coin_details    args: { coin: "BTC" | "ETH" | ticker }
                      returns: sentiment, galaxy_score, alt_rank, social_volume_24h, price_score

Key response fields:
  sentiment         — 0-100 bullish sentiment score (>70 = bullish signal)
  galaxy_score      — overall social strength 0-100 (>60 = strong)
  alt_rank          — rank by social activity vs Bitcoin (lower = more activity)
  social_volume_24h — total posts in last 24 hours

Trading signal logic:
  LONG  signal: sentiment > 70 && galaxy_score > 60
  SHORT signal: sentiment < 30 || galaxy_score < 20
  HOLD  signal: everything else

REST fallback (if MCP unavailable):
  GET https://lunarcrush.ai/api4/public/coins/{coin}/v1
  Authorization: Bearer {LUNARCRUSH_API_KEY}
""",

    "nansen_whale": """
## Nansen — Whale & Smart Money Tracking SDK Reference
Nansen labels on-chain wallets as "Smart Money", "DEX Trader", "NFT Whale", etc.
Use smart money inflow/outflow as a leading indicator before entering a trade.

REST API base: https://api.nansen.ai/v1
  Header: x-api-key: {NANSEN_API_KEY}

Key endpoints:
  GET /smart-money/flow?token={address}&chain={chain}
      Response fields: net_inflow_1h, net_inflow_24h, net_inflow_7d (in USD)
      Use as signal: net_inflow_1h > $50k → potential long entry

  GET /wallet/{address}/portfolio?chain={chain}
      Full portfolio of any labeled wallet (use to validate a whale's conviction)

  GET /token/{address}/holders?chain={chain}&label=smart_money
      List of smart money wallets currently holding the token

Whale mirror strategy (polling):
  1. Poll /smart-money/flow every 60s for the target token.
  2. If net_inflow_1h > BUY_THRESHOLD_USD → mirror buy.
  3. If net_outflow_1h > SELL_THRESHOLD_USD → mirror sell / set stop-loss.
  4. Always run Webacy risk check before entering.

MCP tools (nansen server — use if connected):
  get_smart_money_flow  args: { tokenAddress, chain, timeframe: "1h" | "24h" }
  get_wallet_portfolio  args: { walletAddress, chain }
""",

    "hyperliquid_perp": """
## Hyperliquid — Perpetuals SDK Reference
Hyperliquid is a fully on-chain L1 order book with zero-gas perpetual trading.

REST API: https://api.hyperliquid.xyz/info  (POST, JSON body)
WebSocket: wss://api.hyperliquid.xyz/ws

MCP tools available (hyperliquid server — prefer these):
  get_all_mids           — mid prices for all perp pairs { coin: price }
  get_l2_book            args: { coin }  → bids/asks arrays
  get_user_state         args: { user: walletAddress } → positions, margin, unrealizedPnl
  get_funding_history    args: { coin, startTime, endTime }

Placing an order (REST /exchange POST):
  {
    "action": {
      "type": "order",
      "orders": [{
        "a": <assetIndex>,      // BTC=0, ETH=1 — fetch from /meta endpoint
        "b": true,              // true=buy/long, false=sell/short
        "p": "0",               // price string; "0" = market IOC
        "s": "0.001",           // size in base asset
        "r": false,             // reduce-only flag
        "t": { "limit": { "tif": "Ioc" } }
      }]
    },
    "nonce": Date.now(),
    "signature": "<EIP-712 sig>"
  }

Funding rate arb strategy:
  1. Fetch get_funding_history for target pair.
  2. If funding_rate > threshold → short the perp (collect funding).
  3. Simultaneously long the spot asset to hedge delta.
  4. Close both legs when funding normalizes.
""",

    "debridge_crosschain": """
## DeBridge — Cross-Chain Bridge SDK Reference
DeBridge (DLN protocol) enables intent-based cross-chain swaps with rate guarantees and MEV protection.

REST API base: https://api.debridge.finance/api

Key endpoints:
  GET /DLN/order/quote
      Required params: srcChainId, srcChainTokenIn, srcChainTokenInAmount,
                       dstChainId, dstChainTokenOut, prependOperatingExpenses=true
      Returns: estimation object with fees, amounts, recommendedSlippage

  POST /DLN/order/create-tx
      Body: same params as quote + dstChainTokenOutRecipient (destination address)
      Returns: { tx: { to, data, value, gasLimit } } — ready for ethers.js sendTransaction

  GET /DLN/order/{orderId}/status
      Returns: "CREATED" | "FULFILLED" | "CANCELLED" | "PARTIALLY_FILLED"

Supported chain IDs:
  1=Ethereum, 56=BSC, 137=Polygon, 42161=Arbitrum, 8453=Base, 43114=Avalanche, 7565164=Solana

TypeScript example (Base → Arbitrum USDC yield arb):
  const quoteParams = {
    srcChainId: 8453, srcChainTokenIn: USDC_BASE, srcChainTokenInAmount: amount.toString(),
    dstChainId: 42161, dstChainTokenOut: USDC_ARB, prependOperatingExpenses: true,
  };
  const quoteUrl = new URLSearchParams(quoteParams as any).toString();
  const quote    = await (await fetch(`https://api.debridge.finance/api/DLN/order/quote?${quoteUrl}`)).json();

  const { tx } = await (await fetch('https://api.debridge.finance/api/DLN/order/create-tx', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...quoteParams, dstChainTokenOutRecipient: walletAddress }),
  })).json();
  const receipt = await signer.sendTransaction(tx);

MCP tools (debridge server — use if connected):
  get_chains        — list all supported chains
  get_order_quote   args: { srcChainId, srcChainTokenIn, srcChainTokenInAmount, dstChainId, dstChainTokenOut }
  create_order      args: { ...quoteParams, dstChainTokenOutRecipient }
  get_order_status  args: { orderId }
""",

    "jupiter_solana": """
## Jupiter — Solana Swap Aggregator SDK Reference
Jupiter is the canonical DEX aggregator on Solana, routing across Raydium, Orca, Whirlpool, etc.

Quote API:  GET  https://quote-api.jup.ag/v6/quote
  Params: inputMint, outputMint, amount (in base units / lamports), slippageBps (e.g. 50 = 0.5%)

Swap API:   POST https://quote-api.jup.ag/v6/swap
  Body: { quoteResponse, userPublicKey, wrapAndUnwrapSol: true, prioritizationFeeLamports: "auto" }
  Returns: { swapTransaction: "<base64 VersionedTransaction>" }

MCP tools available (jupiter server — prefer these):
  getQuote              args: { inputMint, outputMint, amount, slippageBps }
  getSwapInstructions   args: { quoteResponse, userPublicKey }

TypeScript signing + broadcasting:
  import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
  import bs58 from 'bs58';

  const connection = new Connection(process.env.SOLANA_RPC_URL!, 'confirmed');
  const keypair    = Keypair.fromSecretKey(bs58.decode(process.env.SOLANA_PRIVATE_KEY!));

  // After getting swapTransaction from Jupiter swap API:
  const vtx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
  vtx.sign([keypair]);
  const sig = await connection.sendRawTransaction(vtx.serialize(), { skipPreflight: true });
  await connection.confirmTransaction(sig, 'confirmed');

Required packages: @solana/web3.js, bs58
""",

    "websocket_mempool": """
## WebSocket Mempool Streaming — Sniper / HF Architecture
For low-latency sniping, connect to a live WebSocket stream instead of REST polling.

Alchemy WebSocket (EVM — subscribe to pending txs or new blocks):
  wss://base-mainnet.g.alchemy.com/v2/{ALCHEMY_API_KEY}
  wss://eth-mainnet.g.alchemy.com/v2/{ALCHEMY_API_KEY}

  Subscribe to pending transactions:
    { "jsonrpc":"2.0","id":1,"method":"eth_subscribe","params":["newPendingTransactions"] }

  Subscribe to new block headers:
    { "jsonrpc":"2.0","id":2,"method":"eth_subscribe","params":["newHeads"] }

  Subscribe to specific address logs (e.g. a Uniswap pool):
    { "jsonrpc":"2.0","id":3,"method":"eth_subscribe",
      "params":["logs",{"address":"<POOL_ADDRESS>","topics":["<EVENT_SIG>"]}] }

TypeScript reconnecting WebSocket pattern (ws package):
  import WebSocket from 'ws';
  function connect(): WebSocket {
    const ws = new WebSocket(process.env.WSS_URL!);
    ws.on('open',    ()    => { ws.send(JSON.stringify(SUBSCRIBE_MSG)); log('INFO', 'WS connected'); });
    ws.on('message', async (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.params?.result) await handleEvent(msg.params.result);
    });
    ws.on('error', (e) => log('ERROR', e.message));
    ws.on('close', ()  => { log('WARN','WS closed — reconnecting in 2s'); setTimeout(connect, 2000); });
    return ws;
  }
  const ws = connect();

Required packages: ws, @types/ws (add both to package.json dependencies + devDependencies)
Env: WSS_URL (derive from RPC_PROVIDER_URL: replace "https://" with "wss://")
""",

    "langchain_agent": """
## LangChain / LangGraph — Agentic Bot Architecture
For bots that use a sub-LLM to interpret news, sentiment, or TA signals before trading.

Required packages: openai  (lightweight; or @langchain/openai + @langchain/langgraph for full graphs)
Required env: OPENAI_API_KEY

Lightweight OpenAI sub-agent pattern (preferred for simple signal interpretation):
  import OpenAI from 'openai';
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  interface TradeDecision { action: 'buy' | 'sell' | 'hold'; confidence: number; reasoning: string; }

  async function getTradeDecision(marketContext: object): Promise<TradeDecision> {
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'You are a DeFi trading signal interpreter. Output JSON only: { action, confidence (0-1), reasoning }' },
        { role: 'user',   content: JSON.stringify(marketContext) },
      ],
    });
    return JSON.parse(res.choices[0].message.content!) as TradeDecision;
  }

Full ReAct agent (LangGraph — use for multi-step research tasks):
  import { ChatOpenAI }       from '@langchain/openai';
  import { createReactAgent } from '@langchain/langgraph/prebuilt';
  import { tool }             from '@langchain/core/tools';
  import { z }                from 'zod';

  const fetchSentiment = tool(async ({ ticker }) => {
    // call lunarcrush MCP or REST here
  }, { name: 'fetch_sentiment', description: 'Get social sentiment for a token', schema: z.object({ ticker: z.string() }) });

  const agent  = createReactAgent({ llm: new ChatOpenAI({ model: 'gpt-4o-mini', temperature: 0 }), tools: [fetchSentiment] });
  const result = await agent.invoke({ messages: [{ role: 'user', content: 'Should I long WETH right now?' }] });
""",
}


# ─────────────────────────────────────────────────────────────────────────────
# Strategy → SDK snippet keys  (used by _collect_sdk_snippets)
# ─────────────────────────────────────────────────────────────────────────────

STRATEGY_SNIPPETS: dict[str, list[str]] = {
    "arbitrage":    [],
    "mev_intent":   ["cow_protocol"],
    "sniping":      ["websocket_mempool"],
    "dca":          [],
    "grid":         [],
    "sentiment":    ["lunarcrush_sentiment"],
    "whale_mirror": ["nansen_whale"],
    "news_reactive": ["langchain_agent", "lunarcrush_sentiment"],
    "yield":        ["debridge_crosschain"],
    "perp":         ["hyperliquid_perp"],
    "scalper":      ["websocket_mempool"],
    "rebalancing":  [],
    "ta_scripter":  ["langchain_agent"],
    "unknown":      [],
}

# MCP server name → SDK snippet key
MCP_TO_SNIPPET: dict[str, str] = {
    "cow_protocol": "cow_protocol",
    "lunarcrush":   "lunarcrush_sentiment",
    "nansen":       "nansen_whale",
    "hyperliquid":  "hyperliquid_perp",
    "debridge":     "debridge_crosschain",
    "lifi":         "debridge_crosschain",
    "jupiter":      "jupiter_solana",
}


# ─────────────────────────────────────────────────────────────────────────────
# Execution Templates  (injected into system prompt based on intent)
# ─────────────────────────────────────────────────────────────────────────────

TEMPLATE_POLLING = """
## EXECUTION ARCHITECTURE: Template A — Polling Loop (REST)
Use a continuous async loop driven by setInterval. Poll all data sources via REST or MCP tools.

TypeScript pattern:
```typescript
let cycle = 0;
async function runCycle(): Promise<void> {
  cycle++;
  try { /* fetch → analyse → execute */ }
  catch (err: unknown) { log('ERROR', `Cycle #${cycle}: ${(err as Error).message}`); }
}
runCycle();
const timer = setInterval(runCycle, POLL_INTERVAL_MS);
process.on('SIGINT',  () => { clearInterval(timer); process.exit(0); });
process.on('SIGTERM', () => { clearInterval(timer); process.exit(0); });
```

Suitable for: Flash Loan Arbitrage, DCA, Grid Bot, Whale Mirror, Rebalancer, Yield Arb, Funding Rate Bot.
Use REST APIs and/or MCP tools exclusively — no persistent socket connections needed.
"""

TEMPLATE_WEBSOCKET = """
## EXECUTION ARCHITECTURE: Template B — WebSocket Stream (Low-Latency)
Maintain a persistent WSS connection and react to events in real time. Do NOT poll.
The bot's entry point connects the socket and registers an event handler; all trading logic
lives inside that handler.

TypeScript pattern (with auto-reconnect):
```typescript
import WebSocket from 'ws';
let ws: WebSocket;
function connect(): void {
  ws = new WebSocket(process.env.WSS_URL!);
  ws.on('open',    ()    => { ws.send(JSON.stringify(SUBSCRIBE_MSG)); log('INFO','WS open'); });
  ws.on('message', async (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.params?.result) await handleEvent(msg.params.result);
  });
  ws.on('error', (e) => log('ERROR', e.message));
  ws.on('close', ()  => { log('WARN','WS closed — reconnect in 2s'); setTimeout(connect, 2000); });
}
connect();
```

Required package additions to package.json:
  dependencies:    "ws": "^8.17.0"
  devDependencies: "@types/ws": "^8.5.0"

Env addition: WSS_URL — derive from RPC_PROVIDER_URL by replacing "https://" with "wss://".
Suitable for: Memecoin Sniper, HF Scalper, Mempool Watcher, Liquidation Hunter.
"""

TEMPLATE_AGENTIC = """
## EXECUTION ARCHITECTURE: Template C — Agentic (AI-Nested)
Embed a sub-LLM call each cycle to interpret complex, unstructured signals (news headlines,
sentiment scores, TA patterns) before deciding whether to trade.
The outer loop polls data; the inner LLM call converts raw context into a typed TradeDecision.

TypeScript pattern:
```typescript
import OpenAI from 'openai';
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

interface TradeDecision { action: 'buy' | 'sell' | 'hold'; confidence: number; reasoning: string; }

async function getTradeDecision(context: object): Promise<TradeDecision> {
  const res = await openai.chat.completions.create({
    model: 'gpt-4o-mini', temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: 'DeFi signal interpreter. Output JSON: { action, confidence (0-1), reasoning }.' },
      { role: 'user',   content: JSON.stringify(context) },
    ],
  });
  return JSON.parse(res.choices[0].message.content!) as TradeDecision;
}
```

Required package additions:
  dependencies: "openai": "^4.0.0"

Required env: OPENAI_API_KEY  (injected by worker at runtime; never hardcode).
Suitable for: Sentiment Sniper, News-Reactive Trader, TA Scripter.
"""

TEMPLATE_SOLANA = """
## EXECUTION ARCHITECTURE: Template D — Solana / Jupiter
Target the Solana blockchain. Use @solana/web3.js for signing and Jupiter API for swap routing.
Do NOT use ethers.js — it is EVM-only.

TypeScript pattern:
```typescript
import { Connection, Keypair, VersionedTransaction, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';

const connection = new Connection(process.env.SOLANA_RPC_URL!, 'confirmed');
const keypair    = Keypair.fromSecretKey(bs58.decode(process.env.SOLANA_PRIVATE_KEY!));

async function jupiterSwap(
  inputMint: string, outputMint: string, amountBaseUnits: bigint, slippageBps = 50,
): Promise<string> {
  const quote = await (await fetch(
    `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountBaseUnits}&slippageBps=${slippageBps}`
  )).json();
  const { swapTransaction } = await (await fetch('https://quote-api.jup.ag/v6/swap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ quoteResponse: quote, userPublicKey: keypair.publicKey.toBase58(), wrapAndUnwrapSol: true }),
  })).json();
  const vtx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
  vtx.sign([keypair]);
  return connection.sendRawTransaction(vtx.serialize(), { skipPreflight: true });
}
```

Required packages (add to package.json):
  dependencies: "@solana/web3.js": "^1.91.0", "bs58": "^6.0.0"

Required env: SOLANA_RPC_URL, SOLANA_PRIVATE_KEY (bs58-encoded keypair secret).
Common mints: SOL=So11111111111111111111111111111111111111112, USDC=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
Suitable for: Solana Memecoin Sniper, Jupiter DCA, Raydium LP Bot.
"""

TEMPLATES: dict[str, str] = {
    "polling":   TEMPLATE_POLLING,
    "websocket": TEMPLATE_WEBSOCKET,
    "agentic":   TEMPLATE_AGENTIC,
    "solana":    TEMPLATE_SOLANA,
}


# ─────────────────────────────────────────────────────────────────────────────
# Intent Classifier System Prompt
# ─────────────────────────────────────────────────────────────────────────────

CLASSIFIER_SYSTEM_PROMPT = """You are a DeFi bot intent classifier.
Analyze the user's trading bot request and output ONLY a valid JSON object — no markdown, no preamble.

Required schema:
{
  "chain":                  "evm" | "solana",
  "network":                "base-sepolia" | "base-mainnet" | "arbitrum" | "solana-mainnet",
  "execution_model":        "polling" | "websocket" | "agentic",
  "strategy":               "arbitrage" | "sniping" | "dca" | "grid" | "sentiment" | "whale_mirror" | "news_reactive" | "yield" | "perp" | "mev_intent" | "scalper" | "rebalancing" | "ta_scripter" | "unknown",
  "required_mcps":          [zero or more of: "one_inch","webacy","lunarcrush","jupiter","nansen","cow_protocol","hyperliquid","lifi","debridge","coingecko","twitter","alchemy","goat_evm","uniswap","chainlink"],
  "bot_type":               "human-readable bot name e.g. Aave Flash Loan Arbitrage Bot",
  "requires_openai_key":    true | false,
  "requires_solana_wallet": true | false
}

Classification rules (apply in order — first match wins):
  flash loan | arbitrage                → execution_model:"polling",  strategy:"arbitrage",    required_mcps:["one_inch","webacy","goat_evm"]
  CoW | MEV intent | MEV-protected      → execution_model:"polling",  strategy:"mev_intent",   required_mcps:[...,"cow_protocol"]
  sniper | memecoin | mempool           → execution_model:"websocket", strategy:"sniping",      required_mcps:["one_inch","webacy","alchemy"]
  DCA | dollar cost                     → execution_model:"polling",  strategy:"dca",          required_mcps:["one_inch"]
  grid | range | ladder                 → execution_model:"polling",  strategy:"grid",         required_mcps:["one_inch"]
  sentiment | social | LunarCrush       → execution_model:"agentic",  strategy:"sentiment",    required_mcps:["lunarcrush","one_inch"], requires_openai_key:true
  whale | smart money | Nansen | mirror → execution_model:"polling",  strategy:"whale_mirror", required_mcps:["nansen","one_inch","webacy"]
  news | GPT trader | AI trader         → execution_model:"agentic",  strategy:"news_reactive",required_mcps:["twitter","one_inch"],    requires_openai_key:true
  cross-chain | bridge | yield arb      → execution_model:"polling",  strategy:"yield",        required_mcps:["debridge","one_inch"]
  perp | perpetual | funding rate       → execution_model:"polling",  strategy:"perp",         required_mcps:["hyperliquid"]
  HF | high frequency | scalper         → execution_model:"websocket", strategy:"scalper",     required_mcps:["one_inch","alchemy"]
  rebalance | portfolio                 → execution_model:"polling",  strategy:"rebalancing",  required_mcps:["one_inch"]
  TA | technical analysis | indicator   → execution_model:"agentic",  strategy:"ta_scripter",  required_mcps:["coingecko"],             requires_openai_key:true
  Solana keyword in any request         → chain:"solana", network:"solana-mainnet", required_mcps includes "jupiter", requires_solana_wallet:true
  default network if unspecified        → "base-sepolia"
"""


# ─────────────────────────────────────────────────────────────────────────────
# MetaAgentBuilder
# ─────────────────────────────────────────────────────────────────────────────

class MetaAgentBuilder:
    def __init__(self):
        self.mcp_manager = MultiMCPClient()

        # ── Existing credentials ─────────────────────────────────────────────
        self.token          = os.environ.get("GITHUB_TOKEN")
        self.alchemy_key    = os.environ.get("ALCHEMY_API_KEY")
        self.webacy_key     = os.environ.get("WEBACY_API_KEY")
        self.oneinch_key    = os.environ.get("1INCH_API_KEY")
        self.coingecko_demo = os.environ.get("COINGECKO_DEMO_API_KEY")
        self.coingecko_pro  = os.environ.get("COINGECKO_PRO_API_KEY")
        self.lunarcrush_key = os.environ.get("LUNARCRUSH_API_KEY")
        self.twitter_key    = os.environ.get("TWITTER_API_KEY")
        self.twitter_secret = os.environ.get("TWITTER_API_SECRET")
        self.twitter_token  = os.environ.get("TWITTER_ACCESS_TOKEN")
        self.twitter_tsecret= os.environ.get("TWITTER_ACCESS_TOKEN_SECRET")
        self.infura_key     = os.environ.get("INFURA_KEY")
        self.uniswap_path   = os.environ.get("UNISWAP_MCP_PATH")
        self.openai_key     = os.environ.get("OPENAI_API_KEY")

        # ── New credentials (Phase 2 MCPs) ───────────────────────────────────
        self.nansen_key     = os.environ.get("NANSEN_API_KEY")
        self.debridge_key   = os.environ.get("DEBRIDGE_API_KEY")   # optional — DeBridge is keyless for reads

        if not self.token:
            raise ValueError("GITHUB_TOKEN not found. Please check your .env file.")

        self.endpoint   = "https://models.inference.ai.azure.com"
        self.model_name = "gpt-4o"
        self.client = ChatCompletionsClient(
            endpoint=self.endpoint,
            credential=AzureKeyCredential(self.token),
        )

        self.arb_bot_address = os.environ.get(
            "ARB_BOT_ADDRESS", "0x6b7b81e04D024259b87a6C0F5ab5Eb04d9539102"
        )

    # ─────────────────────────────────────────────────────────────────────────
    # MCP Server Setup
    # ─────────────────────────────────────────────────────────────────────────

    async def setup_environment(self):
        """Connect to all DeFi MCP servers — core + extended + Phase 2."""
        print("=" * 60)
        print("Connecting to MCP Servers...")
        print("=" * 60)

        # ── CORE MCPs ────────────────────────────────────────────────────────

        # 1. 1inch — EVM swap quotes + calldata
        try:
            one_inch_args = [
                "-y", "supergateway",
                "--streamableHttp", "https://api.1inch.com/mcp/protocol",
            ]
            if self.oneinch_key:
                one_inch_args += ["--header", f"Authorization: Bearer {self.oneinch_key}"]
            one_inch_args += ["--outputTransport", "stdio"]
            await self.mcp_manager.connect_to_server(
                "one_inch", "npx", one_inch_args
            )
        except Exception as e:
            print(f"⚠️  1inch: {e}")

        # 2. Jupiter — Solana swap quotes (no API key needed)
        try:
            await self.mcp_manager.connect_to_server(
                "jupiter", "npx",
                ["-y", "supergateway",
                 "--streamableHttp", "https://dev.jup.ag/mcp",
                 "--outputTransport", "stdio"],
            )
        except Exception as e:
            print(f"⚠️  Jupiter: {e}")

        # 3. Webacy — Token risk scoring
        if self.webacy_key:
            try:
                await self.mcp_manager.connect_to_server(
                    "webacy", "npx",
                    ["-y", "supergateway",
                     "--streamableHttp", "https://api.webacy.com/mcp",
                     "--header", f"x-api-key: {self.webacy_key}",
                     "--outputTransport", "stdio"],
                )
            except Exception as e:
                print(f"⚠️  Webacy: {e}")
        else:
            print("⚠️  WEBACY_API_KEY missing. Skipping Webacy.")

        # 4. Alchemy — RPC + mempool
        if self.alchemy_key:
            try:
                await self.mcp_manager.connect_to_server(
                    "alchemy", "npx",
                    ["-y", "@alchemy/mcp-server"],
                    custom_env={"ALCHEMY_API_KEY": self.alchemy_key},
                )
            except Exception as e:
                print(f"⚠️  Alchemy: {e}")
        else:
            print("⚠️  ALCHEMY_API_KEY missing. Skipping Alchemy.")

        # 5. GOAT EVM — Transaction signing + execution
        wallet_key = os.environ.get("WALLET_PRIVATE_KEY")
        rpc_url    = os.environ.get("RPC_PROVIDER_URL")
        goat_path  = os.environ.get("GOAT_EVM_PATH")
        if wallet_key and rpc_url and goat_path:
            if os.path.exists(goat_path):
                try:
                    await self.mcp_manager.connect_to_server(
                        "goat_evm", "npx", ["tsx", goat_path],
                        custom_env={
                            "WALLET_PRIVATE_KEY": wallet_key,
                            "RPC_PROVIDER_URL":   rpc_url,
                        },
                    )
                except Exception as e:
                    print(f"⚠️  GOAT EVM: {e}")
            else:
                print(f"⚠️  GOAT_EVM_PATH not found: {goat_path}")
        else:
            print("⚠️  WALLET_PRIVATE_KEY / RPC_PROVIDER_URL / GOAT_EVM_PATH missing.")

        # ── EXTENDED MCPs ────────────────────────────────────────────────────

        # 6. CoinGecko — Market prices, trending coins
        if self.coingecko_demo or self.coingecko_pro:
            try:
                cg_env = {}
                if self.coingecko_demo:
                    cg_env["COINGECKO_DEMO_API_KEY"] = self.coingecko_demo
                if self.coingecko_pro:
                    cg_env["COINGECKO_PRO_API_KEY"] = self.coingecko_pro
                    cg_env["COINGECKO_ENVIRONMENT"] = "pro"
                await self.mcp_manager.connect_to_server(
                    "coingecko", "npx",
                    ["-y", "@coingecko/coingecko-mcp"],
                    custom_env=cg_env,
                )
            except Exception as e:
                print(f"⚠️  CoinGecko: {e}")
        else:
            print("⚠️  COINGECKO_DEMO_API_KEY missing. Skipping CoinGecko.")

        # 7. LunarCrush — Social sentiment signals
        if self.lunarcrush_key:
            try:
                await self.mcp_manager.connect_to_server(
                    "lunarcrush", "npx",
                    ["-y", "supergateway",
                     "--streamableHttp",
                     f"https://lunarcrush.ai/mcp?key={self.lunarcrush_key}",
                     "--outputTransport", "stdio"],
                )
            except Exception as e:
                print(f"⚠️  LunarCrush: {e}")
        else:
            print("⚠️  LUNARCRUSH_API_KEY missing. Skipping LunarCrush.")

        # 8. Twitter — Post trade alerts, scan market sentiment
        if all([self.twitter_key, self.twitter_secret,
                self.twitter_token, self.twitter_tsecret]):
            try:
                await self.mcp_manager.connect_to_server(
                    "twitter", "npx",
                    ["-y", "@enescinar/twitter-mcp"],
                    custom_env={
                        "API_KEY":             self.twitter_key,
                        "API_SECRET_KEY":      self.twitter_secret,
                        "ACCESS_TOKEN":        self.twitter_token,
                        "ACCESS_TOKEN_SECRET": self.twitter_tsecret,
                    },
                )
            except Exception as e:
                print(f"⚠️  Twitter: {e}")
        else:
            print("⚠️  Twitter API keys incomplete. Skipping Twitter.")

        # 9. Hyperliquid — Perp market prices, L2 order books
        try:
            await self.mcp_manager.connect_to_server(
                "hyperliquid", "npx",
                ["-y", "@mektigboy/server-hyperliquid"],
            )
        except Exception as e:
            print(f"⚠️  Hyperliquid: {e}")

        # 10. LiFi — Cross-chain bridge route discovery
        try:
            await self.mcp_manager.connect_to_server(
                "lifi", "/Users/adarsh/go/bin/lifi-mcp", [],
            )
        except Exception as e:
            print(f"⚠️  LiFi (install: go install github.com/lifinance/lifi-mcp@latest): {e}")

        # 11. Uniswap — Direct Uniswap V3 swaps, multi-chain
        if self.uniswap_path and self.infura_key:
            if os.path.exists(self.uniswap_path):
                try:
                    await self.mcp_manager.connect_to_server(
                        "uniswap", "node",
                        [self.uniswap_path],
                        custom_env={
                            "INFURA_KEY":         self.infura_key,
                            "WALLET_PRIVATE_KEY": os.environ.get("WALLET_PRIVATE_KEY", ""),
                        },
                    )
                except Exception as e:
                    print(f"⚠️  Uniswap: {e}")
            else:
                print(f"⚠️  UNISWAP_MCP_PATH not found: {self.uniswap_path}")
        else:
            print("⚠️  UNISWAP_MCP_PATH or INFURA_KEY missing. Skipping Uniswap.")

        # 12. Chainlink — On-chain price feeds, CCIP documentation
        if self.openai_key:
            try:
                await self.mcp_manager.connect_to_server(
                    "chainlink", "npx",
                    ["-y", "@chainlink/mcp-server"],
                    custom_env={"OPENAI_API_KEY": self.openai_key},
                )
            except Exception as e:
                print(f"⚠️  Chainlink: {e}")
        else:
            print("⚠️  OPENAI_API_KEY missing. Skipping Chainlink MCP.")

        # ── PHASE 2 MCPs ─────────────────────────────────────────────────────

        # 13. CoW Protocol — MEV-protected swap orderbook
        try:
            await self.mcp_manager.connect_to_server(
                "cow_protocol", "npx",
                ["-y", "supergateway",
                 "--streamableHttp", "https://mcp.api.cow.fi/mcp",
                 "--outputTransport", "stdio"],
            )
        except Exception as e:
            print(f"⚠️  CoW Protocol: {e}")

        # 14. Nansen — Smart money / whale wallet intelligence
        if self.nansen_key:
            try:
                await self.mcp_manager.connect_to_server(
                    "nansen", "npx",
                    ["-y", "supergateway",
                     "--streamableHttp", "https://api.nansen.ai/mcp",
                     "--header", f"x-api-key: {self.nansen_key}",
                     "--outputTransport", "stdio"],
                )
            except Exception as e:
                print(f"⚠️  Nansen: {e}")
        else:
            print("⚠️  NANSEN_API_KEY missing. Skipping Nansen.")

        # 15. DeBridge — Cross-chain intent-based swaps
        try:
            debridge_args = [
                "-y", "supergateway",
                "--streamableHttp", "https://api.debridge.finance/mcp",
                "--outputTransport", "stdio",
            ]
            # DeBridge read endpoints are keyless; inject key only if provided
            if self.debridge_key:
                debridge_args += ["--header", f"Authorization: Bearer {self.debridge_key}"]
            await self.mcp_manager.connect_to_server(
                "debridge", "npx", debridge_args,
            )
        except Exception as e:
            print(f"⚠️  DeBridge: {e}")

        # Summary
        connected = list(self.mcp_manager.sessions.keys())
        print(f"\n✅ Connected servers ({len(connected)}): {', '.join(connected)}")
        print("=" * 60)

    # ─────────────────────────────────────────────────────────────────────────
    # Step 1 — Intent Classifier
    # ─────────────────────────────────────────────────────────────────────────

    async def classify_intent(self, prompt: str) -> dict:
        """
        Fast LLM call that reads the user prompt and returns a structured JSON
        classification dict.  Falls back to EVM/polling/arbitrage on any error.
        """
        try:
            response = self.client.complete(
                messages=[
                    SystemMessage(content=CLASSIFIER_SYSTEM_PROMPT),
                    UserMessage(content=prompt),
                ],
                model=self.model_name,
                temperature=0.0,
                max_tokens=512,
            )
            raw = response.choices[0].message.content.strip()

            # Strip any errant markdown fences
            if raw.startswith("```"):
                parts = raw.split("```")
                raw = parts[1] if len(parts) > 1 else raw
                if raw.startswith("json"):
                    raw = raw[4:]
            raw = raw.strip()


            intent = json.loads(raw)
            # Defensive parsing: If the LLM wrapped the JSON in a list, unwrap it.
            if isinstance(intent, list):
              intent = intent[0] if len(intent) > 0 else {}
            if not isinstance(intent, dict):
              raise ValueError("Parsed intent is not a valid JSON object.")

            print(f"\n🎯 Intent classified:\n{json.dumps(intent, indent=2)}\n")
            return intent

        except Exception as exc:
            print(f"⚠️  Intent classification failed ({exc}). Defaulting to EVM polling arbitrage.")
            return {
                "chain":                  "evm",
                "network":                "base-sepolia",
                "execution_model":        "polling",
                "strategy":               "arbitrage",
                "required_mcps":          ["one_inch", "webacy", "goat_evm"],
                "bot_type":               "EVM Flash Loan Arbitrage Bot",
                "requires_openai_key":    False,
                "requires_solana_wallet": False,
            }

    # ─────────────────────────────────────────────────────────────────────────
    # Step 2 — Template Selector
    # ─────────────────────────────────────────────────────────────────────────

    def _select_template(self, intent: dict) -> str:
        """Return the correct execution template string for this intent."""
        if intent.get("chain") == "solana":
            return TEMPLATES["solana"]
        execution_model = intent.get("execution_model", "polling")
        return TEMPLATES.get(execution_model, TEMPLATES["polling"])

    # ─────────────────────────────────────────────────────────────────────────
    # Step 3 — SDK Snippet Injector (RAG)
    # ─────────────────────────────────────────────────────────────────────────

    def _collect_sdk_snippets(self, intent: dict) -> str:
        """
        Collect all SDK reference snippets relevant to this intent.
        Sources: strategy mapping + required_mcps + execution_model flags.
        Returns a formatted string ready for injection into the system prompt.
        """
        strategy      = intent.get("strategy", "unknown")
        required_mcps = intent.get("required_mcps", [])
        snippet_keys:  set[str] = set()

        # From strategy
        for key in STRATEGY_SNIPPETS.get(strategy, []):
            snippet_keys.add(key)

        # From required MCPs
        for mcp in required_mcps:
            if mcp in MCP_TO_SNIPPET:
                snippet_keys.add(MCP_TO_SNIPPET[mcp])

        # From execution model flags
        if intent.get("execution_model") == "websocket":
            snippet_keys.add("websocket_mempool")
        if intent.get("requires_openai_key") or intent.get("execution_model") == "agentic":
            snippet_keys.add("langchain_agent")

        if not snippet_keys:
            return ""

        lines = ["\n## SDK REFERENCE LIBRARY — use these exact patterns in generated code\n"]
        for key in sorted(snippet_keys):
            if key in SDK_SNIPPETS:
                lines.append(SDK_SNIPPETS[key])
        return "\n".join(lines)

    # ─────────────────────────────────────────────────────────────────────────
    # Chain-specific output format helpers
    # ─────────────────────────────────────────────────────────────────────────

    def _evm_output_format(self, network: str, strategy: str, abi_str: str) -> str:
        chain_ids = {
            "base-sepolia": 84532,
            "base-mainnet": 8453,
            "arbitrum":     42161,
        }
        chain_id = chain_ids.get(network, 84532)

        token_table = {
            "base-sepolia": {
                "USDC":  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
                "WETH":  "0x4200000000000000000000000000000000000006",
                "CBBTC": "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
                "AERO":  "0x940181a94A35A4569E4529A3CDfB74e38FD98631",
            },
            "base-mainnet": {
                "USDC":  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
                "WETH":  "0x4200000000000000000000000000000000000006",
                "CBBTC": "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
                "AERO":  "0x940181a94A35A4569E4529A3CDfB74e38FD98631",
            },
            "arbitrum": {
                "USDC":  "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
                "USDT":  "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
                "WETH":  "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
                "CBBTC": "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
            },
        }
        tokens = token_table.get(network, token_table["base-sepolia"])
        token_lines = "\n".join(f"  {sym}: {addr}" for sym, addr in tokens.items())

        # 🚀 ONLY inject the flashloan ABI if we are actually doing arbitrage
        flashloan_text = f"If using Aave V3 flash loans, embed this ABI in src/config.ts:\n  FLASHLOAN_ABI = {abi_str}" if strategy == "arbitrage" else ""

        return f"""
## EVM-SPECIFIC CONFIGURATION
Network:  {network}
Chain ID: {chain_id}  ← use this exact integer in all 1inch tool calls

Token addresses ({network}):
{token_lines}

Contract addresses:
  ARB_BOT_ADDRESS  = "{self.arb_bot_address}"
  ONE_INCH_ROUTER  = "0x111111125421cA6dc452d289314280a0f8842A65"

{flashloan_text}

1inch MCP tool signatures (NEVER deviate from these):
  get_quote      server="one_inch"  args={{tokenIn, tokenOut, amount:"<str int>", chain:{chain_id}}}
                 parse → int(response.toTokenAmount)
  get_swap_data  server="one_inch"  args={{tokenIn, tokenOut, amount:"<str int>", chain:{chain_id}, from:"<addr>", slippage:1}}
                 parse → response.tx.data

Webacy risk check:
  get_token_risk server="webacy"    args={{address:"<addr>", chain:"{network}"}}  ← STRING not int
                 pass if response.risk==="low" OR response.score<20

GOAT EVM signatures:
  convert_to_base_units  args={{tokenAddress, amount:"<str human>"}}
  write_contract         args={{address:"<NOT contractAddress>", abi, functionName, args:[]}}
"""

    def _solana_output_format(self) -> str:
        return """
## SOLANA-SPECIFIC CONFIGURATION
RPC:  process.env.SOLANA_RPC_URL  (e.g. https://mainnet.helius-rpc.com/?api-key=...)
Key:  process.env.SOLANA_PRIVATE_KEY  (bs58-encoded, NOT hex)

Common token mints:
  SOL (wrapped): So11111111111111111111111111111111111111112
  USDC:          EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
  BONK:          DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263
  WIF:           EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm
  JUP:           JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN

Jupiter MCP tools (prefer over direct REST):
  getQuote              args: { inputMint, outputMint, amount, slippageBps }
  getSwapInstructions   args: { quoteResponse, userPublicKey }

Token amounts: SOL uses 9 decimals (1 SOL = 1_000_000_000 lamports). USDC uses 6.

Files to generate: package.json, tsconfig.json, src/config.ts, src/index.ts
"""

    # ─────────────────────────────────────────────────────────────────────────
    # Main Pipeline — Bot Generation
    # ─────────────────────────────────────────────────────────────────────────

    async def build_bot_logic(self, prompt: str) -> dict:
        """
        Full two-step pipeline:
          1. classify_intent()           → structured intent dict
          2. Assemble dynamic system prompt (template + SDK snippets + tool list)
          3. Call GPT-4o to generate the complete bot
        """
        # ── Step 1: Classify intent ──────────────────────────────────────────
        intent = await self.classify_intent(prompt)

        chain           = intent.get("chain", "evm")
        network         = intent.get("network", "base-sepolia")
        execution_model = intent.get("execution_model", "polling")
        strategy        = intent.get("strategy", "arbitrage")
        bot_type        = intent.get("bot_type", "Arbitrage Bot")

        print(f"🔧 Template: {execution_model.upper()}  |  Strategy: {strategy}  |  Chain: {chain}")

        # ── Step 2: Assemble dynamic system prompt ───────────────────────────
        execution_template = self._select_template(intent)
        sdk_context        = self._collect_sdk_snippets(intent)

        required_mcps = intent.get("required_mcps", [])
        available_tools = await self.mcp_manager.list_all_tools()

        # Minify tool list to fit token budget (Safely handles malformed MCP schemas)
        compressed_tools = []
        for t in available_tools:
            server_name = t.get("server", "unknown") if isinstance(t, dict) else "unknown"
            # 🚀 THE FIX: Strip out thousands of tokens by ignoring irrelevant MCPs
            if required_mcps and server_name not in required_mcps:
                continue
            # Safely extract input schema
            schema = t.get("input_schema") if isinstance(t, dict) else {}
            if not isinstance(schema, dict): schema = {}
            # Safely extract properties
            props = schema.get("properties") or {}
            if not isinstance(props, dict): props = {}
            # Safely map argument types
            args = {}
            for k, v in props.items():
                if isinstance(v, dict):
                    args[k] = v.get("type", "string")
                else:
                    args[k] = "unknown"
            compressed_tools.append({
                "server": server_name,
                "name":   t.get("name", "unknown") if isinstance(t, dict) else "unknown",
                "args":   args,
            })
        tools_str = json.dumps(compressed_tools, separators=(',', ':'))
        abi_str   = json.dumps(FLASHLOAN_ABI,   separators=(',', ':'))

        chain_config = (
          self._solana_output_format()
          if chain == "solana"
          else self._evm_output_format(network, strategy, abi_str)
        )

        system_instructions = f"""You are an expert DeFi bot engineer.
Generate a COMPLETE, production-ready bot for: {bot_type}

## TARGET
Chain:           {chain.upper()}
Network:         {network}
Strategy:        {strategy}
Execution model: {execution_model}

## OUTPUT FORMAT — READ THIS FIRST
Respond with RAW JSON ONLY. No markdown fences, no preamble, no trailing text.
Required schema:
{{
  "thoughts": "<one paragraph: strategy rationale + architecture decisions>",
  "files": [
    {{"filepath": "<path>", "content": "<complete file content>"}}
  ]
}}
Minimum required files: package.json, tsconfig.json, src/config.ts, src/mcp_bridge.ts, src/index.ts

## CRITICAL ENVIRONMENT CONSTRAINT
The bot runs inside a WebContainer (in-browser Node.js environment).
WRITE IN TYPESCRIPT / NODE.JS ONLY — absolutely no Python.
package.json must include: "start": "tsx src/index.ts"

{TS_MCP_BRIDGE}

{execution_template}

{sdk_context}

{chain_config}

## UNIVERSAL HARD RULES
1. NEVER write Python — TypeScript / Node.js ONLY.
2. NEVER hardcode private keys or API keys — always read from process.env.
3. All token amount math must use BigInt — never float, never Decimal.
4. NEVER leave stubs, TODOs, or placeholder comments — every function must be fully implemented.
5. Include SIMULATION_MODE=true by default (process.env.SIMULATION_MODE !== "false").
6. Include structured logging: [timestamp] [LEVEL] message.
7. Handle all errors gracefully — wrap cycle logic in try/catch and log; never let one bad cycle crash the bot.
8. Graceful shutdown: listen for SIGINT / SIGTERM, clear intervals, exit cleanly.

## AVAILABLE MCP TOOLS  (discovered at runtime — reference these in generated code)
{tools_str}
"""

        # ── Step 3: Generate bot ─────────────────────────────────────────────
        response = self.client.complete(
            messages=[
                SystemMessage(content=system_instructions),
                UserMessage(content=prompt),
            ],
            model=self.model_name,
            temperature=0.1,
            max_tokens=4096,
        )

        raw_text = response.choices[0].message.content.strip()

        # Strip any markdown fences the model adds despite instructions
        if raw_text.startswith("```json"):
            raw_text = raw_text[7:]
        elif raw_text.startswith("```"):
            raw_text = raw_text[3:]
        if raw_text.endswith("```"):
            raw_text = raw_text[:-3]
        raw_text = raw_text.strip()

        try:
            structured_output = json.loads(raw_text)
            files = structured_output.get("files", [])
            got   = {f.get("filepath") for f in files}
            required = {"package.json", "src/index.ts"}
            missing  = required - got
            if missing:
                print(f"⚠️  Model did not generate: {missing}")
        except Exception as parse_err:
            print(f"⚠️  JSON parse error: {parse_err}")
            structured_output = {
                "thoughts": "JSON parsing failed — raw output saved.",
                "files": [{"filepath": "error.ts", "content": raw_text}],
            }

        return {
            "status":     "blueprint_ready",
            "output":     structured_output,
            "intent":     intent,           # ← new: expose classification to callers
            "tools_used": [t["name"] for t in available_tools],
        }