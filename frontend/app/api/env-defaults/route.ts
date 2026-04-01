import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";

function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    const hash = value.indexOf(" #");
    if (hash >= 0) value = value.slice(0, hash).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key) out[key] = value;
  }

  return out;
}

export async function GET() {
  try {
    const envPath = path.resolve(process.cwd(), "../agents/.env");
    const envText = fs.readFileSync(envPath, "utf8");
    const values = parseEnvText(envText);
    return NextResponse.json({ values });
  } catch {
    return NextResponse.json({ values: {} });
  }
}
