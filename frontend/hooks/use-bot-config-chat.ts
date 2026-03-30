'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { getRequiredEnvFields, type EnvFieldDef } from '@/lib/bot-constant'

export interface BotConfigChatMessage {
    id: string;
    role: 'assistant' | 'user';
    content: string;
    timestamp: Date;
    card?: 
      | { type: 'success_card'; agentId: string; botName: string }
      | { type: 'dynamic_credentials_form'; fields: EnvFieldDef[] };
  }

  let _msgId = 0
  const uid = () => String(++_msgId)
  const delay = (ms: number) => new Promise(r => setTimeout(r, ms))

  export function useBotConfigChat() {
    const [messages, setMessages] = useState<BotConfigChatMessage[]>([])
    const [input, setInput] = useState('')
    const [isTyping, setIsTyping] = useState(false)
    const [isGenerating, setIsGenerating] = useState(false)
    const [step, setStep] = useState<'idle' | 'ask_keys' | 'generating'>('idle')
    const [pendingPrompt, setPendingPrompt] = useState('')
    const [generatedAgentId, setGeneratedAgentId] = useState<string | null>(null)
  
    const bottomRef = useRef<HTMLDivElement>(null)
    const initialized = useRef(false)

    const defaultChips = ["High-Frequency Sniper", "Solana Sentiment Bot", "Cross-Chain Yield Arbitrage"]
    const [chips, setChips] = useState<string[]>(defaultChips)

    useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages, isTyping, chips])

    const pushA = useCallback((content: string, card?: BotConfigChatMessage['card']) => {
      setMessages(prev => [...prev, { id: uid(), role: 'assistant', content, timestamp: new Date(), card }])
    }, [])
    const pushU = useCallback((content: string) => {
      setMessages(prev => [...prev, { id: uid(), role: 'user', content, timestamp: new Date() }])
    }, [])

    useEffect(() => {
      if (initialized.current) return
      initialized.current = true
      ;(async () => {
        setIsTyping(true); await delay(800); setIsTyping(false);
        pushA(`Hey! 👋 I'm your **Universal Meta-Agent**.\n\nI can build over 20 different types of on-chain bots. What kind of bot do you want to build today?`)
      })()
    }, [pushA])

    const handleSend = useCallback(async (rawInput?: string) => {
      if (step !== 'idle') return;
      const text = (rawInput ?? input).trim()
      if (!text || isGenerating) return

      setInput(''); setChips([]); pushU(text); setIsGenerating(true)

      setIsTyping(true); await delay(600); setIsTyping(false);
      pushA(`🔨 Analyzing your strategy...`)

      try {
        // 1. Classify Intent
        const classRes = await fetch('/api/classify-intent', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: text }),
        })
        const classData = await classRes.json()
        if (!classRes.ok) throw new Error(classData.error)

        // 2. Check Required Keys
        const fields = getRequiredEnvFields(classData.intent).filter(f => f.required)

        if (fields.length > 0) {
          setPendingPrompt(text)
          pushA("To build this specific bot, I'll need a few API keys. Please provide them below (they are safely AES-256 encrypted in the database):", { type: 'dynamic_credentials_form', fields })
          setStep('ask_keys')
          setIsGenerating(false)
        } else {
          await generateBot(text, {})
        }
      } catch (err) {
        setIsGenerating(false)
        pushA(`❌ Analysis failed: ${err instanceof Error ? err.message : String(err)}`)
        setChips(defaultChips)
      }
    }, [input, isGenerating, step, pushA, pushU])

    const submitDynamicKeys = async (envData: Record<string, string>) => {
      setStep('generating'); setIsGenerating(true); pushU("Provided API keys.")
      await generateBot(pendingPrompt, envData)
    }

    const generateBot = async (promptText: string, envConfig: Record<string, string>) => {
      setIsTyping(true); await delay(600); setIsTyping(false);
      pushA(`🔨 Generating your custom bot architecture... This usually takes about 20-30 seconds.`)

      try {
        const res = await fetch('/api/generate-bot', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: promptText, envConfig }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data?.error ?? `Generation failed`)

        setGeneratedAgentId(data.agentId)
        setIsTyping(true); await delay(500); setIsTyping(false);
        pushA(`✅ **${data.botName}** is ready!\n\n${data.thoughts}\n\nYour bot has been generated and saved to the Bot IDE.`, { type: 'success_card', agentId: data.agentId, botName: data.botName })
        setChips(["Build another bot"])
      } catch (err) {
        pushA(`❌ Generation failed: ${err instanceof Error ? err.message : String(err)}`)
        setChips(defaultChips)
      } finally {
        setIsGenerating(false); setStep('idle')
      }
    }

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }
    const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => { setInput(e.target.value); e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px'; }

    return { messages, input, setInput, isTyping, isGenerating: isGenerating || step === 'ask_keys', chips, bottomRef, generatedAgentId, handleSend, handleKeyDown, handleInputChange, submitDynamicKeys, step }}