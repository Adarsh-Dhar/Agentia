import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { encryptEnvConfig } from "@/lib/crypto-env";

const META_AGENT_URL = process.env.META_AGENT_URL ?? "http://127.0.0.1:8000";

export async function POST(req: NextRequest) {
  console.log("[generate-bot] Received request");
  try {
    const body = await req.json();
    console.log("[generate-bot] Body keys:", Object.keys(body));

    // Accept both `prompt` (original) and `expandedPrompt` (pre-expanded by classify-intent).
    // Always prefer the expanded prompt — it gives the meta-agent far more context.
    const expandedPrompt: string = body.expandedPrompt || body.prompt;
    const originalPrompt: string = body.prompt || expandedPrompt;
    const envConfig: Record<string, string> = body.envConfig || {};

    if (!expandedPrompt?.trim()) {
      return NextResponse.json({ error: "Prompt is required." }, { status: 400 });
    }

    console.log("[generate-bot] Using prompt length:", expandedPrompt.length, "chars");
    if (expandedPrompt.length > 200) {
      console.log("[generate-bot] Prompt preview:", expandedPrompt.slice(0, 300), "...");
    }

    // ── Call the Python Universal Meta-Agent ──────────────────────────────
    // We send the EXPANDED prompt so the code-generator has full context.
    // 10-minute timeout — LLM generation can be slow for complex bots.
    const metaController = new AbortController();
    const metaTimer = setTimeout(() => metaController.abort(), 600_000);

    let metaData: {
      output: { files?: Array<{ filepath: string; content: unknown; language?: string }>; thoughts?: string };
      intent: Record<string, unknown>;
      tools_used?: string[];
    };

    try {
      const metaResponse = await fetch(`${META_AGENT_URL}/create-bot`, {
        method: "POST",
        headers: { "Content-Type": "application/json", accept: "application/json" },
        body: JSON.stringify({ prompt: expandedPrompt }),
        signal: metaController.signal,
      });

      clearTimeout(metaTimer);

      if (!metaResponse.ok) {
        const errText = await metaResponse.text().catch(() => "");
        throw new Error(`Meta-Agent HTTP ${metaResponse.status}: ${errText.slice(0, 300)}`);
      }

      metaData = await metaResponse.json();
    } catch (fetchErr: unknown) {
      clearTimeout(metaTimer);
      const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);

      // If the Python agent is down, return a helpful error — don't crash silently
      if (msg.includes("fetch failed") || msg.includes("ECONNREFUSED") || msg.includes("abort")) {
        return NextResponse.json(
          {
            error: `Cannot reach the Python Meta-Agent at ${META_AGENT_URL}. ` +
              "Please ensure it is running: cd agents && uvicorn main:app --reload --port 8000",
          },
          { status: 503 }
        );
      }
      throw fetchErr;
    }


    console.log("[generate-bot] Received meta-agent response");
    // Fallback to metaData itself if the agent returned a flat structure
    const output = metaData.output || metaData;
    const intent = metaData.intent || {};
    const botName: string = (intent.bot_type as string) || "Universal DeFi Bot";

    // Extract files safely
    const filesList = output.files || (metaData as any).files || [];
    // Filter out .env and .env.example — we handle these ourselves
    const files = filesList.filter(
      (f: { filepath: string }) => ![".env", ".env.example"].includes(f.filepath)
    );

    console.log("[generate-bot] Generated files:", files.map((f: { filepath: string }) => f.filepath).join(", "));

    // ── Build .env content ─────────────────────────────────────────────────
    const finalEnv: Record<string, string> = {
      SIMULATION_MODE: "true",
      MCP_GATEWAY_URL: process.env.MCP_GATEWAY_URL ?? "http://localhost:8000/mcp",
      ...envConfig, // User-provided keys (e.g. Localtunnel URL) overwrite defaults
    };

    let envPlaintext = "";
    for (const [key, val] of Object.entries(finalEnv)) {
      if (val) envPlaintext += `${key}=${val}\n`;
    }
    const encryptedEnv = encryptEnvConfig(envPlaintext);

    // ── Save agent + files to DB ───────────────────────────────────────────
    const userId = "public-user";
    await prisma.user.upsert({
      where:  { id: userId },
      update: {},
      create: { id: userId, email: `${userId}@placeholder.agentia`, walletAddress: "" },
    });

    const configRecord = {
      generatedAt:    new Date().toISOString(),
      intent,
      toolsUsed:      metaData.tools_used ?? [],
      originalPrompt, // Keep original for display
    };

    const agent = await prisma.agent.create({
      data: {
        name:          botName,
        userId,
        status:        "STOPPED",
        // configuration: configRecord as Record<string, unknown>,
        envConfig:     encryptedEnv,
        files: {
          create: files.map((f: { filepath: string; content: unknown; language?: string }) => ({
            filepath: f.filepath,
            content:
              typeof f.content === "object"
                ? JSON.stringify(f.content, null, 2)
                : String(f.content),
            language:
              f.language ??
              (f.filepath.endsWith(".ts") ? "typescript"
                : f.filepath.endsWith(".py") ? "python"
                : f.filepath.endsWith(".json") ? "json"
                : "plaintext"),
          })),
        },
      },
      include: { files: true },
    });

    console.log("[generate-bot] Saved agent:", agent.id, "with", agent.files.length, "files");

    return NextResponse.json({
      agentId:  agent.id,
      botName,
      files,
      thoughts: output.thoughts ?? "Bot generated successfully.",
      intent,
    });

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[generate-bot] Error:", msg);
    return NextResponse.json(
      { error: msg },
      { status: 500 }
    );
  }
}