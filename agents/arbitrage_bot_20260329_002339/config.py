WETH_ADDRESS = "0x4200000000000000000000000000000000000006"
USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
ARB_BOT_ADDRESS = "0x6b7b81e04D024259b87a6C0F5ab5Eb04d9539102"
ONE_INCH_ROUTER = "0x111111125421cA6dc452d289314280a0f8842A65"
CHAIN_ID = 84532  # Base Sepolia
USDC_DECIMALS = 6
WETH_DECIMALS = 18
AAVE_FEE_BPS = 9  # 0.09%
GAS_BUFFER_USDC = 2_000_000  # 2 USDC in base units
POLL_INTERVAL = 5  # seconds
BORROW_AMOUNT_HUMAN = 1  # human-readable USDC; converted to base units at runtime
FLASHLOAN_ABI = [
    {"inputs": [{"internalType": "address", "name": "_addressProvider", "type": "address"}], "stateMutability": "nonpayable", "type": "constructor"},
    {"inputs": [
        {"internalType": "address", "name": "asset", "type": "address"},
        {"internalType": "uint256", "name": "amount", "type": "uint256"},
        {"internalType": "uint256", "name": "premium", "type": "uint256"},
        {"internalType": "address", "name": "initiator", "type": "address"},
        {"internalType": "bytes", "name": "params", "type": "bytes"}
    ], "name": "executeOperation", "outputs": [{"internalType": "bool", "name": "", "type": "bool"}], "stateMutability": "nonpayable", "type": "function"},
    {"inputs": [
        {"internalType": "address", "name": "tokenToBorrow", "type": "address"},
        {"internalType": "uint256", "name": "amountToBorrow", "type": "uint256"},
        {"internalType": "address", "name": "routerTarget", "type": "address"},
        {"internalType": "bytes", "name": "swapData", "type": "bytes"}
    ], "name": "requestArbitrage", "outputs": [], "stateMutability": "nonpayable", "type": "function"},
    {"inputs": [{"internalType": "address", "name": "token", "type": "address"}], "name": "withdrawProfit", "outputs": [], "stateMutability": "nonpayable", "type": "function"}
]