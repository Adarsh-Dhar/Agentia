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


@app.post("/create-bot")
async def create_bot(request: PromptRequest):
    """Generate a production-ready arbitrage bot from a plain-English prompt."""
    try:
        result = await builder.build_bot_logic(request.prompt)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))