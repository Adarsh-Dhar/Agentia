import { useState, useRef } from "react";
import { parseFilesToTree } from "../utils/parseFilesToTree";
import { ENTRY_POINTS, NPMRC_CONTENT, TOKEN_ADDRESSES } from "../constants";
import { Phase, EnvConfig, GeneratedFile } from "../types";

let globalWebContainerInstance: any = null;

export function useSandbox({ generatedFiles, envConfig, termRef }: {
  generatedFiles: GeneratedFile[];
  envConfig: EnvConfig;
  termRef: React.MutableRefObject<any>;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [status, setStatus] = useState("Idle");
  const webcontainerRef = useRef<unknown>(null);

  const bootAndRun = async () => {
    const term = termRef.current;
    if (!term) return;
    setPhase("running");
    setStatus("Booting sandbox...");
    term.writeln("\x1b[36m[System]\x1b[0m Injecting environment and booting WebContainer...");
    try {
      if (!envConfig.EVM_RPC_URL || !envConfig.CONTRACT_ADDRESS) {
        term.writeln("\x1b[31m[Error]\x1b[0m Please fill in the RPC URL and Contract Address.");
        setPhase("env-setup");
        return;
      }
      const validHexKey = /^[0-9a-fA-F]{64}$/.test(envConfig.EVM_PRIVATE_KEY.replace('0x', '')) 
        ? envConfig.EVM_PRIVATE_KEY 
        : "0000000000000000000000000000000000000000000000000000000000000000";
      const envContent = [
        `DRY_RUN=${envConfig.DRY_RUN}`,
        `EVM_RPC_URL=${envConfig.EVM_RPC_URL}`,
        `EVM_PRIVATE_KEY=${validHexKey}`,
        `CONTRACT_ADDRESS=${envConfig.CONTRACT_ADDRESS}`,
        `MAX_LOAN_USD=${envConfig.MAX_LOAN_USD}`,
        `MIN_PROFIT_USD=${envConfig.MIN_PROFIT_USD}`,
        `POLL_MS=3000`,
      ].join("\n");
      const finalFiles = [
        ...generatedFiles.filter(f => f.filepath !== ".env" && f.filepath !== ".npmrc"),
        { filepath: ".env",   content: envContent },
        { filepath: ".npmrc", content: NPMRC_CONTENT },
      ];
      // Sync the ref for local component usage
      webcontainerRef.current = globalWebContainerInstance;
      const { WebContainer } = await import("@webcontainer/api");
      if (!globalWebContainerInstance) {
        try {
          globalWebContainerInstance = await Promise.race([
            (WebContainer as { boot: () => Promise<unknown> }).boot(),
            new Promise((_, reject) => setTimeout(() => reject(new Error("WebContainer Boot Timeout")), 15000))
          ]);
        } catch (bootErr: any) {
          if (bootErr?.message?.includes("Only a single WebContainer instance")) {
            throw new Error("WebContainer is already running in the background. Please hard refresh the page (Cmd/Ctrl + R). ");
          }
          throw bootErr;
        }
      }
      await new Promise(r => setTimeout(r, 500));
      const wc = webcontainerRef.current as any;
      try {
        await wc.mount(parseFilesToTree(finalFiles));
      } catch (mountErr: any) {
        throw new Error(`Failed to mount files. The LLM likely generated invalid paths or used native FS modules. Details: ${mountErr.message}`);
      }
      setStatus("Installing packages...");
      term.writeln("\x1b[36m[System]\x1b[0m npm install --legacy-peer-deps");
      const install = await wc.spawn("jsh", ["-c", "npm install --loglevel=error --legacy-peer-deps --no-fund"], {
        env: { npm_config_yes: "true" },
      });
      install.output.pipeTo(new WritableStream({ write(chunk: any) { term.write(chunk); } }));
      const installCode = await install.exit;
      if (installCode !== 0) {
        setStatus("Install failed");
        term.writeln("\x1b[31m[Error]\x1b[0m npm install failed (exit " + installCode + ")");
        setPhase("env-setup");
        return;
      }
      const processEnv = {
        EVM_RPC_URL:      envConfig.EVM_RPC_URL,
        EVM_PRIVATE_KEY:  validHexKey,
        CONTRACT_ADDRESS: envConfig.CONTRACT_ADDRESS || "NOT_DEPLOYED_YET",
        MAX_LOAN_USD:     envConfig.MAX_LOAN_USD,
        MIN_PROFIT_USD:   envConfig.MIN_PROFIT_USD,
        DRY_RUN:          envConfig.DRY_RUN,
        POLL_MS:          "3000",
        ...TOKEN_ADDRESSES,
        RPC_URL:          envConfig.EVM_RPC_URL,
        PRIVATE_KEY:      validHexKey,
        SOL_CONTRACT_PATH: "contracts/FlashLoanReceiver.sol"
      };
      const actualFiles = finalFiles.map(f => (f.filepath || (f as any).path || "").replace(/^[./]+/, ""));
      const foundEntry = ENTRY_POINTS.find(p => actualFiles.includes(p)) || 
                         actualFiles.find(f => f.endsWith(".ts") && !f.includes("config") && !f.includes("types") && !f.includes("shared")) || 
                         "src/agent/index.ts";
      setStatus("Bot running...");
      term.writeln(`\n\x1b[36m[System]\x1b[0m Detected entry point: \x1b[1m${foundEntry}\x1b[0m`);
      const run = await wc.spawn("jsh", ["-c", `npx tsx ${foundEntry}`], {
        env: processEnv
      });
      run.output.pipeTo(new WritableStream({ write(chunk: any) { term.write(chunk); } }));
      const exitCode = await run.exit;
      if (exitCode !== 0) {
        term.writeln(`\n\x1b[31m[Error]\x1b[0m Bot crashed with exit code ${exitCode}`);
        setStatus("Crashed");
      } else {
        setStatus("Finished");
      }
    } catch (err: unknown) {
      setStatus("Error");
      term.writeln("\x1b[31m[Error]\x1b[0m " + String(err instanceof Error ? err.message : err));
      setPhase("env-setup");
    }
  };

  return { bootAndRun, phase, status, setPhase, setStatus };
}
