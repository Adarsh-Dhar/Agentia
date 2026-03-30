import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { encryptEnvConfig } from "@/lib/crypto-env";

const META_AGENT_URL = process.env.META_AGENT_URL ?? "http://127.0.0.1:8000";

export async function POST(req: NextRequest) {
  console.log("Received request for bot generation");
  try {
    const body = await req.json();
    console.log("Received request body for bot generation:", body);

    const prompt = body.prompt;
    const envConfig = body.envConfig || {}; // NEW: Accept keys from chat

    // 1. Validate we received a prompt
    if (!prompt) {
      return NextResponse.json({ error: "Prompt is required." }, { status: 400 });
    }

    console.log("Received prompt for bot generation:", prompt);

    // 2. Call the Python Universal Meta-Agent
    const metaResponse = await fetch(`${META_AGENT_URL}/create-bot`, {
      method:  "POST",
      headers: { "Content-Type": "application/json", accept: "application/json" },
      body:    JSON.stringify({ prompt }),
      signal:  AbortSignal.timeout(600_000), // 10-minute timeout for LLM generation
    });

    if (!metaResponse.ok) {
        console.log(metaResponse)
        const errText = await metaResponse.text();
        throw new Error(`Meta-Agent failed: ${metaResponse.status} - ${errText}`);
    }

    const metaData = await metaResponse.json();
    console.log("Received metadata from Meta-Agent:", metaData);
    const output = metaData.output ?? {};
    console.log("Received output from Meta-Agent:", output);
    const intent = metaData.intent ?? {};
    console.log("Received intent from Meta-Agent:", intent);
    const botName = intent.bot_type || "Universal DeFi Bot";

    const files = (output.files ?? []).filter((f: any) => !['.env', '.env.example'].includes(f.filepath));


    // NEW: Properly merge keys so user input overwrites the defaults
    const finalEnv: Record<string, string> = {
      SIMULATION_MODE: "true",
      MCP_GATEWAY_URL: process.env.MCP_GATEWAY_URL ?? "http://localhost:8000/mcp",
      ...envConfig // The user's Localtunnel URL from the chat overwrites the default here!
    };

    let envPlaintext = "";
    for (const [key, val] of Object.entries(finalEnv)) {
      if (val) envPlaintext += `${key}=${val}\n`;
    }
    const encryptedEnv = encryptEnvConfig(envPlaintext);

    // 4. Save the generated bot to the database
    const userId = "public-user";
    await prisma.user.upsert({
      where:  { id: userId },
      update: {},
      create: { id: userId, email: `${userId}@placeholder.agentia`, walletAddress: "" },
    });

    const configRecord = {
      generatedAt: new Date().toISOString(),
      intent: intent,
      toolsUsed: metaData.tools_used || [],
    };

    const agent = await prisma.agent.create({
      data: {
        name:          botName,
        userId,
        status:        "STOPPED",
        configuration: configRecord as any,
        envConfig:     encryptedEnv,
        files: {
          create: files.map((f: any) => ({
            filepath: f.filepath,
            // Safely convert JSON objects back to strings if the LLM didn't stringify them
            content:  typeof f.content === 'object' ? JSON.stringify(f.content, null, 2) : String(f.content),
            language: f.language || (f.filepath.endsWith(".ts") ? "typescript" : "plaintext"),
          })),
        },
      },
      include: { files: true },
    });

    // 5. Return success to the frontend chat
    return NextResponse.json({
      agentId:  agent.id,
      botName:  botName,
      files,
      thoughts: output.thoughts ?? "Bot generated successfully.",
      intent,
    });

  } catch (err) {
    console.error("[POST /api/generate-bot]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error." },
      { status: 500 }
    );
  }
}