import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { MsgExecuteJSON, RESTClient, Wallet, RawKey, AccAddress } from '@initia/initia.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../../.env') });

const app = express();
app.use(express.json());
app.use(cors());

const PORT = 8001;
const HOST = '127.0.0.1';

function resolveLcdUrl(): string {
  const configuredLcd = String(process.env.INITIA_LCD_URL ?? '').trim();
  if (configuredLcd) return configuredLcd;

  // Some setups only provide RPC URL; map common RPC hosts to LCD hosts when possible.
  const rpcUrl = String(process.env.INITIA_RPC_URL ?? '').trim();
  if (rpcUrl.includes('polkachu.com')) {
    return rpcUrl
      .replace('initia-testnet-rpc.polkachu.com', 'initia-testnet-api.polkachu.com')
      .replace('initia-rpc.polkachu.com', 'initia-api.polkachu.com');
  }

  return 'https://lcd.testnet.initia.xyz';
}

const INITIA_LCD_URL = resolveLcdUrl();
const restClient = new RESTClient(INITIA_LCD_URL);

let wallet: Wallet | null = null;
const keyHex = String(process.env.INITIA_KEY ?? '').trim();
if (keyHex) {
  try {
    const normalized = keyHex.startsWith('0x') ? keyHex.slice(2) : keyHex;
    wallet = new Wallet(restClient, new RawKey(Buffer.from(normalized, 'hex')));
  } catch (error) {
    log('WARN', 'INITIA_KEY is set but could not initialize wallet', error instanceof Error ? error.message : String(error));
  }
}

// Logging utility
function log(level: string, msg: string, data?: unknown): void {
  const timestamp = new Date().toISOString();
  const dataStr = data ? ' ' + JSON.stringify(data).substring(0, 300) : '';
  console.log(`[${timestamp}] [MCP-${level}] ${msg}${dataStr}`);
}

// Helper: Parse string array or comma-separated
function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(v => String(v).trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value.split(',').map(v => v.trim()).filter(Boolean);
  }
  return [];
}

function describeError(error: unknown): string {
  if (!error || typeof error !== 'object') {
    return String(error ?? 'unknown error');
  }

  const maybe = error as {
    message?: unknown;
    response?: {
      status?: unknown;
      statusText?: unknown;
      data?: unknown;
    };
  };

  const message = typeof maybe.message === 'string' ? maybe.message : String(maybe.message ?? 'unknown error');
  const status = maybe.response?.status;
  const statusText = maybe.response?.statusText;
  const data = maybe.response?.data;

  if (status !== undefined || data !== undefined) {
    const parts: string[] = [];
    if (status !== undefined) parts.push(`status=${String(status)}`);
    if (statusText !== undefined && String(statusText).trim()) parts.push(`statusText=${String(statusText)}`);
    if (data !== undefined) {
      const detail = typeof data === 'string' ? data : JSON.stringify(data);
      parts.push(`data=${detail.substring(0, 500)}`);
    }
    return `${message} (${parts.join(', ')})`;
  }

  return message;
}

function toMoveJsonArg(value: string): string {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return '""';

  const looksLikeJson =
    trimmed.startsWith('"') ||
    trimmed.startsWith('{') ||
    trimmed.startsWith('[') ||
    trimmed === 'true' ||
    trimmed === 'false' ||
    trimmed === 'null' 

  return looksLikeJson ? trimmed : JSON.stringify(trimmed);
}

function normalizeMoveAddress(value: string): string {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith('0x')) return trimmed.toLowerCase();
  if (trimmed.startsWith('init1')) {
    try {
      return AccAddress.toHex(trimmed).toLowerCase();
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

function toBigInt(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed || !/^[0-9]+$/.test(trimmed)) return null;
    try {
      return BigInt(trimmed);
    } catch {
      return null;
    }
  }
  return null;
}

function extractBalanceFromViewResult(payload: unknown): bigint | null {
  if (!payload || typeof payload !== 'object') return null;
  const root = payload as Record<string, unknown>;

  const rawData = root.data;
  if (typeof rawData === 'string') {
    const trimmed = rawData.trim();
    const directData = toBigInt(trimmed);
    if (directData !== null) return directData;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (typeof parsed === 'string' || typeof parsed === 'number' || typeof parsed === 'bigint') {
        const parsedData = toBigInt(parsed);
        if (parsedData !== null) return parsedData;
      }
      if (Array.isArray(parsed) && parsed.length > 0) {
        const first = toBigInt(parsed[0]);
        if (first !== null) return first;
      }
      if (parsed && typeof parsed === 'object') {
        const obj = parsed as Record<string, unknown>;
        const nestedData = toBigInt(obj.balance ?? obj.amount ?? obj.value ?? obj.coin_amount);
        if (nestedData !== null) return nestedData;
      }
    } catch {
      // Best-effort parsing only.
    }
  }

  if (Array.isArray(rawData) && rawData.length > 0) {
    const first = toBigInt(rawData[0]);
    if (first !== null) return first;
  }

  const direct = toBigInt(root.balance ?? root.amount ?? root.value ?? root.coin_amount);
  if (direct !== null) return direct;

  const result = root.result && typeof root.result === 'object' ? (root.result as Record<string, unknown>) : null;
  if (!result) return null;

  const nested = toBigInt(result.balance ?? result.amount ?? result.value ?? result.coin_amount);
  if (nested !== null) return nested;

  const content = result.content;
  if (Array.isArray(content) && content.length > 0) {
    for (const item of content) {
      if (!item || typeof item !== 'object') continue;
      const text = (item as Record<string, unknown>).text;
      if (typeof text !== 'string') continue;
      const digits = text.replace(/[^0-9]/g, '');
      const parsed = toBigInt(digits);
      if (parsed !== null) return parsed;
    }
  }

  return null;
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Move View Endpoint
app.post('/initia/move_view', async (req, res) => {
  try {
    const { address, module, function: funcName, type_args = [], args = [] } = req.body;

    log('INFO', 'move_view request', { address, module, funcName, type_args, args });

    // Validate required fields
    if (!address || !module || !funcName) {
      log('WARN', 'Missing required fields for move_view');
      return res.status(400).json({
        result: {
          isError: true,
          content: [{ text: 'Missing required fields: address, module, function' }],
        },
      });
    }

    // Parse type_args to ensure array
    const typeArgsArray = parseStringArray(type_args);
    const parsedArgs = parseStringArray(args);

    log('INFO', 'Parsed move_view input', { typeArgsArray, parsedArgs });

    let effectiveModule = module;
    let effectiveFunction = funcName;
    let effectiveTypeArgs = typeArgsArray;
    let effectiveArgs = parsedArgs;
    let legacyAmountArg: bigint | null = null;

    // Compatibility shim: old generated bots use dex::get_amount_out which is not exposed on Initia dex.
    // We map to get_pool_info and derive an estimated amount from pool reserves.
    if (module === 'dex' && funcName === 'get_amount_out' && parsedArgs.length >= 1) {
      effectiveModule = 'dex';
      effectiveFunction = 'get_pool_info';
      effectiveTypeArgs = [];
      effectiveArgs = [parsedArgs[0]];
      if (parsedArgs.length >= 2 && /^\d+$/.test(parsedArgs[1])) {
        legacyAmountArg = BigInt(parsedArgs[1]);
      }
      log('WARN', 'Mapping deprecated dex.get_amount_out to dex.get_pool_info compatibility path');
    }

    const jsonArgs = effectiveArgs.map(toMoveJsonArg);

    const result = await restClient.move.viewJSON(
      address,
      effectiveModule,
      effectiveFunction,
      effectiveTypeArgs,
      jsonArgs,
    );

    if (module === 'dex' && funcName === 'get_amount_out') {
      try {
        const dataRaw = (result as { data?: unknown })?.data;
        const dataObj = typeof dataRaw === 'string' ? JSON.parse(dataRaw) as Record<string, unknown> : null;
        const coinA = dataObj && /^\d+$/.test(String(dataObj.coin_a_amount ?? '')) ? BigInt(String(dataObj.coin_a_amount)) : null;
        const coinB = dataObj && /^\d+$/.test(String(dataObj.coin_b_amount ?? '')) ? BigInt(String(dataObj.coin_b_amount)) : null;

        if (coinA !== null && coinB !== null && coinA > 0n) {
          const inputAmount = legacyAmountArg ?? 1_000_000n;
          const estimatedOut = (inputAmount * coinB) / coinA;
          const compat = {
            amount: estimatedOut.toString(),
            coin_amount: estimatedOut.toString(),
            coin_a_amount: coinA.toString(),
            coin_b_amount: coinB.toString(),
            source_function: 'dex.get_pool_info',
          };
          log('INFO', 'move_view compatibility success', compat);
          return res.json({ result: compat });
        }
      } catch {
        // If compatibility parsing fails, fall through and return raw result.
      }
    }

    log('INFO', 'move_view success', result);
    res.json({ result });
  } catch (error) {
    const errMsg = describeError(error);
    log('ERROR', 'move_view failed', errMsg);
    res.status(500).json({
      result: {
        isError: true,
        content: [{ text: `Initia move_view error: ${errMsg}` }],
      },
    });
  }
});

// Move Execute Endpoint
app.post('/initia/move_execute', async (req, res) => {
  try {
    if (!wallet) {
      log('WARN', 'move_execute called without INITIA_KEY');
      return res.status(400).json({
        result: {
          isError: true,
          content: [{ text: 'INITIA_KEY environment variable not configured for move_execute' }],
        },
      });
    }

    const { address, module, function: funcName, type_args = [], args = [] } = req.body;

    log('INFO', 'move_execute request', { address, module, funcName, type_args, args });

    // Validate
    if (!address || !module || !funcName) {
      return res.status(400).json({
        result: {
          isError: true,
          content: [{ text: 'Missing required fields: address, module, function' }],
        },
      });
    }

    const typeArgsArray = parseStringArray(type_args);
    const parsedArgs = parseStringArray(args);

    if (address === '0x923edc29f60bb73bec89024e17d3710ae92c0bb5' && module === 'arbitrage_router_fa' && funcName === 'execute_cross_chain_trade') {
      const configuredInputMetadataAddress = normalizeMoveAddress(String(process.env.INITIA_INIT_METADATA_ADDRESS ?? ''));
      const argInputMetadataAddress = normalizeMoveAddress(parsedArgs[3] ?? '');
      const inputMetadataAddress = configuredInputMetadataAddress || argInputMetadataAddress;
      const requestedAmount = toBigInt(parsedArgs[2]);

      if (!inputMetadataAddress || requestedAmount === null) {
        return res.status(400).json({
          result: {
            isError: true,
            content: [{ text: 'Arbitrage execution requires pool addresses, amount, and input token metadata address as args[0..3]' }],
          },
        });
      }

      try {
        const signerMoveAddress = normalizeMoveAddress(wallet.key.accAddress);
        if (configuredInputMetadataAddress && argInputMetadataAddress && configuredInputMetadataAddress !== argInputMetadataAddress) {
          log('WARN', 'Router arg metadata differs from INITIA_INIT_METADATA_ADDRESS; using env metadata', {
            env: configuredInputMetadataAddress,
            arg: argInputMetadataAddress,
          });
        }

        const balanceView = await restClient.move.viewJSON(
          '0x1',
          'primary_fungible_store',
          'balance',
          ['0x1::fungible_asset::Metadata'],
          [toMoveJsonArg(signerMoveAddress), toMoveJsonArg(inputMetadataAddress)],
        );
        const signerBalance = extractBalanceFromViewResult(balanceView);

        if (signerBalance === null) {
          log('WARN', 'Unable to parse signer balance from view result', {
            signer: wallet.key.accAddress,
            signerMoveAddress,
            inputMetadataAddress,
            requestedAmount: requestedAmount.toString(),
            balanceView,
          });
          return res.status(400).json({
            result: {
              isError: true,
              content: [{ text: `Unable to verify input token balance for signer ${wallet.key.accAddress}` }],
            },
          });
        }

        if (signerBalance < requestedAmount) {
          log('WARN', 'Signer USDC balance insufficient for execution request', {
            signer: wallet.key.accAddress,
            signerBalance: signerBalance.toString(),
            requestedAmount: requestedAmount.toString(),
            inputMetadataAddress,
          });
          return res.status(400).json({
            result: {
              isError: true,
              content: [{
                text: `Signer ${wallet.key.accAddress} has insufficient input token balance (${signerBalance.toString()}) for requested amount (${requestedAmount.toString()}) using metadata ${inputMetadataAddress}; this would abort in object::address_to_object/primary_fungible_store::withdraw`,
              }],
            },
          });
        }

        log('INFO', `Preflight balance check passed for signer ${wallet.key.accAddress}: ${signerBalance.toString()} >= ${requestedAmount.toString()}`);
      } catch (error) {
        const errMsg = describeError(error);
        log('ERROR', 'balance preflight failed', errMsg);
        return res.status(400).json({
          result: {
            isError: true,
            content: [{ text: `Failed to verify signer input token balance before execution: ${errMsg}` }],
          },
        });
      }
    }

    const jsonArgs = parsedArgs.map(toMoveJsonArg);

    const msg = new MsgExecuteJSON(
      wallet.key.accAddress,
      address,
      module,
      funcName,
      typeArgsArray,
      jsonArgs,
    );

    const tx = await wallet.createAndSignTx({ msgs: [msg] });
    const result = await restClient.tx.broadcast(tx);
    log('INFO', 'move_execute success', result);
    res.json({ result });
  } catch (error) {
    const errMsg = describeError(error);
    log('ERROR', 'move_execute failed', errMsg);
    res.status(500).json({
      result: {
        isError: true,
        content: [{ text: `Initia move_execute error: ${errMsg}` }],
      },
    });
  }
});

// Catch-all for unknown routes
app.use((req, res) => {
  res.status(404).json({
    result: {
      isError: true,
      content: [{ text: `Endpoint not found: ${req.method} ${req.path}` }],
    },
  });
});

// Start server
app.listen(PORT, HOST, () => {
  log('INFO', `Native Initia MCP Server running on http://${HOST}:${PORT}`);
  log('INFO', `Initia LCD URL: ${INITIA_LCD_URL}`);
  log('INFO', 'Endpoints: /health, /initia/move_view, /initia/move_execute');
});
