"""
agents/main.py

FastAPI server — the Meta-Agent API.
Start with: uvicorn main:app --reload
"""

import os
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from orchestrator import MetaAgentBuilder

app     = FastAPI(title="Arbitrage Meta-Agent", version="1.0.0")

# Add CORS middleware to allow browser-based requests
from fastapi.middleware.cors import CORSMiddleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], # Allows the browser WebContainer to fetch data
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

builder = MetaAgentBuilder()


class PromptRequest(BaseModel):
    prompt: str


@app.on_event("startup")
async def startup():
    if not os.environ.get("GITHUB_TOKEN"):
        raise RuntimeError("GITHUB_TOKEN environment variable is missing.")
    await builder.setup_environment()


@app.on_event("shutdown")
async def shutdown():
    print("Shutting down — closing MCP sessions to prevent ghost processes.")
    await builder.mcp_manager.shutdown()


@app.get("/tools")
async def get_tools():
    """List all tools discovered from connected MCP servers."""
    tools = await builder.mcp_manager.list_all_tools()
    return {"count": len(tools), "tools": tools}


# --- Two-Step Intelligence Flow: Expose intent classification endpoint ---
from fastapi import Request

@app.post("/classify-intent")
async def classify_intent(request: PromptRequest):
    """Classify user intent to determine required API keys before generating."""
    try:
        intent = await builder.classify_intent(request.prompt)
        return {"intent": intent}

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# --- MCP Proxy Route: Forwards tool calls from WebContainer bots to MCP servers ---
from fastapi import Request

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
        result = await builder.build_bot_logic(request.prompt)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))