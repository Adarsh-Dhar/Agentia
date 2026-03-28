import os
import shutil
import asyncio
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from contextlib import AsyncExitStack

class MultiMCPClient:
    def __init__(self):
        self.sessions = {}
        self.exit_stack = AsyncExitStack()

    async def connect_to_server(self, name: str, command: str, args: list, custom_env: dict = None):
        """Connects to a single MCP server via stdio."""
        cmd_path = shutil.which(command)
        if not cmd_path:
            raise RuntimeError(f"Command '{command}' not found in system PATH.")
        
        # Copy base environment and inject any custom variables (like API keys)
        env = os.environ.copy()
        if custom_env:
            env.update(custom_env)
            
        server_params = StdioServerParameters(
            command=cmd_path,
            args=args,
            env=env
        )
        
        # 1. Start the stdio transport
        transport = await self.exit_stack.enter_async_context(stdio_client(server_params))
        # 2. Unpack the tuple
        read_stream, write_stream = transport
        # 3. Pass the separated streams to the session
        session = await self.exit_stack.enter_async_context(ClientSession(read_stream, write_stream))
        # 4. Initialize the protocol handshake
        await session.initialize()
        
        self.sessions[name] = session
        print(f"✅ Connected to {name} MCP Server")

    async def list_all_tools(self):
        """Aggregates tool definitions from all active MCP sessions."""
        all_tools = []
        for server_name, session in self.sessions.items():
            result = await session.list_tools()
            for tool in result.tools:
                all_tools.append({
                    "server": server_name,
                    "name": tool.name,
                    "description": tool.description,
                    "input_schema": tool.inputSchema
                })
        return all_tools

    async def shutdown(self):
        await self.exit_stack.aclose()