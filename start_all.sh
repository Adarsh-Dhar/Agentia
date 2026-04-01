#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENTS_DIR="$ROOT_DIR/agents"
FRONTEND_DIR="$ROOT_DIR/frontend"

AGENT_PORT="${AGENT_PORT:-8000}"
FRONTEND_PORT="${FRONTEND_PORT:-3000}"
AUTO_KILL_PORTS="${AUTO_KILL_PORTS:-true}"

AGENT_PID=""
FRONTEND_PID=""

log() {
  printf '[start_all] %s\n' "$*"
}

find_listener_pid() {
  local port="$1"
  lsof -nP -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | head -n 1 || true
}

kill_process_tree() {
  local pid="$1"
  local children

  if [[ -z "$pid" ]] || ! kill -0 "$pid" 2>/dev/null; then
    return 0
  fi

  children="$(pgrep -P "$pid" || true)"
  for child in $children; do
    kill_process_tree "$child"
  done

  kill -TERM "$pid" 2>/dev/null || true
}

force_kill_process_tree() {
  local pid="$1"
  local children

  if [[ -z "$pid" ]] || ! kill -0 "$pid" 2>/dev/null; then
    return 0
  fi

  children="$(pgrep -P "$pid" || true)"
  for child in $children; do
    force_kill_process_tree "$child"
  done

  kill -KILL "$pid" 2>/dev/null || true
}

cleanup() {
  set +e
  log "Shutting down services..."

  kill_process_tree "$AGENT_PID"
  kill_process_tree "$FRONTEND_PID"
  sleep 2
  force_kill_process_tree "$AGENT_PID"
  force_kill_process_tree "$FRONTEND_PID"

  local pid
  pid="$(find_listener_pid "$AGENT_PORT")"
  if [[ -n "$pid" ]]; then
    kill -TERM "$pid" 2>/dev/null || true
  fi

  pid="$(find_listener_pid "$FRONTEND_PORT")"
  if [[ -n "$pid" ]]; then
    kill -TERM "$pid" 2>/dev/null || true
  fi

  log "Cleanup complete."
}

trap cleanup EXIT INT TERM

if [[ ! -d "$AGENTS_DIR" ]]; then
  log "Missing agents directory: $AGENTS_DIR"
  exit 1
fi

if [[ ! -d "$FRONTEND_DIR" ]]; then
  log "Missing frontend directory: $FRONTEND_DIR"
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  log "pnpm not found. Install pnpm and try again."
  exit 1
fi

if [[ "$AUTO_KILL_PORTS" == "true" ]]; then
  pid="$(find_listener_pid "$AGENT_PORT")"
  if [[ -n "$pid" ]]; then
    log "Port $AGENT_PORT is busy (PID $pid). Stopping existing process..."
    kill -TERM "$pid" 2>/dev/null || true
    sleep 1
  fi

  pid="$(find_listener_pid "$FRONTEND_PORT")"
  if [[ -n "$pid" ]]; then
    log "Port $FRONTEND_PORT is busy (PID $pid). Stopping existing process..."
    kill -TERM "$pid" 2>/dev/null || true
    sleep 1
  fi
fi

log "Starting Meta-Agent on port $AGENT_PORT..."
(
  cd "$AGENTS_DIR"
  if [[ -f ".venv/bin/activate" ]]; then
    # shellcheck disable=SC1091
    source .venv/bin/activate
  fi
  exec uvicorn main:app --port "$AGENT_PORT"
) &
AGENT_PID="$!"

log "Starting frontend on port $FRONTEND_PORT..."
(
  cd "$FRONTEND_DIR"
  exec pnpm exec next dev -p "$FRONTEND_PORT"
) &
FRONTEND_PID="$!"

log "Both services started."
log "Frontend: http://127.0.0.1:$FRONTEND_PORT"
log "Meta-Agent: http://127.0.0.1:$AGENT_PORT"
log "Press Ctrl+C to stop both cleanly."

while true; do
  if ! kill -0 "$AGENT_PID" 2>/dev/null; then
    log "Meta-Agent process exited."
    break
  fi

  if ! kill -0 "$FRONTEND_PID" 2>/dev/null; then
    log "Frontend process exited."
    break
  fi

  sleep 1
done

exit 1
