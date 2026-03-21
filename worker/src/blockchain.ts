import { Agent, TradeAction, TradeResult } from "./types.js";
import { Wallet, RESTClient, MsgSend, Key } from "@initia/initia.js";

const INITIA_REST_URL =
  process.env.INITIA_REST_URL ?? "https://rest.testnet.initia.xyz";

export async function executeTrade(
  agent: Agent,
  action: TradeAction,
  price: number
): Promise<TradeResult> {
  console.log(
    `⛓  Preparing ${action} tx for agent "${agent.name}" on pair ${agent.targetPair} @ $${price.toFixed(4)}`
  );

  try {

    const rest    = new RESTClient(INITIA_REST_URL);
    const wallet  = new Wallet(rest, agent.sessionKeyPriv as any as Key);

    const msg = new MsgSend(
      wallet.key.accAddress,
      "<dex_contract_address>",
      `{"swap":{"offer_asset":{"info":{"native_token":{"denom":"uinit"}},"amount":"1000000"}}}`,
    );

    const tx = await wallet.createAndSignTx({ msgs: [msg] });
    const result = await rest.tx.broadcast(tx);
    return { txHash: result.txhash, success: true };
    // ─────────────────────────────────────────────────────────────────────

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`❌ Trade execution failed for agent ${agent.id}: ${message}`);
    return { txHash: "", success: false, error: message };
  }
}
