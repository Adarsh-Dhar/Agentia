import express from 'express';
import * as fs from 'fs';
import path from 'path';
import 'dotenv/config';
// Import your existing logic
import { buildElizaCharacter } from "./tools/core-orchestration/elizaos";
import { setupSmartAccountAndSessionKey } from "./tools/specialized-payments/biconomy";

const app = express();
const PORT = 5555;

// 1. Define the specific "DeFi-Lender-Bot" configuration
const defiAgentConfig = {
  name: "DeFi-Lender-Bot",
  systemPrompt: "You are an expert DeFi assistant specializing in EVM chains and Aave protocol. You help users manage liquidity and monitor lending rates.",
  description: "EVM & Aave Autonomous Agent",
  plugins: [
    "@elizaos/plugin-evm", 
    "@elizaos/plugin-aave",
    "@elizaos/plugin-1inch",
    "@elizaos/plugin-bootstrap"
  ]
};

// 2. Fix and generate the character object
const character = buildElizaCharacter(defiAgentConfig);
// Fix: Ensure the specific plugins are mapped into the character object
character.plugins = defiAgentConfig.plugins;

// 3. Save the physical file (initial write without keys)
const fileName = `${character.name.toLowerCase()}.character.json`;
fs.writeFileSync(fileName, JSON.stringify(character, null, 2));

// 4. Setup Server Routes
app.get('/', (req, res) => {
  res.send(`<h1>ElizaOS Character Server</h1>
            <p>Character <b>${character.name}</b> generated.</p>
            <a href="/character">View JSON File</a>`);
});

// Route to serve the actual JSON file
app.get('/character', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(character, null, 2));
});

// 5. Initialize Wallet & Start Server
async function bootstrapSystem() {
  console.log("=== Bootstrapping Agent Identity & Wallet ===");
  
  try {
    const pk = process.env.USER_PRIVATE_KEY as `0x${string}`;
    
    if (!pk) {
      console.warn("⚠️ USER_PRIVATE_KEY not found in .env. Saving generic character.");
      fs.writeFileSync(fileName, JSON.stringify(character, null, 2));
    } else {
      // ✅ Call the new MEE setup (RPC URL is no longer needed!)
      const walletData = await setupSmartAccountAndSessionKey(pk);
      
      // Inject the generated addresses into the ElizaOS character secrets
      if (!character.settings) character.settings = { secrets: {} };
      if (!character.settings.secrets) character.settings.secrets = {};
      
      // Save the Nexus Smart Account address
      character.settings.secrets.SMART_ACCOUNT_ADDRESS = walletData.smartAccountAddress;
      
      fs.writeFileSync(fileName, JSON.stringify(character, null, 2));
      console.log(`✅ Character file updated with MEE Smart Account!`);
    }
  } catch (err) {
    console.error("❌ Wallet Setup Failed:", err);
    fs.writeFileSync(fileName, JSON.stringify(character, null, 2));
  }

  app.listen(PORT, () => {
    console.log(`
    🚀 Server is running on http://localhost:${PORT}
    📄 Character file saved as: ${path.resolve(fileName)}
    🔗 Access character JSON at: http://localhost:${PORT}/character
    `);
  });
}

// 7. EXECUTE THE BOOTSTRAP SEQUENCE
bootstrapSystem();