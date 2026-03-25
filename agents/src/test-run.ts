
import 'dotenv/config';
// import { generateAgentProject } from "./src/meta-agent/index"; // This line is commented out for clarity
import { generateAgentProject } from "./meta-agent/index.js";

async function run() {
  const userIntent = "Build a Flash Loan Arbitrageur on Solana using Jupiter and Aave.";
  // Simulate MCP servers passing in context
  const fakeMcpSnippets = [
    "To use GOAT with Solana: import { getOnChainTools } from '@goat-sdk/core';",
    "To use LangGraph: import { StateGraph } from '@langchain/langgraph';"
  ];

  await generateAgentProject(userIntent, fakeMcpSnippets);
}

run();
