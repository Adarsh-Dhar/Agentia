import * as fs from 'fs';
import { buildElizaCharacter } from "../tools/core-orchestration/elizaos"; // Assuming your code is in elizaos.ts

// 1. Define the configuration for the specific agent
const defiAgentConfig = {
  name: "DeFi-Lender-Bot",
  systemPrompt: "You are an expert DeFi assistant specializing in EVM chains and Aave protocol. You help users manage liquidity and monitor lending rates.",
  description: "EVM & Aave Autonomous Agent",
  // We explicitly add the requested plugins here
  plugins: [
    "@elizaos/plugin-evm", 
    "@elizaos/plugin-aave",
    "@elizaos/plugin-bootstrap"
  ]
};

/**
 * Enhanced function to generate the physical file
 */
function saveCharacterFile(config: any) {
  // Generate the object using your builder
  const character = buildElizaCharacter(config);
  
  // Ensure the plugins from our config are actually pushed into the character object
  // (Your current buildElizaCharacter had a hardcoded bootstrap plugin)
  character.plugins = config.plugins || ["@elizaos/plugin-bootstrap"];

  const fileName = `${character.name.toLowerCase()}.character.json`;
  
  fs.writeFileSync(fileName, JSON.stringify(character, null, 2));
  console.log(`Successfully generated: ${fileName}`);
}

// 2. Run the generation
saveCharacterFile(defiAgentConfig);