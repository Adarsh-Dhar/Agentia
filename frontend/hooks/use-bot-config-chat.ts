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
  const [messages, setMessages]         = useState<BotConfigChatMessage[]>([])
  const [input, setInput]               = useState('')
  const [isTyping, setIsTyping]         = useState(false)
  const [isGenerating, setIsGenerating] = useState(false)
  const [step, setStep]                 = useState<'idle' | 'ask_keys' | 'generating'>('idle')

  // Store both the original and expanded prompts across steps
  const [pendingOriginalPrompt,  setPendingOriginalPrompt]  = useState('')
  const [pendingExpandedPrompt,  setPendingExpandedPrompt]  = useState('')
  const [pendingRequiredFields,  setPendingRequiredFields]  = useState<EnvFieldDef[]>([])

  const [generatedAgentId, setGeneratedAgentId] = useState<string | null>(null)
  const [envDefaults, setEnvDefaults] = useState<Record<string, string>>({})

  const bottomRef  = useRef<HTMLDivElement>(null)
  const initialized = useRef(false)

  const defaultChips = [
    "Initia Yield Sweeper",
    "Initia Spread Scanner",
    "Initia Sentiment Bot",
    "Initia Custom Utility Bot",
    "Initia Move Action Bot",
  ]
  const [chips, setChips] = useState<string[]>(defaultChips)

  const normalizeIntent = useCallback((intent: Record<string, unknown>) => {
    const chain = String(intent.chain ?? '').trim().toLowerCase()
    const strategy = String(intent.strategy ?? intent.execution_model ?? '').trim().toLowerCase()
    const botName = String(intent.bot_name ?? intent.bot_type ?? '').trim().toLowerCase()
    const isInitiaYield = chain === 'initia' && (strategy === 'yield' || /sweep|consolidator/.test(botName))
    const isInitiaScanner = chain === 'initia' && (
      strategy === 'arbitrage' || /spread scanner|read-only scanner|market intelligence/.test(botName)
    )

    const mcpsRaw = [
      ...(Array.isArray(intent.mcps) ? intent.mcps : []),
      ...(Array.isArray(intent.required_mcps) ? intent.required_mcps : []),
    ]
    const deduped = mcpsRaw
      .map((m) => String(m || "").trim())
      .filter(Boolean)
    const required = Array.from(new Set(deduped))

    if (isInitiaYield || isInitiaScanner) {
      return {
        ...intent,
        bot_name: String(
          intent.bot_name ?? intent.bot_type ?? (isInitiaYield ? "Cross-Rollup Yield Sweeper" : "Cross-Rollup Spread Scanner")
        ),
        requires_openai: Boolean(intent.requires_openai ?? intent.requires_openai_key),
        required_mcps: ["initia"],
        mcps: ["initia"],
      }
    }

    return {
      ...intent,
      bot_name: String(intent.bot_name ?? intent.bot_type ?? "Trading Bot"),
      requires_openai: Boolean(intent.requires_openai ?? intent.requires_openai_key),
      required_mcps: required,
      mcps: required,
    }
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, isTyping, chips])

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
      setIsTyping(true)
      await delay(700)
      setIsTyping(false)
      pushA(
        `Hey! 👋 I'm your **Universal Meta-Agent**.\n\n` +
        `I can architect and generate Initia-native bots — yield sweepers, spread scanners, sentiment bots, and custom Move utility workflows.\n\n` +
        `Just describe your strategy in plain English. I'll expand it into a full technical specification and then generate production-ready TypeScript code.\n\n` +
        `What kind of bot do you want to build?`
      )
    })()
  }, [pushA])

  useEffect(() => {
    let cancelled = false

    ;(async () => {
      try {
        const res = await fetch('/api/env-defaults')
        const data = await res.json().catch(() => ({}))
        if (!cancelled && data?.values && typeof data.values === 'object') {
          setEnvDefaults(data.values as Record<string, string>)
        }
      } catch {
        if (!cancelled) setEnvDefaults({})
      }
    })()

    return () => {
      cancelled = true
    }
  }, [])

  // ── Main send handler ──────────────────────────────────────────────────────

  const handleSend = useCallback(async (rawInput?: string) => {
    if (step !== 'idle') return
    const text = (rawInput ?? input).trim()
    if (!text || isGenerating) return

    setInput('')
    setChips([])
    pushU(text)
    setIsGenerating(true)

    // Show a thinking message
    setIsTyping(true)
    await delay(500)
    setIsTyping(false)
    pushA(`🔍 Analyzing your strategy and expanding it into a full technical spec...`)

    try {
      // ── Step 1: Classify intent + expand prompt ───────────────────────────
      const classRes = await fetch('/api/classify-intent', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ prompt: text }),
      })

      const classData = await classRes.json()

      if (!classRes.ok) {
        throw new Error(classData.error ?? `Classification failed (HTTP ${classRes.status})`)
      }

      const rawIntent: Record<string, unknown> = classData.intent ?? {}
      const intent: Record<string, unknown> = normalizeIntent(rawIntent)
      const expandedPrompt: string           = classData.expandedPrompt ?? text

      console.log("[chat] Intent:", JSON.stringify(intent))
      console.log("[chat] Expanded prompt length:", expandedPrompt.length, "chars")

      // Show the user what was classified
      const botType    = (intent.bot_name as string) ?? "Trading Bot"
      const strategy   = (intent.strategy as string) ?? "unknown"
      const chain      = (intent.chain as string) ?? "initia"
      const network    = (intent.network as string) ?? "initia-testnet"
      const execModel  = (intent.execution_model as string) ?? "polling"

      setIsTyping(true)
      await delay(400)
      setIsTyping(false)
      pushA(
        `✅ **Strategy identified:** ${botType}\n\n` +
        `📋 **Details:**\n` +
        `• Chain: ${chain === 'initia' ? `◇ ${network}` : '◇ initia-testnet'}\n` +
        `• Strategy: ${strategy.replace(/_/g, ' ')}\n` +
        `• Execution model: ${execModel}\n` +
        `• Required MCPs: ${((intent.mcps as string[]) ?? []).join(', ') || 'standard'}\n\n` +
        `I've expanded your idea into a detailed technical specification (${expandedPrompt.length} chars). Checking what credentials are needed...`
      )

      // ── Step 2: Check which API keys are required ─────────────────────────
      const fields = getRequiredEnvFields(intent as Parameters<typeof getRequiredEnvFields>[0])
        .filter(f => f.required)

      if (fields.length > 0) {
        // Store both prompts + intent for when the user submits keys
        setPendingOriginalPrompt(text)
        setPendingExpandedPrompt(expandedPrompt)
        setPendingRequiredFields(fields)

        setIsTyping(true)
        await delay(400)
        setIsTyping(false)
        pushA(
          `To build this bot I need a few API keys. They'll be **AES-256 encrypted** before being stored — never stored in plaintext.`,
          { type: 'dynamic_credentials_form', fields }
        )
        setStep('ask_keys')
        setIsGenerating(false)
      } else {
        // No keys needed — generate immediately
        await generateBot(text, expandedPrompt, envDefaults)
      }

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error("[chat] Error during classification:", msg)
      setIsGenerating(false)
      setIsTyping(true)
      await delay(300)
      setIsTyping(false)
      pushA(
        `❌ **Classification failed:** ${msg}\n\n` +
        `Please try again. If this keeps happening, verify GITHUB_TOKEN is set so the classifier can run.`
      )
      setChips(defaultChips)
    }
  }, [input, isGenerating, step, pushA, pushU, normalizeIntent])

  // ── Submit keys from the credentials form ─────────────────────────────────

  const submitDynamicKeys = async (envData: Record<string, string>) => {
    const mergedEnv = {
      ...envDefaults,
      ...envData,
    }

    const missing = pendingRequiredFields
      .map(f => f.key)
      .filter((k) => !(mergedEnv[k] ?? "").trim())

    if (missing.length > 0) {
      pushA(
        `❌ Missing required keys: ${missing.join(", ")}.\n\n` +
        `Please provide all required .env keys before generation can continue.`
      )
      setStep('ask_keys')
      setIsGenerating(false)
      return
    }

    setStep('generating')
    setIsGenerating(true)
    pushU("API keys provided ✓")

    await generateBot(pendingOriginalPrompt, pendingExpandedPrompt, mergedEnv)
  }

  // ── Core generation function ───────────────────────────────────────────────

  const generateBot = async (
    originalPrompt: string,
    expandedPrompt: string,
    envConfig: Record<string, string>
  ) => {
    setIsTyping(true)
    await delay(500)
    setIsTyping(false)
    pushA(
      `🔨 **Generating your bot...**\n\n` +
      `The Meta-Agent is now writing production-ready TypeScript code based on your expanded specification. ` +
      `This typically takes 20–45 seconds.\n\n` +
      `_Hang tight while I architect the full bot..._`
    )

    try {
      const res = await fetch('/api/generate-bot', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          prompt:         originalPrompt,   // original for display / DB record
          expandedPrompt,                   // rich spec for the code generator
          envConfig,
        }),
        // Increase timeout to 60 seconds for generation
        signal: AbortSignal.timeout(600000),
      })

      const data = await res.json()

      if (!res.ok) {
        console.error("[chat] Generation response error:", data)
        throw new Error(data?.error ?? `Generation failed (HTTP ${res.status})`)
      }

      console.log("[chat] Generation succeeded:", { agentId: data.agentId, botName: data.botName, files: data.files?.length })

      setGeneratedAgentId(data.agentId)

      const fileCount = (data.files ?? []).length
      const thoughts  = data.thoughts ?? "Bot generated successfully."

      console.log("[chat] About to push success card:", { agentId: data.agentId, botName: data.botName })

      setIsTyping(true)
      await delay(400)
      setIsTyping(false)
      pushA(
        `🎉 **${data.botName} is ready!**\n\n` +
        `${thoughts}\n\n` +
        `📁 **${fileCount} files generated** and saved to the Bot IDE.\n\n` +
        `Click **Open in Bot IDE** below to review the code, configure your environment variables, and launch the bot.`,
        { type: 'success_card', agentId: data.agentId, botName: data.botName }
      )
      setChips(["Build another bot", "What strategies are available?"])

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error("[chat] Error during generation:", msg, err)
      setIsTyping(true)
      await delay(300)
      setIsTyping(false)
      pushA(
        `❌ **Generation failed:** ${msg}\n\n` +
        (msg.includes("Cannot reach") || msg.includes("503")
          ? `The Python Meta-Agent server isn't running. Start it with:\n\`cd agents && uvicorn main:app --reload\``
          : `Please try again. If the error persists, check that all services are running.`)
      )
      setChips(defaultChips)
    } finally {
      setIsGenerating(false)
      setStep('idle')
    }
  }

  // ── Input event handlers ───────────────────────────────────────────────────

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value)
    e.target.style.height = 'auto'
    e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px'
  }

  return {
    messages,
    input,
    setInput,
    isTyping,
    isGenerating: isGenerating || step === 'ask_keys',
    chips,
    bottomRef,
    generatedAgentId,
    envDefaults,
    handleSend,
    handleKeyDown,
    handleInputChange,
    submitDynamicKeys,
    step,
  }
}