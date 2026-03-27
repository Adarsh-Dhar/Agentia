import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma.ts";
import { MissionPlan, CreateAgentRequestBody, Strategy, Confidence } from "@/lib/types.ts";
import { VALID_STRATEGIES, VALID_CONFIDENCE } from "@/lib/constant.ts";


const SYSTEM_PROMPT = `You are an expert AI trading strategy architect for the Initia blockchain ecosystem.
Your job is to interpret a user's natural language trading intent and produce a precise, executable Mission Plan.

AVAILABLE STRATEGIES:
- MEME_SNIPER: Identifies and trades emerging meme tokens on Initia DEXes. Best for: high-risk/high-reward, trending tokens.
- ARBITRAGE: Exploits price differences between trading pairs or DEX pools. Best for: lower risk, consistent small gains.
- SENTIMENT_TRADER: Trades based on social media signals and on-chain sentiment. Best for: narrative-driven moves.

AVAILABLE TRADING PAIRS (Initia ecosystem):
INIT/USDC, MEME/INIT, INIT/USDT, ARB/INIT, SOL/INIT, BTC/INIT

OUTPUT RULES:
- Respond ONLY with a valid JSON object. No markdown fences, no explanation, no preamble.
- agentName must be creative, <= 4 words, trading-themed.
- entryConditions: exactly 2-3 specific, actionable conditions.
- exitConditions: exactly 2-3 specific, actionable conditions.
- riskNotes: 1-3 honest risk disclosures relevant to the strategy.
- warnings: 0-2 critical warnings if the intent is risky, vague, or contradictory. Empty array if none.
- sessionDurationHours: integer 1-168 (max 1 week).
- recommendedSpendAllowance: number in USD, reasonable and proportionate to the stated risk tolerance.
- confidence: HIGH if intent is clear and complete, MEDIUM if some ambiguity exists, LOW if very vague.

JSON SCHEMA (return exactly this shape, no extra keys):
{
  "agentName": string,
  "strategy": "MEME_SNIPER" | "ARBITRAGE" | "SENTIMENT_TRADER",
  "targetPair": string,
  "description": string,
  "entryConditions": string[],
  "exitConditions": string[],
  "riskNotes": string[],
  "sessionDurationHours": number,
  "recommendedSpendAllowance": number,
  "confidence": "HIGH" | "MEDIUM" | "LOW",
  "warnings": string[]
}`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function errorResponse(message: string, status: number, details?: unknown) {
  return NextResponse.json(
    { error: message, ...(details ? { details } : {}) },
    { status }
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// ─── GitHub Models → gpt-4o ───────────────────────────────────────────────────

async function interpretIntent(intent: string): Promise<MissionPlan> {
  const githubToken = process.env.GITHUB_TOKEN;
  if (!githubToken) {
    throw new Error("GITHUB_TOKEN environment variable is not configured.");
  }

  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), 30_000); // 30s timeout

  let response: Response;
  try {
    response = await fetch(
      "https://models.inference.ai.azure.com/chat/completions",
      {
        method:  "POST",
        signal:  controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization:  `Bearer ${githubToken}`,
        },
        body: JSON.stringify({
          model:           "gpt-4o",
          temperature:     0.3,
          max_tokens:      900,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            {
              role:    "user",
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
    throw new Error(
      `Failed to reach GitHub Models API: ${(err as Error).message}`
    );
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    // Try to extract a useful message from the GitHub Models error body
    let apiErrorMsg = `GitHub Models API returned ${response.status}`;
    try {
      const errBody = await response.json();
      if (errBody?.error?.message) apiErrorMsg += `: ${errBody.error.message}`;
    } catch {
      // swallow JSON parse error on error body
    }
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

  // Parse JSON — try directly first, then regex-extract if needed
  let parsed: Partial<MissionPlan>;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error(
        "AI returned malformed JSON. Please rephrase your trading intent."
      );
    }
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      throw new Error(
        "Could not parse AI response after extraction. Try a clearer description."
      );
    }
  }

  // ── Validate required fields ──────────────────────────────────────────────

  const requiredFields: (keyof MissionPlan)[] = [
    "agentName",
    "strategy",
    "targetPair",
    "description",
    "entryConditions",
    "exitConditions",
    "sessionDurationHours",
    "recommendedSpendAllowance",
    "confidence",
  ];

  const missingFields = requiredFields.filter(
    (k) => parsed[k] === undefined || parsed[k] === null
  );
  if (missingFields.length > 0) {
    throw new Error(
      `AI plan is incomplete — missing fields: ${missingFields.join(", ")}. Please retry.`
    );
  }

  // ── Coerce and sanitise values ────────────────────────────────────────────

  if (!VALID_STRATEGIES.includes(parsed.strategy as Strategy)) {
    throw new Error(
      `AI returned an invalid strategy "${parsed.strategy}". Please retry.`
    );
  }

  if (!VALID_CONFIDENCE.includes(parsed.confidence as Confidence)) {
    parsed.confidence = "MEDIUM";
  }

  // Clamp numeric fields to safe ranges
  const sessionHours = clamp(
    Number(parsed.sessionDurationHours) || 24,
    1,
    168
  );
  const spendAllowance = clamp(
    Number(parsed.recommendedSpendAllowance) || 500,
    10,
    1_000_000
  );

  // Ensure arrays are actually arrays and within length limits
  const toArray = (v: unknown, limit: number): string[] =>
    Array.isArray(v) ? (v as string[]).slice(0, limit) : [];

  return {
    agentName:                 String(parsed.agentName).slice(0, 60),
    strategy:                  parsed.strategy as Strategy,
    targetPair:                String(parsed.targetPair).slice(0, 30),
    description:               String(parsed.description).slice(0, 400),
    entryConditions:           toArray(parsed.entryConditions, 3),
    exitConditions:            toArray(parsed.exitConditions, 3),
    riskNotes:                 toArray(parsed.riskNotes, 3),
    sessionDurationHours:      sessionHours,
    recommendedSpendAllowance: spendAllowance,
    confidence:                parsed.confidence as Confidence,
    warnings:                  toArray(parsed.warnings, 2),
  };
}

// ─── POST /api/agent ──────────────────────────────────────────────────────────
//
// Body (JSON):
//   userId               string   required — must exist in DB
//   intent               string   required — natural language trading goal (20-1000 chars)
//   spendAllowance?      number   optional override (Tier 3 guardrail)
//   sessionDurationHours? number  optional override (Tier 3 guardrail)
//   maxDailyLoss?        number   optional — stored in boot log for worker reference
//   sessionKeyPub?       string   optional — if generated client-side
//   sessionKeyPriv?      string   optional — if generated client-side
//
// Returns 201 with { agent, plan } on success.
// Returns 4xx/5xx with { error, details? } on failure.

export async function POST(req: NextRequest) {
  // ── 1. Parse request body ────────────────────────────────────────────────
  let body: CreateAgentRequestBody;
  try {
    body = await req.json();
  } catch {
    return errorResponse("Request body must be valid JSON.", 400);
  }

  const {
    userId,
    intent,
    spendAllowance:      spendOverride,
    sessionDurationHours: hoursOverride,
    maxDailyLoss,
    sessionKeyPub,
    sessionKeyPriv,
  } = body;

  // ── 2. Validate required inputs ──────────────────────────────────────────
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

  // Validate optional numeric overrides
  if (spendOverride !== undefined) {
    if (typeof spendOverride !== "number" || spendOverride <= 0) {
      return errorResponse("spendAllowance must be a positive number.", 400);
    }
    if (spendOverride > 1_000_000) {
      return errorResponse("spendAllowance cannot exceed $1,000,000.", 400);
    }
  }

  if (hoursOverride !== undefined) {
    if (typeof hoursOverride !== "number" || hoursOverride < 1) {
      return errorResponse("sessionDurationHours must be at least 1.", 400);
    }
    if (hoursOverride > 168) {
      return errorResponse("sessionDurationHours cannot exceed 168 (1 week).", 400);
    }
  }

  if (maxDailyLoss !== undefined) {
    if (typeof maxDailyLoss !== "number" || maxDailyLoss <= 0) {
      return errorResponse("maxDailyLoss must be a positive number.", 400);
    }
    const effectiveSpend = spendOverride ?? 1_000_000;
    if (maxDailyLoss > effectiveSpend) {
      return errorResponse(
        "maxDailyLoss cannot exceed the total spendAllowance.",
        400
      );
    }
  }

  // ── 3. Confirm user exists ────────────────────────────────────────────────
  let userExists: { id: string } | null;
  try {
    userExists = await prisma.user.findUnique({
      where:  { id: userId },
      select: { id: true },
    });
  } catch (err) {
    console.error("[POST /api/agent] DB user lookup error:", err);
    return errorResponse("Database error while verifying user.", 500);
  }

  if (!userExists) {
    return errorResponse(`User "${userId}" not found.`, 404);
  }

  // ── 4. Call GitHub Models gpt-4o to interpret intent ─────────────────────
  let plan: MissionPlan;
  try {
    plan = await interpretIntent(trimmedIntent);
  } catch (err) {
    const msg =
      err instanceof Error ? err.message : "Unknown AI interpretation error.";
    console.error("[POST /api/agent] AI interpretation error:", err);

    // Distinguish between config errors (500) and retry-able model errors (502)
    const isConfigError = msg.includes("GITHUB_TOKEN");
    return errorResponse(
      isConfigError ? "Server configuration error." : "Failed to interpret trading intent.",
      isConfigError ? 500 : 502,
      { aiError: msg }
    );
  }

  // ── 5. Apply Tier 3 guardrail overrides ──────────────────────────────────
  const finalSpendAllowance     = spendOverride    ?? plan.recommendedSpendAllowance;
  const finalSessionHours       = hoursOverride    ?? plan.sessionDurationHours;
  const finalMaxDailyLoss       = maxDailyLoss     ?? Math.round(finalSpendAllowance * 0.1);
  const sessionExpiresAt        = new Date(Date.now() + finalSessionHours * 3_600_000);

  // ── 6. Write Agent + boot TradeLog in one atomic transaction ──────────────
  let agent: Awaited<ReturnType<typeof prisma.agent.create>>;
  try {
    agent = await prisma.$transaction(async (tx) => {
      const newAgent = await tx.agent.create({
        data: {
          userId,
          name:            plan.agentName,
          strategy:        plan.strategy,
          status:          "RUNNING",
          targetPair:      plan.targetPair,
          spendAllowance:  finalSpendAllowance,
          sessionExpiresAt,
          sessionKeyPub:   sessionKeyPub  ?? null,
          sessionKeyPriv:  sessionKeyPriv ?? null,
        },
      });

      // Structured boot log — the off-chain worker reads this to configure itself
      const bootMessage = JSON.stringify({
        event:           "SYSTEM_BOOT",
        description:     plan.description,
        entryConditions: plan.entryConditions,
        exitConditions:  plan.exitConditions,
        riskNotes:       plan.riskNotes,
        maxDailyLoss:    finalMaxDailyLoss,
        confidence:      plan.confidence,
        warnings:        plan.warnings,
        intent:          trimmedIntent,
        generatedAt:     new Date().toISOString(),
      });

      await tx.tradeLog.create({
        data: {
          agentId: newAgent.id,
          type:    "INFO",
          message: `System Boot: Agent "${newAgent.name}" deployed. ${bootMessage}`,
        },
      });

      return newAgent;
    });
  } catch (err) {
    console.error("[POST /api/agent] DB transaction error:", err);
    return errorResponse(
      "Failed to persist agent to the database. Please try again.",
      500
    );
  }

  // ── 7. Return created agent + the full plan so the client can display it ──
  return NextResponse.json(
    {
      agent,
      plan: {
        ...plan,
        appliedSpendAllowance:     finalSpendAllowance,
        appliedSessionHours:       finalSessionHours,
        appliedMaxDailyLoss:       finalMaxDailyLoss,
        sessionExpiresAt:          sessionExpiresAt.toISOString(),
      },
    },
    { status: 201 }
  );
}