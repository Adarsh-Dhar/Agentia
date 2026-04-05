#!/usr/bin/env bash

set -euo pipefail

SCRIPT_NAME="$(basename "$0")"

ACCOUNT_NAME="${INITIAD_ACCOUNT_NAME:-test-account}"
CHAIN_ID="${INITIA_CHAIN_ID:-initiation-2}"
NODE="${INITIA_NODE:-https://rpc.testnet.initia.xyz:443}"
GAS_PRICES="${INITIA_GAS_PRICES:-0.015uinit}"
GAS_ADJUSTMENT="${INITIA_GAS_ADJUSTMENT:-1.5}"
POOL_GAS_LIMIT="${POOL_GAS_LIMIT:-5000000}"

COIN_A_NAME="${1:-${COIN_A_NAME:-token-a}}"
COIN_A_SYMBOL="${2:-${COIN_A_SYMBOL:-TOA}}"
COIN_A_DECIMALS="${3:-${COIN_A_DECIMALS:-6}}"
COIN_A_MINT_AMOUNT="${4:-${COIN_A_MINT_AMOUNT:-2000000000}}"

COIN_B_NAME="${COIN_B_NAME:-token-b}"
COIN_B_SYMBOL="${COIN_B_SYMBOL:-TOB}"
COIN_B_DECIMALS="${COIN_B_DECIMALS:-6}"
COIN_B_MINT_AMOUNT="${COIN_B_MINT_AMOUNT:-2500000000}"

POOL_A_NAME="${POOL_A_NAME:-${COIN_A_SYMBOL}-${COIN_B_SYMBOL}-balanced}"
POOL_A_SYMBOL="${POOL_A_SYMBOL:-${COIN_A_SYMBOL}${COIN_B_SYMBOL}A}"
POOL_A_SWAP_FEE="${POOL_A_SWAP_FEE:-0.003}"
POOL_A_COIN_A_WEIGHT="${POOL_A_COIN_A_WEIGHT:-0.5}"
POOL_A_COIN_B_WEIGHT="${POOL_A_COIN_B_WEIGHT:-0.5}"
POOL_A_COIN_A_AMOUNT="${POOL_A_COIN_A_AMOUNT:-1000000000}"
POOL_A_COIN_B_AMOUNT="${POOL_A_COIN_B_AMOUNT:-1000000000}"

POOL_B_NAME="${POOL_B_NAME:-${COIN_A_SYMBOL}-${COIN_B_SYMBOL}-skewed}"
POOL_B_SYMBOL="${POOL_B_SYMBOL:-${COIN_A_SYMBOL}${COIN_B_SYMBOL}B}"
POOL_B_SWAP_FEE="${POOL_B_SWAP_FEE:-0.003}"
POOL_B_COIN_A_WEIGHT="${POOL_B_COIN_A_WEIGHT:-0.5}"
POOL_B_COIN_B_WEIGHT="${POOL_B_COIN_B_WEIGHT:-0.5}"
POOL_B_COIN_A_AMOUNT="${POOL_B_COIN_A_AMOUNT:-1000000000}"
POOL_B_COIN_B_AMOUNT="${POOL_B_COIN_B_AMOUNT:-1500000000}"

MAXIMUM_SUPPLY="${MAXIMUM_SUPPLY:-null}"
COIN_ICON_URI="${COIN_ICON_URI:-}"
COIN_PROJECT_URI="${COIN_PROJECT_URI:-}"
DRY_RUN="${DRY_RUN:-0}"

log() {
  printf '%s\n' "$*" >&2
}

usage() {
  cat <<EOF
Usage:
  ./$SCRIPT_NAME [coin_a_name] [coin_a_symbol] [coin_a_decimals] [coin_a_mint_amount]

Environment overrides:
  INITIAD_ACCOUNT_NAME   default: test-account
  INITIA_CHAIN_ID        default: initiation-2
  INITIA_NODE            default: https://rpc.testnet.initia.xyz:443
  INITIA_GAS_PRICES      default: 0.015uinit
  INITIA_GAS_ADJUSTMENT  default: 1.5
  COIN_A_NAME            default: token-a
  COIN_A_SYMBOL          default: TOA
  COIN_A_DECIMALS        default: 6
  COIN_A_MINT_AMOUNT     default: 2000000000
  COIN_B_NAME            default: token-b
  COIN_B_SYMBOL          default: TOB
  COIN_B_DECIMALS        default: 6
  COIN_B_MINT_AMOUNT     default: 2500000000
  POOL_A_NAME            default: TOA-TOB-balanced
  POOL_A_SYMBOL          default: TOATOBA
  POOL_A_SWAP_FEE        default: 0.003
  POOL_A_COIN_A_WEIGHT   default: 0.5
  POOL_A_COIN_B_WEIGHT   default: 0.5
  POOL_A_COIN_A_AMOUNT   default: 1000000000
  POOL_A_COIN_B_AMOUNT   default: 1000000000
  POOL_B_NAME            default: TOA-TOB-skewed
  POOL_B_SYMBOL          default: TOATOBB
  POOL_B_SWAP_FEE        default: 0.003
  POOL_B_COIN_A_WEIGHT   default: 0.5
  POOL_B_COIN_B_WEIGHT   default: 0.5
  POOL_B_COIN_A_AMOUNT   default: 1000000000
  POOL_B_COIN_B_AMOUNT   default: 1500000000
  MAXIMUM_SUPPLY         default: null
  COIN_ICON_URI          default: empty string
  COIN_PROJECT_URI       default: empty string
  DRY_RUN                set to 1 to print commands without broadcasting
EOF
}

run_cmd() {
  printf '  $'
  printf ' %q' "$@"
  printf '\n' >&2

  if [[ "$DRY_RUN" == "1" ]]; then
    return 0
  fi

  "$@"
}

extract_hex64() {
  local payload="$1"
  PAYLOAD="$payload" python3 - <<'PY'
import os
import re
import sys

text = os.environ.get('PAYLOAD', '')
match = re.search(r'0x[0-9a-fA-F]{64}', text)
if match:
    print(match.group(0))
    sys.exit(0)

sys.exit(1)
PY
}

extract_txhash() {
  local payload="$1"
  PAYLOAD="$payload" python3 - <<'PY'
import json
import os
import re
import sys

text = os.environ.get('PAYLOAD', '')

def walk(value):
    if isinstance(value, dict):
        for key in ('txhash', 'tx_hash', 'hash'):
            candidate = value.get(key)
            if isinstance(candidate, str) and re.fullmatch(r'[0-9A-Fa-f]{64}', candidate):
                print(candidate)
                return True
        for candidate in value.values():
            if walk(candidate):
                return True
    elif isinstance(value, list):
        for candidate in value:
            if walk(candidate):
                return True
    elif isinstance(value, str):
        if re.fullmatch(r'[0-9A-Fa-f]{64}', value):
            print(value)
            return True
    return False

try:
    decoded = json.loads(text)
    if walk(decoded):
        sys.exit(0)
except Exception:
    pass

match = re.search(r'\b([0-9A-Fa-f]{64})\b', text)
if match:
    print(match.group(1))
    sys.exit(0)

sys.exit(1)
PY
}

extract_liquidity_token() {
  local payload="$1"
  PAYLOAD="$payload" python3 - <<'PY'
import json
import os
import re
import sys

text = os.environ.get('PAYLOAD', '')

def walk(value):
  if isinstance(value, dict):
    candidate = value.get('liquidity_token')
    if isinstance(candidate, str) and re.fullmatch(r'0x[0-9A-Fa-f]{64}', candidate):
      print(candidate)
      return True
    for child in value.values():
      if walk(child):
        return True
  elif isinstance(value, list):
    for child in value:
      if walk(child):
        return True
  elif isinstance(value, str):
    match = re.search(r'"liquidity_token"\s*:\s*"(0x[0-9A-Fa-f]{64})"', value)
    if match:
      print(match.group(1))
      return True
  return False

try:
  decoded = json.loads(text)
  if walk(decoded):
    sys.exit(0)
except Exception:
  pass

match = re.search(r'"liquidity_token"\s*:\s*"(0x[0-9A-Fa-f]{64})"', text)
if match:
  print(match.group(1))
  sys.exit(0)

sys.exit(1)
PY
}

query_tx() {
  local tx_hash="$1"

  run_cmd initiad query tx "$tx_hash" \
  --node "$NODE" \
  --output json
}

query_metadata() {
  local creator_address="$1"
  local coin_symbol="$2"

  run_cmd initiad query move view 0x1 coin metadata \
    --args "[\"address:${creator_address}\",\"string:${coin_symbol}\"]" \
    --node "$NODE" \
    --output json
}

initialize_coin() {
  local coin_name="$1"
  local coin_symbol="$2"
  local coin_decimals="$3"
  local maximum_supply="$4"
  local icon_uri="$5"
  local project_uri="$6"
  local max_supply_arg="option<u128>:null"

  if [[ "$maximum_supply" != "null" && -n "$maximum_supply" ]]; then
    max_supply_arg="option<u128>:${maximum_supply}"
  fi

  run_cmd initiad tx move execute 0x1 managed_coin initialize \
    --args "[\"${max_supply_arg}\",\"string:${coin_name}\",\"string:${coin_symbol}\",\"u8:${coin_decimals}\",\"string:${icon_uri}\",\"string:${project_uri}\"]" \
    --from "$ACCOUNT_NAME" \
    --gas auto \
    --gas-adjustment "$GAS_ADJUSTMENT" \
    --gas-prices "$GAS_PRICES" \
    --node "$NODE" \
    --chain-id "$CHAIN_ID" \
    --output json \
    --yes
}

mint_coin() {
  local recipient_address="$1"
  local metadata_address="$2"
  local mint_amount="$3"

  run_cmd initiad tx move execute 0x1 managed_coin mint_to \
    --args "[\"address:${recipient_address}\",\"object:${metadata_address}\",\"u64:${mint_amount}\"]" \
    --from "$ACCOUNT_NAME" \
    --gas auto \
    --gas-adjustment "$GAS_ADJUSTMENT" \
    --gas-prices "$GAS_PRICES" \
    --node "$NODE" \
    --chain-id "$CHAIN_ID" \
    --output json \
    --yes
}

create_pair() {
  local pair_name="$1"
  local pair_symbol="$2"
  local swap_fee_rate="$3"
  local coin_a_weight="$4"
  local coin_b_weight="$5"
  local coin_a_metadata="$6"
  local coin_b_metadata="$7"
  local coin_a_amount="$8"
  local coin_b_amount="$9"

  run_cmd initiad tx move execute 0x1 dex create_pair_script \
    --args "[\"string:${pair_name}\",\"string:${pair_symbol}\",\"bigdecimal:${swap_fee_rate}\",\"bigdecimal:${coin_a_weight}\",\"bigdecimal:${coin_b_weight}\",\"object:${coin_a_metadata}\",\"object:${coin_b_metadata}\",\"u64:${coin_a_amount}\",\"u64:${coin_b_amount}\"]" \
    --from "$ACCOUNT_NAME" \
    --gas "$POOL_GAS_LIMIT" \
    --gas-adjustment "$GAS_ADJUSTMENT" \
    --gas-prices "$GAS_PRICES" \
    --node "$NODE" \
    --chain-id "$CHAIN_ID" \
    --output json \
    --yes
}

ensure_coin() {
  local coin_name="$1"
  local coin_symbol="$2"
  local coin_decimals="$3"
  local mint_amount="$4"
  local maximum_supply="$5"
  local icon_uri="$6"
  local project_uri="$7"
  local recipient_address="$8"
  local metadata_address=""
  local raw_output=""

  if raw_output="$(query_metadata "$ACCOUNT_ADDRESS" "$coin_symbol" 2>/dev/null)"; then
    if metadata_address="$(extract_hex64 "$raw_output")"; then
      log "Coin already exists: $coin_symbol -> $metadata_address"
    fi
  fi

  if [[ -z "$metadata_address" ]]; then
    log "Creating coin: $coin_name ($coin_symbol)"
    initialize_coin "$coin_name" "$coin_symbol" "$coin_decimals" "$maximum_supply" "$icon_uri" "$project_uri"

    for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
      if raw_output="$(query_metadata "$ACCOUNT_ADDRESS" "$coin_symbol" 2>/dev/null)" && metadata_address="$(extract_hex64 "$raw_output")"; then
        break
      fi
      sleep 2
    done
  fi

  if [[ -z "$metadata_address" ]]; then
    log "❌ Failed to resolve metadata object address for $coin_symbol"
    exit 1
  fi

  log "$coin_symbol metadata: $metadata_address"
  log "Minting $mint_amount of $coin_symbol to $recipient_address"

  local mint_output=""
  mint_output="$(mint_coin "$recipient_address" "$metadata_address" "$mint_amount")"
  if TX_HASH="$(extract_txhash "$mint_output")"; then
    log "$coin_symbol mint tx hash: $TX_HASH"
  fi

  printf '%s' "$metadata_address"
}

ensure_pool() {
  local pair_name="$1"
  local pair_symbol="$2"
  local swap_fee_rate="$3"
  local coin_a_weight="$4"
  local coin_b_weight="$5"
  local coin_a_metadata="$6"
  local coin_b_metadata="$7"
  local coin_a_amount="$8"
  local coin_b_amount="$9"
  local pool_address=""
  local raw_output=""

  if raw_output="$(query_metadata "$ACCOUNT_ADDRESS" "$pair_symbol" 2>/dev/null)"; then
    if pool_address="$(extract_hex64 "$raw_output")"; then
      log "Pool already exists: $pair_symbol -> $pool_address"
      printf '%s' "$pool_address"
      return 0
    fi
  fi

  log "Creating pool: $pair_name ($pair_symbol)"
  local create_output=""
  local tx_query_output=""
  create_output="$(create_pair "$pair_name" "$pair_symbol" "$swap_fee_rate" "$coin_a_weight" "$coin_b_weight" "$coin_a_metadata" "$coin_b_metadata" "$coin_a_amount" "$coin_b_amount")"
  if TX_HASH="$(extract_txhash "$create_output")"; then
    log "$pair_symbol create tx hash: $TX_HASH"

    # Fallback: resolve liquidity token directly from tx events when metadata indexing lags.
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      if tx_query_output="$(query_tx "$TX_HASH" 2>/dev/null)" && pool_address="$(extract_liquidity_token "$tx_query_output")"; then
        break
      fi
      sleep 2
    done
  fi

  if [[ -z "$pool_address" ]]; then
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
      if raw_output="$(query_metadata "$ACCOUNT_ADDRESS" "$pair_symbol" 2>/dev/null)" && pool_address="$(extract_hex64 "$raw_output")"; then
        break
      fi
      sleep 2
    done
  fi

  if [[ -z "$pool_address" ]]; then
    log "❌ Failed to resolve pool object address for $pair_symbol"
    exit 1
  fi

  log "$pair_symbol pool address: $pool_address"
  printf '%s' "$pool_address"
}

main() {
  if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
    usage
    exit 0
  fi

  if ! command -v initiad >/dev/null 2>&1; then
    log "❌ initiad not found in PATH"
    log "   Install it from https://github.com/initia-labs/initia/releases"
    exit 1
  fi

  if ! command -v python3 >/dev/null 2>&1; then
    log "❌ python3 not found in PATH"
    exit 1
  fi

  if ! ACCOUNT_ADDRESS="$(initiad keys show "$ACCOUNT_NAME" -a 2>/dev/null)"; then
    log "❌ Unable to resolve keyring account: $ACCOUNT_NAME"
    exit 1
  fi

  RECIPIENT_ADDRESS="${RECIPIENT_ADDRESS:-$ACCOUNT_ADDRESS}"

  if [[ "$DRY_RUN" == "1" ]]; then
    log "DRY_RUN=1: commands will be printed but not broadcast"
  fi

  log "Initia managed coin + pool bootstrap"
  log "  account   : $ACCOUNT_NAME"
  log "  sender    : $ACCOUNT_ADDRESS"
  log "  recipient : $RECIPIENT_ADDRESS"
  log "  network   : $CHAIN_ID"
  log "  node      : $NODE"
  log "  coin a    : $COIN_A_NAME ($COIN_A_SYMBOL)"
  log "  coin b    : $COIN_B_NAME ($COIN_B_SYMBOL)"
  log "  pool a    : $POOL_A_NAME ($POOL_A_SYMBOL)"
  log "  pool b    : $POOL_B_NAME ($POOL_B_SYMBOL)"

  if [[ "$DRY_RUN" == "1" ]]; then
    log "Dry run mode: planned steps"
    log "  1. initialize and mint $COIN_A_SYMBOL"
    log "  2. initialize and mint $COIN_B_SYMBOL"
    log "  3. create $POOL_A_SYMBOL with ${POOL_A_COIN_A_AMOUNT}:${POOL_A_COIN_B_AMOUNT}"
    log "  4. create $POOL_B_SYMBOL with ${POOL_B_COIN_A_AMOUNT}:${POOL_B_COIN_B_AMOUNT}"
    exit 0
  fi

  COIN_A_METADATA="$(ensure_coin "$COIN_A_NAME" "$COIN_A_SYMBOL" "$COIN_A_DECIMALS" "$COIN_A_MINT_AMOUNT" "$MAXIMUM_SUPPLY" "$COIN_ICON_URI" "$COIN_PROJECT_URI" "$RECIPIENT_ADDRESS")"
  COIN_B_METADATA="$(ensure_coin "$COIN_B_NAME" "$COIN_B_SYMBOL" "$COIN_B_DECIMALS" "$COIN_B_MINT_AMOUNT" "$MAXIMUM_SUPPLY" "$COIN_ICON_URI" "$COIN_PROJECT_URI" "$RECIPIENT_ADDRESS")"

  POOL_A_ADDRESS="$(ensure_pool "$POOL_A_NAME" "$POOL_A_SYMBOL" "$POOL_A_SWAP_FEE" "$POOL_A_COIN_A_WEIGHT" "$POOL_A_COIN_B_WEIGHT" "$COIN_A_METADATA" "$COIN_B_METADATA" "$POOL_A_COIN_A_AMOUNT" "$POOL_A_COIN_B_AMOUNT")"
  POOL_B_ADDRESS="$(ensure_pool "$POOL_B_NAME" "$POOL_B_SYMBOL" "$POOL_B_SWAP_FEE" "$POOL_B_COIN_A_WEIGHT" "$POOL_B_COIN_B_WEIGHT" "$COIN_A_METADATA" "$COIN_B_METADATA" "$POOL_B_COIN_A_AMOUNT" "$POOL_B_COIN_B_AMOUNT")"

  log ""
  log "Addresses"
  log "  coin a metadata: $COIN_A_METADATA"
  log "  coin b metadata: $COIN_B_METADATA"
  log "  pool a address : $POOL_A_ADDRESS"
  log "  pool b address : $POOL_B_ADDRESS"

  log "Done."
}

main "$@"