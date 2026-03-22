import { Agent, TradeAction, TradeResult } from "./types.js";
import { Wallet, RESTClient, MsgSend, RawKey } from "@initia/initia.js";

const INITIA_REST_URL =
  process.env.INITIA_REST_URL ?? "https://rest.testnet.initia.xyz"; // Ensure this matches a valid REST endpoint

export async function executeTrade(
  agent: Agent,
  action: TradeAction,
  price: number
): Promise<TradeResult> {
  console.log(
    `⛓  Preparing ${action} tx for agent "${agent.name}" on pair ${agent.targetPair} @ $${price.toFixed(4)}`
  );

  // Check for missing private key
  if (!agent.sessionKeyPriv) {
    const msg = `No private key found for agent ${agent.id}`;
    console.error(`❌ ${msg}`);
    return { txHash: "", success: false, error: msg };
  }

  try {
    const rest = new RESTClient(INITIA_REST_URL);
    // Trim and convert the hex string to Buffer
    const hexKey = agent.sessionKeyPriv.trim();
    const key = new RawKey(Buffer.from(hexKey, "hex"));
    const wallet = new Wallet(rest, key);

    // The 3rd argument of MsgSend is the "amount", which expects a Coin[] 
    // or a string that can be parsed as a Coin.
    // The recipient address must be a valid Initia address (not a contract unless supported by MsgSend)
    const msg = new MsgSend(
      wallet.key.accAddress,
      "init1hp2ja3qu676kjaryvqkjfkwpwnm0hp3u8sthw2", // Replace with a valid recipient Initia address
      "1000000uinit" // Amount must be "number" + "denom"
    );

    const tx = await wallet.createAndSignTx({ msgs: [msg] });
    const result = await rest.tx.broadcast(tx);
    return { txHash: result.txhash, success: true };

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`❌ Trade execution failed for agent ${agent.id}: ${message}`);
    return { txHash: "", success: false, error: message };
  }
}
