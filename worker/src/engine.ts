import { spawn, exec, ChildProcess } from "child_process";
import { promisify } from "util";
import * as fs from "fs/promises";
import * as path from "path";
import prisma from "./lib/prisma.js";

const execAsync = promisify(exec);

// In-memory registry of running bot processes
const runningAgents: Map<string, ChildProcess> = new Map();

export async function startAgent(agentId: string) {
  if (runningAgents.has(agentId)) {
    throw new Error(`Agent ${agentId} is already running`);
  }

  // 1. Fetch the Agent and its code files from the DB
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    include: { files: true },
  });

  if (!agent) throw new Error(`Agent ${agentId} not found`);
  if (!agent.files || agent.files.length === 0) {
    throw new Error(`No code files found for agent ${agentId} in the database`);
  }

  // 2. Create a dedicated workspace directory for this bot
  const workspaceDir = path.join(process.cwd(), ".workspaces", agentId);
  await fs.mkdir(workspaceDir, { recursive: true });

  // 3. Write all database files to disk
  console.log(`[Agent ${agentId}] Rebuilding workspace from ${agent.files.length} file(s)...`);
  for (const file of agent.files) {
    const fullPath = path.join(workspaceDir, file.filepath);
    // Ensure nested directories (e.g. src/) exist
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, file.content, "utf-8");
    console.log(`[Agent ${agentId}]   wrote: ${file.filepath}`);
  }

  // 4. Mark as STARTING
  await prisma.agent.update({
    where: { id: agentId },
    data: { status: "STARTING" },
  });

  try {
    // 5. Install dependencies
    console.log(`[Agent ${agentId}] Running npm install...`);
    await execAsync("npm install --legacy-peer-deps", { cwd: workspaceDir });

    // 6. Build environment — inherit worker env + any agent-specific config
    const agentConfig =
      agent.configuration && typeof agent.configuration === "object"
        ? (agent.configuration as Record<string, string>)
        : {};

    const agentEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...agentConfig,
      // Pass the private session key if present
      ...(agent.sessionKeyPriv ? { SESSION_KEY_PRIV: agent.sessionKeyPriv } : {}),
    };

    // 7. Spawn the bot process
    console.log(`[Agent ${agentId}] Spawning tsx src/index.ts ...`);
    const botProcess = spawn("npx", ["tsx", "src/index.ts"], {
      cwd: workspaceDir,
      env: agentEnv,
      shell: true,
    });

    runningAgents.set(agentId, botProcess);

    await prisma.agent.update({
      where: { id: agentId },
      data: { status: "RUNNING" },
    });

    // 8. Pipe stdout / stderr
    botProcess.stdout?.on("data", (data: Buffer) => {
      console.log(`[Agent ${agentId} OUT] ${data.toString().trim()}`);
    });

    botProcess.stderr?.on("data", (data: Buffer) => {
      console.error(`[Agent ${agentId} ERR] ${data.toString().trim()}`);
    });

    // 9. Handle process exit
    botProcess.on("close", async (code) => {
      console.log(`[Agent ${agentId}] Process exited with code ${code}`);
      runningAgents.delete(agentId);

      await prisma.agent.update({
        where: { id: agentId },
        data: { status: code === 0 ? "STOPPED" : "ERROR" },
      });
    });

    return { success: true, message: "Agent started successfully" };
  } catch (error) {
    console.error(`[Agent ${agentId}] Failed to start:`, error);
    runningAgents.delete(agentId);
    await prisma.agent.update({
      where: { id: agentId },
      data: { status: "ERROR" },
    });
    throw error;
  }
}

export async function stopAgent(agentId: string) {
  const botProcess = runningAgents.get(agentId);

  if (!botProcess) {
    // Not running in memory — just sync the DB
    await prisma.agent.update({
      where: { id: agentId },
      data: { status: "STOPPED" },
    });
    return { success: true, message: "Agent was not running; marked as STOPPED." };
  }

  await prisma.agent.update({
    where: { id: agentId },
    data: { status: "STOPPING" },
  });

  botProcess.kill("SIGTERM");
  runningAgents.delete(agentId);

  await prisma.agent.update({
    where: { id: agentId },
    data: { status: "STOPPED" },
  });

  return { success: true, message: "Agent stopped successfully" };
}

export function getAgentStatus(agentId: string) {
  return { agentId, running: runningAgents.has(agentId) };
}

export function listRunningAgents() {
  return Array.from(runningAgents.keys());
}