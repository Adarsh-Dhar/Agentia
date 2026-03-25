// Aave V3 Contract Addresses — ARBITRUM
// Source: https://docs.aave.com/developers/deployed-contracts/v3-mainnet
// Last verified: 2024

export const AAVE_V3_ADDRESSES = {
  "POOL": "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  "POOL_ADDRESSES_PROVIDER": "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb",
  "WETH": "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
  "USDC": "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8"
};

// Aave Flash Loan Fee: 0.09% (9 basis points) of borrowed amount
// This fee must be included in the repayment amount.
export const AAVE_FLASH_LOAN_FEE_BPS = 9;
export const AAVE_FLASH_LOAN_FEE_PERCENT = 0.0009;