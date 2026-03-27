/**
 * MCP Server: rugcheck  v2.0.0
 *
 * FIXED: Now actually calls Rugcheck.xyz (Solana) and GoPlus (EVM) APIs.
 * Previous version only returned code strings.
 *
 * Tools:
 *   validate_token        – LIVE call to Rugcheck/GoPlus, returns real risk report
 *   check_honeypot        – LIVE call to honeypot.is for EVM tokens
 *   get_token_validator_code – (kept) code template
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "rugcheck-mcp", version: "2.0.0" },
  { capabilities: { tools: {} } }
);

// ─── Types ────────────────────────────────────────────────────────────────────

type RiskLevel = "SAFE" | "LOW_RISK" | "MEDIUM_RISK" | "HIGH_RISK" | "CRITICAL";

interface TokenSecurityReport {
  tokenAddress: string;
  chain: string;
  riskLevel: RiskLevel;
  isSafe: boolean;
  score: number; // 0–100, higher = safer
  flags: string[];
  details: {
    mintAuthority?: boolean;
    freezeAuthority?: boolean;
    isHoneypot?: boolean;
    lpLocked?: boolean;
    topHolderConcentration?: number;
    hasBlacklist?: boolean;
    isProxy?: boolean;
  };
  source: string;
  checkedAt: string;
}

// ─── Fetch helper ─────────────────────────────────────────────────────────────

async function apiFetch(url: string, opts: RequestInit = {}): Promise<any> {
  const res = await fetch(url, {
    ...opts,
    headers: { Accept: "application/json", ...(opts.headers ?? {}) },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

// ─── Rugcheck.xyz — Solana ────────────────────────────────────────────────────

async function validateSolanaToken(
  mintAddress: string,
  strict: boolean
): Promise<TokenSecurityReport> {
  const flags: string[] = [];
  let score = 100;
  const details: TokenSecurityReport["details"] = {};

  try {
    const data = await apiFetch(
      `https://api.rugcheck.xyz/v1/tokens/${mintAddress}/report/summary`
    );

    const risks: Array<{ name: string; description: string; level: string }> =
      data.risks ?? [];

    for (const risk of risks) {
      flags.push(`[${risk.level.toUpperCase()}] ${risk.name}: ${risk.description}`);
      if (risk.level === "danger") score -= 40;
      else if (risk.level === "warn") score -= 15;
      else score -= 5;
    }

    details.mintAuthority = data.token?.mintAuthority !== null && data.token?.mintAuthority !== undefined;
    details.freezeAuthority = data.token?.freezeAuthority !== null && data.token?.freezeAuthority !== undefined;

    const lockedPct =
      data.markets
        ?.map((m: any) => m.lp?.lpLockedPct ?? 0)
        .reduce((a: number, b: number) => Math.max(a, b), 0) ?? 0;
    details.lpLocked = lockedPct > 80;

    const concentration = (data.topHolders ?? [])
      .slice(0, 10)
      .reduce((s: number, h: any) => s + (h.pct ?? 0), 0);
    details.topHolderConcentration = Math.round(concentration * 100) / 100;

    if (details.mintAuthority) {
      flags.push("[DANGER] MINT_AUTHORITY_ENABLED: token supply can be inflated");
      score -= 30;
    }
    if (details.freezeAuthority) {
      flags.push("[WARN] FREEZE_AUTHORITY_ENABLED: transfers can be frozen");
      score -= 20;
    }
    if (concentration > 50) {
      flags.push(`[WARN] HIGH_CONCENTRATION: top-10 wallets hold ${concentration.toFixed(1)}%`);
      score -= 15;
    }
    if (!details.lpLocked) {
      flags.push("[WARN] LP_NOT_LOCKED: liquidity not verified as locked");
      score -= 10;
    }
  } catch (err: any) {
    flags.push(`VALIDATION_FAILED: ${err.message}`);
    score = 0;
  }

  score = Math.max(0, Math.min(100, score));
  const riskLevel = scoreToRisk(score);

  return {
    tokenAddress: mintAddress,
    chain: "solana",
    riskLevel,
    isSafe: strict ? riskLevel === "SAFE" : ["SAFE", "LOW_RISK"].includes(riskLevel),
    score,
    flags,
    details,
    source: "rugcheck.xyz",
    checkedAt: new Date().toISOString(),
  };
}

// ─── GoPlus — EVM ─────────────────────────────────────────────────────────────

async function validateEvmToken(
  tokenAddress: string,
  chainId: string,
  strict: boolean
): Promise<TokenSecurityReport> {
  const flags: string[] = [];
  let score = 100;
  const details: TokenSecurityReport["details"] = {};

  try {
    const data = await apiFetch(
      `https://api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${tokenAddress}`
    );

    const result = data.result?.[tokenAddress.toLowerCase()];
    if (!result) throw new Error("Token not found in GoPlus database");

    details.isHoneypot = result.is_honeypot === "1";
    details.hasBlacklist = result.is_blacklisted === "1";
    details.mintAuthority = result.can_take_back_ownership === "1";
    details.isProxy = result.is_proxy === "1";

    const lockedHolder = (result.lp_holders ?? []).find(
      (h: any) => h.is_locked
    );
    details.lpLocked =
      parseFloat(lockedHolder?.percent ?? "0") > 0.5;

    const top10Pct =
      (result.holders ?? [])
        .slice(0, 10)
        .reduce((s: number, h: any) => s + parseFloat(h.percent ?? "0"), 0) *
      100;
    details.topHolderConcentration = Math.round(top10Pct * 10) / 10;

    if (details.isHoneypot) {
      flags.push("[CRITICAL] HONEYPOT: token cannot be sold");
      score -= 100;
    }
    if (details.hasBlacklist) {
      flags.push("[DANGER] BLACKLIST: addresses can be blacklisted");
      score -= 30;
    }
    if (details.mintAuthority) {
      flags.push("[DANGER] MINT_CONTROL: owner can mint unlimited tokens");
      score -= 40;
    }
    if (details.isProxy) {
      flags.push("[WARN] PROXY_CONTRACT: contract logic can be swapped");
      score -= 20;
    }
    if (!details.lpLocked) {
      flags.push("[WARN] LP_UNLOCKED: liquidity can be removed at any time");
      score -= 10;
    }
    if (top10Pct > 50) {
      flags.push(`[WARN] HIGH_CONCENTRATION: top-10 hold ${top10Pct.toFixed(1)}%`);
      score -= 10;
    }

    // Bonus flags from GoPlus
    if (result.sell_tax && parseFloat(result.sell_tax) > 0.1) {
      flags.push(`[WARN] HIGH_SELL_TAX: ${(parseFloat(result.sell_tax) * 100).toFixed(1)}%`);
      score -= 15;
    }
    if (result.buy_tax && parseFloat(result.buy_tax) > 0.1) {
      flags.push(`[WARN] HIGH_BUY_TAX: ${(parseFloat(result.buy_tax) * 100).toFixed(1)}%`);
      score -= 10;
    }
  } catch (err: any) {
    flags.push(`VALIDATION_FAILED: ${err.message}`);
    score = 0;
  }

  score = Math.max(0, Math.min(100, score));
  const riskLevel = scoreToRisk(score);
  const chainNames: Record<string, string> = {
    "1": "ethereum", "56": "bsc", "137": "polygon",
    "42161": "arbitrum", "10": "optimism", "8453": "base",
  };

  return {
    tokenAddress,
    chain: chainNames[chainId] ?? `chain-${chainId}`,
    riskLevel,
    isSafe: strict ? riskLevel === "SAFE" : ["SAFE", "LOW_RISK"].includes(riskLevel),
    score,
    flags,
    details,
    source: "gopluslabs.io",
    checkedAt: new Date().toISOString(),
  };
}

function scoreToRisk(score: number): RiskLevel {
  if (score >= 80) return "SAFE";
  if (score >= 60) return "LOW_RISK";
  if (score >= 40) return "MEDIUM_RISK";
  if (score >= 20) return "HIGH_RISK";
  return "CRITICAL";
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS: Tool[] = [
  {
    name: "validate_token",
    description:
      "LIVE: Calls Rugcheck.xyz (Solana) or GoPlus (EVM) right now and returns a real security report with risk score, flags, and a clear isSafe verdict. Always call this before trading any token.",
    inputSchema: {
      type: "object",
      properties: {
        tokenAddress: { type: "string", description: "Token contract / mint address" },
        chain: {
          type: "string",
          enum: ["solana", "ethereum", "bsc", "polygon", "arbitrum", "optimism", "base"],
          description: "Blockchain the token is on",
        },
        strict: {
          type: "boolean",
          description: "If true, only 'SAFE' tokens pass. If false, 'LOW_RISK' also passes. Default true.",
          default: true,
        },
      },
      required: ["tokenAddress", "chain"],
    },
  },
  {
    name: "check_honeypot",
    description:
      "LIVE: Calls honeypot.is to check whether an EVM token can actually be sold. Returns isHoneypot, buyTax, sellTax.",
    inputSchema: {
      type: "object",
      properties: {
        tokenAddress: { type: "string" },
        chainId: {
          type: "number",
          description: "EVM chain ID: 1=ETH, 56=BSC, 137=Polygon, 42161=Arbitrum",
          default: 1,
        },
      },
      required: ["tokenAddress"],
    },
  },
  {
    name: "get_token_validator_code",
    description: "Returns TypeScript boilerplate for token validation (code template, not a live call).",
    inputSchema: {
      type: "object",
      properties: {
        chain: { type: "string", enum: ["solana", "ethereum", "bsc", "polygon"] },
        strictMode: { type: "boolean" },
      },
    },
  },
];

// ─── Handlers ─────────────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    // ── LIVE token validation ─────────────────────────────────────────────────
    case "validate_token": {
      const address: string = (args as any)?.tokenAddress;
      const chain: string = (args as any)?.chain ?? "solana";
      const strict: boolean = (args as any)?.strict ?? true;

      const chainIdMap: Record<string, string> = {
        ethereum: "1", bsc: "56", polygon: "137",
        arbitrum: "42161", optimism: "10", base: "8453",
      };

      let report: TokenSecurityReport;
      if (chain === "solana") {
        report = await validateSolanaToken(address, strict);
      } else {
        const chainId = chainIdMap[chain] ?? "1";
        report = await validateEvmToken(address, chainId, strict);
      }

      return {
        content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
      };
    }

    // ── LIVE honeypot check ───────────────────────────────────────────────────
    case "check_honeypot": {
      const address: string = (args as any)?.tokenAddress;
      const chainId: number = (args as any)?.chainId ?? 1;

      try {
        const data = await apiFetch(
          `https://api.honeypot.is/v2/IsHoneypot?address=${address}&chainID=${chainId}`
        );

        const result = {
          tokenAddress: address,
          chainId,
          isHoneypot: data.honeypotResult?.isHoneypot ?? false,
          honeypotReason: data.honeypotResult?.honeypotReason ?? null,
          buyTaxPct: Math.round((data.simulationResult?.buyTax ?? 0) * 100) / 100,
          sellTaxPct: Math.round((data.simulationResult?.sellTax ?? 0) * 100) / 100,
          buyGas: data.simulationResult?.buyGas ?? null,
          sellGas: data.simulationResult?.sellGas ?? null,
          verdict:
            data.honeypotResult?.isHoneypot
              ? "HONEYPOT — DO NOT TRADE"
              : "SELL_ENABLED — appears safe",
          checkedAt: new Date().toISOString(),
        };

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: err.message, tokenAddress: address }),
            },
          ],
        };
      }
    }

    // ── Code template (kept) ─────────────────────────────────────────────────
    case "get_token_validator_code": {
      return {
        content: [
          {
            type: "text",
            text: `
// Tip: use the validate_token MCP tool directly from your agent instead of
// copy-pasting this template. The MCP tool already calls the APIs for you.

// Quick guard to paste into your agent workflow:
async function guardToken(mcpClient: any, address: string, chain: string) {
  const result = await mcpClient.callTool("validate_token", {
    tokenAddress: address,
    chain,
    strict: true,
  });
  const report = JSON.parse(result.content[0].text);
  if (!report.isSafe) {
    throw new Error(\`Token rejected [\${report.riskLevel}]: \${report.flags.join("; ")}\`);
  }
  return report;
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
  console.error("[rugcheck-mcp v2] Server running — live API mode");
}

main().catch(console.error);