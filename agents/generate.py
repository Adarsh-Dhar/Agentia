
import requests
import json
import os
from datetime import datetime

PROMPT = """
Write an autonomous arbitrage bot. 
Run a continuous async loop. Every 5 seconds, use 1inch to check the price difference for USDC and WETH. 
If profitable, verify the tokens using Webacy. 
Finally, use GOAT to trigger the flash loan smart contract.
"""

print("🧠 Sending request to Meta-Agent...")

response = requests.post(
    "http://127.0.0.1:8000/create-bot",
    json={"prompt": PROMPT},
    headers={"accept": "application/json"}
)

if response.status_code == 200:
    data = response.json()
    output = data.get("output", {})
    # Always create a timestamped folder
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    folder = f"arbitrage_bot_{timestamp}"
    os.makedirs(folder, exist_ok=True)

    # Try to get the main code from files, else save error
    files = output.get("files", [])
    if files and isinstance(files, list) and "content" in files[0]:
        for idx, file in enumerate(files):
            # Use provided filename if present, else default to main.py
            fname = file.get("filepath") or f"main_{idx}.py"
            # Always write inside the timestamped folder
            outpath = os.path.join(folder, os.path.basename(fname))
            with open(outpath, "w") as f:
                f.write(file["content"])
            print(f"✅ Generated and saved: {outpath}")
        print(f"💡 AI Thoughts: {output.get('thoughts')}\n")
    else:
        # Save error output to main.py in the folder
        err_content = output.get("files", [{}])[0].get("content") or str(output)
        outpath = os.path.join(folder, "main.py")
        with open(outpath, "w") as f:
            f.write(err_content)
        print(f"❌ AI failed to format as JSON. Raw output saved to {outpath}")
else:
    print(f"❌ HTTP Error: {response.status_code}")