"""
agents/generate.py

Triggers the Meta-Agent to scaffold a production-ready arbitrage bot.
Run from inside agents/:  python generate.py
"""

import requests
import os
from datetime import datetime

PROMPT = """
Write an autonomous arbitrage bot for Base Sepolia.
Run a continuous async loop every 5 seconds.
Use 1inch get_quote to check the USDC->WETH->USDC round-trip price.
Calculate net profit after the 0.09% Aave flash loan fee and a 2 USDC gas buffer.
All math must use integers (base units) only.
If profitable, verify both tokens with Webacy get_token_risk (chain="base-sepolia").
Only proceed if both tokens are low risk (risk=="low" OR score<20).
Get swap calldata from 1inch get_swap_data using tokenIn/tokenOut keys.
Execute via goat_evm write_contract using the "address" key (not contractAddress).
Use structured logging. Call convert_to_base_units at startup. Include SIMULATION_MODE.
"""

SERVER_URL = "http://127.0.0.1:8000/create-bot"

print("🧠 Sending request to Meta-Agent...")

try:
    response = requests.post(
        SERVER_URL,
        json={"prompt": PROMPT},
        headers={"accept": "application/json"},
        timeout=120,
    )
except requests.exceptions.ConnectionError:
    print("❌ Cannot connect to http://127.0.0.1:8000")
    print("   Start the server first:  uvicorn main:app --reload")
    raise SystemExit(1)
except requests.exceptions.Timeout:
    print("❌ Request timed out after 120 s.")
    raise SystemExit(1)

if response.status_code != 200:
    print(f"❌ HTTP {response.status_code}: {response.text}")
    raise SystemExit(1)

data        = response.json()
output      = data.get("output", {})
tools_used  = data.get("tools_used", [])

# ── Create timestamped output directory ───────────────────────────────────────
timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
folder    = f"arbitrage_bot_{timestamp}"
os.makedirs(folder, exist_ok=True)

print(f"\n📁 Output: {folder}/")
print(f"🔧 Tools:  {', '.join(tools_used) if tools_used else 'none'}")
print(f"\n💡 {output.get('thoughts', 'N/A')}\n")

# ── Save generated files ──────────────────────────────────────────────────────
EXPECTED = {"config.py", "mcp_bridge.py", "arbitrage.py", "main.py"}
saved    = set()

for file in output.get("files", []):
    filepath = file.get("filepath", "unknown.py")
    content  = file.get("content", "")
    filename = os.path.basename(filepath)
    outpath  = os.path.join(folder, filename)
    with open(outpath, "w") as f:
        f.write(content)
    saved.add(filename)
    print(f"  ✅ {filename:<20} ({len(content.splitlines())} lines)")

# ── Validation report ─────────────────────────────────────────────────────────
missing = EXPECTED - saved
if missing:
    print(f"\n⚠️  Missing files: {', '.join(sorted(missing))}")
else:
    print(f"\n🎉 All {len(EXPECTED)} production files generated successfully!")

# ── Write requirements.txt ────────────────────────────────────────────────────
with open(os.path.join(folder, "requirements.txt"), "w") as f:
    f.write("# MCP servers handle all heavy blockchain calls.\n")
    f.write("# Only lightweight runtime deps needed:\n")
    f.write("python-dotenv\n")

print(f"\n🚀 To run:  cd {folder} && python main.py")
print(f"🧪 Dry-run: cd {folder} && SIMULATION_MODE=true python main.py")