import { spawn, exec, ChildProcess } from "child_process";
import { promisify } from "util";
import * as fs from "fs/promises";
import * as path from "path";
import prisma from "./lib/prisma.js";

const execAsync = promisify(exec);

// ── In-memory state ───────────────────────────────────────────────────────────

const runningAgents: Map<string, ChildProcess> = new Map();

// Circular log buffer — keeps last 500 lines per agent
const MAX_LOG_LINES = 500;

interface LogEntry {
  line:  string;
  level: "stdout" | "stderr";
  ts:    number; // epoch ms
}

const agentLogs: Map<string, LogEntry[]> = new Map();

function appendLog(agentId: string, line: string, level: "stdout" | "stderr") {
  if (!agentLogs.has(agentId)) agentLogs.set(agentId, []);
  const buf = agentLogs.get(agentId)!;
  buf.push({ line, level, ts: Date.now() });
  if (buf.length > MAX_LOG_LINES) buf.splice(0, buf.length - MAX_LOG_LINES);
}

/** Returns log entries for an agent, optionally filtering to entries after `since` (epoch ms). */
export function getAgentLogs(agentId: string, since?: number): LogEntry[] {
  const buf = agentLogs.get(agentId) ?? [];
  return since ? buf.filter((e) => e.ts > since) : [...buf];
}

export function clearAgentLogs(agentId: string) {
  agentLogs.delete(agentId);
}

// ── Core operations ───────────────────────────────────────────────────────────

export async function startAgent(agentId: string) {
  if (runningAgents.has(agentId)) {
    throw new Error(`Agent ${agentId} is already running`);
  }

  // Fetch agent + files from DB
  const agent = await prisma.agent.findUnique({
    where:   { id: agentId },
    include: { files: true },
  });

  if (!agent) throw new Error(`Agent ${agentId} not found`);
  if (!agent.files || agent.files.length === 0) {
    throw new Error(`No code files found for agent ${agentId} in the database`);
  }

  // Build workspace
  const workspaceDir = path.join(process.cwd(), ".workspaces", agentId);
  await fs.mkdir(workspaceDir, { recursive: true });

  appendLog(agentId, `Rebuilding workspace from ${agent.files.length} file(s)...`, "stdout");

  for (const file of agent.files) {
    const fullPath = path.join(workspaceDir, file.filepath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, file.content, "utf-8");
    appendLog(agentId, `  wrote: ${file.filepath}`, "stdout");
  }

  await prisma.agent.update({
    where: { id: agentId },
    data:  { status: "STARTING" },
  });

  try {
    appendLog(agentId, "Running npm install...", "stdout");
    await execAsync("npm install --legacy-peer-deps", { cwd: workspaceDir });
    appendLog(agentId, "npm install complete.", "stdout");

    const agentConfig =
      agent.configuration && typeof agent.configuration === "object"
        ? (agent.configuration as Record<string, string>)
        : {};

    const agentEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...agentConfig,
      ...(agent.sessionKeyPriv ? { SESSION_KEY_PRIV: agent.sessionKeyPriv } : {}),
    };

    appendLog(agentId, "Spawning tsx src/index.ts...", "stdout");

    const botProcess = spawn("npx", ["tsx", "src/index.ts"], {
      cwd:   workspaceDir,
      env:   agentEnv,
      shell: true,
    });

    runningAgents.set(agentId, botProcess);

    await prisma.agent.update({
      where: { id: agentId },
      data:  { status: "RUNNING" },
    });

    appendLog(agentId, "Agent RUNNING.", "stdout");

    botProcess.stdout?.on("data", (data: Buffer) => {
      const text = data.toString().trimEnd();
      console.log(`[Agent ${agentId} OUT] ${text}`);
      for (const line of text.split("\n")) {
        if (line.trim()) appendLog(agentId, line, "stdout");
      }
    });

    botProcess.stderr?.on("data", (data: Buffer) => {
      const text = data.toString().trimEnd();
      console.error(`[Agent ${agentId} ERR] ${text}`);
      for (const line of text.split("\n")) {
        if (line.trim()) appendLog(agentId, line, "stderr");
      }
    });

    botProcess.on("close", async (code) => {
      const msg = `Process exited with code ${code}`;
      appendLog(agentId, msg, code === 0 ? "stdout" : "stderr");
      runningAgents.delete(agentId);

      try {
        await prisma.agent.update({
          where: { id: agentId },
          data:  { status: code === 0 ? "STOPPED" : "ERROR" },
        });
      } catch { /* agent may have been deleted */ }
    });

    return { success: true, message: "Agent started successfully" };

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    appendLog(agentId, `Failed to start: ${msg}`, "stderr");
    runningAgents.delete(agentId);
    await prisma.agent.update({
      where: { id: agentId },
      data:  { status: "ERROR" },
    });
    throw error;
  }
}

export async function stopAgent(agentId: string) {
  const botProcess = runningAgents.get(agentId);

  if (!botProcess) {
    await prisma.agent.update({
      where: { id: agentId },
      data:  { status: "STOPPED" },
    });
    return { success: true, message: "Agent was not running; marked as STOPPED." };
  }

  await prisma.agent.update({
    where: { id: agentId },
    data:  { status: "STOPPING" },
  });

  appendLog(agentId, "SIGTERM sent — stopping agent...", "stdout");
  botProcess.kill("SIGTERM");
  runningAgents.delete(agentId);

  await prisma.agent.update({
    where: { id: agentId },
    data:  { status: "STOPPED" },
  });

  appendLog(agentId, "Agent STOPPED.", "stdout");
  return { success: true, message: "Agent stopped successfully" };
}

export function getAgentStatus(agentId: string) {
  return { agentId, running: runningAgents.has(agentId) };
}

export function listRunningAgents() {
  return Array.from(runningAgents.keys());
}