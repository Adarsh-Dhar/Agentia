// ============================================================
// langgraph.ts — LangGraph / LangChain: Stateful Workflow Graphs
// ============================================================
//
// LangGraph is best for complex, stateful workflows where agents must
// follow specific logical paths with conditional branching and cycles.
//
// Install: pnpm install @langchain/langgraph @langchain/core @langchain/openai
// Docs: https://langchain-ai.github.io/langgraphjs/
// ============================================================

import type { AgentConfig, AgentResult, Message, ToolDefinition, WorkflowGraph } from "../types";

// ── State & Node Types ───────────────────────────────────────────────────────

export type StateReducer<S> = (current: S, update: Partial<S>) => S;

export interface GraphState {
  messages: Message[];
  currentNode: string;
  iterations: number;
  toolCallsMade: string[];
  scratchpad: Record<string, unknown>;
  finalOutput?: string;
}

export type NodeHandler<S extends GraphState = GraphState> = (
  state: S
) => Promise<Partial<S>>;

export interface GraphNodeDefinition<S extends GraphState = GraphState> {
  id: string;
  handler: NodeHandler<S>;
  /** Return node id to route to, or "__end__" to finish */
  next?: string | ((state: S) => string);
}

export interface CompiledGraph<S extends GraphState = GraphState> {
  nodes: Map<string, GraphNodeDefinition<S>>;
  entryPoint: string;
  invoke: (initialState: Partial<S>, input: string) => Promise<AgentResult>;
  stream: (initialState: Partial<S>, input: string) => AsyncGenerator<Partial<S>>;
}

// ── State Management ─────────────────────────────────────────────────────────

/**
 * Default reducer — shallow merges updates into state.
 * Replace with channel-based reducers (e.g. append for messages) as needed.
 */
export function defaultReducer<S>(current: S, update: Partial<S>): S {
  return { ...current, ...update };
}

/**
 * Append-only reducer for message arrays.
 * Use this for the `messages` channel to accumulate conversation history.
 */
export function appendReducer(current: Message[], update: Message[]): Message[] {
  return [...current, ...update];
}

// ── Graph Builder ────────────────────────────────────────────────────────────

/**
 * StateGraph builder — mirrors LangGraph's StateGraph API.
 *
 * @example
 * const graph = new StateGraph<MyState>()
 *   .addNode("plan",   planNode)
 *   .addNode("act",    actNode)
 *   .addNode("review", reviewNode)
 *   .addEdge("plan",   "act")
 *   .addConditionalEdge("act", state => state.needsReview ? "review" : "__end__")
 *   .setEntryPoint("plan")
 *   .compile();
 */
export class StateGraph<S extends GraphState = GraphState> {
  private nodes = new Map<string, GraphNodeDefinition<S>>();
  private edges = new Map<string, string | ((state: S) => string)>();
  private entry = "";
  private reducer: StateReducer<S>;

  constructor(reducer: StateReducer<S> = defaultReducer) {
    this.reducer = reducer;
  }

  addNode(id: string, handler: NodeHandler<S>): this {
    this.nodes.set(id, { id, handler });
    return this;
  }

  /** Static edge: always go from `from` to `to` */
  addEdge(from: string, to: string): this {
    this.edges.set(from, to);
    return this;
  }

  /** Conditional edge: routing function decides next node at runtime */
  addConditionalEdge(from: string, routeFn: (state: S) => string): this {
    this.edges.set(from, routeFn);
    return this;
  }

  setEntryPoint(id: string): this {
    this.entry = id;
    return this;
  }

  compile(): CompiledGraph<S> {
    if (!this.entry) throw new Error("StateGraph: entryPoint not set.");
    const nodes = this.nodes;
    const edges = this.edges;
    const entry = this.entry;
    const reducer = this.reducer;

    const buildInitial = (partial: Partial<S>, input: string): S =>
      reducer(
        {
          messages: [{ role: "user", content: input }],
          currentNode: entry,
          iterations: 0,
          toolCallsMade: [],
          scratchpad: {},
        } as unknown as S,
        partial as Partial<S>
      );

    const invoke = async (initialState: Partial<S>, input: string): Promise<AgentResult> => {
      let state = buildInitial(initialState, input);
      const MAX = 50;

      while (state.currentNode !== "__end__" && state.iterations < MAX) {
        const nodeDef = nodes.get(state.currentNode);
        if (!nodeDef) throw new Error(`Node "${state.currentNode}" not found`);

        console.log(`[LangGraph] → Node: ${state.currentNode} (iter ${state.iterations + 1})`);

        const update = await nodeDef.handler(state);
        state = reducer(state, { ...update, iterations: state.iterations + 1 } as Partial<S>);

        const routeSpec = edges.get(state.currentNode);
        if (!routeSpec) {
          state = reducer(state, { currentNode: "__end__" } as Partial<S>);
        } else if (typeof routeSpec === "string") {
          state = reducer(state, { currentNode: routeSpec } as Partial<S>);
        } else {
          state = reducer(state, { currentNode: routeSpec(state) } as Partial<S>);
        }
      }

      return {
        output: state.finalOutput ?? state.messages[state.messages.length - 1]?.content ?? "",
        messages: state.messages,
        iterations: state.iterations,
        toolCallsMade: state.toolCallsMade,
        metadata: { finalState: state.scratchpad },
      };
    };

    async function* stream(initialState: Partial<S>, input: string): AsyncGenerator<Partial<S>> {
      let state = buildInitial(initialState, input);
      const MAX = 50;

      while (state.currentNode !== "__end__" && state.iterations < MAX) {
        const nodeDef = nodes.get(state.currentNode);
        if (!nodeDef) break;

        const update = await nodeDef.handler(state);
        state = reducer(state, { ...update, iterations: state.iterations + 1 } as Partial<S>);
        yield update;

        const routeSpec = edges.get(state.currentNode);
        if (!routeSpec) {
          state = reducer(state, { currentNode: "__end__" } as Partial<S>);
        } else if (typeof routeSpec === "string") {
          state = reducer(state, { currentNode: routeSpec } as Partial<S>);
        } else {
          state = reducer(state, { currentNode: routeSpec(state) } as Partial<S>);
        }
      }
    }

    return { nodes, entryPoint: entry, invoke, stream };
  }
}

// ── Tool Node ────────────────────────────────────────────────────────────────

/**
 * Create a graph node that executes a list of tools based on the last message.
 *
 * @example
 * graph.addNode("tools", createToolNode([searchTool, calcTool]));
 */
export function createToolNode<S extends GraphState>(
  tools: ToolDefinition[]
): NodeHandler<S> {
  const toolMap = new Map(tools.map((t) => [t.name, t]));

  return async (state: S): Promise<Partial<S>> => {
    const lastMsg = state.messages[state.messages.length - 1];
    const matchedTool = tools.find((t) =>
      lastMsg.content.toLowerCase().includes(t.name.toLowerCase())
    );

    if (!matchedTool) {
      return {
        messages: [
          ...state.messages,
          { role: "assistant", content: "No matching tool found for this request." },
        ],
      } as Partial<S>;
    }

    console.log(`[LangGraph:ToolNode] Calling tool: ${matchedTool.name}`);
    const result = await matchedTool.execute({});
    const resultMsg: Message = {
      role: "tool",
      name: matchedTool.name,
      content: JSON.stringify(result),
    };

    return {
      messages: [...state.messages, resultMsg],
      toolCallsMade: [...state.toolCallsMade, matchedTool.name],
    } as Partial<S>;
  };
}

// ── Agent Node ───────────────────────────────────────────────────────────────

/**
 * Create a graph node that represents an LLM agent step.
 * In production, replace the mock LLM call with @langchain/openai ChatOpenAI.
 *
 * @example
 * graph.addNode("llm", createAgentNode({ name: "Planner", systemPrompt: "..." }));
 */
export function createAgentNode<S extends GraphState>(
  config: AgentConfig
): NodeHandler<S> {
  return async (state: S): Promise<Partial<S>> => {
    const lastUser = [...state.messages].reverse().find((m) => m.role === "user");
    const toolList = config.tools?.map((t) => `• ${t.name}: ${t.description}`).join("\n") ?? "none";

    // ── Replace with real LLM call, e.g.: ──────────────────────────────────
    // const llm = new ChatOpenAI({ model: config.model ?? "gpt-4o", temperature: config.temperature });
    // const response = await llm.invoke([new SystemMessage(config.systemPrompt), ...state.messages]);
    // const content = response.content as string;
    // ───────────────────────────────────────────────────────────────────────

    const content = `[${config.name}] Responding to: "${lastUser?.content}"\nAvailable tools:\n${toolList}`;
    console.log(`[LangGraph:AgentNode] ${config.name} produced response`);

    return {
      messages: [...state.messages, { role: "assistant", content }],
    } as Partial<S>;
  };
}

// ── Workflow Builder from Config ─────────────────────────────────────────────

/**
 * Build and compile a LangGraph workflow from a WorkflowGraph config.
 *
 * @example
 * const graph = buildWorkflowFromConfig({
 *   entryPoint: "plan",
 *   nodes: [
 *     { id: "plan",   agent: plannerConfig, next: "act" },
 *     { id: "act",    agent: actorConfig,   next: "__end__" },
 *   ],
 * });
 * const result = await graph.invoke({}, "Analyze this market");
 */
export function buildWorkflowFromConfig(workflow: WorkflowGraph): CompiledGraph {
  const graph = new StateGraph<GraphState>();
  graph.setEntryPoint(workflow.entryPoint);

  for (const node of workflow.nodes) {
    graph.addNode(node.id, createAgentNode(node.agent));
    if (node.next) {
      if (typeof node.next === "string") {
        graph.addEdge(node.id, node.next);
      } else {
        // node.next is a function of AgentResult — adapt to GraphState
        graph.addConditionalEdge(node.id, (state: GraphState) => {
          const mockResult: AgentResult = {
            output: state.finalOutput ?? "",
            messages: state.messages,
            iterations: state.iterations,
            toolCallsMade: state.toolCallsMade,
          };
          return (node.next as (r: AgentResult) => string)(mockResult);
        });
      }
    }
  }

  return graph.compile();
}

// ── Example Usage ────────────────────────────────────────────────────────────

/*
import { StateGraph, createAgentNode, createToolNode } from "./langgraph";

interface MyState extends GraphState {
  plan?: string;
}

const searchTool: ToolDefinition = {
  name: "web_search",
  description: "Search the web",
  parameters: { properties: { query: { type: "string" } } },
  execute: async ({ query }) => ({ results: [`Result for: ${query}`] }),
};

const graph = new StateGraph<MyState>()
  .addNode("planner",  createAgentNode({ name: "Planner",  systemPrompt: "Create a step-by-step plan." }))
  .addNode("tools",    createToolNode([searchTool]))
  .addNode("reviewer", createAgentNode({ name: "Reviewer", systemPrompt: "Review and summarize." }))
  .addEdge("planner",  "tools")
  .addEdge("tools",    "reviewer")
  .addEdge("reviewer", "__end__")
  .setEntryPoint("planner")
  .compile();

const result = await graph.invoke({}, "Research the latest LLM benchmarks");
console.log(result.output);
*/