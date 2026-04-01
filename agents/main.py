"""
agents/main.py

FastAPI server — the Meta-Agent API.
Start with: uvicorn main:app --reload
"""

import os
import socket
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from orchestrator import MetaAgentBuilder

builder = MetaAgentBuilder()


def _is_port_bound(host: str, port: int) -> bool:
    """Return True if another process is already listening on host:port."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.2)
        return sock.connect_ex((host, port)) == 0


@asynccontextmanager
async def lifespan(app: FastAPI):
    if not os.environ.get("GITHUB_TOKEN"):
        raise RuntimeError("GITHUB_TOKEN environment variable is missing.")

    # Fail fast before expensive MCP bootstrap if the target port is already in use.
    host = os.environ.get("META_AGENT_HOST", "127.0.0.1")
    port = int(os.environ.get("META_AGENT_PORT", "8000"))
    if _is_port_bound(host, port):
        raise RuntimeError(
            f"Meta-Agent already running on {host}:{port}. "
            f"Stop the existing process before starting a new instance."
        )

    # Block startup until MCP servers are connected (or explicitly failed/skipped).
    await builder.setup_environment()
    yield

    print("Shutting down - closing MCP sessions to prevent ghost processes.")
    await builder.mcp_manager.shutdown()


app = FastAPI(title="Arbitrage Meta-Agent", version="1.0.0", lifespan=lifespan)

# Add CORS middleware to allow browser-based requests
from fastapi.middleware.cors import CORSMiddleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], # Allows the browser WebContainer to fetch data
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class PromptRequest(BaseModel):
    prompt: str


@app.get("/health")
async def health():
    """Lightweight liveness/readiness probe for the Meta-Agent service."""
    return {
        "status": "ok",
        "connected_mcp_servers": len(builder.mcp_manager.sessions),
        "servers": sorted(builder.mcp_manager.sessions.keys()),
    }


@app.get("/tools")
async def get_tools():
    """List all tools discovered from connected MCP servers."""
    tools = await builder.mcp_manager.list_all_tools()
    return {"count": len(tools), "tools": tools}


# --- Two-Step Intelligence Flow: Expose intent classification endpoint ---
@app.post("/classify-intent")
async def classify_intent(request: PromptRequest):
    """Classify user intent to determine required API keys before generating."""
    try:
        intent = await builder.classify_intent(request.prompt)
        return {"intent": intent}

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# --- MCP Proxy Route: Forwards tool calls from WebContainer bots to MCP servers ---
@app.post("/mcp/{server_name}/{tool_name}")
async def proxy_mcp_tool(server_name: str, tool_name: str, args: dict):
    """
    Acts as a gateway. Receives HTTP POST from the WebContainer bot,
    executes the tool via the active MCP session, and returns the result.
    """
    try:
        # Check if the server session exists
        if server_name not in builder.mcp_manager.sessions:
            raise HTTPException(status_code=404, detail=f"MCP Server '{server_name}' not connected.")

        # Execute the tool via your MultiMCPClient
        result = await builder.mcp_manager.call_tool(server_name, tool_name, args)
        return result
    except Exception as e:
        print(f"❌ Tool Execution Failed ({server_name}/{tool_name}): {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/create-bot")
async def create_bot(request: PromptRequest):
    """Generate a production-ready arbitrage bot from a plain-English prompt."""
    try:
        print(f"Received bot generation request with prompt: {request.prompt}")
        result = await builder.build_bot_logic(request.prompt)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))