import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import type { ChatMessage } from './types'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export const uid = () => Math.random().toString(36).slice(2)
 
export const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
 
export const strategyLabel = (s: string) =>
  s === 'MEME_SNIPER'  ? 'Meme Token Sniper'
  : s === 'ARBITRAGE'  ? 'Arbitrage Bot'
  : 'Social Sentiment Trader'
 
export const confidenceColor = (c: string) =>
  c === 'HIGH' ? 'bg-green-500/20 text-green-300 border-green-500/30'
  : c === 'LOW' ? 'bg-red-500/20 text-red-300 border-red-500/30'
  : 'bg-yellow-500/20 text-yellow-300 border-yellow-500/30'
 
export function makeAssistantMsg(
  content: string,
  card?: ChatMessage['card'],
): ChatMessage {
  return { id: uid(), role: 'assistant', content, timestamp: new Date(), card }
}
 
export function makeUserMsg(content: string): ChatMessage {
  return { id: uid(), role: 'user', content, timestamp: new Date() }
}
