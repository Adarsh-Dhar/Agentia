// ============================================================
// crewai.ts — CrewAI: Role-Based Multi-Agent Teams
// ============================================================
//
// CrewAI is ideal for role-based multi-agent teams: one agent researches,
// another writes, another trades — each with a clear role and goal.
//
// Install: pip install crewai crewai-tools  (Python SDK)
//          This file provides an idiomatic TypeScript implementation
//          of the CrewAI pattern.
// Docs: https://docs.crewai.com/
// ============================================================

import type { AgentConfig, AgentResult, Message, ToolDefinition } from "../types";

// ── Core Types ───────────────────────────────────────────────────────────────

export type ProcessMode = "sequential" | "hierarchical" | "parallel";

export interface CrewAgentOptions {
  role: string;             // e.g. "Senior Research Analyst"
  goal: string;             // e.g. "Find accurate, up-to-date information"
  backstory: string;        // narrative context for the LLM
  tools?: ToolDefinition[];
  model?: string;
  allowDelegation?: boolean;
  verbose?: boolean;
  maxIterations?: number;
}

export interface TaskOptions {
  description: string;      // what needs to be done
  expectedOutput: string;   // what a good result looks like
  agent?: CrewAgent;        // if omitted, the crew assigns automatically
  context?: Task[];         // outputs of these tasks feed into this one
  outputFile?: string;      // write result to this path (optional)
}

export interface CrewOptions {
  agents: CrewAgent[];
  tasks: Task[];
  process?: ProcessMode;
  verbose?: boolean;
  managerAgent?: CrewAgent; // required for hierarchical process
  maxRpm?: number;          // max requests per minute
}

export interface CrewResult {
  finalOutput: string;
  taskOutputs: TaskOutput[];
  agentResult: AgentResult;
}

export interface TaskOutput {
  task: string;
  agent: string;
  output: string;
  duration: number;
}

// ── CrewAgent ────────────────────────────────────────────────────────────────

/**
 * A role-based agent in a CrewAI crew.
 *
 * @example
 * const researcher = new CrewAgent({
 *   role: "Senior Research Analyst",
 *   goal: "Uncover cutting-edge developments in AI",
 *   backstory: "You work at a leading AI think tank...",
 *   tools: [searchTool, scraperTool],
 * });
 */
export class CrewAgent {
  readonly role: string;
  readonly goal: string;
  readonly backstory: string;
  readonly tools: ToolDefinition[];
  readonly model: string;
  readonly allowDelegation: boolean;
  readonly verbose: boolean;
  readonly maxIterations: number;

  private executionLog: string[] = [];

  constructor(options: CrewAgentOptions) {
    this.role = options.role;
    this.goal = options.goal;
    this.backstory = options.backstory;
    this.tools = options.tools ?? [];
    this.model = options.model ?? "gpt-4o";
    this.allowDelegation = options.allowDelegation ?? false;
    this.verbose = options.verbose ?? false;
    this.maxIterations = options.maxIterations ?? 5;
  }

  get name(): string {
    return this.role;
  }

  /**
   * Execute a task and return the output string.
   * Replace the mock implementation with a real LLM call.
   */
  async executeTask(task: Task, contextOutputs: TaskOutput[] = []): Promise<string> {
    const contextStr = contextOutputs.length
      ? `\n\nContext from prior tasks:\n${contextOutputs.map((c) => `- ${c.task}: ${c.output.slice(0, 200)}`).join("\n")}`
      : "";

    const systemPrompt = [
      `You are: ${this.role}`,
      `Your goal: ${this.goal}`,
      `Backstory: ${this.backstory}`,
      `Available tools: ${this.tools.map((t) => `${t.name} — ${t.description}`).join("; ") || "none"}`,
    ].join("\n");

    const userPrompt = [
      `Task: ${task.description}`,
      `Expected output: ${task.expectedOutput}`,
      contextStr,
    ].join("\n");

    if (this.verbose) {
      console.log(`\n[CrewAI:${this.role}]`);
      console.log(`  Task: ${task.description}`);
    }

    // ── Replace with real LLM call ──────────────────────────────────────────
    // const llm = new ChatOpenAI({ model: this.model });
    // const result = await llm.invoke([
    //   new SystemMessage(systemPrompt),
    //   new HumanMessage(userPrompt),
    // ]);
    // const output = result.content as string;
    // ───────────────────────────────────────────────────────────────────────

    // Tool execution (simplified)
    let toolResults = "";
    for (const tool of this.tools) {
      if (task.description.toLowerCase().includes(tool.name.toLowerCase())) {
        try {
          const result = await tool.execute({ query: task.description });
          toolResults += `\nTool "${tool.name}" result: ${JSON.stringify(result)}`;
          this.executionLog.push(`Used tool: ${tool.name}`);
        } catch (err) {
          console.warn(`[CrewAI:${this.role}] Tool ${tool.name} failed:`, err);
        }
      }
    }

    const output =
      `[${this.role}] Completed task: "${task.description.slice(0, 60)}..."` +
      (toolResults ? `\n${toolResults}` : "") +
      `\n→ ${task.expectedOutput}`;

    if (this.verbose) console.log(`  Output: ${output.slice(0, 120)}...`);

    this.executionLog.push(`Executed: ${task.description}`);
    return output;
  }

  getLog(): string[] {
    return [...this.executionLog];
  }
}

// ── Task ─────────────────────────────────────────────────────────────────────

/**
 * A discrete unit of work to be executed by a CrewAgent.
 *
 * @example
 * const researchTask = new Task({
 *   description: "Research the top 5 LLM frameworks in 2025.",
 *   expectedOutput: "A bullet-point summary with sources.",
 *   agent: researcher,
 * });
 */
export class Task {
  readonly description: string;
  readonly expectedOutput: string;
  readonly agent?: CrewAgent;
  readonly context: Task[];
  readonly outputFile?: string;

  output?: string;

  constructor(options: TaskOptions) {
    this.description = options.description;
    this.expectedOutput = options.expectedOutput;
    this.agent = options.agent;
    this.context = options.context ?? [];
    this.outputFile = options.outputFile;
  }
}

// ── Crew ─────────────────────────────────────────────────────────────────────

/**
 * Orchestrates a team of CrewAgents to complete a set of Tasks.
 *
 * @example
 * const crew = new Crew({
 *   agents: [researcher, writer],
 *   tasks:  [researchTask, writeTask],
 *   process: "sequential",
 *   verbose: true,
 * });
 * const result = await crew.kickoff();
 * console.log(result.finalOutput);
 */
export class Crew {
  private agents: CrewAgent[];
  private tasks: Task[];
  private process: ProcessMode;
  private verbose: boolean;
  private managerAgent?: CrewAgent;

  constructor(options: CrewOptions) {
    this.agents = options.agents;
    this.tasks = options.tasks;
    this.process = options.process ?? "sequential";
    this.verbose = options.verbose ?? false;
    this.managerAgent = options.managerAgent;
  }

  /**
   * Start the crew — analogous to `crew.kickoff()` in Python CrewAI.
   */
  async kickoff(inputs?: Record<string, string>): Promise<CrewResult> {
    console.log(`\n[CrewAI] 🚀 Crew kickoff — process: ${this.process}`);
    if (inputs) {
      console.log(`[CrewAI] Inputs: ${JSON.stringify(inputs)}`);
      // interpolate inputs into task descriptions
      for (const task of this.tasks) {
        (task as { description: string }).description = interpolate(task.description, inputs);
      }
    }

    const taskOutputs: TaskOutput[] = [];
    const messages: Message[] = [];
    const toolCallsMade: string[] = [];

    switch (this.process) {
      case "sequential":
        await this.runSequential(taskOutputs, messages, toolCallsMade);
        break;
      case "hierarchical":
        await this.runHierarchical(taskOutputs, messages, toolCallsMade);
        break;
      case "parallel":
        await this.runParallel(taskOutputs, messages, toolCallsMade);
        break;
    }

    const finalOutput = taskOutputs[taskOutputs.length - 1]?.output ?? "";

    if (this.verbose) {
      console.log("\n[CrewAI] ✅ Crew finished");
      console.log(`[CrewAI] Final output: ${finalOutput.slice(0, 200)}...`);
    }

    return {
      finalOutput,
      taskOutputs,
      agentResult: {
        output: finalOutput,
        messages,
        iterations: taskOutputs.length,
        toolCallsMade,
        metadata: { process: this.process, taskOutputs },
      },
    };
  }

  // ── Process implementations ────────────────────────────────────────────────

  private async runSequential(
    taskOutputs: TaskOutput[],
    messages: Message[],
    toolCallsMade: string[]
  ): Promise<void> {
    for (const task of this.tasks) {
      const agent = task.agent ?? this.autoAssign(task);
      const contextOutputs = task.context.map((t) =>
        taskOutputs.find((o) => o.task === t.description)
      ).filter(Boolean) as TaskOutput[];

      const start = Date.now();
      const output = await agent.executeTask(task, contextOutputs);
      const duration = Date.now() - start;

      task.output = output;
      taskOutputs.push({ task: task.description, agent: agent.name, output, duration });
      messages.push({ role: "assistant", name: agent.name, content: output });
      toolCallsMade.push(...agent.getLog().filter((l) => l.startsWith("Used tool:")));
    }
  }

  private async runParallel(
    taskOutputs: TaskOutput[],
    messages: Message[],
    toolCallsMade: string[]
  ): Promise<void> {
    const results = await Promise.all(
      this.tasks.map(async (task) => {
        const agent = task.agent ?? this.autoAssign(task);
        const start = Date.now();
        const output = await agent.executeTask(task, []);
        return { task: task.description, agent: agent.name, output, duration: Date.now() - start };
      })
    );
    taskOutputs.push(...results);
    results.forEach((r) => messages.push({ role: "assistant", name: r.agent, content: r.output }));
  }

  private async runHierarchical(
    taskOutputs: TaskOutput[],
    messages: Message[],
    toolCallsMade: string[]
  ): Promise<void> {
    const manager = this.managerAgent ?? this.agents[0];
    console.log(`[CrewAI:Hierarchical] Manager: ${manager.name}`);

    // Manager decomposes, then delegates sequentially (simplified)
    for (const task of this.tasks) {
      const delegatedAgent = this.autoAssign(task);
      console.log(`[CrewAI:Hierarchical] ${manager.name} → delegating to ${delegatedAgent.name}`);
      const start = Date.now();
      const output = await delegatedAgent.executeTask(task, taskOutputs);
      taskOutputs.push({ task: task.description, agent: delegatedAgent.name, output, duration: Date.now() - start });
      messages.push({ role: "assistant", name: delegatedAgent.name, content: output });
    }
  }

  private autoAssign(task: Task): CrewAgent {
    // Simple heuristic: pick the agent whose role best matches the task keywords
    const scored = this.agents.map((agent) => {
      const roleWords = agent.role.toLowerCase().split(/\s+/);
      const score = roleWords.filter((w) => task.description.toLowerCase().includes(w)).length;
      return { agent, score };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored[0]?.agent ?? this.agents[0];
  }
}

// ── Utilities ────────────────────────────────────────────────────────────────

function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`);
}

/**
 * Quick-create a crew from a simple config object.
 *
 * @example
 * const crew = createCrew([
 *   { role: "Researcher", goal: "Find info", backstory: "...", tools: [searchTool] },
 *   { role: "Writer",     goal: "Write report", backstory: "..." },
 * ], [
 *   { description: "Research {topic}", expectedOutput: "Bullet summary" },
 *   { description: "Write a report on the research", expectedOutput: "500-word report" },
 * ], "sequential");
 * const result = await crew.kickoff({ topic: "quantum computing" });
 */
export function createCrew(
  agentDefs: CrewAgentOptions[],
  taskDefs: Omit<TaskOptions, "agent">[],
  process: ProcessMode = "sequential",
  verbose = false
): Crew {
  const agents = agentDefs.map((def) => new CrewAgent({ ...def, verbose }));
  const tasks = taskDefs.map((def, i) => new Task({ ...def, agent: agents[i % agents.length] }));
  return new Crew({ agents, tasks, process, verbose });
}

// ── Example Usage ────────────────────────────────────────────────────────────

/*
import { CrewAgent, Task, Crew } from "./crewai";

const searchTool: ToolDefinition = {
  name: "web_search",
  description: "Search the web for information",
  parameters: { properties: { query: { type: "string" } } },
  execute: async ({ query }) => ({ results: [`Top result for: ${query}`] }),
};

const researcher = new CrewAgent({
  role: "Senior Research Analyst",
  goal: "Find accurate, up-to-date information on any topic",
  backstory: "You work at a leading AI think tank with access to cutting-edge tools.",
  tools: [searchTool],
  verbose: true,
});

const writer = new CrewAgent({
  role: "Tech Content Strategist",
  goal: "Craft engaging, easy-to-understand reports",
  backstory: "You have written for Forbes, Wired, and MIT Tech Review.",
  verbose: true,
});

const researchTask = new Task({
  description: "Research the current state of {topic} and its main players.",
  expectedOutput: "A bullet-point summary with 5-7 key insights and sources.",
  agent: researcher,
});

const writeTask = new Task({
  description: "Write a concise 3-paragraph report based on the research.",
  expectedOutput: "A polished, publication-ready report with a clear narrative.",
  agent: writer,
  context: [researchTask],
});

const crew = new Crew({
  agents: [researcher, writer],
  tasks: [researchTask, writeTask],
  process: "sequential",
  verbose: true,
});

const result = await crew.kickoff({ topic: "agentic AI frameworks" });
console.log(result.finalOutput);
*/