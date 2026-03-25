// ============================================================
// FILE: src/token-validator.ts
// Security validation — ALWAYS run before trading any token
// Chain: ethereum | Strict Mode: true
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
      `https://api.gopluslabs.io/api/v1/token_security/${chainId}`,
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
      isSafe: true ? riskLevel === "SAFE" : ["SAFE", "LOW_RISK"].includes(riskLevel),
      flags, score, details,
    };
  } catch {
    return { tokenAddress, riskLevel: "CRITICAL", isSafe: false, 
             flags: ["VALIDATION_FAILED"], score: 0, details: {} };
  }
}


/**
 * Quick validation gate — use this in your LangGraph workflow node.
 * Returns true only if the token is safe to trade.
 */
export async function isTokenSafe(
  tokenAddress: string, 
  chain: string = "ethereum"
): Promise<boolean> {
  console.log(`[Security] Validating ${tokenAddress} on ${chain}...`);
  
  const report = chain === "solana"
    ? await validateSolanaToken(tokenAddress)
    : await validateEvmToken(tokenAddress);

  if (!report.isSafe) {
    console.warn(`[Security] ⛔ UNSAFE TOKEN: ${tokenAddress}`);
    report.flags.forEach(f => console.warn(`  → ${f}`));
  } else {
    console.log(`[Security] ✓ Token safe (score: ${report.score}/100)`);
  }

  return report.isSafe;
}