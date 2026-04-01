import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { encryptEnvConfig } from "@/lib/crypto-env";
import fs from "node:fs";
import path from "node:path";

const META_AGENT_URL = process.env.META_AGENT_URL ?? "http://127.0.0.1:8000";
const HEALTH_TIMEOUT_MS = Number(process.env.META_AGENT_HEALTH_TIMEOUT_MS ?? "2000");
const HEALTH_RETRIES = Number(process.env.META_AGENT_HEALTH_RETRIES ?? "2");
const META_TIMEOUT_MS = Number(process.env.META_AGENT_GENERATE_TIMEOUT_MS ?? "600000");
const META_RETRIES = Number(process.env.META_AGENT_GENERATE_RETRIES ?? "1");
const MAX_META_PROMPT_CHARS = Number(process.env.MAX_META_PROMPT_CHARS ?? "2800");

function compactPromptForMetaAgent(input: string): string {
  const normalized = input.replace(/\r/g, "").trim();
  if (normalized.length <= MAX_META_PROMPT_CHARS) return normalized;

  const head = Math.floor(MAX_META_PROMPT_CHARS * 0.7);
  const tail = Math.max(300, MAX_META_PROMPT_CHARS - head - 64);
  return `${normalized.slice(0, head)}\n\n[...truncated for model limit...]\n\n${normalized.slice(-tail)}`;
}

function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const commentIndex = value.indexOf(" #");
    if (commentIndex >= 0) value = value.slice(0, commentIndex).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

function loadAgentEnvDefaults(): Record<string, string> {
  try {
    const envPath = path.resolve(process.cwd(), "../agents/.env");
    const envText = fs.readFileSync(envPath, "utf8");
    return parseEnvText(envText);
  } catch {
    return {};
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function POST(req: NextRequest) {
  console.log("[generate-bot] Received request");
  try {
    const body = await req.json();
    console.log("[generate-bot] Body keys:", Object.keys(body));

    // Accept both `prompt` (original) and `expandedPrompt` (pre-expanded by classify-intent).
    // Always prefer the expanded prompt — it gives the meta-agent far more context.
    const expandedPrompt: string = body.expandedPrompt || body.prompt;
    const originalPrompt: string = body.prompt || expandedPrompt;
    const boundedPrompt = compactPromptForMetaAgent(expandedPrompt || originalPrompt || "");
    const envDefaults = loadAgentEnvDefaults();
    const envConfig: Record<string, string> = {
      ...envDefaults,
      ...(body.envConfig || {}),
    };

    if (!boundedPrompt?.trim()) {
      return NextResponse.json({ error: "Prompt is required." }, { status: 400 });
    }

    console.log("[generate-bot] Using prompt length:", boundedPrompt.length, "chars");
    if (boundedPrompt.length > 200) {
      console.log("[generate-bot] Prompt preview:", boundedPrompt.slice(0, 300), "...");
    }

    // Fast preflight: verify Meta-Agent is reachable before a long generation call.
    // Retry a few times to absorb transient startup/busy spikes.
    let healthOk = false;
    let lastHealthError = "unknown error";
    for (let attempt = 1; attempt <= HEALTH_RETRIES + 1; attempt += 1) {
      const healthController = new AbortController();
      const healthTimer = setTimeout(() => healthController.abort(), HEALTH_TIMEOUT_MS);
      try {
        const healthRes = await fetch(`${META_AGENT_URL}/health`, {
          method: "GET",
          headers: { accept: "application/json" },
          signal: healthController.signal,
        });
        clearTimeout(healthTimer);

        if (healthRes.ok) {
          healthOk = true;
          break;
        }

        const healthText = await healthRes.text().catch(() => "");
        lastHealthError = `health ${healthRes.status}: ${healthText.slice(0, 200)}`;
      } catch (healthErr: unknown) {
        clearTimeout(healthTimer);
        const msg = healthErr instanceof Error ? healthErr.message : String(healthErr);
        const isAbort = healthErr instanceof DOMException && healthErr.name === "AbortError";
        lastHealthError = isAbort ? "health check timed out" : msg;
      }

      if (attempt <= HEALTH_RETRIES) {
        await delay(400 * attempt);
      }
    }

    if (!healthOk) {
      return NextResponse.json(
        {
          error:
            `Meta-Agent is unavailable (${lastHealthError}) at ${META_AGENT_URL}. ` +
            "Please ensure it is running: cd agents && uvicorn main:app --reload --port 8000",
        },
        { status: 503 }
      );
    }

    // ── Call the Python Universal Meta-Agent ──────────────────────────────
    // We send the EXPANDED prompt so the code-generator has full context.
    // Retry once on timeout/temporary connectivity issue.

    let metaData: {
      output: { files?: Array<{ filepath: string; content: unknown; language?: string }>; thoughts?: string };
      intent: Record<string, unknown>;
      tools_used?: string[];
    };

    let lastMetaError = "unknown error";
    let lastMetaStatus = 500;
    for (let attempt = 1; attempt <= META_RETRIES + 1; attempt += 1) {
      const metaController = new AbortController();
      const metaTimer = setTimeout(() => metaController.abort(), META_TIMEOUT_MS);
      try {
        const metaResponse = await fetch(`${META_AGENT_URL}/create-bot`, {
          method: "POST",
          headers: { "Content-Type": "application/json", accept: "application/json" },
          body: JSON.stringify({ prompt: boundedPrompt }),
          signal: metaController.signal,
        });

        clearTimeout(metaTimer);

        if (!metaResponse.ok) {
          const errText = await metaResponse.text().catch(() => "");
          lastMetaError = `Meta-Agent HTTP ${metaResponse.status}: ${errText.slice(0, 300)}`;
          lastMetaStatus = metaResponse.status;
        } else {
          metaData = await metaResponse.json();
          break;
        }
      } catch (fetchErr: unknown) {
        clearTimeout(metaTimer);
        const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
        const isAbort = fetchErr instanceof DOMException && fetchErr.name === "AbortError";
        lastMetaError = msg;

        if (isAbort || msg.toLowerCase().includes("abort")) {
          lastMetaStatus = 504;
        } else if (msg.includes("fetch failed") || msg.includes("ECONNREFUSED")) {
          lastMetaStatus = 503;
        } else {
          lastMetaStatus = 500;
        }
      }

      if (attempt <= META_RETRIES) {
        await delay(750 * attempt);
      }
    }

    if (!metaData) {
      if (lastMetaStatus === 504) {
        return NextResponse.json(
          {
            error:
              `Meta-Agent request timed out at ${META_AGENT_URL}/create-bot. ` +
              "The server may be busy or blocked by a slow MCP/tool discovery call. " +
              "Try again after ensuring only one healthy Meta-Agent instance is running.",
          },
          { status: 504 }
        );
      }

      if (lastMetaStatus === 503 || lastMetaError.includes("fetch failed") || lastMetaError.includes("ECONNREFUSED")) {
        return NextResponse.json(
          {
            error: `Cannot reach the Python Meta-Agent at ${META_AGENT_URL}. ` +
              "Please ensure it is running: cd agents && uvicorn main:app --reload --port 8000",
          },
          { status: 503 }
        );
      }

      return NextResponse.json({ error: lastMetaError }, { status: 500 });
    }


    console.log("[generate-bot] Received meta-agent response");
    // Fallback to metaData itself if the agent returned a flat structure
    const output = metaData.output || metaData;
    const intent = metaData.intent || {};
    const botName: string = (intent.bot_type as string) || "Universal DeFi Bot";

    // Extract files safely from varying model response shapes
    const filesList = output.files || (metaData as any).files || [];
    const normalizedFiles = (Array.isArray(filesList) ? filesList : [])
      .map((raw: any, idx: number) => {
        const filepath =
          (typeof raw?.filepath === "string" && raw.filepath.trim()) ||
          (typeof raw?.path === "string" && raw.path.trim()) ||
          (typeof raw?.filename === "string" && raw.filename.trim()) ||
          `generated_${idx + 1}.txt`;

        const content = raw?.content ?? raw?.code ?? raw?.text ?? "";
        const language = typeof raw?.language === "string" ? raw.language : undefined;

        return { filepath, content, language };
      })
      .filter((f: { filepath: string }) => ![".env", ".env.example"].includes(f.filepath));

    const files = normalizedFiles;

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
            filepath: typeof f.filepath === "string" && f.filepath.trim()
              ? f.filepath
              : "generated.txt",
            content:
              typeof f.content === "object"
                ? JSON.stringify(f.content, null, 2)
                : String(f.content),
            language: (() => {
              const fp = typeof f.filepath === "string" ? f.filepath : "";
              return (
                f.language ??
                (fp.endsWith(".ts") ? "typescript"
                  : fp.endsWith(".py") ? "python"
                  : fp.endsWith(".json") ? "json"
                  : "plaintext")
              );
            })(),
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