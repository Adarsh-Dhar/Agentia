import { NextRequest, NextResponse } from "next/server";

const META_AGENT_URL = process.env.META_AGENT_URL ?? "http://127.0.0.1:8000";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

// 🧠 The System Prompt that turns our mini-agent into a DeFi Architect
const EXPANDER_SYSTEM_PROMPT = `You are an expert DeFi Quantitative Architect. 
Your task is to take a brief user idea for a crypto trading bot and expand it into a highly detailed, comprehensive technical specification.
Describe the execution loop (e.g., polling vs websocket), the target blockchain, the required data APIs/MCPs (e.g., Jupiter for Solana, LunarCrush for sentiment, 1inch for EVM, Nansen for whales), and the step-by-step trading logic.
Make it detailed enough so that a downstream code-generation agent understands EXACTLY what to build.
Output ONLY the expanded technical spec in plain text. Do not include markdown fences, intros, or pleasantries.`;

export async function POST(req: NextRequest) {
  console.log("Received request for intent classification");
  
  try {
    const body = await req.json();
    const originalPrompt = body.prompt;

    // 1. Validate we received a prompt
    if (!originalPrompt) {
      return NextResponse.json({ error: "Prompt is required." }, { status: 400 });
    }

    console.log("Original prompt:", originalPrompt);
    let finalPrompt = originalPrompt;

    // 2. Step 1 Agent: Expand the prompt using gpt-4o-mini via GitHub Models
    if (GITHUB_TOKEN) {
      console.log("🧠 Expanding prompt via gpt-4o-mini...");
      
      const expandRes = await fetch("https://models.inference.ai.azure.com/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${GITHUB_TOKEN}`
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: EXPANDER_SYSTEM_PROMPT },
            { role: "user", content: `Expand this bot idea into a technical spec: ${originalPrompt}` }
          ],
          temperature: 0.6,
          max_tokens: 800
        })
      });

      if (expandRes.ok) {
        const expandData = await expandRes.json();
        finalPrompt = expandData.choices[0].message.content.trim();
        console.log("✅ Expanded prompt generated:\n", finalPrompt);
      } else {
        console.warn("⚠️ Failed to expand prompt. Falling back to original. Status:", expandRes.status);
      }
    } else {
      console.warn("⚠️ No GITHUB_TOKEN found in frontend env. Skipping expansion.");
    }

    // 3. Send the EXPANDED prompt to the Python Meta-Agent for Intent Classification
    const res = await fetch(`${META_AGENT_URL}/classify-intent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: finalPrompt }),
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Failed to classify intent: ${errText}`);
    }
    
    const data = await res.json();
    
    // 4. Return both the classification data AND the expanded prompt 
    // (So your frontend can pass the expanded prompt to the code generator later!)
    return NextResponse.json({
        ...data,
        expandedPrompt: finalPrompt 
    });

  } catch (err: any) {
    console.error("[POST /api/classify-intent]", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}