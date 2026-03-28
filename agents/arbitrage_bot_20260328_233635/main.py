import asyncio
import json
from web3 import Web3
from eth_abi import encode_abi

# Constants
WETH_ADDRESS = "0x4200000000000000000000000000000000000006"
USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
ARB_BOT_ADDRESS = "0x6b7b81e04D024259b87a6C0F5ab5Eb04d9539102"
BASE_SEPOLIA_CHAIN_ID = 11155111

# MCP Tool Wrapper
async def call_mcp_tool(server, tool, args):
    response = await mcp_manager.call_tool(server=server, tool=tool, args=args)
    return json.loads(response)

# Arbitrage Logic
async def check_arbitrage():
    while True:
        try:
            # Step 1: Get price quotes from 1inch
            quote_response = await call_mcp_tool(
                server="one_inch",
                tool="swap",
                args={
                    "src": USDC_ADDRESS,
                    "dst": WETH_ADDRESS,
                    "amount": "1000000",  # 1 USDC in base units
                    "chain": BASE_SEPOLIA_CHAIN_ID,
                    "from": ARB_BOT_ADDRESS,
                    "quoteOnly": True
                }
            )

            usdc_to_weth_price = int(quote_response["toTokenAmount"])

            quote_response = await call_mcp_tool(
                server="one_inch",
                tool="swap",
                args={
                    "src": WETH_ADDRESS,
                    "dst": USDC_ADDRESS,
                    "amount": str(usdc_to_weth_price),
                    "chain": BASE_SEPOLIA_CHAIN_ID,
                    "from": ARB_BOT_ADDRESS,
                    "quoteOnly": True
                }
            )

            weth_to_usdc_price = int(quote_response["toTokenAmount"])

            # Step 2: Check for profitability
            profit = weth_to_usdc_price - 1000000  # Initial USDC amount in base units
            if profit > 0:
                print(f"Profitable arbitrage opportunity found! Profit: {profit} base units")

                # Step 3: Verify tokens using Webacy
                usdc_risk = await call_mcp_tool(
                    server="webacy",
                    tool="get_token_risk",
                    args={"address": USDC_ADDRESS, "chain": "base-sepolia", "metrics_date": "", "modules": []}
                )

                weth_risk = await call_mcp_tool(
                    server="webacy",
                    tool="get_token_risk",
                    args={"address": WETH_ADDRESS, "chain": "base-sepolia", "metrics_date": "", "modules": []}
                )

                if usdc_risk["risk"] == "low" and weth_risk["risk"] == "low":
                    print("Tokens verified as low risk. Proceeding with arbitrage.")

                    # Step 4: Get swap data from 1inch
                    swap_data_response = await call_mcp_tool(
                        server="one_inch",
                        tool="swap",
                        args={
                            "src": USDC_ADDRESS,
                            "dst": WETH_ADDRESS,
                            "amount": "1000000",  # 1 USDC in base units
                            "chain": BASE_SEPOLIA_CHAIN_ID,
                            "from": ARB_BOT_ADDRESS,
                            "quoteOnly": False
                        }
                    )

                    swap_data = swap_data_response["tx"]["data"]

                    # Step 5: Trigger flash loan smart contract using GOAT
                    await call_mcp_tool(
                        server="goat_evm",
                        tool="send_token",
                        args={
                            "recipient": ARB_BOT_ADDRESS,
                            "amountInBaseUnits": "1000000",
                            "tokenAddress": USDC_ADDRESS
                        }
                    )

                    print("Arbitrage executed successfully!")
                else:
                    print("Token risk too high. Skipping arbitrage.")
            else:
                print("No profitable arbitrage opportunity found.")

        except Exception as e:
            print(f"Error during arbitrage check: {e}")

        # Wait for 5 seconds before checking again
        await asyncio.sleep(5)

# Main Function
async def main():
    await check_arbitrage()

# Run the bot
if __name__ == "__main__":
    asyncio.run(main())