import { NextResponse } from "next/server";
import { getSystemPrompt } from "./prompts/prompt";

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const userIntent: string = body.intent ?? "Build a flash loan arbitrageur for Arbitrum Sepolia testnet.";

    console.log("[get-code] Generating bot for intent:", userIntent);

    const systemPrompt = getSystemPrompt("OnchainForge");

    // 👇 CHANGED: Using GitHub Models Endpoint and your GitHub Token
    const response = await fetch("https://models.inference.ai.azure.com/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Ensure GITHUB_TOKEN is in your frontend/.env file
        "Authorization": `Bearer ${process.env.GITHUB_TOKEN}` 
      },
      body: JSON.stringify({
        model: "gpt-4o", // Or whichever specific model you are targeting on GitHub Models (e.g., "Meta-Llama-3.1-70B-Instruct")
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userIntent }
        ],
        response_format: { type: "json_object" },
        temperature: 0.2
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`GitHub Models API Failed: ${response.status} ${errorText}`);
    }
    console.log("[get-code] Raw LLM response:", response)
    const data = await response.json();
    console.log("[get-code] Raw LLM data:", data);
    const aiMessage = data.choices[0].message.content;
    console.log("[get-code] LLM message content:", aiMessage);

    const parsedResponse = JSON.parse(aiMessage);

    if (!parsedResponse.files || !Array.isArray(parsedResponse.files)) {
      throw new Error("LLM did not return a valid 'files' array in the JSON response.");
    }

    console.log(`[get-code] Successfully generated ${parsedResponse.files.length} files.`);

    return NextResponse.json({ 
      thoughts: parsedResponse.thoughts,
      files: parsedResponse.files 
    });

  } catch (err: any) {
    console.error("[get-code] Error:", err);
    return NextResponse.json(
      { error: "Failed to generate bot", details: err.message },
      { status: 500 }
    );
  }
}