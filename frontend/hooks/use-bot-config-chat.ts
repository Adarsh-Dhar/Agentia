'use client'

/**
 * frontend/hooks/use-bot-config-chat.ts
 *
 * Drives the step-by-step bot configuration chat.
 */

import { useState, useRef, useEffect, useCallback } from 'react'
import type {
  BotConfig,
  BotConfigChatMessage,
  BotConfigStep,
} from '@/lib/types'
import {
  DEFAULT_BOT_CONFIG,
  SUPPORTED_CHAINS,
  SUPPORTED_BASE_TOKENS,
  SUPPORTED_TARGET_TOKENS,
  SUPPORTED_DEXES,
  SUPPORTED_SECURITY,
} from '@/lib/types'

let _msgId = 0
const uid = () => String(++_msgId)

function assistantMsg(
  content: string,
  card?: BotConfigChatMessage['card'],
): BotConfigChatMessage {
  return { id: uid(), role: 'assistant', content, timestamp: new Date(), card }
}

function userMsg(content: string): BotConfigChatMessage {
  return { id: uid(), role: 'user', content, timestamp: new Date() }
}

const delay = (ms: number) => new Promise(r => setTimeout(r, ms))

export function useBotConfigChat() {
  const [messages,   setMessages]   = useState<BotConfigChatMessage[]>([])
  const [step,       setStep]       = useState<BotConfigStep>('greeting')
  const [config,     setConfig]     = useState<BotConfig>({ ...DEFAULT_BOT_CONFIG })
  const [input,      setInput]      = useState('')
  const [isTyping,   setIsTyping]   = useState(false)
  const [chips,      setChips]      = useState<string[]>([])
  const [generatedAgentId, setGeneratedAgentId] = useState<string | null>(null)
  const [generatedFiles,   setGeneratedFiles]   = useState<unknown[]>([])
  const [error,      setError]      = useState<string | null>(null)

  // Use a ref to always have the latest config — avoids stale closure bugs
  const configRef = useRef<BotConfig>(config)
  useEffect(() => {
    configRef.current = config
  }, [config])

  const bottomRef   = useRef<HTMLDivElement>(null)
  const initialized = useRef(false)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, isTyping, chips])

  const pushA = useCallback((content: string, card?: BotConfigChatMessage['card']) => {
    setMessages(prev => [...prev, assistantMsg(content, card)])
  }, [])

  const pushU = useCallback((content: string) => {
    setMessages(prev => [...prev, userMsg(content)])
  }, [])

  const think = useCallback(async (ms = 700) => {
    setIsTyping(true)
    await delay(ms)
    setIsTyping(false)
  }, [])

  // ── greeting ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (initialized.current) return
    initialized.current = true
    ;(async () => {
      await think(600)
      pushA(
        `Hey! 👋 I'm going to help you build a **customized flash-loan arbitrage bot**.\n\nThe core architecture is rock-solid — MCP bridges, Aave flash loans, structured logging — but you get to decide all the important details: which chain, which tokens, which DEX, safety settings, and more.\n\nLet's go through it step by step. It'll only take about a minute.`
      )
      await delay(400)
      setStep('ask_chain')
      await askChain()
    })()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const askChain = useCallback(async () => {
    await think(400)
    pushA(
      `**Step 1 of 9 — Network**\n\nWhich blockchain should your bot run on?`,
      {
        type:    'chain_picker',
        options: Object.entries(SUPPORTED_CHAINS).map(([k, v]) => `${v.label}||${k}`),
      }
    )
    setChips(Object.values(SUPPORTED_CHAINS).map(v => v.label))
  }, [pushA, think])

  const askBaseToken = useCallback(async () => {
    await think(400)
    pushA(
      `**Step 2 of 9 — Flash Loan Asset**\n\nWhich token should Aave lend to your bot?`,
      {
        type:    'token_picker',
        options: Object.keys(SUPPORTED_BASE_TOKENS),
        label:   'base',
      }
    )
    setChips(Object.keys(SUPPORTED_BASE_TOKENS))
  }, [pushA, think])

  const askTargetToken = useCallback(async (chain: string) => {
    await think(400)
    const available = Object.entries(SUPPORTED_TARGET_TOKENS)
      .filter(([, v]) => v.address[chain as keyof typeof v.address])
      .map(([k]) => k)
    pushA(
      `**Step 3 of 9 — Arbitrage Target**\n\nWhich token do you want to trade against?`,
      { type: 'token_picker', options: available, label: 'target' }
    )
    setChips(available)
  }, [pushA, think])

  const askDex = useCallback(async () => {
    await think(400)
    pushA(
      `**Step 4 of 9 — DEX / Aggregator**\n\nWhich DEX or aggregator should your bot use?`,
      {
        type:    'dex_picker',
        options: Object.entries(SUPPORTED_DEXES).map(
          ([k, v]) => `${v.label} — ${v.description}||${k}`
        ),
      }
    )
    setChips(Object.values(SUPPORTED_DEXES).map(v => v.label))
  }, [pushA, think])

  const askSecurity = useCallback(async () => {
    await think(400)
    pushA(
      `**Step 5 of 9 — Security Provider**\n\nDo you want to run a token risk check before every trade?`,
      {
        type:    'security_picker',
        options: Object.entries(SUPPORTED_SECURITY).map(
          ([k, v]) => `${v.label} — ${v.description}||${k}`
        ),
      }
    )
    setChips(Object.values(SUPPORTED_SECURITY).map(v => v.label))
  }, [pushA, think])

  const askBorrowAmount = useCallback(async () => {
    await think(400)
    pushA(
      `**Step 6 of 9 — Flash Loan Size**\n\nHow much should the bot borrow per cycle?`,
      {
        type:        'number_input',
        field:       'borrowAmountHuman',
        label:       'Borrow amount',
        placeholder: '1',
        min:         0.01,
        step:        0.5,
      }
    )
    setChips(['1', '5', '10', '50', '100'])
  }, [pushA, think])

  const askMinProfit = useCallback(async () => {
    await think(400)
    pushA(
      `**Step 7 of 9 — Minimum Profit Threshold**\n\nWhat's the minimum net profit (in USD) required before executing a trade?`,
      {
        type:        'number_input',
        field:       'minProfitUsd',
        label:       'Min profit (USD)',
        placeholder: '0.5',
        min:         0.01,
        step:        0.1,
      }
    )
    setChips(['0.1', '0.5', '1', '5'])
  }, [pushA, think])

  const askPolling = useCallback(async () => {
    await think(400)
    pushA(
      `**Step 8 of 9 — Polling Interval**\n\nHow often should the bot check for opportunities? (seconds)`,
      {
        type:        'number_input',
        field:       'pollingIntervalSec',
        label:       'Interval (seconds)',
        placeholder: '5',
        min:         1,
        step:        1,
      }
    )
    setChips(['2', '5', '10', '30'])
  }, [pushA, think])

  const askSimMode = useCallback(async () => {
    await think(400)
    pushA(
      `**Step 9 of 9 — Execution Mode**\n\nShould the bot run in **Simulation** mode or **Live** mode?`,
      { type: 'bool_toggle', field: 'simulationMode', label: 'Simulation mode' }
    )
    setChips(['Simulation (Safe)', 'Live (Real trades)'])
  }, [pushA, think])

  // ── credentials step ──────────────────────────────────────────────────────────
  const askCredentials = useCallback(async () => {
    setStep('ask_credentials')
    await think(400)
    pushA(
      `Almost there! Please provide your API credentials. These will be **AES-256 encrypted** before saving to the database — never stored in plaintext.`,
      { type: 'credentials_form' }
    )
  }, [pushA, think])

  // submitCredentials receives creds, merges into config, then shows review
  // We pass the merged config directly to showReview to avoid stale closure
  const submitCredentials = useCallback(async (creds: {
    rpcUrl: string
    privateKey: string
    oneInchApiKey: string
    webacyApiKey: string
  }) => {
    // Build the merged config synchronously before any state updates
    const mergedConfig: BotConfig = {
      ...configRef.current,
      rpcUrl:        creds.rpcUrl,
      privateKey:    creds.privateKey,
      oneInchApiKey: creds.oneInchApiKey,
      webacyApiKey:  creds.webacyApiKey,
    }

    // Update state (for UI) AND the ref (for generateBot closure)
    setConfig(mergedConfig)
    configRef.current = mergedConfig

    await showReview(mergedConfig)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const showReview = useCallback(async (finalConfig: BotConfig) => {
    await think(500)
    pushA(
      `Here's a summary of your bot. Review everything and hit **Generate Bot** when you're happy.`,
      { type: 'review_card', config: finalConfig }
    )
    setChips(['Looks good, generate it!', 'Change the chain', 'Change the tokens'])
    setStep('review')
  }, [pushA, think])

  // ── generate ─────────────────────────────────────────────────────────────────
  // Accept config explicitly to avoid stale closure
  const generateBot = useCallback(async (finalConfig: BotConfig) => {
    setStep('generating')
    setChips([])
    await think(400)
    pushA(`🔨 Generating your custom arbitrage bot... This takes about 30 seconds.`)

    try {
      const res = await fetch('/api/generate-bot', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ config: finalConfig }),
      })

      const data = await res.json()

      if (!res.ok) {
        throw new Error(data?.error ?? `Generation failed (${res.status})`)
      }

      setGeneratedAgentId(data.agentId)
      setGeneratedFiles(data.files ?? [])
      setStep('done')

      await think(300)
      pushA(
        `✅ **${finalConfig.botName}** is ready!\n\nYour bot has been generated and saved to the Bot IDE.`,
        { type: 'success_card', agentId: data.agentId, botName: finalConfig.botName }
      )
      setChips(['Open Bot IDE', 'Create another bot'])

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
      setStep('error')
      await think(300)
      pushA(`❌ Something went wrong:\n\n_${msg}_\n\nWant to try again?`)
      setChips(['Try again', 'Start over'])
    }
  }, [pushA, think])

  // ── main send handler ─────────────────────────────────────────────────────────
  const handleSend = useCallback(async (rawInput?: string) => {
    const text = (rawInput ?? input).trim()
    if (!text) return
    setInput('')
    setChips([])
    pushU(text)

    const lower = text.toLowerCase()

    switch (step) {

      case 'ask_chain': {
        const match = Object.entries(SUPPORTED_CHAINS).find(([k, v]) =>
          lower.includes(k) ||
          lower.includes(v.label.toLowerCase()) ||
          (lower.includes('sepolia') && k === 'base-sepolia') ||
          (lower.includes('mainnet') && k === 'base-mainnet') ||
          (lower.includes('arbitrum') && k === 'arbitrum')
        )
        if (!match) {
          await think(400)
          pushA(`I didn't catch that. Please pick one of the supported chains below.`,
            { type: 'chain_picker', options: Object.entries(SUPPORTED_CHAINS).map(([k, v]) => `${v.label}||${k}`) })
          setChips(Object.values(SUPPORTED_CHAINS).map(v => v.label))
          return
        }
        const [chainKey, chainVal] = match
        setConfig(c => ({ ...c, chain: chainKey as typeof c.chain }))
        await think(300)
        pushA(`Got it — **${chainVal.label}**. ✓`)
        setStep('ask_base_token')
        await askBaseToken()
        break
      }

      case 'ask_base_token': {
        const match = Object.keys(SUPPORTED_BASE_TOKENS).find(k =>
          lower.includes(k.toLowerCase())
        )
        if (!match) {
          await think(400)
          pushA(`Please choose one of the supported base tokens.`,
            { type: 'token_picker', options: Object.keys(SUPPORTED_BASE_TOKENS), label: 'base' })
          setChips(Object.keys(SUPPORTED_BASE_TOKENS))
          return
        }
        setConfig(c => ({ ...c, baseToken: match }))
        await think(300)
        pushA(`**${match}** as the flash loan asset. ✓`)
        setStep('ask_target_token')
        await askTargetToken(configRef.current.chain)
        break
      }

      case 'ask_target_token': {
        const match = Object.keys(SUPPORTED_TARGET_TOKENS).find(k =>
          lower.includes(k.toLowerCase())
        )
        if (!match) {
          await think(400)
          pushA(`Please choose a target token.`,
            { type: 'token_picker', options: Object.keys(SUPPORTED_TARGET_TOKENS), label: 'target' })
          setChips(Object.keys(SUPPORTED_TARGET_TOKENS))
          return
        }
        setConfig(c => ({ ...c, targetToken: match }))
        await think(300)
        pushA(`Trading against **${match}**. ✓`)
        setStep('ask_dex')
        await askDex()
        break
      }

      case 'ask_dex': {
        const match = Object.entries(SUPPORTED_DEXES).find(([k, v]) =>
          lower.includes(k) || lower.includes(v.label.toLowerCase().split(' ')[0])
        )
        if (!match) {
          await think(400)
          pushA(`Please pick a DEX from the options.`,
            { type: 'dex_picker', options: Object.entries(SUPPORTED_DEXES).map(([k, v]) => `${v.label}||${k}`) })
          setChips(Object.values(SUPPORTED_DEXES).map(v => v.label))
          return
        }
        setConfig(c => ({ ...c, dex: match[0] as typeof c.dex }))
        await think(300)
        pushA(`Using **${match[1].label}** for swaps. ✓`)
        setStep('ask_security')
        await askSecurity()
        break
      }

      case 'ask_security': {
        const match = Object.entries(SUPPORTED_SECURITY).find(([k, v]) =>
          lower.includes(k) ||
          lower.includes(v.label.toLowerCase().split(' ')[0]) ||
          (lower.includes('none') && k === 'none') ||
          (lower.includes('no') && k === 'none') ||
          (lower.includes('skip') && k === 'none')
        )
        if (!match) {
          await think(400)
          pushA(`Please choose a security provider.`,
            { type: 'security_picker', options: Object.entries(SUPPORTED_SECURITY).map(([k, v]) => `${v.label}||${k}`) })
          return
        }
        setConfig(c => ({ ...c, securityProvider: match[0] as typeof c.securityProvider }))
        await think(300)
        pushA(`Security: **${match[1].label}**. ✓`)
        setStep('ask_borrow_amount')
        await askBorrowAmount()
        break
      }

      case 'ask_borrow_amount': {
        const num = parseFloat(text.replace(/[^0-9.]/g, ''))
        if (isNaN(num) || num <= 0) {
          await think(400)
          pushA(`Please enter a positive number (e.g. \`1\` or \`10\`).`)
          setChips(['1', '5', '10', '50'])
          return
        }
        setConfig(c => ({ ...c, borrowAmountHuman: num }))
        await think(300)
        pushA(`Flash loan size: **${num} ${configRef.current.baseToken}**. ✓`)
        setStep('ask_min_profit')
        await askMinProfit()
        break
      }

      case 'ask_min_profit': {
        const num = parseFloat(text.replace(/[^0-9.]/g, ''))
        if (isNaN(num) || num < 0) {
          await think(400)
          pushA(`Please enter a non-negative number (e.g. \`0.5\`).`)
          setChips(['0.1', '0.5', '1'])
          return
        }
        setConfig(c => ({ ...c, minProfitUsd: num }))
        await think(300)
        pushA(`Min profit threshold: **$${num}**. ✓`)
        setStep('ask_polling')
        await askPolling()
        break
      }

      case 'ask_polling': {
        const num = parseInt(text.replace(/[^0-9]/g, ''), 10)
        if (isNaN(num) || num < 1) {
          await think(400)
          pushA(`Please enter a whole number of seconds (minimum 1).`)
          setChips(['2', '5', '10'])
          return
        }
        setConfig(c => ({ ...c, pollingIntervalSec: num }))
        await think(300)
        pushA(`Polling every **${num}s**. ✓`)
        setStep('ask_sim_mode')
        await askSimMode()
        break
      }

      case 'ask_sim_mode': {
        const isSim =
          lower.includes('sim') ||
          lower.includes('safe') ||
          lower.includes('test') ||
          lower.includes('dry') ||
          lower.includes('no real') ||
          lower.includes('true')
        setConfig(c => ({ ...c, simulationMode: isSim }))
        await think(300)
        pushA(isSim
          ? `**Simulation mode** — no real transactions. ✓`
          : `**Live mode** — real on-chain transactions. ✓`
        )
        setStep('ask_bot_name')
        await think(400)
        pushA(`Last thing — what do you want to name your bot?`)
        setChips(['ArbitrageBot', 'FlashHunter', 'ProfitSeeker'])
        break
      }

      case 'ask_bot_name': {
        if (text.trim().length < 2) {
          pushA(`Please provide a name with at least 2 characters.`)
          return
        }
        setConfig(prev => ({ ...prev, botName: text.trim() }))
        configRef.current = { ...configRef.current, botName: text.trim() }
        setInput('')
        await askCredentials()
        break
      }

      case 'review': {
        if (
          lower.includes('generate') ||
          lower.includes('looks good') ||
          lower.includes("let's go") ||
          lower.includes('yes') ||
          lower.includes('go') ||
          lower.includes('build')
        ) {
          // Use configRef.current to get the latest config including credentials
          await generateBot(configRef.current)
          return
        }
        if (lower.includes('chain')) { setStep('ask_chain'); await askChain(); return }
        if (lower.includes('token')) { setStep('ask_base_token'); await askBaseToken(); return }
        if (lower.includes('dex'))   { setStep('ask_dex'); await askDex(); return }
        if (lower.includes('borrow') || lower.includes('amount')) { setStep('ask_borrow_amount'); await askBorrowAmount(); return }
        if (lower.includes('profit')) { setStep('ask_min_profit'); await askMinProfit(); return }
        if (lower.includes('poll') || lower.includes('interval')) { setStep('ask_polling'); await askPolling(); return }
        if (lower.includes('security') || lower.includes('risk')) { setStep('ask_security'); await askSecurity(); return }
        await think(300)
        pushA(`Ready to generate? Just say **"generate it"** or tell me which setting to change.`)
        setChips(['Generate it!', 'Change tokens', 'Change chain'])
        break
      }

      case 'done': {
        if (lower.includes('another') || lower.includes('new') || lower.includes('start over')) {
          setConfig({ ...DEFAULT_BOT_CONFIG })
          configRef.current = { ...DEFAULT_BOT_CONFIG }
          setStep('ask_chain')
          setMessages([])
          initialized.current = false
          await think(300)
          pushA(`Let's build another bot! Starting fresh...`)
          await askChain()
          return
        }
        await think(300)
        pushA(`Your bot is ready in the Bot IDE.`)
        break
      }

      case 'error': {
        if (lower.includes('try again') || lower.includes('retry')) {
          await generateBot(configRef.current)
          return
        }
        if (lower.includes('start over') || lower.includes('restart')) {
          setConfig({ ...DEFAULT_BOT_CONFIG })
          configRef.current = { ...DEFAULT_BOT_CONFIG }
          setStep('ask_chain')
          setMessages([])
          initialized.current = false
          await think(300)
          pushA(`Starting fresh.`)
          await askChain()
          return
        }
        break
      }

      default:
        await think(300)
        pushA(`Try picking one of the options.`)
    }
  }, [
    input, step,
    pushU, pushA, think,
    askChain, askBaseToken, askTargetToken, askDex,
    askSecurity, askBorrowAmount, askMinProfit, askPolling, askSimMode,
    askCredentials, showReview, generateBot,
  ])

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
    step,
    config,
    input,
    setInput,
    isTyping,
    chips,
    bottomRef,
    generatedAgentId,
    generatedFiles,
    error,
    handleSend,
    handleKeyDown,
    handleInputChange,
    isBusy: isTyping || step === 'generating',
    submitCredentials,
  }
}