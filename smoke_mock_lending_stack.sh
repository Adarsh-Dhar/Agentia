#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

NODE_URL="${NODE_URL:-https://rpc.testnet.initia.xyz}"
CHAIN_ID="${CHAIN_ID:-initiation-2}"
ACCOUNT_NAME="${ACCOUNT_NAME:-test-account}"
USER_ADDR="${USER_ADDR:-$(initiad keys show "$ACCOUNT_NAME" -a)}"

ACCOUNT_HEX="${ACCOUNT_HEX:-}"
if [[ -z "$ACCOUNT_HEX" ]]; then
  ACCOUNT_HEX="$(initiad keys parse "$USER_ADDR" | awk '/bytes:/ {print $2}')"
fi

ACCOUNT_ADDR="${ACCOUNT_ADDR:-$USER_ADDR}"

INIT_METADATA_ADDRESS="${INIT_METADATA_ADDRESS:-}"
USDC_METADATA_ADDRESS="${USDC_METADATA_ADDRESS:-}"

if [[ -z "$INIT_METADATA_ADDRESS" || -z "$USDC_METADATA_ADDRESS" ]]; then
  echo "Set INIT_METADATA_ADDRESS and USDC_METADATA_ADDRESS before running smoke flow."
  exit 1
fi

echo "Setting oracle prices"
if ! initiad tx move execute "$ACCOUNT_ADDR" mock_oracle_v2 initialize \
  --from "$ACCOUNT_NAME" \
  --broadcast-mode sync \
  --gas auto --gas-adjustment 1.5 --gas-prices 0.015uinit \
  --node "$NODE_URL" --chain-id "$CHAIN_ID" --yes; then
  echo "mock_oracle_v2 initialize skipped or already applied"
fi

initiad tx move execute "$ACCOUNT_ADDR" mock_oracle_v2 set_price \
  --args '["string:USDC","u64:1000000"]' \
  --from "$ACCOUNT_NAME" \
  --broadcast-mode sync \
  --gas auto --gas-adjustment 1.5 --gas-prices 0.015uinit \
  --node "$NODE_URL" --chain-id "$CHAIN_ID" --yes

initiad tx move execute "$ACCOUNT_ADDR" mock_oracle_v2 set_price \
  --args '["string:INIT","u64:3000000"]' \
  --from "$ACCOUNT_NAME" \
  --broadcast-mode sync \
  --gas auto --gas-adjustment 1.5 --gas-prices 0.015uinit \
  --node "$NODE_URL" --chain-id "$CHAIN_ID" --yes

echo "Registering token metadata in lending"
if ! initiad tx move execute "$ACCOUNT_ADDR" mock_lending_v2 initialize \
  --from "$ACCOUNT_NAME" \
  --broadcast-mode sync \
  --gas auto --gas-adjustment 1.5 --gas-prices 0.015uinit \
  --node "$NODE_URL" --chain-id "$CHAIN_ID" --yes; then
  echo "mock_lending_v2 initialize skipped or already applied"
fi

initiad tx move execute "$ACCOUNT_ADDR" mock_lending_v2 set_token_metadata \
  --args "[\"string:INIT\",\"address:${INIT_METADATA_ADDRESS}\"]" \
  --from "$ACCOUNT_NAME" \
  --broadcast-mode sync \
  --gas auto --gas-adjustment 1.5 --gas-prices 0.015uinit \
  --node "$NODE_URL" --chain-id "$CHAIN_ID" --yes

initiad tx move execute "$ACCOUNT_ADDR" mock_lending_v2 set_token_metadata \
  --args "[\"string:USDC\",\"address:${USDC_METADATA_ADDRESS}\"]" \
  --from "$ACCOUNT_NAME" \
  --broadcast-mode sync \
  --gas auto --gas-adjustment 1.5 --gas-prices 0.015uinit \
  --node "$NODE_URL" --chain-id "$CHAIN_ID" --yes

echo "Opening position"
initiad tx move execute "$ACCOUNT_ADDR" mock_lending_v2 open_position \
  --args '["string:INIT","string:USDC","u64:1000","u64:2000"]' \
  --from "$ACCOUNT_NAME" \
  --broadcast-mode sync \
  --gas auto --gas-adjustment 1.5 --gas-prices 0.015uinit \
  --node "$NODE_URL" --chain-id "$CHAIN_ID" --yes

echo "Health factor before crash"
initiad query move view "$ACCOUNT_ADDR" mock_lending_v2 get_health_factor \
  --args "[\"address:${USER_ADDR}\"]" \
  --node "$NODE_URL"

echo "Forcing unsafe health factor"
initiad tx move execute "$ACCOUNT_ADDR" mock_lending_v2 set_health_factor_unsafe \
  --args "[\"address:${USER_ADDR}\",\"u64:100\"]" \
  --from "$ACCOUNT_NAME" \
  --broadcast-mode sync \
  --gas auto --gas-adjustment 1.5 --gas-prices 0.015uinit \
  --node "$NODE_URL" --chain-id "$CHAIN_ID" --yes

echo "Health factor after crash"
initiad query move view "$ACCOUNT_ADDR" mock_lending_v2 get_health_factor \
  --args "[\"address:${USER_ADDR}\"]" \
  --node "$NODE_URL"

echo "Liquidating"
initiad tx move execute "$ACCOUNT_ADDR" mock_lending_v2 liquidate \
  --args "[\"address:${USER_ADDR}\"]" \
  --from "$ACCOUNT_NAME" \
  --broadcast-mode sync \
  --gas auto --gas-adjustment 1.5 --gas-prices 0.015uinit \
  --node "$NODE_URL" --chain-id "$CHAIN_ID" --yes

echo "Smoke flow submitted. Check explorer for LiquidationEvent."
