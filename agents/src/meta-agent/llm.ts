/**
 * llm.ts — Shared LLM instance
 * =====================================================================
 * Uses GitHub Models (via Azure inference) if GITHUB_TOKEN is present,
 * otherwise falls back to standard OpenAI if OPENAI_API_KEY is present.
 */

import OpenAI from "openai";
import type { ChatCompletionCreateParamsNonStreaming, ChatCompletionMessageParam } from "openai/resources/chat/completions";


const GITHUB_MODEL_NAME = process.env.GITHUB_MODEL_NAME || "gpt-4o";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";

interface ChatCompletionParams {
  messages: ChatCompletionMessageParam[];
  response_format: { type: "json_object" };
  temperature: number;
}

class UniversalLLM {
  private client: OpenAI;
  private model: string;

  constructor() {
    if (!GITHUB_TOKEN) {
      throw new Error(
        "Missing GITHUB_TOKEN. Please set GITHUB_TOKEN in your .env file."
      );
    }
    // GitHub Models API is fully compatible with the OpenAI SDK!
    // We just point it to the Azure endpoint.
    this.client = new OpenAI({
      baseURL: "https://models.inference.ai.azure.com",
      apiKey: GITHUB_TOKEN,
    });
    this.model = GITHUB_MODEL_NAME;
    console.log(`[LLM] Connected via GitHub Models (${this.model})`);
  }

  async chatCompletion({ messages, response_format, temperature }: ChatCompletionParams) {
    const response = await this.client.chat.completions.create({
      model: this.model,
      response_format,
      messages,
      temperature,
    } as ChatCompletionCreateParamsNonStreaming);
    
    return response;
  }
}

export const llm = new UniversalLLM();