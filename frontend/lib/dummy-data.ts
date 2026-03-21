export const dummyAgents = [
  {
    id: 1,
    name: 'INIT Sniffer',
    strategy: 'Momentum',
    status: 'Running',
    pnl: 80.0,
    sessionExpires: '12h 4m',
    allocation: 1000,
  },
  {
    id: 2,
    name: 'DCA Bot',
    strategy: 'Hourly Buy',
    status: 'Paused',
    pnl: -5.0,
    sessionExpires: '48h 0m',
    allocation: 500,
  },
  {
    id: 3,
    name: 'Arb Searcher',
    strategy: 'Arbitrage',
    status: 'Running',
    pnl: 245.5,
    sessionExpires: '24h 15m',
    allocation: 2000,
  },
]

export const dashboardStats = {
  totalBalance: 2450.0,
  balance24hPnL: 142.5,
  balance24hPnLPercent: 6.1,
  activeAgents: 2,
}

export const executionLogs = [
  {
    timestamp: '10:04:12 AM',
    message: 'AI identified arbitrage on INIT/USDC.',
    type: 'info',
  },
  {
    timestamp: '10:04:13 AM',
    message: 'Executed Buy: 100 INIT at $0.45 (100ms settlement)',
    type: 'success',
  },
  {
    timestamp: '10:05:01 AM',
    message: 'Executed Sell: 100 INIT at $0.47 (TxHash: 0x3A1...)',
    type: 'success',
  },
  {
    timestamp: '10:05:01 AM',
    message: 'Profit Secured: +$2.00 USDC',
    type: 'success',
  },
  {
    timestamp: '10:05:30 AM',
    message: 'Monitoring for next arbitrage opportunity...',
    type: 'info',
  },
]

export const aiModels = [
  { id: 1, name: 'Meme Token Sniper', description: 'Identify and trade emerging meme tokens' },
  { id: 2, name: 'Arbitrage Bot', description: 'Exploit price differences across pairs' },
  { id: 3, name: 'Social Sentiment Trader', description: 'Trade based on social media sentiment' },
]

export const supportedNetworks = [
  { id: 1, name: 'Arbitrum', icon: '🔴' },
  { id: 2, name: 'Ethereum', icon: '⟠' },
  { id: 3, name: 'Polygon', icon: '🟣' },
]

export const chartData = [
  { time: '10:00', value: 2100 },
  { time: '10:30', value: 2150 },
  { time: '11:00', value: 2200 },
  { time: '11:30', value: 2180 },
  { time: '12:00', value: 2250 },
  { time: '12:30', value: 2300 },
  { time: '13:00', value: 2400 },
  { time: '13:30', value: 2450 },
]
