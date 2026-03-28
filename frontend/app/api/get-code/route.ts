/**
 * FIXED: frontend/app/api/get-code/route.ts
 *
 * Changes from original:
 * 1. Uses the new, correct system prompt from prompts/prompt.ts
 * 2. Better error handling with specific messages
 * 3. Validates the returned files array properly
 * 4. Handles both the AI response and falls back to deterministic files
 *    (so the WebContainer always gets working code even if AI is slow/unavailable)
 */
import { NextResponse } from "next/server";
import { getSystemPrompt } from "./prompts/prompt";
import { assembleFiles } from "./deterministic-files"; // optional deterministic fallback

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const userIntent: string =
      body.intent ??
      "Build a flash loan arbitrageur on Arbitrum mainnet using Aave V3, Uniswap V3, and SushiSwap V2.";

    console.log("[get-code] Generating bot for intent:", userIntent);

    const systemPrompt = getSystemPrompt("FlashForge");

    const response = await fetch(
      "https://models.inference.ai.azure.com/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        },
        body: JSON.stringify({
          model: "gpt-4o",
          messages: [
            { role: "system", content: systemPrompt },
            {
              role: "user",
              content: `Generate the complete arbitrage bot project for this request: "${userIntent}"\n\nReturn valid JSON only.`,
            },
          ],
          response_format: { type: "json_object" },
          temperature: 0.1,           // low temp = more deterministic code
          max_tokens: 16000,           // need enough tokens for all files
        }),
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      console.error("[get-code] GitHub Models API error:", response.status, errText);
      
      // Fallback to deterministic files so the WebContainer still works
      const files = assembleFiles();
      return NextResponse.json({
        thoughts: "Using pre-built verified arbitrage bot (AI API unavailable)",
        files,
        fallback: true,
      });
    }

    const data = await response.json();
    const aiMessage: string = data.choices?.[0]?.message?.content ?? "";

    if (!aiMessage.trim()) {
      console.warn("[get-code] Empty AI response, using deterministic fallback");
      return NextResponse.json({
        thoughts: "Using pre-built verified arbitrage bot (empty AI response)",
        files: assembleFiles(),
        fallback: true,
      });
    }

    // Parse AI response — strip accidental markdown fences
    let parsedResponse: { thoughts?: string; files: Array<{ filepath: string; content: string }> };
    try {
      const cleaned = aiMessage
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();
      parsedResponse = JSON.parse(cleaned);
    } catch {
      console.error("[get-code] Failed to parse AI JSON, using deterministic fallback");
      return NextResponse.json({
        thoughts: "Using pre-built verified arbitrage bot (AI returned invalid JSON)",
        files: assembleFiles(),
        fallback: true,
      });
    }

    if (!parsedResponse.files || !Array.isArray(parsedResponse.files)) {
      console.error("[get-code] AI response missing files array, using deterministic fallback");
      return NextResponse.json({
        thoughts: "Using pre-built verified arbitrage bot (no files in AI response)",
        files: assembleFiles(),
        fallback: true,
      });
    }

    // Sanity check: ensure prices.ts uses QuoterV2 (key correctness indicator)
    const pricesFile = parsedResponse.files.find(
      (f: any) => f.filepath?.includes("prices") || f.filepath?.includes("price")
    );
    const hasCorrectQuoter =
      pricesFile?.content?.includes("quoteExactInputSingle.staticCall") &&
      pricesFile?.content?.includes("61fFE014bA17989E743c5F6cB21bF9697530B21e");

    if (!hasCorrectQuoter && pricesFile) {
      console.warn("[get-code] AI prices.ts missing correct QuoterV2 — merging deterministic fix");
      const deterministicFiles = assembleFiles();
      const deterministicPrices = deterministicFiles.find(f => f.filepath === "src/prices.ts");
      if (deterministicPrices) {
        const idx = parsedResponse.files.findIndex(
          (f: any) => f.filepath?.includes("prices")
        );
        if (idx !== -1) parsedResponse.files[idx] = deterministicPrices;
      }
    }

    console.log(`[get-code] Successfully generated ${parsedResponse.files.length} files.`);

    return NextResponse.json({
      thoughts: parsedResponse.thoughts ?? "Generated arbitrage bot",
      files:    parsedResponse.files,
    });
  } catch (err: any) {
    console.error("[get-code] Unexpected error:", err);
    
    // Last-resort deterministic fallback
    try {
      const files = assembleFiles();
      return NextResponse.json({
        thoughts: "Using pre-built verified arbitrage bot (unexpected error occurred)",
        files,
        fallback: true,
        error: err.message,
      });
    } catch {
      return NextResponse.json(
        { error: "Failed to generate bot", details: err.message },
        { status: 500 }
      );
    }
  }
}