from config import *
from mcp_bridge import call_mcp_tool

async def convert_to_base_units(token_address: str, human_amount) -> int:
    response = await call_mcp_tool("goat_evm", "convert_to_base_units", {"tokenAddress": token_address, "amount": str(human_amount)})
    return int(response["baseUnits"])

async def get_usdc_to_weth_quote(amount_usdc_base: int) -> int:
    response = await call_mcp_tool("one_inch", "get_quote", {"tokenIn": USDC_ADDRESS, "tokenOut": WETH_ADDRESS, "amount": str(amount_usdc_base), "chain": CHAIN_ID})
    return int(response["toTokenAmount"])

async def get_weth_to_usdc_quote(amount_weth_base: int) -> int:
    response = await call_mcp_tool("one_inch", "get_quote", {"tokenIn": WETH_ADDRESS, "tokenOut": USDC_ADDRESS, "amount": str(amount_weth_base), "chain": CHAIN_ID})
    return int(response["toTokenAmount"])

async def calculate_profit(borrow_usdc_base: int) -> int:
    weth = await get_usdc_to_weth_quote(borrow_usdc_base)
    gross = await get_weth_to_usdc_quote(weth)
    fee = (borrow_usdc_base * AAVE_FEE_BPS) // 10_000
    return gross - borrow_usdc_base - fee - GAS_BUFFER_USDC

async def verify_tokens() -> bool:
    usdc_risk = await call_mcp_tool("webacy", "get_token_risk", {"address": USDC_ADDRESS, "chain": "base-sepolia"})
    weth_risk = await call_mcp_tool("webacy", "get_token_risk", {"address": WETH_ADDRESS, "chain": "base-sepolia"})
    return (usdc_risk["risk"] == "low" or usdc_risk["score"] < 20) and (weth_risk["risk"] == "low" or weth_risk["score"] < 20)

async def get_swap_calldata(src, dst, amount_base, from_addr) -> str:
    response = await call_mcp_tool("one_inch", "get_swap_data", {"tokenIn": src, "tokenOut": dst, "amount": str(amount_base), "chain": CHAIN_ID, "from": from_addr, "slippage": 1})
    return response["tx"]["data"]

async def execute_arbitrage(calldata: str, borrow_amount_base: int) -> str:
    response = await call_mcp_tool("goat_evm", "write_contract", {
        "address": ARB_BOT_ADDRESS,
        "abi": FLASHLOAN_ABI,
        "functionName": "requestArbitrage",
        "args": [USDC_ADDRESS, borrow_amount_base, ONE_INCH_ROUTER, calldata]
    })
    return response["transactionHash"]