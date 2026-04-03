# Mock Flash Loan Deployment Summary

**Chain:** initiation-2 testnet  
**Date:** April 3, 2026  
**Status:** ✅ Successfully Deployed

## Deployment Details

### Transaction Hash
```
14072D8756CE79E343798AB4228EDEE1F3A4334B2CF705E0EC19824926829002
```

### Deployed Module Address
```
0x923edc29f60bb73bec89024e17d3710ae92c0bb5::flash_loan
```

### Deployer Wallet
```
init1jgldc20kpwmnhmyfqf8p05m3pt5jcza4eufk9x (hex: 0x923edc29f60bb73bec89024e17d3710ae92c0bb5)
```

### RPC Endpoint
```
https://rpc.testnet.initia.xyz:443
```

### Explorer Link
```
https://scan.testnet.initia.xyz/tx/14072D8756CE79E343798AB4228EDEE1F3A4334B2CF705E0EC19824926829002
```

## Contract Features

The `flash_loan` module includes:

### Events
- **BorrowEvent**: Emitted when `borrow()` is called
  - Fields: `borrower` (address), `amount` (u64)
  
- **RepayEvent**: Emitted when `repay()` is called
  - Fields: `borrower` (address), `amount` (u64), `fee` (u64)

### Entry Functions

#### borrow<CoinType>
```move
public entry fun borrow<CoinType>(
    account: &signer,
    amount: u64
)
```
- Mock borrow function that emits a BorrowEvent
- Does NOT move any funds
- Signature matches TypeScript bot's batched calls

#### repay<CoinType>
```move
public entry fun repay<CoinType>(
    account: &signer,
    amount: u64,
    fee: u64
)
```
- Mock repay function that emits a RepayEvent
- Does NOT move any funds
- Signature matches TypeScript bot's batched calls

## Verification Command

```bash
initiad query tx 14072D8756CE79E343798AB4228EDEE1F3A4334B2CF705E0EC19824926829002 \
    --node https://rpc.testnet.initia.xyz:443
```

Result: `code: 0` (Success)

## Next Steps

### 1. Update Bot Environment

Add to your bot's `.env` file:
```env
INITIA_FLASH_POOL_ADDRESS=0x923edc29f60bb73bec89024e17d3710ae92c0bb5
INITIA_FLASH_LOAN_MODULE=flash_loan
INITIA_RPC=https://rpc.testnet.initia.xyz:443
INITIA_CHAIN_ID=initiation-2
```

### 2. Test the Integration

```bash
npm run start
```

Your bot will bundle transactions as:
```
borrow<CoinType> → swap → swap → repay<CoinType>
```

All in a single atomic transaction on-chain!

## Project Structure

```
mock_flash_loan/
├── Move.toml                           # Package manifest with dependencies
├── sources/
│   └── flash_loan.move                # Contract with events and entry functions
├── build/
│   └── MockFlashLoan/
│       └── bytecode_modules/
│           └── flash_loan.mv          # Compiled bytecode
└── deploy.log                          # Deployment transaction log
```

## Key Configuration Files

### Move.toml
```toml
[package]
name = "MockFlashLoan"
version = "0.0.0"

[addresses]
deployer = "0x923edc29f60bb73bec89024e17d3710ae92c0bb5"

[dependencies]
InitiaStdlib = { git = "https://github.com/initia-labs/move-natives.git", subdir = "initia_stdlib", rev = "v1.2.0" }
```

## Testing on-chain

Once deployed, you can call the functions via initiad:

```bash
# Test borrow
initiad tx move execute 0x923edc29f60bb73bec89024e17d3710ae92c0bb5::flash_loan::borrow \
  0x923edc29f60bb73bec89024e17d3710ae92c0bb5::usdc::USDC \
  1000000 \
  --from test-account \
  --chain-id initiation-2 \
  --node https://rpc.testnet.initia.xyz:443

# Test repay
initiad tx move execute 0x923edc29f60bb73bec89024e17d3710ae92c0bb5::flash_loan::repay \
  0x923edc29f60bb73bec89024e17d3710ae92c0bb5::usdc::USDC \
  1000000 \
  0 \
  --from test-account \
  --chain-id initiation-2 \
  --node https://rpc.testnet.initia.xyz:443
```

## Compilation Notes

- Used Initia's `#[event]` attribute for event emission
- Removed non-ASCII characters (em-dashes) for compiler compatibility
- Built with dev address `0x42` first, then recompiled with actual deployer address

## Gas Details

- Transaction Gas Used: ~115,898
- Gas Price: 0.015 uinit
- Network: initiation-2 testnet
