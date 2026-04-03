/**
 * Initia-only bot intent and env configuration.
 */

export interface BotIntent {
  chain?: "initia";
  network?: string;
  execution_model?: "polling" | "agentic";
  strategy?: string;
  mcps?: string[];
  bot_name?: string;
  requires_openai?: boolean;
  required_mcps?: string[];
  bot_type?: string;
  requires_openai_key?: boolean;
}

export interface BotEnvConfig {
  SIMULATION_MODE: string;
  MCP_GATEWAY_URL: string;
  INITIA_KEY: string;
  INITIA_RPC_URL: string;
  INITIA_NETWORK: string;
  USER_WALLET_ADDRESS: string;
  INITIA_BRIDGE_ADDRESS: string;
  INITIA_POOL_A_ADDRESS: string;
  INITIA_POOL_B_ADDRESS: string;
  INITIA_FLASH_POOL_ADDRESS: string;
  INITIA_SWAP_ROUTER_ADDRESS: string;
  OPENAI_API_KEY: string;
  LUNARCRUSH_API_KEY: string;
  POLL_INTERVAL: string;
  [key: string]: string;
}

export const DEFAULT_BOT_ENV_CONFIG: BotEnvConfig = {
  SIMULATION_MODE: "false",
  MCP_GATEWAY_URL: "http://192.168.1.50:8000/mcp",
  INITIA_KEY: "",
  INITIA_RPC_URL: "",
  INITIA_NETWORK: "initia-testnet",
  USER_WALLET_ADDRESS: "",
  INITIA_BRIDGE_ADDRESS: "",
  INITIA_POOL_A_ADDRESS: "",
  INITIA_POOL_B_ADDRESS: "",
  INITIA_FLASH_POOL_ADDRESS: "",
  INITIA_SWAP_ROUTER_ADDRESS: "",
  OPENAI_API_KEY: "",
  LUNARCRUSH_API_KEY: "",
  POLL_INTERVAL: "15",
};

export interface EnvFieldDef {
  key: string;
  label: string;
  type: "text" | "password" | "toggle";
  required: boolean;
  placeholder?: string;
  helpText?: string;
  helpLink?: string;
  helpLinkLabel?: string;
}

export const BOT_NPMRC = "fund=false\naudit=false\n";

export function getRequiredEnvFields(intent?: BotIntent | null): EnvFieldDef[] {
  const strategy = (intent?.strategy ?? "").toLowerCase();
  const botName = (intent?.bot_name ?? intent?.bot_type ?? "").toLowerCase();
  const mcps = Array.from(
    new Set([
      ...((intent?.mcps ?? []).map((m) => String(m || "").trim()).filter(Boolean)),
      ...((intent?.required_mcps ?? []).map((m) => String(m || "").trim()).filter(Boolean)),
    ]),
  );

  const isYield = strategy.includes("yield") || /sweep|consolidator/.test(botName);
  const isSpreadScanner = botName.includes("spread") && botName.includes("scanner");

  const fields: EnvFieldDef[] = [
    {
      key: "MCP_GATEWAY_URL",
      label: "MCP Gateway URL",
      type: "text",
      required: true,
      placeholder: "http://192.168.1.50:8000/mcp",
      helpText: "URL of the running Meta-Agent gateway.",
    },
    {
      key: "SIMULATION_MODE",
      label: "Execution Mode",
      type: "toggle",
      required: false,
      placeholder: "true",
      helpText: "Simulation mode avoids sending real transactions.",
    },
    {
      key: "INITIA_KEY",
      label: "Initia Private Key",
      type: "password",
      required: true,
      placeholder: "0x...",
      helpText: "Required for move_execute signing via Initia MCP.",
    },
    {
      key: "INITIA_RPC_URL",
      label: "Initia RPC URL (Optional)",
      type: "text",
      required: false,
      placeholder: "https://rpc.testnet.initia.xyz/",
      helpText: "Optional Initia RPC override.",
    },
    {
      key: "INITIA_NETWORK",
      label: "Initia Network",
      type: "text",
      required: false,
      placeholder: "initia-testnet",
      helpText: "initia-testnet or initia-mainnet.",
    },
  ];

  if (isYield) {
    fields.push(
      {
        key: "USER_WALLET_ADDRESS",
        label: "User Wallet Address",
        type: "text",
        required: true,
        placeholder: "init1...",
      },
      {
        key: "INITIA_BRIDGE_ADDRESS",
        label: "Initia Bridge Address",
        type: "text",
        required: true,
        placeholder: "0x...",
      },
    );
  }

  if (isSpreadScanner) {
    fields.push(
      {
        key: "INITIA_POOL_A_ADDRESS",
        label: "Pool A Address",
        type: "text",
        required: true,
      },
      {
        key: "INITIA_POOL_B_ADDRESS",
        label: "Pool B Address",
        type: "text",
        required: true,
      },
      {
        key: "POLL_INTERVAL",
        label: "Poll Interval (seconds)",
        type: "text",
        required: false,
        placeholder: "15",
      },
    );
  }

  if (mcps.includes("lunarcrush") || strategy.includes("sentiment")) {
    fields.push({
      key: "LUNARCRUSH_API_KEY",
      label: "LunarCrush API Key",
      type: "password",
      required: false,
      placeholder: "your-lunarcrush-api-key",
    });
  }

  if (Boolean(intent?.requires_openai ?? intent?.requires_openai_key)) {
    fields.push({
      key: "OPENAI_API_KEY",
      label: "OpenAI API Key",
      type: "password",
      required: true,
      placeholder: "sk-...",
    });
  }

  return fields;
}
