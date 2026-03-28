import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

const SYSTEM_PROMPT = `You are an expert AI trading strategy architect for the Base Sepolia blockchain ecosystem.
Your job is to interpret a user's natural language trading intent and produce a precise, executable Mission Plan.

AVAILABLE STRATEGIES:
- FLASH_LOAN_ARB: Borrows an asset via Aave flash loan, swaps via 1inch (asset→WETH→asset), repays with fee, keeps profit. Best for: low-risk, capital-efficient, sub-second execution.
- SENTIMENT_TRADER: Trades based on social media signals and on-chain sentiment. Best for: narrative-driven moves.
- MEME_SNIPER: Identifies and trades emerging meme tokens. Best for: high-risk/high-reward, trending tokens.

AVAILABLE TRADING PAIRS: USDC/WETH, WETH/USDC, USDC/WBTC, WETH/WBTC

OUTPUT RULES:
- Respond ONLY with a valid JSON object. No markdown fences, no explanation, no preamble.
- agentName must be creative, <= 4 words, trading-themed.
- entryConditions: exactly 2-3 specific, actionable conditions.
- exitConditions: exactly 2-3 specific, actionable conditions.
- riskNotes: 1-3 honest risk disclosures relevant to the strategy.
- warnings: 0-2 critical warnings if the intent is risky, vague, or contradictory. Empty array if none.
- pollIntervalSeconds: integer 3-60 (how often to check for opportunities).
- borrowAmountHuman: number representing the token amount to borrow (e.g., 1000 for 1000 USDC).
- confidence: HIGH if intent is clear and complete, MEDIUM if some ambiguity exists, LOW if very vague.

JSON SCHEMA (return exactly this shape, no extra keys):
{
  "agentName": string,
  "strategy": "FLASH_LOAN_ARB" | "SENTIMENT_TRADER" | "MEME_SNIPER",
  "targetPair": string,
  "description": string,
  "entryConditions": string[],
  "exitConditions": string[],
  "riskNotes": string[],
  "pollIntervalSeconds": number,
  "borrowAmountHuman": number,
  "confidence": "HIGH" | "MEDIUM" | "LOW",
  "warnings": string[]
}`;

interface MissionPlan {
  agentName: string;
  strategy: string;
  targetPair: string;
  description: string;
  entryConditions: string[];
  exitConditions: string[];
  riskNotes: string[];
  pollIntervalSeconds: number;
  borrowAmountHuman: number;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  warnings: string[];
}

function errorResponse(message: string, status: number, details?: unknown) {
  return NextResponse.json(
    { error: message, ...(details ? { details } : {}) },
    { status }
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

async function interpretIntent(intent: string): Promise<MissionPlan> {
  const githubToken = process.env.GITHUB_TOKEN;
  if (!githubToken) {
    throw new Error("GITHUB_TOKEN environment variable is not configured.");
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30_000);

  let response: Response;
  try {
    response = await fetch(
      "https://models.inference.ai.azure.com/chat/completions",
      {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${githubToken}`,
        },
        body: JSON.stringify({
          model: "gpt-4o",
          temperature: 0.3,
          max_tokens: 900,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            {
              role: "user",
              content: `Parse this trading intent into a Mission Plan:\n\n"${intent}"`,
            },
          ],
        }),
      }
    );
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error("AI model request timed out after 30 seconds. Please try again.");
    }
    throw new Error(`Failed to reach GitHub Models API: ${(err as Error).message}`);
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    let apiErrorMsg = `GitHub Models API returned ${response.status}`;
    try {
      const errBody = await response.json();
      if (errBody?.error?.message) apiErrorMsg += `: ${errBody.error.message}`;
    } catch { /* ignore */ }
    throw new Error(apiErrorMsg);
  }

  let rawData: unknown;
  try {
    rawData = await response.json();
  } catch {
    throw new Error("GitHub Models API returned an unreadable response body.");
  }

  const rawContent: string =
    (rawData as { choices?: { message?: { content?: string } }[] })
      ?.choices?.[0]?.message?.content ?? "";

  if (!rawContent.trim()) {
    throw new Error("AI model returned an empty response. Please retry.");
  }

  let parsed: Partial<MissionPlan>;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("AI returned malformed JSON. Please rephrase your trading intent.");
    }
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      throw new Error("Could not parse AI response after extraction. Try a clearer description.");
    }
  }

  // ── Validate required fields ───────────────────────────────────────────────
  const requiredFields: (keyof MissionPlan)[] = [
    "agentName", "strategy", "targetPair", "description",
    "entryConditions", "exitConditions", "pollIntervalSeconds",
    "borrowAmountHuman", "confidence",
  ];

  const missingFields = requiredFields.filter(
    (k) => parsed[k] === undefined || parsed[k] === null
  );
  if (missingFields.length > 0) {
    throw new Error(
      `AI plan is incomplete — missing fields: ${missingFields.join(", ")}. Please retry.`
    );
  }

  const validStrategies = ["FLASH_LOAN_ARB", "SENTIMENT_TRADER", "MEME_SNIPER"];
  if (!validStrategies.includes(parsed.strategy as string)) {
    throw new Error(`AI returned an invalid strategy "${parsed.strategy}". Please retry.`);
  }

  const validConfidence = ["HIGH", "MEDIUM", "LOW"];
  if (!validConfidence.includes(parsed.confidence as string)) {
    parsed.confidence = "MEDIUM";
  }

  const toArray = (v: unknown, limit: number): string[] =>
    Array.isArray(v) ? (v as string[]).slice(0, limit) : [];

  return {
    agentName:          String(parsed.agentName).slice(0, 60),
    strategy:           parsed.strategy as string,
    targetPair:         String(parsed.targetPair).slice(0, 30),
    description:        String(parsed.description).slice(0, 400),
    entryConditions:    toArray(parsed.entryConditions, 3),
    exitConditions:     toArray(parsed.exitConditions, 3),
    riskNotes:          toArray(parsed.riskNotes, 3),
    pollIntervalSeconds: clamp(Number(parsed.pollIntervalSeconds) || 5, 3, 60),
    borrowAmountHuman:  clamp(Number(parsed.borrowAmountHuman) || 1000, 1, 1_000_000),
    confidence:         parsed.confidence as "HIGH" | "MEDIUM" | "LOW",
    warnings:           toArray(parsed.warnings, 2),
  };
}

// ─── POST /api/agent-creation ─────────────────────────────────────────────────
//
// Body (JSON):
//   userId      string   required — must exist in DB (Clerk user ID)
//   intent      string   required — natural language trading goal (20-1000 chars)
//
// Returns 201 with { agent, plan } on success.
export async function POST(req: NextRequest) {
  // ── 1. Parse request body ──────────────────────────────────────────────────
  let body: { userId?: string; intent?: string };
  try {
    body = await req.json();
  } catch {
    return errorResponse("Request body must be valid JSON.", 400);
  }

  const { userId, intent } = body;

  // ── 2. Validate inputs ─────────────────────────────────────────────────────
  if (!userId || typeof userId !== "string" || !userId.trim()) {
    return errorResponse("userId is required.", 400);
  }

  if (!intent || typeof intent !== "string") {
    return errorResponse("intent is required and must be a string.", 400);
  }

  const trimmedIntent = intent.trim();
  if (trimmedIntent.length < 20) {
    return errorResponse(
      "intent must be at least 20 characters — describe your trading goal in more detail.",
      400
    );
  }
  if (trimmedIntent.length > 1000) {
    return errorResponse("intent must be 1000 characters or fewer.", 400);
  }

  // ── 3. Confirm user exists ─────────────────────────────────────────────────
  let userExists: { id: string } | null;
  try {
    userExists = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
  } catch (err) {
    console.error("[POST /api/agent-creation] DB user lookup error:", err);
    return errorResponse("Database error while verifying user.", 500);
  }

  if (!userExists) {
    return errorResponse(`User "${userId}" not found.`, 404);
  }

  // ── 4. Interpret intent via AI ─────────────────────────────────────────────
  let plan: MissionPlan;
  try {
    plan = await interpretIntent(trimmedIntent);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown AI interpretation error.";
    console.error("[POST /api/agent-creation] AI interpretation error:", err);
    const isConfigError = msg.includes("GITHUB_TOKEN");
    return errorResponse(
      isConfigError ? "Server configuration error." : "Failed to interpret trading intent.",
      isConfigError ? 500 : 502,
      { aiError: msg }
    );
  }

  // ── 5. Persist agent with configuration derived from the plan ──────────────
  let agent: Awaited<ReturnType<typeof prisma.agent.create>>;
  try {
    agent = await prisma.agent.create({
      data: {
        userId,
        name: plan.agentName,
        status: "STOPPED",
        configuration: {
          strategy:           plan.strategy,
          targetPair:         plan.targetPair,
          description:        plan.description,
          entryConditions:    plan.entryConditions,
          exitConditions:     plan.exitConditions,
          riskNotes:          plan.riskNotes,
          pollIntervalSeconds: plan.pollIntervalSeconds,
          borrowAmountHuman:  plan.borrowAmountHuman,
          confidence:         plan.confidence,
          warnings:           plan.warnings,
          intent:             trimmedIntent,
          generatedAt:        new Date().toISOString(),
        },
      },
    });
  } catch (err) {
    console.error("[POST /api/agent-creation] DB transaction error:", err);
    return errorResponse(
      "Failed to persist agent to the database. Please try again.",
      500
    );
  }

  // ── 6. Return created agent + full plan ────────────────────────────────────
  return NextResponse.json({ agent, plan }, { status: 201 });
}