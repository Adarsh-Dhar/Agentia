import { Agent, TradeAction, TradeResult } from "./types.js";
import { Wallet, RESTClient, MsgSend, RawKey} from "@initia/initia.js";

const INITIA_REST_URL =
  process.env.INITIA_REST_URL ?? "https://rest.initiation-2.initia.xyz"; // Updated to active Initia Initiation-2 endpoint

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
      const rest = new RESTClient(INITIA_REST_URL, {
        chainId: "initiation-2",
        gasPrices: "0.15uinit",
        gasAdjustment: "2.0",
      });

      // Trim and convert the hex string to Buffer
      const hexKey = agent.sessionKeyPriv.trim();
      const key = new RawKey(Buffer.from(hexKey, "hex"));
      const wallet = new Wallet(rest, key);

      // Debug: log the address and check if account exists
      console.log("Sender address:", wallet.key.accAddress);
      let balanceUinit = 0;
      try {
        const [balance] = await rest.bank.balance(wallet.key.accAddress);
        console.log("Balance:", balance);
        balanceUinit = parseInt(balance.get("uinit")?.amount ?? "0");
      } catch (err) {
        console.error("Error fetching balance (account may not exist):", err);
        return { txHash: "", success: false, error: "Could not fetch balance" };
      }

      const GAS_RESERVE = 300_000; // 0.3 INIT for gas
      if (balanceUinit <= GAS_RESERVE) {
        return { txHash: "", success: false, error: "Insufficient balance for gas" };
      }

      const sendAmount = String(balanceUinit - GAS_RESERVE);
      const msg = new MsgSend(
        wallet.key.accAddress,
        "init1hp2ja3qu676kjaryvqkjfkwpwnm0hp3u8sthw2",
        `${sendAmount}uinit`
      );

      const tx = await wallet.createAndSignTx({
        msgs: [msg],
        // chain_id: "initiation-2"
      });
      const result = await rest.tx.broadcast(tx);
      return { txHash: result.txhash, success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`❌ Trade execution failed for agent ${agent.id}: ${message}`);
      return { txHash: "", success: false, error: message };
    }
}
