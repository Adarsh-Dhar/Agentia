#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENTS_DIR="$ROOT_DIR/agents"
FRONTEND_DIR="$ROOT_DIR/frontend"

AGENT_PORT="${AGENT_PORT:-8000}"
FRONTEND_PORT="${FRONTEND_PORT:-3000}"
MCP_PORT="${MCP_PORT:-8001}"
AUTO_KILL_PORTS="${AUTO_KILL_PORTS:-true}"

AGENT_PID=""
MCP_PID=""
FRONTEND_PID=""
SERVICES_STARTED=0
MCP_READY=0
FRONTEND_READY=0

wait_for_http() {
  local url_primary="$1"
  local url_fallback="$2"
  local timeout_seconds="$3"

  for ((i = 1; i <= timeout_seconds; i++)); do
    if curl -s --max-time 2 "$url_primary" >/dev/null 2>&1; then
      return 0
    fi
    if [[ -n "$url_fallback" ]] && curl -s --max-time 2 "$url_fallback" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done

  return 1
}

log() {
  printf '[start_all] %s\n' "$*"
}

error() {
  printf '[start_all] ❌ ERROR: %s\n' "$*" >&2
}

success() {
  printf '[start_all] ✓ %s\n' "$*"
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

  if [[ "$SERVICES_STARTED" -eq 1 ]]; then
    kill_process_tree "$MCP_PID"
    kill_process_tree "$AGENT_PID"
    kill_process_tree "$FRONTEND_PID"
    sleep 2
    force_kill_process_tree "$MCP_PID"
    force_kill_process_tree "$AGENT_PID"
    force_kill_process_tree "$FRONTEND_PID"
  fi

  local pid
  pid="$(find_listener_pid "$MCP_PORT")"
  if [[ -n "$pid" ]]; then
    log "Killing lingering process on port $MCP_PORT (PID $pid)..."
    kill -TERM "$pid" 2>/dev/null || true
  fi

  pid="$(find_listener_pid "$AGENT_PORT")"
  if [[ -n "$pid" ]]; then
    log "Killing lingering process on port $AGENT_PORT (PID $pid)..."
    kill -TERM "$pid" 2>/dev/null || true
  fi

  pid="$(find_listener_pid "$FRONTEND_PORT")"
  if [[ -n "$pid" ]]; then
    log "Killing lingering process on port $FRONTEND_PORT (PID $pid)..."
    kill -TERM "$pid" 2>/dev/null || true
  fi

  success "Cleanup complete."
}

trap cleanup EXIT INT TERM

if [[ ! -d "$AGENTS_DIR" ]]; then
  error "Missing agents directory: $AGENTS_DIR"
  exit 1
fi

if [[ ! -d "$FRONTEND_DIR" ]]; then
  error "Missing frontend directory: $FRONTEND_DIR"
  exit 1
fi

# Check for Python 3.8+
if ! command -v python3 >/dev/null 2>&1; then
  error "Python 3 not found. Please install Python 3.8 or later."
  exit 1
fi

# Check for pnpm
if ! command -v pnpm >/dev/null 2>&1; then
  error "pnpm not found. Install pnpm and try again (npm install -g pnpm)"
  exit 1
fi

# Ensure agents venv exists
log "Setting up Python environment..."
if [[ ! -d "$AGENTS_DIR/.venv" ]]; then
  log "Creating virtual environment at $AGENTS_DIR/.venv..."
  cd "$AGENTS_DIR"
  python3 -m venv .venv || {
    error "Failed to create virtual environment"
    exit 1
  }
  cd "$ROOT_DIR"
fi

# Activate venv and install dependencies
log "Installing Python dependencies..."
(
  cd "$AGENTS_DIR"
  source .venv/bin/activate
  pip install -q uvicorn fastapi openai 2>/dev/null || true
) || {
  error "Failed to install Python dependencies"
  exit 1
}

# Check frontend dependencies
log "Checking frontend dependencies..."
if [[ ! -d "$FRONTEND_DIR/node_modules" ]]; then
  log "Installing frontend dependencies with pnpm..."
  (
    cd "$FRONTEND_DIR"
    pnpm install --frozen-lockfile 2>&1 | head -20
  ) || {
    error "Failed to install frontend dependencies"
  }
fi

if [[ "$AUTO_KILL_PORTS" == "true" ]]; then
  pid="$(find_listener_pid "$MCP_PORT")"
  if [[ -n "$pid" ]]; then
    log "Port $MCP_PORT is busy (PID $pid). Stopping existing process..."
    kill -TERM "$pid" 2>/dev/null || true
    sleep 1
  fi

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

# Check and install MCP server dependencies
log "Checking MCP server dependencies..."
if [[ ! -d "$AGENTS_DIR/initia-mcp-server/node_modules" ]]; then
  log "Installing MCP server dependencies with npm..."
  (
    cd "$AGENTS_DIR/initia-mcp-server"
    npm install 2>&1 | head -20
  ) || {
    error "Failed to install MCP server dependencies"
    exit 1
  }
fi

log "Starting native Initia MCP server on port $MCP_PORT..."
(
  cd "$AGENTS_DIR/initia-mcp-server"
  exec npm run dev 2>&1
) &
MCP_PID="$!"

log "Waiting for MCP server to be ready..."
if wait_for_http "http://127.0.0.1:$MCP_PORT/health" "http://localhost:$MCP_PORT/health" 15; then
  MCP_READY=1
  success "MCP server is ready!"
else
  error "MCP server failed to start (health check timed out after 15s)"
  kill "$MCP_PID" 2>/dev/null || true
  exit 1
fi

log "Starting Meta-Agent on port $AGENT_PORT..."
(
  cd "$AGENTS_DIR"
  source .venv/bin/activate
  exec uvicorn main:app --port "$AGENT_PORT" --host 127.0.0.1 2>&1
) &
AGENT_PID="$!"

log "Waiting for Meta-Agent to be ready..."
if wait_for_http "http://127.0.0.1:$AGENT_PORT/health" "http://localhost:$AGENT_PORT/health" 30; then
  success "Meta-Agent is ready!"
else
  error "Meta-Agent failed to start (health check timed out after 30s)"
  kill "$AGENT_PID" 2>/dev/null || true
  exit 1
fi

log "Starting frontend on port $FRONTEND_PORT..."
(
  cd "$FRONTEND_DIR"
  exec pnpm exec next dev -H 127.0.0.1 -p "$FRONTEND_PORT" 2>&1
) &
FRONTEND_PID="$!"

log "Waiting for frontend to be ready..."
if wait_for_http "http://127.0.0.1:$FRONTEND_PORT" "http://localhost:$FRONTEND_PORT" 45; then
  FRONTEND_READY=1
  success "Frontend is ready!"
else
  error "Frontend failed to start (health check timed out after 45s)"
  kill "$FRONTEND_PID" 2>/dev/null || true
  exit 1
fi

SERVICES_STARTED=1
AGENT_STUCK_COUNT=0
FRONTEND_STUCK_COUNT=0

if [[ "$FRONTEND_READY" -ne 1 ]]; then
  error "Frontend readiness check failed. Exiting."
  exit 1
fi

success "All services started successfully!"
log "MCP Server: http://127.0.0.1:$MCP_PORT"
log "Meta-Agent: http://127.0.0.1:$AGENT_PORT"
log "Frontend: http://127.0.0.1:$FRONTEND_PORT"
log "Press Ctrl+C to stop all cleanly."

while true; do
  if ! kill -0 "$AGENT_PID" 2>/dev/null; then
    error "Meta-Agent process exited unexpectedly."
    break
  fi

  if ! kill -0 "$FRONTEND_PID" 2>/dev/null; then
    error "Frontend process exited unexpectedly."
    break
  fi

  # Monitor health of Agent (warn-only: avoid killing valid long-running generation requests)
  agent_health=$(curl -s -m 5 "http://127.0.0.1:$AGENT_PORT/health" 2>/dev/null || echo "")
  if [[ -z "$agent_health" || ! "$agent_health" == *"ok"* ]]; then
    ((AGENT_STUCK_COUNT++))
    if [[ $AGENT_STUCK_COUNT -ge 3 ]]; then
      error "Meta-Agent health check failed 3x in a row (process still running)."
      AGENT_STUCK_COUNT=0
    fi
  else
    AGENT_STUCK_COUNT=0
  fi

  sleep 5
done

exit 1
