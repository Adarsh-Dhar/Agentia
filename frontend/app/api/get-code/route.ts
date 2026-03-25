import { NextResponse } from "next/server";
import OpenAI from "openai";

// Reuse your Universal LLM logic here
const apiKey = process.env.GITHUB_TOKEN || process.env.OPENAI_API_KEY;
const baseURL = process.env.GITHUB_TOKEN ? "https://models.inference.ai.azure.com" : undefined;
const model = process.env.GITHUB_TOKEN ? "gpt-4o" : "gpt-4o-mini";

const openai = new OpenAI({ apiKey, baseURL });

export async function POST(req: Request) {
  try {
    const { intent, mcpSnippets = [] } = await req.json();

    const prompt = `
      You are the Meta-Agent. Generate a complete Node.js project.
      USER INTENT: "${intent}"
      MCP SNIPPETS: ${JSON.stringify(mcpSnippets)}

      Respond STRICTLY in JSON matching this schema:
      {
        "thoughts": "String explaining architecture",
        "files": [ { "filepath": "package.json", "content": "..." } ]
      }
    `;

    const response = await openai.chat.completions.create({
      model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You output valid JSON projects." },
        { role: "user", content: prompt }
      ],
      temperature: 0.2,
    });

    const rawContent = response.choices[0].message.content || "{}";
    const parsedData = JSON.parse(rawContent);

    return NextResponse.json(parsedData);
  } catch (error) {
    console.error("[get-code] Error:", error);
    return NextResponse.json({ error: "Failed to generate code" }, { status: 500 });
  }
}
