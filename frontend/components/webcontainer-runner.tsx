"use client";

import { useState, useRef } from "react";


// Helper: Converts flat [{filepath, content}] into WebContainer's nested tree format
// Helper: Converts flat [{filepath, content}] into WebContainer's nested tree format
function parseFilesToTree(files: { filepath: string; content: string }[]): any {
  const tree: any = {};

  for (const file of files) {
    const parts = file.filepath.split("/");
    let currentLevel: any = tree;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isFile = i === parts.length - 1;

      if (isFile) {
        currentLevel[part] = { file: { contents: file.content } };
      } else {
        if (!currentLevel[part]) {
          currentLevel[part] = { directory: {} };
        }
        currentLevel = currentLevel[part].directory;
      }
    }
  }
  return tree;
}

export function WebContainerRunner() {
  const [status, setStatus] = useState("Idle");
  const [logs, setLogs] = useState<string[]>([]);
  const containerRef = useRef<any>(null);

  const generateAndRun = async () => {
    setStatus("Generating code via AI...");

    // Dynamically import @webcontainer/api only in the browser
    let WebContainer;
    if (typeof window !== "undefined") {
      WebContainer = (await import("@webcontainer/api")).WebContainer;
    } else {
      setStatus("WebContainer can only run in the browser.");
      return;
    }

    // 1. Fetch the code from our new API route
    const res = await fetch("/api/get-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        intent: "Build a Flash Loan Arbitrageur on Solana using Jupiter and Aave.",
      }),
    });
    const data = await res.json();

    if (!data.files) {
      setStatus("Error: Failed to generate files.");
      return;
    }

    setStatus("Booting WebContainer Sandbox...");

    // 2. Boot WebContainer (Ensure it only boots once)
    if (!containerRef.current) {
      containerRef.current = await WebContainer.boot();
    }
    const webcontainerInstance = containerRef.current;

    // 3. Mount the files into the virtual filesystem
    const fileSystemTree = parseFilesToTree(data.files);
    await webcontainerInstance.mount(fileSystemTree);
    setStatus("Files mounted. Installing dependencies (this takes a moment)...");

    // 4. Run `npm install`
    const installProcess = await webcontainerInstance.spawn("npm", ["install"]);
    installProcess.output.pipeTo(
      new WritableStream({
        write(data) {
          setLogs((prev) => [...prev, data]);
        },
      })
    );
    await installProcess.exit;

    setStatus("Running bot...");

    // 5. Run the bot (assuming package.json has a "start" script)
    const startProcess = await webcontainerInstance.spawn("npm", ["start"]);
    startProcess.output.pipeTo(
      new WritableStream({
        write(data) {
          setLogs((prev) => [...prev, data]);
        },
      })
    );
  };

  return (
    <div className="p-6 bg-slate-900 text-white rounded-xl space-y-4 font-mono">
      <h2 className="text-xl font-bold">Meta-Agent Execution Environment</h2>
      
      <div className="flex items-center space-x-4">
        <button 
          onClick={generateAndRun}
          className="bg-blue-600 hover:bg-blue-500 px-4 py-2 rounded text-sm font-semibold transition"
        >
          Generate & Run Bot
        </button>
        <span className="text-sm text-slate-400">Status: {status}</span>
      </div>

      <div className="bg-black p-4 rounded-lg h-96 overflow-y-auto whitespace-pre-wrap text-sm text-green-400 border border-slate-700">
        {logs.length === 0 ? "Terminal output will appear here..." : logs.join("")}
      </div>
    </div>
  );
}
