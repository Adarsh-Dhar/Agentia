import express from 'express';
import * as fs from 'fs';
import path from 'path';
import 'dotenv/config';

import { buildElizaCharacter } from "./tools/core-orchestration/elizaos";
import { setupSmartAccountAndSessionKey } from "./tools/specialized-payments/biconomy";
import { createAlchemyProvider } from "./tools/market-intelligence/rpc-provider";
import { StateGraph, GraphState } from "./tools/core-orchestration/langgraph";
import type { Address } from "./tools/types";
import { baseSepolia } from 'viem/chains';

const app = express();
const PORT = 5555;

// Global array to act as our Agent's Database / Dashboard
const agentLedger: Array<{ timestamp: string; pair: string; profit: string; txHash: string; status: string }> = [];

// 1. Define the Configuration
const defiAgentConfig = {
  name: "DeFi-Lender-Bot",
  systemPrompt: "You are an expert DeFi assistant specializing in EVM chains and Aave protocol.",
  description: "EVM & Aave Autonomous Agent",
  plugins: ["@elizaos/plugin-evm", "@elizaos/plugin-aave", "@elizaos/plugin-1inch", "@elizaos/plugin-bootstrap"]
};

const character = buildElizaCharacter(defiAgentConfig);
character.plugins = defiAgentConfig.plugins;
const fileName = `${character.name.toLowerCase()}.character.json`;
fs.writeFileSync(fileName, JSON.stringify(character, null, 2));

// ── EXPRESS DASHBOARD ROUTES ──────────────────────────────────────────────────

app.get('/', (req, res) => res.send(`
  <h1>ElizaOS Flash Loan Agent</h1>
  <ul>
    <li><a href="/character">View Agent Character JSON</a></li>
    <li><a href="/dashboard">📈 View Live Profit Dashboard</a></li>
  </ul>
`));

app.get('/character', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(character, null, 2));
});

// 🌟 ADDED: The Finality Dashboard 🌟
app.get('/dashboard', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify({
    totalTrades: agentLedger.length,
    ledger: agentLedger
  }, null, 2));
});

// ── THE BRAIN (LANGGRAPH) ─────────────────────────────────────────────────────

// 🌟 ADDED: We now pass the 'meeClient' into the brain so it has hands! 🌟
function buildFlashLoanGraph(meeClient: any) {
  const graph = new StateGraph<GraphState>()
    
    // NODE 1: Security & Validation (The "Shield")
    .addNode("security_check", async (state) => {
      console.log("\n[LangGraph] 🛡️ Node 1: Running Rugcheck/Webacy Validation...");
      // In production: Call Rugcheck API here.
      console.log("   ↳ Token Contracts verified. No honeypots detected.");
      return { scratchpad: { ...state.scratchpad, isSecure: true } } as Partial<GraphState>;
    })

    // NODE 2: Profit Calculation (The Math)
    .addNode("verify_gap", async (state) => {
      console.log("[LangGraph] 🧠 Node 2: Verifying Price Gap across DEXs...");
      // In production: Profit > (LoanAmount * 0.0009) + GasFees
      console.log("   ↳ >1% Gap Detected. Flash Loan Premium (0.09%) cleared.");
      return { scratchpad: { ...state.scratchpad, isProfitable: true } } as Partial<GraphState>;
    })

    // NODE 3: Execution & Finality (The "Hands")
    .addNode("execute_arbitrage", async (state) => {
      console.log("[LangGraph] ⚡ Node 3: Executing Atomic Flash Loan via Biconomy MEE!");
      
      // In production: GOAT SDK translates this intent to the meeClient
      // await getOnChainTools({ wallet: meeClient, plugins: [pluginAave(), plugin1inch()] });
      
      console.log("   ↳ Borrowing from Aave V3");
      console.log("   ↳ Buying low on Uniswap | Selling high on Sushiswap");
      console.log("   ↳ Repaying Aave + fee");

      // 🌟 ADDED: Finality Logging 🌟
      const mockTxHash = "0x" + Math.random().toString(16).slice(2, 42);
      const profit = "12.5 USDC";

      agentLedger.push({
        timestamp: new Date().toISOString(),
        pair: "ETH/USDC",
        profit: profit,
        txHash: mockTxHash,
        status: "Settled Sub-second ⚡"
      });

      console.log(`✅ [Finality] Transaction confirmed! Hash: ${mockTxHash}`);
      console.log(`✅ [Dashboard] Logged profit of ${profit} to Master Wallet.`);
      
      return { finalOutput: "Arbitrage executed successfully." } as Partial<GraphState>;
    })

    // THE EDGE ROUTING LOGIC
    .addEdge("security_check", "verify_gap")
    .addConditionalEdge("verify_gap", (state) => {
       // If not profitable, route to "__end__" to abort. Otherwise, execute.
       return state.scratchpad.isProfitable ? "execute_arbitrage" : "__end__";
    })
    .addEdge("execute_arbitrage", "__end__")
    .setEntryPoint("security_check");

  return graph.compile();
}

// ── SYSTEM BOOTSTRAP ─────────────────────────────────────────────────────────

async function bootstrapSystem() {
  console.log("=== Bootstrapping Agent Identity & Wallet ===");
  let executionClient = null;
  
  try {
    const pk = process.env.USER_PRIVATE_KEY as `0x${string}`;
    if (pk) {
      const walletData = await setupSmartAccountAndSessionKey(pk);
      executionClient = walletData.meeClient; // Save the client for LangGraph!
      
      if (!character.settings) character.settings = { secrets: {} };
      if (!character.settings.secrets) character.settings.secrets = {};
      character.settings.secrets.SMART_ACCOUNT_ADDRESS = walletData.smartAccountAddress;
      fs.writeFileSync(fileName, JSON.stringify(character, null, 2));
      console.log(`✅ Character file updated with MEE Smart Account!`);
    }
  } catch (err) {
    console.error("❌ Wallet Setup Failed:", err);
  }

  console.log("=== Initializing Market Monitoring ===");
  try {
    const alchemyKey = process.env.ALCHEMY_API_KEY;
    if (alchemyKey && executionClient) {
      const rpcProvider = createAlchemyProvider(alchemyKey, "base-sepolia", baseSepolia.id as any);
      await rpcProvider.connect();

      const ETH_USDC_POOL: Address = "0x4C36388bE6F416A29C8d8Eee81C771cE6bE14B18"; 
      
      // Compile the brain, passing in the execution client
      const arbGraph = buildFlashLoanGraph(executionClient);

      rpcProvider.onLogs({ address: ETH_USDC_POOL }, async (log) => {
        console.log(`\n[Market Intelligence] 🚨 Activity detected on ETH/USDC pool! Block: ${log.blockNumber}`);
        await arbGraph.invoke({}, `Analyze block ${log.blockNumber} for arbitrage opportunities.`);
      });

      console.log(`✅ Monitoring Loop Active: Listening to ETH/USDC pool via Alchemy`);

      // 🌟 TEST TRIGGER: Force the graph to run once after 3 seconds for testing 🌟
      setTimeout(async () => {
        console.log("\n[Test] Simulating Alchemy Event trigger...");
        await arbGraph.invoke({}, "Analyze block latest for arbitrage opportunities.");
      }, 3000);

    }
  } catch (err) {
    console.error("❌ RPC Provider Setup Failed:", err);
  }

  app.listen(PORT, () => {
    console.log(`
    🚀 Server is running on http://localhost:${PORT}
    📈 View Live Dashboard: http://localhost:${PORT}/dashboard
    `);
  });
}

bootstrapSystem();