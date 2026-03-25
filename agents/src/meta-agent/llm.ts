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
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

interface ChatCompletionParams {
  messages: ChatCompletionMessageParam[];
  response_format: { type: "json_object" };
  temperature: number;
}

class UniversalLLM {
  private client: OpenAI;
  private model: string;

  constructor() {
    if (GITHUB_TOKEN) {
      // GitHub Models API is fully compatible with the OpenAI SDK!
      // We just point it to the Azure endpoint.
      this.client = new OpenAI({
        baseURL: "https://models.inference.ai.azure.com",
        apiKey: GITHUB_TOKEN,
      });
      this.model = GITHUB_MODEL_NAME;
      console.log(`[LLM] Connected via GitHub Models (${this.model})`);
    } else if (OPENAI_API_KEY) {
      // Fallback to standard OpenAI
      this.client = new OpenAI({
        apiKey: OPENAI_API_KEY,
      });
      this.model = process.env.OPENAI_MODEL_NAME || "gpt-4o";
      console.log(`[LLM] Connected via OpenAI (${this.model})`);
    } else {
      throw new Error(
        "Missing LLM API keys. Please set GITHUB_TOKEN or OPENAI_API_KEY in your .env file."
      );
    }
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