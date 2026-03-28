import os
import json
from dotenv import load_dotenv
from mcp_client import MultiMCPClient
from azure.ai.inference import ChatCompletionsClient
from azure.ai.inference.models import SystemMessage, UserMessage
from azure.core.credentials import AzureKeyCredential

# Load variables from .env 
load_dotenv()

class MetaAgentBuilder:
    def __init__(self):
        self.mcp_manager = MultiMCPClient()
        
        # Fetch API Keys
        self.token = os.environ.get("GITHUB_TOKEN")
        self.alchemy_key = os.environ.get("ALCHEMY_API_KEY")
        self.webacy_key = os.environ.get("WEBACY_API_KEY")
        
        if not self.token:
            raise ValueError("GITHUB_TOKEN not found. Please check your .env file.")
            
        self.endpoint = "https://models.inference.ai.azure.com"
        self.model_name = "gpt-4o"
        
        self.client = ChatCompletionsClient(
            endpoint=self.endpoint,
            credential=AzureKeyCredential(self.token),
        )


    async def setup_environment(self):
        """Connects to all required DeFi MCP Servers."""
        print("Connecting to MCP Servers...")

        # 1. 1inch (HTTP via supergateway)
        await self.mcp_manager.connect_to_server(
            "one_inch", "npx",
            ["-y", "supergateway", "--streamableHttp", "https://api.1inch.com/mcp/protocol", "--outputTransport", "stdio"]
        )

        # 2. Jupiter (HTTP via supergateway)
        await self.mcp_manager.connect_to_server(
            "jupiter", "npx",
            ["-y", "supergateway", "--streamableHttp", "https://dev.jup.ag/mcp", "--outputTransport", "stdio"]
        )

        # 3. Webacy (HTTP via supergateway WITH API Header)
        if self.webacy_key:
            await self.mcp_manager.connect_to_server(
                "webacy", "npx",
                [
                    "-y", "supergateway", 
                    "--streamableHttp", "https://api.webacy.com/mcp", 
                    "--header", f"x-api-key: {self.webacy_key}", 
                    "--outputTransport", "stdio"
                ]
            )
        else:
            print("⚠️ WEBACY_API_KEY missing in .env. Skipping Webacy.")

        # 4. Alchemy (Native stdio WITH custom environment variables)
        if self.alchemy_key:
            await self.mcp_manager.connect_to_server(
                "alchemy", "npx",
                ["-y", "@alchemy/mcp-server"],
                custom_env={"ALCHEMY_API_KEY": self.alchemy_key}
            )
        else:
            print("⚠️ ALCHEMY_API_KEY missing in .env. Skipping Alchemy.")

        # 5. GOAT EVM execution wallet (Native typescript execution)
        self.wallet_key = os.environ.get("WALLET_PRIVATE_KEY")
        self.rpc_url = os.environ.get("RPC_PROVIDER_URL")
        self.goat_path = os.environ.get("GOAT_EVM_PATH")
        if self.wallet_key and self.rpc_url and self.goat_path:
            if os.path.exists(self.goat_path):
                await self.mcp_manager.connect_to_server(
                    "goat_evm", "npx",
                    ["tsx", self.goat_path],
                    custom_env={
                        "WALLET_PRIVATE_KEY": self.wallet_key,
                        "RPC_PROVIDER_URL": self.rpc_url
                    }
                )
            else:
                print(f"⚠️ GOAT EVM path not found: {self.goat_path}")
        else:
            print("⚠️ WALLET_PRIVATE_KEY, RPC_PROVIDER_URL, or GOAT_EVM_PATH missing in .env. Skipping GOAT EVM.")


    async def build_bot_logic(self, prompt: str):
        """Uses GPT-4o to build a bot using all discovered tools."""
        available_tools = await self.mcp_manager.list_all_tools()
        
        system_instructions = f"""
        You are an expert Multi-Chain DeFi Architect. Use the following tool schemas 
        to write a structured deployment configuration or Python logic for 
        swaps, liquidity management, and security analysis based on the user's intent.
        
        AVAILABLE PROTOCOL TOOLS:
        {json.dumps(available_tools, indent=2)}
        
        STRICT RULES:
        - Use exact tool names provided in the schema.
        - Combine tools from different providers (e.g., use Webacy to check a token, then Jupiter to swap).
        """
        
        response = self.client.complete(
            messages=[
                SystemMessage(content=system_instructions),
                UserMessage(content=prompt),
            ],
            model=self.model_name,
            temperature=0.2
        )
        
        return {
            "status": "blueprint_ready",
            "code": response.choices[0].message.content,
            "tools_used": [t['name'] for t in available_tools]
        }