/**
 * MCP Server: rugcheck
 *
 * Security validation code generator.
 * Generates code to check tokens against rug pull / honeypot databases
 * before the agent interacts with them.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "rugcheck-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

const TOOLS: Tool[] = [
  {
    name: "get_token_validator_code",
    description:
      "Returns TypeScript code that validates a token's safety using Rugcheck.xyz and GoPlus Security APIs before trading.",
    inputSchema: {
      type: "object",
      properties: {
        chain: {
          type: "string",
          enum: ["solana", "ethereum", "bsc", "polygon"],
        },
        strictMode: {
          type: "boolean",
          description: "If true, reject any token with even minor risk flags",
        },
      },
    },
  },
  {
    name: "get_honeypot_check_code",
    description:
      "Returns TypeScript code to check if a token is a honeypot (buy works but sell is blocked).",
    inputSchema: {
      type: "object",
      properties: {
        network: { type: "string", enum: ["ethereum", "bsc", "polygon"] },
      },
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "get_token_validator_code": {
      const chain = (args as any)?.chain ?? "solana";
      const strictMode = (args as any)?.strictMode ?? true;

      return {
        content: [
          {
            type: "text",
            text: `
// ============================================================
// FILE: src/token-validator.ts
// Security validation — ALWAYS run before trading any token
// Chain: ${chain} | Strict Mode: ${strictMode}
// ============================================================

import axios from "axios";

export type RiskLevel = "SAFE" | "LOW_RISK" | "MEDIUM_RISK" | "HIGH_RISK" | "CRITICAL";

export interface TokenSecurityReport {
  tokenAddress: string;
  riskLevel: RiskLevel;
  isSafe: boolean;
  flags: string[];
  score: number;         // 0-100, higher = safer
  details: {
    mintAuthority?: boolean;       // Can supply be inflated?
    freezeAuthority?: boolean;     // Can transfers be frozen?
    isHoneypot?: boolean;          // Can tokens be sold?
    lpLocked?: boolean;            // Is liquidity locked?
    topHolderConcentration?: number; // % held by top 10 wallets
    hasBlacklist?: boolean;
    isProxy?: boolean;
  };
}

${chain === "solana" ? `
/**
 * Validates a Solana token using Rugcheck.xyz API.
 * Checks for: mint authority, freeze authority, LP lock status.
 */
export async function validateSolanaToken(
  mintAddress: string
): Promise<TokenSecurityReport> {
  const flags: string[] = [];
  let score = 100;

  try {
    // Rugcheck API (free, no key required)
    const { data } = await axios.get(
      \`https://api.rugcheck.xyz/v1/tokens/\${mintAddress}/report/summary\`,
      { timeout: 8000 }
    );

    // Parse risk indicators from Rugcheck
    const risks = data.risks || [];
    
    risks.forEach((risk: any) => {
      flags.push(\`\${risk.name}: \${risk.description}\`);
      // Deduct score based on severity
      if (risk.level === "danger") score -= 40;
      else if (risk.level === "warn") score -= 15;
      else if (risk.level === "info") score -= 5;
    });

    const details = {
      mintAuthority: data.token?.mintAuthority !== null,
      freezeAuthority: data.token?.freezeAuthority !== null,
      lpLocked: data.markets?.some((m: any) => m.lp?.lpLockedPct > 80),
      topHolderConcentration: data.topHolders?.reduce(
        (sum: number, h: any) => sum + (h.pct || 0), 0
      ),
    };

    if (details.mintAuthority) {
      flags.push("MINT_AUTHORITY_ENABLED: Supply can be inflated");
      score -= 30;
    }
    if (details.freezeAuthority) {
      flags.push("FREEZE_AUTHORITY_ENABLED: Transfers can be frozen");
      score -= 20;
    }
    if ((details.topHolderConcentration || 0) > 50) {
      flags.push(\`HIGH_CONCENTRATION: Top 10 hold \${details.topHolderConcentration?.toFixed(1)}%\`);
      score -= 15;
    }

    score = Math.max(0, score);

    let riskLevel: RiskLevel;
    if (score >= 80) riskLevel = "SAFE";
    else if (score >= 60) riskLevel = "LOW_RISK";
    else if (score >= 40) riskLevel = "MEDIUM_RISK";
    else if (score >= 20) riskLevel = "HIGH_RISK";
    else riskLevel = "CRITICAL";

    const isSafe = ${strictMode} 
      ? riskLevel === "SAFE" 
      : ["SAFE", "LOW_RISK"].includes(riskLevel);

    return { tokenAddress: mintAddress, riskLevel, isSafe, flags, score, details };

  } catch (err) {
    // If we can't validate, treat as unsafe
    return {
      tokenAddress: mintAddress,
      riskLevel: "CRITICAL",
      isSafe: false,
      flags: ["VALIDATION_FAILED: Could not fetch security report"],
      score: 0,
      details: {},
    };
  }
}
` : `
/**
 * Validates an EVM token using GoPlus Security API.
 * Checks for: honeypot, blacklist, proxy, ownership.
 */
export async function validateEvmToken(
  tokenAddress: string,
  chainId: string = "1"  // 1=eth, 56=bsc, 137=polygon, 42161=arbitrum
): Promise<TokenSecurityReport> {
  const flags: string[] = [];
  let score = 100;

  try {
    const { data } = await axios.get(
      \`https://api.gopluslabs.io/api/v1/token_security/\${chainId}\`,
      { params: { contract_addresses: tokenAddress }, timeout: 8000 }
    );
    
    const result = data.result[tokenAddress.toLowerCase()];
    if (!result) throw new Error("Token not found in GoPlus database");

    const details = {
      isHoneypot: result.is_honeypot === "1",
      hasBlacklist: result.is_blacklisted === "1",
      mintAuthority: result.can_take_back_ownership === "1",
      isProxy: result.is_proxy === "1",
      lpLocked: parseFloat(result.lp_holders?.find((h: any) => h.is_locked)?.percent || "0") > 0.5,
      topHolderConcentration: result.holders?.slice(0, 10)
        .reduce((s: number, h: any) => s + parseFloat(h.percent), 0) * 100,
    };

    if (details.isHoneypot) { flags.push("HONEYPOT: Cannot sell token"); score -= 100; }
    if (details.hasBlacklist) { flags.push("BLACKLIST: Address can be blacklisted"); score -= 30; }
    if (details.mintAuthority) { flags.push("MINT_CONTROL: Owner can mint unlimited tokens"); score -= 40; }
    if (details.isProxy) { flags.push("PROXY_CONTRACT: Logic can be changed"); score -= 20; }

    score = Math.max(0, score);
    
    const riskLevel: RiskLevel = score >= 80 ? "SAFE" : score >= 60 ? "LOW_RISK" 
      : score >= 40 ? "MEDIUM_RISK" : score >= 20 ? "HIGH_RISK" : "CRITICAL";

    return {
      tokenAddress,
      riskLevel,
      isSafe: ${strictMode} ? riskLevel === "SAFE" : ["SAFE", "LOW_RISK"].includes(riskLevel),
      flags, score, details,
    };
  } catch {
    return { tokenAddress, riskLevel: "CRITICAL", isSafe: false, 
             flags: ["VALIDATION_FAILED"], score: 0, details: {} };
  }
}
`}

/**
 * Quick validation gate — use this in your LangGraph workflow node.
 * Returns true only if the token is safe to trade.
 */
export async function isTokenSafe(
  tokenAddress: string, 
  chain: string = "${chain}"
): Promise<boolean> {
  console.log(\`[Security] Validating \${tokenAddress} on \${chain}...\`);
  
  const report = chain === "solana"
    ? await validateSolanaToken(tokenAddress)
    : await validateEvmToken(tokenAddress);

  if (!report.isSafe) {
    console.warn(\`[Security] ⛔ UNSAFE TOKEN: \${tokenAddress}\`);
    report.flags.forEach(f => console.warn(\`  → \${f}\`));
  } else {
    console.log(\`[Security] ✓ Token safe (score: \${report.score}/100)\`);
  }

  return report.isSafe;
}
            `,
          },
        ],
      };
    }

    case "get_honeypot_check_code": {
      return {
        content: [
          {
            type: "text",
            text: `
// Honeypot detection via honeypot.is API (EVM only)
import axios from "axios";

export async function checkHoneypot(
  tokenAddress: string,
  chainId: number = 1
): Promise<{ isHoneypot: boolean; sellTax: number; buyTax: number }> {
  const { data } = await axios.get(
    \`https://api.honeypot.is/v2/IsHoneypot?address=\${tokenAddress}&chainID=\${chainId}\`
  );
  
  return {
    isHoneypot: data.honeypotResult?.isHoneypot ?? false,
    sellTax: data.simulationResult?.sellTax ?? 0,
    buyTax: data.simulationResult?.buyTax ?? 0,
  };
}
            `,
          },
        ],
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[rugcheck-mcp] Server running on stdio");
}

main().catch(console.error);