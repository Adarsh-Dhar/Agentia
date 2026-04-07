#!/usr/bin/env bash

set -euo pipefail

SCRIPT_NAME="$(basename "$0")"

ACCOUNT_NAME="${ACCOUNT_NAME:-${INITIAD_ACCOUNT_NAME:-test-account}}"
NODE_URL="${NODE_URL:-${INITIA_NODE:-https://rpc.testnet.initia.xyz:443}}"
CHAIN_ID="${CHAIN_ID:-${INITIA_CHAIN_ID:-initiation-2}}"
GAS_PRICES="${GAS_PRICES:-${INITIA_GAS_PRICES:-0.015uinit}}"
GAS_ADJUSTMENT="${GAS_ADJUSTMENT:-${INITIA_GAS_ADJUSTMENT:-1.5}}"

INITIA_USDC_METADATA_ADDRESS="${INITIA_USDC_METADATA_ADDRESS:-0x9d15469b3ddca182bf719e9e2543fdd867772446e9e029fd84d5f134c0998c7c}"
INITIA_INIT_METADATA_ADDRESS="${INITIA_INIT_METADATA_ADDRESS:-0x445b724eccaed92de94160336f3e0a84b96db14c170c3500dd85048a3d5594aa}"

DEFAULT_RECIPIENT_HEX="b8552ec41cd7b5697464602d24d9c174F6FB863C"
RECIPIENT_INPUT="${1:-${RECIPIENT_ADDRESS:-0x${DEFAULT_RECIPIENT_HEX}}}"
USDC_AMOUNT="${USDC_AMOUNT:-${2:-1000000000}}"
INIT_AMOUNT="${INIT_AMOUNT:-${3:-1000000000}}"

usage() {
  cat <<EOF
Usage:
  ./$SCRIPT_NAME [recipient_address] [usdc_amount] [init_amount]

Examples:
  ./$SCRIPT_NAME
  ./$SCRIPT_NAME init1jgldc20kpwmnhmyfqf8p05m3pt5jcza4eufk9x 2500000000 500000000
  ./$SCRIPT_NAME 0x${DEFAULT_RECIPIENT_HEX}

Environment overrides:
  ACCOUNT_NAME / INITIAD_ACCOUNT_NAME
  NODE_URL / INITIA_NODE
  CHAIN_ID / INITIA_CHAIN_ID
  GAS_PRICES / INITIA_GAS_PRICES
  GAS_ADJUSTMENT / INITIA_GAS_ADJUSTMENT
  INITIA_USDC_METADATA_ADDRESS
  INITIA_INIT_METADATA_ADDRESS
  RECIPIENT_ADDRESS
  USDC_AMOUNT
  INIT_AMOUNT
EOF
}

log() {
  printf '%s\n' "$*" >&2
}

normalize_recipient() {
  local input="$1"

  if [[ "$input" == init1* ]]; then
    printf '%s' "$input"
    return 0
  fi

  local hex="${input#0x}"
  if ! [[ "$hex" =~ ^[0-9a-fA-F]{40}$ ]]; then
    log "Invalid recipient address: $input"
    log "Expected bech32 init1... or 20-byte hex with/without 0x prefix"
    exit 1
  fi

  local parsed
  parsed="$(initiad keys parse "$hex")"
  local bech32
  bech32="$(printf '%s\n' "$parsed" | awk '/^- init1/{print $2; exit}')"

  if [[ -z "$bech32" ]]; then
    log "Failed to parse recipient address: $input"
    exit 1
  fi

  printf '%s' "$bech32"
}

mint_coin() {
  local recipient="$1"
  local metadata="$2"
  local amount="$3"
  local symbol="$4"

  log "Minting $amount of $symbol to $recipient using metadata $metadata"

  initiad tx move execute 0x1 managed_coin mint_to \
    --args "[\"address:${recipient}\",\"object:${metadata}\",\"u64:${amount}\"]" \
    --from "$ACCOUNT_NAME" \
    --gas auto \
    --gas-adjustment "$GAS_ADJUSTMENT" \
    --gas-prices "$GAS_PRICES" \
    --node "$NODE_URL" \
    --chain-id "$CHAIN_ID" \
    --broadcast-mode sync \
    --output json \
    --yes
}

main() {
  if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
    usage
    exit 0
  fi

  if ! command -v initiad >/dev/null 2>&1; then
    log "initiad is not installed or not in PATH"
    exit 1
  fi

  local recipient
  recipient="$(normalize_recipient "$RECIPIENT_INPUT")"

  mint_coin "$recipient" "$INITIA_USDC_METADATA_ADDRESS" "$USDC_AMOUNT" "USDC"
  mint_coin "$recipient" "$INITIA_INIT_METADATA_ADDRESS" "$INIT_AMOUNT" "INIT"

  log "Done. Minted both tokens to $recipient"
}

main "$@"
