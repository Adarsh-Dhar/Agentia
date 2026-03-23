// ============================================================
// security.ts — Rugcheck & Webacy: Token Safety Verification
// ============================================================
//
// Before the agent interacts with a price gap, it MUST verify the
// token isn't a honeypot or rug pull — otherwise the flash loan
// cannot be repaid and the transaction reverts with a loss.
//
// Docs:
//   Rugcheck: https://rugcheck.xyz/
//   Webacy:   https://docs.webacy.com/
// ============================================================

import type { ChainId, Address, SafetyReport } from "../types";

// ── Risk Levels ───────────────────────────────────────────────────────────────

export type RiskLevel = "SAFE" | "LOW_RISK" | "MEDIUM_RISK" | "HIGH_RISK" | "CRITICAL";

export function scoreToRiskLevel(score: number): RiskLevel {
  if (score <= 10) return "SAFE";
  if (score <= 30) return "LOW_RISK";
  if (score <= 60) return "MEDIUM_RISK";
  if (score <= 80) return "HIGH_RISK";
  return "CRITICAL";
}

// ── Rugcheck (Solana) ─────────────────────────────────────────────────────────

const RUGCHECK_API = "https://api.rugcheck.xyz/v1";

export interface RugcheckTokenReport {
  mint: string;
  score: number;                // 0 (safe) → 100 (danger)
  score_normalised: number;
  risks: RugcheckRisk[];
  tokenMeta?: { name: string; symbol: string; mutable: boolean };
  markets?: RugcheckMarket[];
  topHolders?: Array<{ address: string; pct: number; uiAmount: number }>;
  freezeAuthority?: string | null;
  mintAuthority?: string | null;
  rugged: boolean;
}

export interface RugcheckRisk {
  name: string;
  value: string;
  description: string;
  score: number;
  level: "info" | "warn" | "danger";
}

export interface RugcheckMarket {
  pubkey: string;
  marketType: string;
  liquidity: number;
  lp_locked: boolean;
  lp_burned_pct?: number;
}

/**
 * Fetch a full token safety report from Rugcheck (Solana).
 *
 * @example
 * const report = await rugcheckGetReport("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
 * if (!report.isSafe) throw new Error("Token unsafe: " + report.flags.join(", "));
 */
export async function rugcheckGetReport(mintAddress: string): Promise<SafetyReport & { raw: RugcheckTokenReport }> {
  const url = `${RUGCHECK_API}/tokens/${mintAddress}/report/summary`;
  console.log(`[Rugcheck] Checking mint: ${mintAddress}`);

  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`[Rugcheck] API error: ${res.status} — ${await res.text()}`);

  const raw: RugcheckTokenReport = await res.json();

  const flags = raw.risks
    .filter((r) => r.level === "danger" || r.level === "warn")
    .map((r) => `[${r.level.toUpperCase()}] ${r.name}: ${r.description}`);

  const isHoneypot = raw.risks.some((r) =>
    r.name.toLowerCase().includes("honeypot") || r.name.toLowerCase().includes("cannot sell")
  );

  const isRugPull = raw.rugged || raw.risks.some((r) => r.name.toLowerCase().includes("rug"));

  const report: SafetyReport = {
    tokenAddress: mintAddress,
    chainId: "solana",
    isSafe: raw.score <= 30 && !isHoneypot && !isRugPull,
    isHoneypot,
    isRugPull,
    riskScore: raw.score_normalised ?? raw.score,
    flags,
    source: "rugcheck",
  };

  console.log(`[Rugcheck] Score: ${raw.score} | Safe: ${report.isSafe} | Flags: ${flags.length}`);
  return { ...report, raw };
}

/**
 * Quick check — returns just a boolean (suitable for hot path).
 */
export async function rugcheckIsSafe(mintAddress: string, maxScore = 30): Promise<boolean> {
  try {
    const report = await rugcheckGetReport(mintAddress);
    return report.isSafe && report.riskScore <= maxScore;
  } catch {
    // If the API fails, default to NOT safe (fail closed)
    console.warn(`[Rugcheck] Failed to check ${mintAddress} — defaulting to UNSAFE`);
    return false;
  }
}

// ── Webacy (EVM Multi-chain) ──────────────────────────────────────────────────

const WEBACY_API = "https://api.webacy.com";

export interface WebacyContractRisk {
  address: Address;
  chainId: string;
  riskScore: number;
  riskFactors: WebacyRiskFactor[];
  verdict: "SAFE" | "RISKY" | "CRITICAL";
  isProxy: boolean;
  isVerified: boolean;
  contractAge?: number; // days
}

export interface WebacyRiskFactor {
  type: string;
  description: string;
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
}

export interface WebacyWalletRisk {
  address: Address;
  riskScore: number;
  exposures: Array<{ protocol: string; riskScore: number; type: string }>;
  sanctioned: boolean;
}

/**
 * Fetch a contract risk report from Webacy (EVM chains).
 * Requires a Webacy API key: https://webacy.com/
 *
 * @example
 * const risk = await webacyCheckContract(
 *   "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
 *   "1",
 *   "YOUR_WEBACY_API_KEY"
 * );
 * if (risk.verdict === "CRITICAL") throw new Error("Unsafe contract");
 */
export async function webacyCheckContract(
  contractAddress: Address,
  chainId: string,
  apiKey: string
): Promise<SafetyReport & { raw: WebacyContractRisk }> {
  const url = `${WEBACY_API}/v2/contracts/${chainId}/${contractAddress}`;
  console.log(`[Webacy] Checking contract ${contractAddress} on chain ${chainId}`);

  const res = await fetch(url, {
    headers: { "x-api-key": apiKey, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`[Webacy] API error: ${res.status} — ${await res.text()}`);

  const raw: WebacyContractRisk = await res.json();

  const flags = raw.riskFactors
    .filter((f) => f.severity === "HIGH" || f.severity === "CRITICAL")
    .map((f) => `[${f.severity}] ${f.type}: ${f.description}`);

  const isHoneypot = raw.riskFactors.some((f) => f.type.toLowerCase().includes("honeypot"));
  const isRugPull = raw.riskFactors.some((f) =>
    f.type.toLowerCase().includes("rug") || f.type.toLowerCase().includes("ownership")
  );

  const report: SafetyReport = {
    tokenAddress: contractAddress,
    chainId: parseInt(chainId) as ChainId,
    isSafe: raw.verdict === "SAFE",
    isHoneypot,
    isRugPull,
    riskScore: raw.riskScore,
    flags,
    source: "webacy",
  };

  console.log(`[Webacy] Verdict: ${raw.verdict} | Score: ${raw.riskScore} | Flags: ${flags.length}`);
  return { ...report, raw };
}

/**
 * Check wallet risk exposure (useful to vet counterparty wallets).
 */
export async function webacyCheckWallet(
  walletAddress: Address,
  apiKey: string
): Promise<WebacyWalletRisk> {
  const url = `${WEBACY_API}/v2/address/${walletAddress}`;
  const res = await fetch(url, {
    headers: { "x-api-key": apiKey, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`[Webacy] Wallet check error: ${res.status}`);
  const data = await res.json();

  return {
    address: walletAddress,
    riskScore: data.riskScore ?? 0,
    exposures: data.exposures ?? [],
    sanctioned: data.sanctioned ?? false,
  };
}

// ── Aggregate Safety Gate ─────────────────────────────────────────────────────

export interface SafetyGateOptions {
  /** Maximum acceptable risk score (0–100). Default: 30 */
  maxRiskScore?: number;
  /** Fail if token is a suspected honeypot */
  blockHoneypots?: boolean;
  /** Fail if token is a suspected rug pull */
  blockRugPulls?: boolean;
  /** Webacy API key (EVM only) */
  webacyApiKey?: string;
  /** Fail if ANY flag is present (strictest mode) */
  strictMode?: boolean;
}

export interface SafetyGateResult {
  passed: boolean;
  reason?: string;
  reports: SafetyReport[];
  combinedRiskScore: number;
  riskLevel: RiskLevel;
}

/**
 * Unified safety gate — runs both Rugcheck (Solana) and Webacy (EVM)
 * checks and returns a single pass/fail decision.
 *
 * Use this in the arbitrage pipeline BEFORE executing any trade
 * involving an unfamiliar or low-cap token.
 *
 * @example
 * const gate = await safetyGate("solana", "EPjFWdd5...", { maxRiskScore: 25 });
 * if (!gate.passed) {
 *   console.error("Token failed safety check:", gate.reason);
 *   return; // abort the trade
 * }
 */
export async function safetyGate(
  chain: "solana" | "evm",
  tokenAddress: string,
  chainId: string = "1",
  options: SafetyGateOptions = {}
): Promise<SafetyGateResult> {
  const {
    maxRiskScore = 30,
    blockHoneypots = true,
    blockRugPulls = true,
    webacyApiKey,
    strictMode = false,
  } = options;

  const reports: SafetyReport[] = [];

  try {
    if (chain === "solana") {
      const report = await rugcheckGetReport(tokenAddress);
      reports.push(report);
    } else if (webacyApiKey) {
      const report = await webacyCheckContract(tokenAddress as Address, chainId, webacyApiKey);
      reports.push(report);
    } else {
      console.warn("[SafetyGate] No security API key provided for EVM — skipping external check");
    }
  } catch (e) {
    // API failure → fail closed
    return {
      passed: false,
      reason: `Security API unreachable: ${(e as Error).message}`,
      reports: [],
      combinedRiskScore: 100,
      riskLevel: "CRITICAL",
    };
  }

  if (!reports.length) {
    return { passed: true, reports: [], combinedRiskScore: 0, riskLevel: "SAFE" };
  }

  const combinedScore = Math.max(...reports.map((r) => r.riskScore));
  const riskLevel = scoreToRiskLevel(combinedScore);
  const allFlags = reports.flatMap((r) => r.flags);

  if (combinedScore > maxRiskScore) {
    return { passed: false, reason: `Risk score ${combinedScore} exceeds max ${maxRiskScore}`, reports, combinedRiskScore: combinedScore, riskLevel };
  }

  if (blockHoneypots && reports.some((r) => r.isHoneypot)) {
    return { passed: false, reason: "Token flagged as honeypot", reports, combinedRiskScore: combinedScore, riskLevel };
  }

  if (blockRugPulls && reports.some((r) => r.isRugPull)) {
    return { passed: false, reason: "Token flagged as rug pull", reports, combinedRiskScore: combinedScore, riskLevel };
  }

  if (strictMode && allFlags.length > 0) {
    return { passed: false, reason: `Strict mode: ${allFlags[0]}`, reports, combinedRiskScore: combinedScore, riskLevel };
  }

  return { passed: true, reports, combinedRiskScore: combinedScore, riskLevel };
}

// ── Convenience Wrappers ──────────────────────────────────────────────────────

/**
 * Assert a token is safe before trading. Throws on failure.
 *
 * @example
 * await assertTokenSafe("solana", "EPjFWdd5...");
 * // safe to proceed
 */
export async function assertTokenSafe(
  chain: "solana" | "evm",
  tokenAddress: string,
  chainId = "1",
  options?: SafetyGateOptions
): Promise<void> {
  const result = await safetyGate(chain, tokenAddress, chainId, options);
  if (!result.passed) {
    throw new Error(`[SafetyGate] Token ${tokenAddress} FAILED safety check: ${result.reason}`);
  }
  console.log(`[SafetyGate] ✓ Token ${tokenAddress} passed (score: ${result.combinedRiskScore}, level: ${result.riskLevel})`);
}

// ── Example Usage ─────────────────────────────────────────────────────────────

/*
// Solana token check via Rugcheck
const solanaResult = await safetyGate("solana", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "solana", {
  maxRiskScore: 25,
  blockHoneypots: true,
  blockRugPulls: true,
});
console.log(solanaResult);

// EVM token check via Webacy
const evmResult = await safetyGate("evm", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", "1", {
  webacyApiKey: "YOUR_KEY",
  maxRiskScore: 30,
});
console.log(evmResult);

// Throw-on-failure pattern
await assertTokenSafe("evm", "0xSomeNewToken", "137", { webacyApiKey: "KEY", maxRiskScore: 20 });
*/