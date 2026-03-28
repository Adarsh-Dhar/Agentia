import os

from fastapi import FastAPI, HTTPException
from fastapi import Body
from pydantic import BaseModel
from orchestrator import MetaAgentBuilder


app = FastAPI()
builder = MetaAgentBuilder()


class PromptRequest(BaseModel):
    prompt: str


@app.on_event("startup")
async def startup():
    # Ensure environment variables are set before starting
    if not os.environ.get("GITHUB_TOKEN"):
        raise RuntimeError("GITHUB_TOKEN environment variable is missing")
    await builder.setup_environment()

# NEW: Add a shutdown event to clean up ghost sessions
@app.on_event("shutdown")
async def shutdown():
    print("Shutting down... Closing MCP sessions to prevent rate limits.")
    await builder.mcp_manager.shutdown()

@app.get("/tools")
async def get_tools():
    """Returns all tools discovered from connected MCP servers."""
    tools = await builder.mcp_manager.list_all_tools()
    return {"count": len(tools), "tools": tools}


@app.post("/create-bot")
async def create_bot(request: PromptRequest):
    """Triggers the Meta-Agent to build a new bot blueprint using GPT-4o."""
    try:
        result = await builder.build_bot_logic(request.prompt)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))