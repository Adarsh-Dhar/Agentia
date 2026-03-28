import asyncio, logging, os
from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))
from mcp_bridge import mcp
from arbitrage import (convert_to_base_units, calculate_profit, verify_tokens, get_swap_calldata, execute_arbitrage)
from config import *

SIMULATION_MODE = os.getenv("SIMULATION_MODE", "false").lower() == "true"

async def setup_bot_connections():
    await mcp.connect_to_server("one_inch", "npx", [
        "-y", "supergateway", "--streamableHttp", "https://api.1inch.com/mcp/protocol", "--outputTransport", "stdio"
    ])
    webacy_key = os.getenv("WEBACY_API_KEY")
    if not webacy_key:
        raise RuntimeError("WEBACY_API_KEY not set")
    await mcp.connect_to_server("webacy", "npx", [
        "-y", "supergateway", "--streamableHttp", "https://api.webacy.com/mcp", "--header", f"x-api-key: {webacy_key}", "--outputTransport", "stdio"
    ])
    wallet = os.getenv("WALLET_PRIVATE_KEY")
    rpc = os.getenv("RPC_PROVIDER_URL")
    gpath = os.getenv("GOAT_EVM_PATH")
    if not all([wallet, rpc, gpath]):
        raise RuntimeError("WALLET_PRIVATE_KEY, RPC_PROVIDER_URL, GOAT_EVM_PATH must be set")
    await mcp.connect_to_server("goat_evm", "npx", ["tsx", gpath], custom_env={"WALLET_PRIVATE_KEY": wallet, "RPC_PROVIDER_URL": rpc})

async def run_bot():
    if SIMULATION_MODE:
        logger.info("SIMULATION MODE — no transactions will broadcast")
    await setup_bot_connections()
    borrow_amount_base = await convert_to_base_units(USDC_ADDRESS, BORROW_AMOUNT_HUMAN)
    logger.info(f"Borrow amount: {borrow_amount_base} base units")
    try:
        while True:
            try:
                profit = await calculate_profit(borrow_amount_base)
                if profit > 0:
                    logger.info(f"Opportunity: +{profit} base units")
                    if not await verify_tokens():
                        logger.warning("Risk check failed. Skipping.")
                    elif SIMULATION_MODE:
                        logger.info(f"[SIM] Would execute. Profit: +{profit / 1_000_000:.6f} USDC")
                    else:
                        calldata = await get_swap_calldata(USDC_ADDRESS, WETH_ADDRESS, borrow_amount_base, ARB_BOT_ADDRESS)
                        tx = await execute_arbitrage(calldata, borrow_amount_base)
                        logger.info(f"Executed. TX: {tx}")
                else:
                    logger.info(f"No opportunity. Net: {profit} base units")
            except Exception as e:
                logger.error(str(e), exc_info=True)
            await asyncio.sleep(POLL_INTERVAL)
    except KeyboardInterrupt:
        logger.info("Stopping bot...")
    finally:
        await mcp.shutdown()

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s", datefmt="%Y-%m-%d %H:%M:%S")
logger = logging.getLogger(__name__)

if __name__ == "__main__":
    asyncio.run(run_bot())