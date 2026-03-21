import { Agent, PriceData } from "./types.js";
import { executeTrade } from "./blockchain.js";
import { notifyWebhook } from "./webhook_client.js";

// ─── Price Feed ───────────────────────────────────────────────────────────────

/**
 * Fetches the current price for the agent's target pair.
 *
 * Swap this for a real DEX/oracle call in production, e.g.:
 *   GET https://api.initia.xyz/prices/{pair}
 */
async function getPrice(pair: string): Promise<PriceData> {
  // MVP: simulated price centred around $0.50 with ±5 % noise
  const base = 0.5;
  const noise = (Math.random() * 0.1 - 0.05);
  return {
    pair,
    price: parseFloat((base + noise).toFixed(6)),
    timestamp: Date.now(),
    volume24h: Math.random() * 1_000_000,
    priceChange24h: (Math.random() * 10 - 5),
  };
}

// ─── Strategies ───────────────────────────────────────────────────────────────

async function runMemeSniper(agent: Agent, priceData: PriceData): Promise<void> {
  const BUY_THRESHOLD = 0.48;
  const TAKE_PROFIT = 0.55;
  const STOP_LOSS = 0.44;

  const { price } = priceData;

  if (price < BUY_THRESHOLD) {
    console.log(`🎯 [MEME_SNIPER] "${agent.name}": price $${price} < threshold $${BUY_THRESHOLD} — executing BUY`);
    const result = await executeTrade(agent, "BUY", price);
    if (result.success) {
      await notifyWebhook({
        agentId: agent.id,
        action: "BUY",
        txHash: result.txHash,
        profit: 0,
        price,
        message: `AI Sniper bought ${agent.targetPair} at $${price.toFixed(4)}`,
      });
    }
    return;
  }

  if (price >= TAKE_PROFIT) {
    console.log(`💰 [MEME_SNIPER] "${agent.name}": price $${price} >= take-profit $${TAKE_PROFIT} — executing SELL`);
    const result = await executeTrade(agent, "SELL", price);
    if (result.success) {
      const estimatedProfit = parseFloat((price - BUY_THRESHOLD).toFixed(6));
      await notifyWebhook({
        agentId: agent.id,
        action: "SELL",
        txHash: result.txHash,
        profit: estimatedProfit,
        price,
        message: `AI Sniper took profit on ${agent.targetPair} at $${price.toFixed(4)} (+$${estimatedProfit})`,
      });
    }
    return;
  }

  if (price <= STOP_LOSS) {
    console.log(`🛑 [MEME_SNIPER] "${agent.name}": price $${price} <= stop-loss $${STOP_LOSS} — executing SELL`);
    const result = await executeTrade(agent, "SELL", price);
    if (result.success) {
      const loss = parseFloat((price - BUY_THRESHOLD).toFixed(6));
      await notifyWebhook({
        agentId: agent.id,
        action: "SELL",
        txHash: result.txHash,
        profit: loss,
        price,
        message: `Stop-loss triggered on ${agent.targetPair} at $${price.toFixed(4)} ($${loss})`,
      });
    }
    return;
  }

  console.log(`⏳ [MEME_SNIPER] "${agent.name}": price $${price} — holding`);
}

async function runDCABot(agent: Agent, priceData: PriceData): Promise<void> {
  // Dollar-Cost Averaging: buy a fixed amount every cycle regardless of price
  const { price } = priceData;
  console.log(`📅 [DCA_BOT] "${agent.name}": DCA buy at $${price}`);

  const result = await executeTrade(agent, "BUY", price);
  if (result.success) {
    await notifyWebhook({
      agentId: agent.id,
      action: "BUY",
      txHash: result.txHash,
      profit: 0,
      price,
      message: `DCA bot purchased ${agent.targetPair} at $${price.toFixed(4)}`,
    });
  }
}

async function runGridTrader(agent: Agent, priceData: PriceData): Promise<void> {
  // Grid trader: alternates BUY/SELL within a price band
  const GRID_LOW = 0.46;
  const GRID_HIGH = 0.54;
  const { price } = priceData;

  if (price <= GRID_LOW) {
    console.log(`📊 [GRID_TRADER] "${agent.name}": buying at grid low $${price}`);
    const result = await executeTrade(agent, "BUY", price);
    if (result.success) {
      await notifyWebhook({
        agentId: agent.id,
        action: "BUY",
        txHash: result.txHash,
        profit: 0,
        price,
        message: `Grid bot bought ${agent.targetPair} at grid low $${price.toFixed(4)}`,
      });
    }
  } else if (price >= GRID_HIGH) {
    console.log(`📊 [GRID_TRADER] "${agent.name}": selling at grid high $${price}`);
    const result = await executeTrade(agent, "SELL", price);
    if (result.success) {
      const profit = parseFloat((GRID_HIGH - GRID_LOW).toFixed(6));
      await notifyWebhook({
        agentId: agent.id,
        action: "SELL",
        txHash: result.txHash,
        profit,
        price,
        message: `Grid bot sold ${agent.targetPair} at grid high $${price.toFixed(4)} (+$${profit})`,
      });
    }
  } else {
    console.log(`📊 [GRID_TRADER] "${agent.name}": price $${price} inside grid — waiting`);
  }
}

// ─── Dispatcher ───────────────────────────────────────────────────────────────

/**
 * Entry point called by the worker loop for each active agent.
 * Fetches the latest price and routes to the correct strategy handler.
 */
export async function runTradingEngine(agent: Agent): Promise<void> {
  try {
    const priceData = await getPrice(agent.targetPair);

    switch (agent.strategy) {
      case "MEME_SNIPER":
        await runMemeSniper(agent, priceData);
        break;
      case "DCA_BOT":
        await runDCABot(agent, priceData);
        break;
      case "GRID_TRADER":
        await runGridTrader(agent, priceData);
        break;
      default:
        console.warn(`⚠️  Unknown strategy "${agent.strategy}" for agent "${agent.name}" — skipping`);
    }
  } catch (error) {
    console.error(`❌ Engine error for agent "${agent.name}" (${agent.id}):`, error);
  }
}