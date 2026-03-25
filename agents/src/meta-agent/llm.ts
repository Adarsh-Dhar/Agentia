/**
 * llm.ts — Shared LLM instance (GitHub Models / gpt-4o-mini or OpenAI)
 * =====================================================================
 * Import this anywhere you need the LLM:
 *
 *   import { llm } from "./llm";
 *   const response = await llm.chatCompletion({ ... });
 *
 * Requires GITHUB_TOKEN or OPENAI_API_KEY in environment. The main entrypoint should load .env before any
 * local imports so this module always sees the correct value.
 */

import OpenAI from "openai";
import { Octokit } from "@octokit/rest";

const GITHUB_MODEL_NAME = process.env.GITHUB_MODEL_NAME || "gpt-4o-mini";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const GITHUB_LLM_OWNER = process.env.GITHUB_LLM_OWNER || "";
const GITHUB_LLM_REPO = process.env.GITHUB_LLM_REPO || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

function checkGithubEnv() {
  const missing = [];
  if (!GITHUB_TOKEN) missing.push("GITHUB_TOKEN");
  if (!GITHUB_LLM_OWNER) missing.push("GITHUB_LLM_OWNER");
  if (!GITHUB_LLM_REPO) missing.push("GITHUB_LLM_REPO");
  if (missing.length > 0) {
    throw new Error(
      `Missing required GitHub LLM environment variables: ${missing.join(", ")}.\n` +
      `Please set them in your .env file.\n` +
      `Current values: { GITHUB_TOKEN: ${GITHUB_TOKEN ? "set" : "MISSING"}, GITHUB_LLM_OWNER: ${GITHUB_LLM_OWNER ? "set" : "MISSING"}, GITHUB_LLM_REPO: ${GITHUB_LLM_REPO ? "set" : "MISSING"} }`
    );
  }
}

function checkOpenAIEnv() {
  if (!OPENAI_API_KEY) {
    throw new Error(
      "Missing required OpenAI environment variable: OPENAI_API_KEY.\n" +
      "Please set it in your .env file."
    );
  }
}
import type { ChatCompletionCreateParamsNonStreaming, ChatCompletionMessageParam } from "openai/resources/chat/completions";

interface ChatCompletionParams {
  messages: ChatCompletionMessageParam[];
  response_format: { type: "json_object" };
  temperature: number;
}

class GithubLLM {
  private octokit: Octokit;
  private model: string;
  private owner: string;
  private repo: string;

  constructor({ token, owner, repo, model }: { token: string; owner: string; repo: string; model: string }) {
    this.octokit = new Octokit({ auth: token });
    this.owner = owner;
    this.repo = repo;
    this.model = model;
  }

  async chatCompletion({ messages, response_format, temperature }: ChatCompletionParams) {
    const res = await this.octokit.request('POST /repos/{owner}/{repo}/llm/chat/completions', {
      owner: this.owner,
      repo: this.repo,
      model: this.model,
      messages,
      response_format,
      temperature
    });
    return res.data;
  }
}

class OpenAILLM {
  private openai: OpenAI;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.openai = new OpenAI({ apiKey });
    this.model = model;
  }

  async chatCompletion({ messages, response_format, temperature }: ChatCompletionParams) {
    // Ensure response_format is the correct literal type
    const response = await this.openai.chat.completions.create({
      model: this.model,
      response_format: { type: "json_object" },
      messages: messages as ChatCompletionMessageParam[],
      temperature,
    } as ChatCompletionCreateParamsNonStreaming);
    return response;
  }
}

function requireGithubLLM() {
  const missing = [];
  if (!GITHUB_TOKEN) missing.push("GITHUB_TOKEN");
  if (!GITHUB_LLM_OWNER) missing.push("GITHUB_LLM_OWNER");
  if (!GITHUB_LLM_REPO) missing.push("GITHUB_LLM_REPO");
  if (missing.length > 0) {
    throw new Error(
      `Missing required GitHub LLM environment variables: ${missing.join(", ")}.\n` +
      `Please set them in your .env file.\n` +
      `Current values: { GITHUB_TOKEN: ${GITHUB_TOKEN ? "set" : "MISSING"}, GITHUB_LLM_OWNER: ${GITHUB_LLM_OWNER ? "set" : "MISSING"}, GITHUB_LLM_REPO: ${GITHUB_LLM_REPO ? "set" : "MISSING"} }`
    );
  }
}

requireGithubLLM();
const llm = new GithubLLM({
  token: GITHUB_TOKEN,
  owner: GITHUB_LLM_OWNER,
  repo: GITHUB_LLM_REPO,
  model: GITHUB_MODEL_NAME,
});
export { llm };