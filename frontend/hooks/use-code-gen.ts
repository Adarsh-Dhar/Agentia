import { useState } from "react";
import { GeneratedFile } from "../components/types";

export function useCodeGen(termRef: React.MutableRefObject<any>) {
  const [generatedFiles, setGeneratedFiles] = useState<GeneratedFile[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  const generateFiles = async () => {
    const term = termRef.current;
    if (!term) return;
    term.clear();
    term.writeln("\x1b[36m[System]\x1b[0m Calling AI code generator...");
    try {
      const res = await fetch("/api/get-code", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ intent: "Build a Flash Loan Arbitrageur on Arbitrum using Aave V3" }),
      });
      const data = await res.json();
      if (!data.files?.length) throw new Error("No files received from generator");
      setGeneratedFiles(data.files);
      const hasWorkflow = data.files.some((f: any) => (f.filepath || f.path) === "src/workflow.ts");
      if (!hasWorkflow && data.files.length > 0) {
        const firstFile = data.files[0].filepath || data.files[0].path;
        setSelectedFile(firstFile);
      } else {
        setSelectedFile("src/workflow.ts");
      }
      term.writeln("\x1b[32m[System]\x1b[0m " + data.files.length + " files generated successfully.");
      term.writeln("\x1b[33m[System]\x1b[0m Configure your environment variables, then click \x1b[1mLaunch Sandbox\x1b[0m.");
    } catch (err: unknown) {
      term.writeln("\x1b[31m[Error]\x1b[0m " + String(err instanceof Error ? err.message : err));
    }
  };

  return { generateFiles, generatedFiles, selectedFile, setSelectedFile };
}
