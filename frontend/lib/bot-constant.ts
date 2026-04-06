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
  SIGNING_RELAY_BASE: string;
  SESSION_KEY_MODE: string;
  INITIA_KEY: string;
  INITIA_RPC_URL: string;
  INITIA_NETWORK: string;
  USER_WALLET_ADDRESS: string;
  ONS_REGISTRY_ADDRESS: string;
  INITIA_BRIDGE_ADDRESS: string;
  INITIA_POOL_A_ADDRESS: string;
  INITIA_POOL_B_ADDRESS: string;
  INITIA_PRICE_VIEW_ADDRESS: string;
  INITIA_PRICE_VIEW_MODULE: string;
  INITIA_PRICE_VIEW_FUNCTION: string;
  INITIA_PRICE_VIEW_TYPE_ARGS: string;
  INITIA_PRICE_VIEW_ARGS: string;
  INITIA_SELL_VIEW_TYPE_ARGS: string;
  INITIA_FLASH_POOL_ADDRESS: string;
  INITIA_SWAP_ROUTER_ADDRESS: string;
  INITIA_SWAP_ROUTER_MODULE: string;
  INITIA_SWAP_ROUTER_FUNCTION: string;
  INITIA_SWAP_ROUTER_ARGS: string;
  INITIA_EXECUTION_AMOUNT_USDC: string;
  ESTIMATED_BRIDGE_FEE_USDC: string;
  OPENAI_API_KEY: string;
  POLL_INTERVAL: string;
  [key: string]: string;
}

export const DEFAULT_BOT_ENV_CONFIG: BotEnvConfig = {
  SIMULATION_MODE: "false",
  MCP_GATEWAY_URL: "http://192.168.1.50:8000/mcp",
  SIGNING_RELAY_BASE: "",
  SESSION_KEY_MODE: "false",
  INITIA_KEY: "",
  INITIA_RPC_URL: "",
  INITIA_NETWORK: "initia-testnet",
  USER_WALLET_ADDRESS: "",
  ONS_REGISTRY_ADDRESS: "0x1",
  INITIA_BRIDGE_ADDRESS: "",
  INITIA_POOL_A_ADDRESS: "",
  INITIA_POOL_B_ADDRESS: "",
  INITIA_PRICE_VIEW_ADDRESS: "0x1",
  INITIA_PRICE_VIEW_MODULE: "dex",
  INITIA_PRICE_VIEW_FUNCTION: "get_amount_out",
  INITIA_PRICE_VIEW_TYPE_ARGS: "",
  INITIA_PRICE_VIEW_ARGS: "$endpoint,$amount",
  INITIA_SELL_VIEW_TYPE_ARGS: "",
  INITIA_FLASH_POOL_ADDRESS: "",
  INITIA_SWAP_ROUTER_ADDRESS: "",
  INITIA_SWAP_ROUTER_MODULE: "arbitrage_router",
  INITIA_SWAP_ROUTER_FUNCTION: "execute_cross_chain_trade",
  INITIA_SWAP_ROUTER_ARGS: "$buyEndpoint,$sellEndpoint,$amount",
  INITIA_EXECUTION_AMOUNT_USDC: "1000000",
  ESTIMATED_BRIDGE_FEE_USDC: "5000",
  OPENAI_API_KEY: "",
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

export function getRequiredEnvFields(
  intent?: BotIntent | null,
  options?: { sessionKeyMode?: boolean },
): EnvFieldDef[] {
  const strategy = (intent?.strategy ?? "").toLowerCase();
  const botName = (intent?.bot_name ?? intent?.bot_type ?? "").toLowerCase();
  const sessionKeyMode = options?.sessionKeyMode ?? false;
  const mcps = Array.from(
    new Set([
      ...((intent?.mcps ?? []).map((m) => String(m || "").trim()).filter(Boolean)),
      ...((intent?.required_mcps ?? []).map((m) => String(m || "").trim()).filter(Boolean)),
    ]),
  );

  const isYield = strategy.includes("yield") || /sweep|consolidator/.test(botName);
  const isSpreadScanner = botName.includes("spread") && botName.includes("scanner");
  const isArbitrage = strategy.includes("arbitrage") || /arbitrage/.test(botName);

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
      key: "SIGNING_RELAY_BASE",
      label: "Signing Relay Base URL",
      type: "text",
      required: false,
      placeholder: "http://localhost:3000",
      helpText: "Base URL for /api/signing-relay. Leave blank to auto-use browser origin.",
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
      required: false,
      placeholder: "0x...",
      helpText: "Not used by the relay flow. move_execute is signed in the browser via AutoSign.",
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
        placeholder: "init1... or yourname.init",
        helpText: "Your Initia wallet address, or a .init name. It will be resolved automatically.",
      },
      {
        key: "ONS_REGISTRY_ADDRESS",
        label: "ONS Registry Address (Optional)",
        type: "text",
        required: false,
        placeholder: "0x1",
        helpText: "The ONS registry contract address. Defaults to 0x1 on testnet.",
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

  if (isSpreadScanner || isArbitrage) {
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
        key: "INITIA_PRICE_VIEW_TYPE_ARGS",
        label: "Price View Type Args",
        type: "text",
        required: true,
        placeholder: "0x1::coin::uinit,0x1::coin::uusdc",
        helpText: "Comma-separated Move type args required by your quote view (for example base/quote coin types).",
      },
      {
        key: "INITIA_SELL_VIEW_TYPE_ARGS",
        label: "Sell View Type Args (Optional)",
        type: "text",
        required: false,
        placeholder: "",
        helpText: "Optional comma-separated type args for sell-leg quote. Leave blank to auto-reverse buy type args.",
      },
      {
        key: "POLL_INTERVAL",
        label: "Poll Interval (seconds)",
        type: "text",
        required: false,
        placeholder: "15",
      },
      {
        key: "INITIA_SWAP_ROUTER_ADDRESS",
        label: "Execution Address",
        type: "text",
        required: isArbitrage,
        placeholder: "0x...",
        helpText: "Address of the module that executes the arbitrage transaction.",
      },
    );
  }


  if (intent?.requires_openai ?? intent?.requires_openai_key) {
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
