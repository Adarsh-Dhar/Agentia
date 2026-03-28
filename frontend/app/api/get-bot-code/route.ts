/**
 * frontend/app/api/get-bot-code/route.ts
 *
 * Serves the Base Sepolia MCP arbitrage bot files so the WebContainer
 * can install deps and run them.  The Python bot talks to 1inch / Webacy /
 * GOAT-EVM via MCP servers that the user must supply credentials for.
 *
 * All file content is inlined here so the route works without filesystem
 * access to the /agents directory in production.
 */
import { NextResponse } from "next/server";
import { assembleBotFiles } from "./bot-files";

export async function POST() {
  const files = assembleBotFiles();

  return NextResponse.json({
    thoughts:
      "Base Sepolia MCP arbitrage bot: borrows USDC via Aave flash loan, " +
      "swaps USDC→WETH→USDC via 1inch, repays loan + 0.09 % fee. " +
      "Token risk checked with Webacy before every execution. " +
      "Set SIMULATION_MODE=true to run without sending transactions.",
    files,
    verified: true,
  });
}