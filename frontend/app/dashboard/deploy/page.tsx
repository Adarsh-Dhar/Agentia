"use client"

import React, {
  useState, useEffect, useRef, useCallback, useTransition
} from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useUser } from '@/lib/user-context'
import { useInterwovenKit, TESTNET } from '@initia/interwovenkit-react'
import { useMutation } from '@tanstack/react-query'
import { MsgSend } from 'cosmjs-types/cosmos/bank/v1beta1/tx.js'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  ChevronLeft, Send, Zap, Bot, User, CheckCircle,
  AlertTriangle, ShieldCheck, ShieldOff, Wallet,
  TrendingUp, Shield, Clock, DollarSign, RotateCcw,
  Sparkles, ArrowRight,
} from 'lucide-react'

// ─── Types ────────────────────────────────────────────────────────────────────

type Role = 'assistant' | 'user' | 'system'

interface ChatMessage {
  id:        string
  role:      Role
  content:   string
  timestamp: Date
  // rich payloads attached to assistant messages
  card?:     PlanCard | ConfirmCard | DeployedCard | ErrorCard
}

interface PlanCard {
  type:       'plan'
  plan:       AgentPlan
}

interface ConfirmCard {
  type:       'confirm'
  plan:       AgentPlan
  guardrails: Guardrails
}

interface DeployedCard {
  type:       'deployed'
  agentName:  string
  agentId:    string
}

interface ErrorCard {
  type:    'error'
  message: string
}

interface AgentPlan {
  agentName:                 string
  strategy:                  'MEME_SNIPER' | 'ARBITRAGE' | 'SENTIMENT_TRADER'
  targetPair:                string
  description:               string
  entryConditions:           string[]
  exitConditions:            string[]
  riskNotes:                 string[]
  sessionDurationHours:      number
  recommendedSpendAllowance: number
  confidence:                'HIGH' | 'MEDIUM' | 'LOW'
  warnings:                  string[]
}

interface Guardrails {
  spendAllowance:      number
  sessionDurationHours: number
  maxDailyLoss:        number
}

// Conversation state machine
type ConvState =
  | 'greeting'        // initial
  | 'collecting'      // waiting for more user info
  | 'drafting'        // calling AI
  | 'reviewing_plan'  // plan shown, waiting for approve/edit
  | 'guardrails'      // confirming guardrails
  | 'deploying'       // calling API
  | 'deposit'         // waiting for wallet deposit
  | 'done'            // finished

// ─── Utilities ────────────────────────────────────────────────────────────────

const uid = () => Math.random().toString(36).slice(2)

const strategyLabel = (s: string) =>
  s === 'MEME_SNIPER'       ? 'Meme Token Sniper'
  : s === 'ARBITRAGE'       ? 'Arbitrage Bot'
  : 'Social Sentiment Trader'

const confidenceColor = (c: string) =>
  c === 'HIGH'   ? 'bg-green-500/20 text-green-300 border-green-500/30'
  : c === 'LOW'  ? 'bg-red-500/20 text-red-300 border-red-500/30'
  : 'bg-yellow-500/20 text-yellow-300 border-yellow-500/30'

function makeAssistantMsg(
  content: string,
  card?: ChatMessage['card']
): ChatMessage {
  return { id: uid(), role: 'assistant', content, timestamp: new Date(), card }
}

function makeUserMsg(content: string): ChatMessage {
  return { id: uid(), role: 'user', content, timestamp: new Date() }
}

// ─── Typing indicator ─────────────────────────────────────────────────────────

function TypingIndicator() {
  return (
    <div className="flex items-end gap-3 px-4 py-2">
      <div className="w-7 h-7 rounded-full bg-primary/20 border border-primary/30 flex items-center justify-center flex-shrink-0">
        <Bot size={13} className="text-primary" />
      </div>
      <div className="bg-card border border-border rounded-2xl rounded-bl-sm px-4 py-3">
        <div className="flex gap-1 items-center h-4">
          <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/60 animate-bounce [animation-delay:0ms]" />
          <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/60 animate-bounce [animation-delay:150ms]" />
          <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/60 animate-bounce [animation-delay:300ms]" />
        </div>
      </div>
    </div>
  )
}

// ─── Plan Card ────────────────────────────────────────────────────────────────

function PlanCardView({
  plan,
  onApprove,
  onEdit,
  disabled,
}: {
  plan:       AgentPlan
  onApprove:  () => void
  onEdit:     () => void
  disabled:   boolean
}) {
  return (
    <div className="mt-3 bg-background border border-border rounded-xl overflow-hidden">
      {/* Header */}
      <div className="bg-gradient-to-r from-primary/10 to-secondary/10 border-b border-border px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Sparkles size={14} className="text-primary" />
          <span className="text-sm font-semibold">{plan.agentName}</span>
        </div>
        <Badge className={`text-xs ${confidenceColor(plan.confidence)}`}>
          {plan.confidence} confidence
        </Badge>
      </div>

      <div className="p-4 space-y-3">
        {/* Strategy + Pair */}
        <div className="flex flex-wrap gap-2">
          <span className="text-xs bg-primary/10 text-primary border border-primary/20 px-2.5 py-1 rounded-full">
            {strategyLabel(plan.strategy)}
          </span>
          <span className="text-xs bg-muted/20 text-foreground border border-border px-2.5 py-1 rounded-full font-mono">
            {plan.targetPair}
          </span>
        </div>

        {/* Description */}
        <p className="text-sm text-muted-foreground leading-relaxed">{plan.description}</p>

        {/* Entry / Exit */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <div className="bg-green-500/5 border border-green-500/20 rounded-lg p-3">
            <p className="text-xs font-semibold text-green-400 mb-1.5 flex items-center gap-1">
              <TrendingUp size={11} /> Entry
            </p>
            <ul className="space-y-0.5">
              {plan.entryConditions.map((c, i) => (
                <li key={i} className="text-xs text-foreground/70 flex gap-1.5">
                  <span className="text-green-400 flex-shrink-0">›</span>{c}
                </li>
              ))}
            </ul>
          </div>
          <div className="bg-red-500/5 border border-red-500/20 rounded-lg p-3">
            <p className="text-xs font-semibold text-red-400 mb-1.5 flex items-center gap-1">
              <Shield size={11} /> Exit
            </p>
            <ul className="space-y-0.5">
              {plan.exitConditions.map((c, i) => (
                <li key={i} className="text-xs text-foreground/70 flex gap-1.5">
                  <span className="text-red-400 flex-shrink-0">›</span>{c}
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-2">
          {[
            { icon: DollarSign, label: 'Suggested', value: `$${plan.recommendedSpendAllowance.toLocaleString()}`, color: 'text-primary' },
            { icon: Clock,       label: 'Duration',  value: `${plan.sessionDurationHours}h`,                        color: 'text-secondary' },
            { icon: Shield,      label: 'Max loss',  value: `$${Math.round(plan.recommendedSpendAllowance * 0.1).toLocaleString()}`, color: 'text-yellow-400' },
          ].map(s => (
            <div key={s.label} className="bg-muted/10 border border-border rounded-lg p-2 text-center">
              <s.icon size={12} className={`${s.color} mx-auto mb-0.5`} />
              <p className="text-[10px] text-muted-foreground">{s.label}</p>
              <p className="text-xs font-semibold">{s.value}</p>
            </div>
          ))}
        </div>

        {/* Warnings */}
        {plan.warnings.length > 0 && (
          <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-3">
            <p className="text-xs font-semibold text-yellow-400 mb-1 flex items-center gap-1">
              <AlertTriangle size={11} /> Heads up
            </p>
            {plan.warnings.map((w, i) => (
              <p key={i} className="text-xs text-yellow-300/80">{w}</p>
            ))}
          </div>
        )}

        {/* Risk Notes */}
        {plan.riskNotes.length > 0 && (
          <div className="bg-muted/10 border border-muted/20 rounded-lg p-3">
            <p className="text-xs font-semibold text-muted-foreground mb-1">Risk disclosures</p>
            {plan.riskNotes.map((r, i) => (
              <p key={i} className="text-xs text-muted-foreground">• {r}</p>
            ))}
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-2 pt-1">
          <Button
            size="sm"
            variant="outline"
            onClick={onEdit}
            disabled={disabled}
            className="flex-1 border-border text-muted-foreground hover:text-foreground"
          >
            <RotateCcw size={13} className="mr-1.5" /> Revise
          </Button>
          <Button
            size="sm"
            onClick={onApprove}
            disabled={disabled}
            className="flex-1 bg-gradient-to-r from-primary to-secondary text-primary-foreground hover:opacity-90"
          >
            Approve Plan <ArrowRight size={13} className="ml-1.5" />
          </Button>
        </div>
      </div>
    </div>
  )
}

// ─── Guardrail Confirm Card ───────────────────────────────────────────────────

function ConfirmCardView({
  plan,
  guardrails,
  onConfirm,
  onEdit,
  disabled,
}: {
  plan:       AgentPlan
  guardrails: Guardrails
  onConfirm:  () => void
  onEdit:     (field: string) => void
  disabled:   boolean
}) {
  return (
    <div className="mt-3 bg-background border border-border rounded-xl overflow-hidden">
      <div className="bg-muted/20 border-b border-border px-4 py-3 flex items-center gap-2">
        <Shield size={14} className="text-primary" />
        <span className="text-sm font-semibold">Hard Guardrails</span>
        <span className="text-xs text-muted-foreground ml-auto">Cannot be overridden by the agent</span>
      </div>
      <div className="p-4 space-y-3">
        {[
          {
            icon: DollarSign,
            label: 'Spending limit',
            value: `$${guardrails.spendAllowance.toLocaleString()} USDC`,
            sub: 'Max total the agent can spend',
            color: 'text-primary',
            field: 'spendAllowance',
          },
          {
            icon: Clock,
            label: 'Session expires in',
            value: `${guardrails.sessionDurationHours} hours`,
            sub: 'Session key auto-revokes after this',
            color: 'text-secondary',
            field: 'sessionDurationHours',
          },
          {
            icon: AlertTriangle,
            label: 'Max daily loss',
            value: `$${guardrails.maxDailyLoss.toLocaleString()} USDC`,
            sub: 'Agent halts if daily loss hits this',
            color: 'text-yellow-400',
            field: 'maxDailyLoss',
          },
        ].map(row => (
          <div key={row.field} className="flex items-center justify-between bg-muted/10 border border-border rounded-lg px-3 py-2.5">
            <div className="flex items-center gap-2.5">
              <row.icon size={14} className={row.color} />
              <div>
                <p className="text-xs text-muted-foreground">{row.label}</p>
                <p className="text-sm font-semibold">{row.value}</p>
              </div>
            </div>
            <button
              onClick={() => onEdit(row.field)}
              disabled={disabled}
              className="text-xs text-primary hover:underline disabled:opacity-50"
            >
              change
            </button>
          </div>
        ))}

        <div className="bg-primary/5 border border-primary/20 rounded-lg p-3">
          <p className="text-xs text-muted-foreground">
            Deploying <strong className="text-foreground">{plan.agentName}</strong> ·{' '}
            {strategyLabel(plan.strategy)} · {plan.targetPair}
          </p>
        </div>

        <Button
          onClick={onConfirm}
          disabled={disabled}
          className="w-full bg-gradient-to-r from-primary to-secondary text-primary-foreground hover:opacity-90 font-semibold py-5"
        >
          <Zap size={16} className="mr-2" />
          Deploy Agent
        </Button>
      </div>
    </div>
  )
}

// ─── Deployed Card ────────────────────────────────────────────────────────────

function DeployedCardView({ agentName, agentId }: { agentName: string; agentId: string }) {
  return (
    <div className="mt-3 bg-green-500/10 border border-green-500/30 rounded-xl p-4 flex items-center gap-3">
      <div className="w-10 h-10 bg-green-500/20 rounded-full flex items-center justify-center flex-shrink-0">
        <CheckCircle size={20} className="text-green-400" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-green-300">{agentName} is live</p>
        <p className="text-xs text-green-400/70 truncate">Agent ID: {agentId}</p>
      </div>
      <Link href={`/dashboard/agents/${agentId}`}>
        <Button size="sm" variant="outline" className="border-green-500/30 text-green-300 hover:bg-green-500/10 flex-shrink-0">
          View <ArrowRight size={12} className="ml-1" />
        </Button>
      </Link>
    </div>
  )
}

// ─── Deposit Modal ────────────────────────────────────────────────────────────

function DepositModal({
  agentName, agentAddress, onDeposit, onSkip, isDepositing, error,
}: {
  agentName:    string
  agentAddress: string
  onDeposit:    (amount: string) => Promise<void>
  onSkip:       () => void
  isDepositing: boolean
  error:        string | null
}) {
  const [amount, setAmount] = useState('')
  const valid = amount.trim() !== '' && parseFloat(amount) > 0

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-card border border-border rounded-2xl p-6 w-full max-w-sm shadow-xl">
        <div className="flex items-center gap-3 mb-5">
          <div className="w-10 h-10 bg-primary/20 rounded-xl flex items-center justify-center">
            <Wallet size={18} className="text-primary" />
          </div>
          <div>
            <h3 className="font-semibold">Fund Your Agent</h3>
            <p className="text-xs text-muted-foreground">Send INIT to {agentName}</p>
          </div>
        </div>

        <div className="bg-muted/20 rounded-lg p-3 mb-4">
          <p className="text-xs text-muted-foreground mb-1">Agent wallet</p>
          <p className="font-mono text-xs break-all text-foreground">{agentAddress}</p>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-destructive/10 border border-destructive/30 rounded-lg text-destructive text-xs flex gap-2">
            <AlertTriangle size={13} className="flex-shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        <div className="relative mb-4">
          <input
            type="number"
            min="0"
            step="0.1"
            placeholder="Amount to deposit"
            value={amount}
            onChange={e => setAmount(e.target.value)}
            disabled={isDepositing}
            autoFocus
            className="w-full h-12 bg-background border border-border rounded-xl px-4 pr-16 text-foreground placeholder:text-muted-foreground text-sm focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/20"
          />
          <span className="absolute right-4 top-1/2 -translate-y-1/2 text-sm text-muted-foreground font-medium">INIT</span>
        </div>

        <div className="flex flex-col gap-2">
          <Button
            onClick={() => onDeposit(amount)}
            disabled={!valid || isDepositing}
            className="w-full bg-gradient-to-r from-primary to-secondary text-primary-foreground font-semibold py-5 disabled:opacity-50"
          >
            {isDepositing
              ? <><div className="animate-spin mr-2 w-4 h-4 border-2 border-transparent border-t-primary-foreground rounded-full" />Sending…</>
              : <><Zap size={15} className="mr-2" />Send {amount || '0'} INIT</>
            }
          </Button>
          <Button variant="ghost" onClick={onSkip} disabled={isDepositing} className="text-muted-foreground text-sm">
            Skip — fund later
          </Button>
        </div>
      </div>
    </div>
  )
}

// ─── Quick-reply chip ─────────────────────────────────────────────────────────

function Chips({ options, onSelect, disabled }: {
  options:  string[]
  onSelect: (v: string) => void
  disabled: boolean
}) {
  return (
    <div className="flex flex-wrap gap-2 px-4 pb-3">
      {options.map(o => (
        <button
          key={o}
          disabled={disabled}
          onClick={() => onSelect(o)}
          className="text-xs bg-card border border-border hover:border-primary/50 hover:bg-primary/5 text-foreground px-3 py-1.5 rounded-full transition-all disabled:opacity-40"
        >
          {o}
        </button>
      ))}
    </div>
  )
}

// ─── MAIN PAGE ────────────────────────────────────────────────────────────────

export default function DeployChatPage() {
  const { user } = useUser()
  const { autoSign, initiaAddress, requestTxBlock } = useInterwovenKit()
  const router = useRouter()
  const [, startTransition] = useTransition()

  const autosignEnabled = autoSign?.isEnabledByChain?.[TESTNET.defaultChainId] ?? false
  const enableAutosign = useMutation({
    mutationFn: () => autoSign.enable(TESTNET.defaultChainId),
  })

  // ── State ────────────────────────────────────────────────────────────────
  const [messages,    setMessages]    = useState<ChatMessage[]>([])
  const [input,       setInput]       = useState('')
  const [convState,   setConvState]   = useState<ConvState>('greeting')
  const [isTyping,    setIsTyping]    = useState(false)
  const [chips,       setChips]       = useState<string[]>([])

  // Plan / deploy state
  const [currentPlan,      setCurrentPlan]      = useState<AgentPlan | null>(null)
  const [currentGuardrails, setCurrentGuardrails] = useState<Guardrails | null>(null)
  const [pendingEditField,  setPendingEditField]  = useState<string | null>(null)
  const [deployedAgentId,   setDeployedAgentId]   = useState<string | null>(null)
  const [agentAddress,      setAgentAddress]      = useState('')
  const [deployedAgentName, setDeployedAgentName] = useState('')
  const [showDeposit,       setShowDeposit]       = useState(false)
  const [isDepositing,      setIsDepositing]      = useState(false)
  const [depositError,      setDepositError]      = useState<string | null>(null)

  const bottomRef  = useRef<HTMLDivElement>(null)
  const inputRef   = useRef<HTMLTextAreaElement>(null)
  const initialized = useRef(false)

  // ── Scroll to bottom ─────────────────────────────────────────────────────
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, isTyping, chips, showDeposit])

  // ── Greeting on mount ────────────────────────────────────────────────────
  useEffect(() => {
    if (initialized.current) return
    initialized.current = true

    const greet = async () => {
      setIsTyping(true)
      await delay(900)
      setIsTyping(false)
      pushAssistant(
        `Hey there! I'm your agent-creation assistant. 👋\n\nTell me what you want to achieve — your trading goal, how much risk you're comfortable with, and roughly how long you want the agent to run.\n\nI'll design a complete strategy and deploy it for you.`
      )
      await delay(400)
      setChips([
        'Snipe meme tokens, low risk',
        'Arbitrage INIT pairs, 48h',
        'Sentiment trading, $500 max',
      ])
      setConvState('collecting')
    }

    greet()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Helpers ──────────────────────────────────────────────────────────────

  function delay(ms: number) {
    return new Promise(r => setTimeout(r, ms))
  }

  function pushAssistant(content: string, card?: ChatMessage['card']) {
    setMessages(prev => [...prev, makeAssistantMsg(content, card)])
  }

  function pushUser(content: string) {
    setMessages(prev => [...prev, makeUserMsg(content)])
  }

  // ── Interpret intent → plan via /api/agent ───────────────────────────────

  async function buildPlan(intent: string) {
    if (!user?.id) {
      pushAssistant("I can't create an agent — you're not logged in. Please connect your wallet first.", { type: 'error', message: 'Not authenticated' })
      return
    }

    setConvState('drafting')
    setIsTyping(true)
    setChips([])

    try {
      const res = await fetch('/api/agent-creation', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ userId: user.id, intent }),
      })

      const data = await res.json()

      if (!res.ok) {
        throw new Error(data?.details?.aiError ?? data?.error ?? `Request failed (${res.status})`)
      }

      const plan = data.plan as AgentPlan & {
        appliedSpendAllowance: number
        appliedSessionHours:   number
        appliedMaxDailyLoss:   number
      }

      // Immediately delete the agent that was created — we re-create it at confirm
      // (The API created it to get an ID; we only want the plan right now)
      if (data.agent?.id) {
        await fetch(`/api/agent/${data.agent.id}`, { method: 'DELETE' }).catch(() => {})
      }

      setCurrentPlan(plan)
      setCurrentGuardrails({
        spendAllowance:      plan.appliedSpendAllowance,
        sessionDurationHours: plan.appliedSessionHours,
        maxDailyLoss:        plan.appliedMaxDailyLoss,
      })

      await delay(600)
      setIsTyping(false)

      pushAssistant(
        `Here's the mission plan I designed for you. It uses the **${strategyLabel(plan.strategy)}** strategy on **${plan.targetPair}**.\n\nReview the entry/exit conditions and stats below. You can approve it or ask me to revise anything.`,
        { type: 'plan', plan }
      )
      setConvState('reviewing_plan')

    } catch (err) {
      setIsTyping(false)
      const msg = err instanceof Error ? err.message : 'Something went wrong. Please try again.'
      pushAssistant(
        `I ran into a problem drafting your plan:\n\n_${msg}_\n\nCould you rephrase your goal? Try being more specific about the strategy, risk tolerance, or time horizon.`,
        { type: 'error', message: msg }
      )
      setConvState('collecting')
      setChips(['Try again', 'Use arbitrage strategy', 'Keep it simple'])
    }
  }

  // ── Handle approve plan ───────────────────────────────────────────────────

  async function handleApprovePlan() {
    if (!currentPlan || !currentGuardrails) return
    setConvState('guardrails')
    setChips([])
    setIsTyping(true)
    await delay(700)
    setIsTyping(false)
    pushAssistant(
      `Great! Now let's lock in your **hard guardrails** — these limits are enforced by the session key and the agent can never override them.\n\nI've pre-filled them based on your intent. You can change any value by tapping "change" or just say _"change spend limit to $300"_.`,
      { type: 'confirm', plan: currentPlan, guardrails: currentGuardrails }
    )
  }

  // ── Handle guardrail field edit via chat ──────────────────────────────────

  async function handleGuardrailEditRequest(field: string) {
    setPendingEditField(field)
    const labels: Record<string, string> = {
      spendAllowance:       'spending limit (in USD)',
      sessionDurationHours: 'session duration (in hours)',
      maxDailyLoss:         'max daily loss (in USD)',
    }
    setIsTyping(true)
    await delay(500)
    setIsTyping(false)
    pushAssistant(`Sure — what should the new **${labels[field] ?? field}** be?`)
  }

  // ── Deploy agent ──────────────────────────────────────────────────────────

  async function handleDeploy() {
    if (!currentPlan || !currentGuardrails || !user?.id || !initiaAddress) return

    setConvState('deploying')
    setChips([])
    setIsTyping(true)

    try {
      // Generate session key client-side
      const { RawKey } = await import('@initia/initia.js')
      const randomBytes   = window.crypto.getRandomValues(new Uint8Array(32))
      const privHex       = Array.from(randomBytes).map(b => b.toString(16).padStart(2, '0')).join('')
      const sessionKey    = RawKey.fromHex(privHex)
      if (!sessionKey.publicKey) throw new Error('Failed to derive session key.')

      const derivedAddress = sessionKey.accAddress
      const sessionKeyPub  = (sessionKey.publicKey as { key: string }).key
      const sessionKeyPriv = sessionKey.privateKey.toString('hex')

      const res = await fetch('/api/agent-creation', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          userId:               user.id,
          intent:               `Deploy: ${currentPlan.agentName} — ${currentPlan.description}`,
          spendAllowance:       currentGuardrails.spendAllowance,
          sessionDurationHours: currentGuardrails.sessionDurationHours,
          maxDailyLoss:         currentGuardrails.maxDailyLoss,
          sessionKeyPub,
          sessionKeyPriv,
        }),
      })

      const data = await res.json()

      if (!res.ok) {
        throw new Error(data?.details?.aiError ?? data?.error ?? `Deploy failed (${res.status})`)
      }

      const agentId = data.agent.id as string

      setDeployedAgentId(agentId)
      setDeployedAgentName(currentPlan.agentName)
      setAgentAddress(derivedAddress)

      await delay(500)
      setIsTyping(false)

      pushAssistant(
        `🎉 **${currentPlan.agentName}** is deployed and running on Initia!\n\nOne last step — fund the agent wallet so it can execute trades. You can skip this and do it later from the dashboard.`,
        { type: 'deployed', agentName: currentPlan.agentName, agentId }
      )
      setConvState('deposit')
      setShowDeposit(true)

    } catch (err) {
      setIsTyping(false)
      const msg = err instanceof Error ? err.message : 'Deployment failed.'
      pushAssistant(
        `Deployment hit an error:\n\n_${msg}_\n\nWant to try again?`,
        { type: 'error', message: msg }
      )
      setConvState('guardrails')
      setChips(['Try deploying again'])
    }
  }

  // ── Deposit ───────────────────────────────────────────────────────────────

  async function handleDeposit(amount: string) {
    if (!initiaAddress || !agentAddress) return
    setIsDepositing(true)
    setDepositError(null)

    try {
      const parsed = parseFloat(amount)
      if (isNaN(parsed) || parsed <= 0) throw new Error('Invalid deposit amount.')
      const uinitAmount = String(Math.floor(parsed * 1_000_000))
      const messages = [{
        typeUrl: '/cosmos.bank.v1beta1.MsgSend',
        value: MsgSend.fromPartial({
          fromAddress: initiaAddress,
          toAddress:   agentAddress,
          amount:      [{ amount: uinitAmount, denom: 'uinit' }],
        }),
      }]
      await requestTxBlock({ messages })
      setShowDeposit(false)
      setIsDepositing(false)
      setConvState('done')

      setIsTyping(true)
      await delay(600)
      setIsTyping(false)
      pushAssistant(`Funds received! Your agent is fully operational. Head to the dashboard to monitor its trades in real time.`)
      setChips(['Go to dashboard'])

    } catch (err) {
      setDepositError(err instanceof Error ? err.message : 'Transaction failed.')
      setIsDepositing(false)
    }
  }

  function handleSkipDeposit() {
    setShowDeposit(false)
    setConvState('done')
    startTransition(() => {
      setIsTyping(true)
      delay(500).then(() => {
        setIsTyping(false)
        pushAssistant(`No problem — you can fund it anytime from the agent's detail page. Your agent is registered and will start once it has funds.`)
        setChips(['Go to dashboard'])
      })
    })
  }

  // ── Message send dispatcher ───────────────────────────────────────────────

  const handleSend = useCallback(async (rawInput?: string) => {
    const text = (rawInput ?? input).trim()
    if (!text) return
    setInput('')
    setChips([])
    pushUser(text)

    const lower = text.toLowerCase()

    // "go to dashboard" shortcut
    if (lower.includes('dashboard')) {
      router.push('/dashboard')
      return
    }

    // ── Collecting intent ─────────────────────────────────────────────────
    if (convState === 'collecting' || convState === 'greeting') {
      if (text.length < 10) {
        setIsTyping(true)
        await delay(600)
        setIsTyping(false)
        pushAssistant(`Could you say a bit more? Even a short description like "low-risk arb trades for 24 hours" helps me design the right strategy.`)
        return
      }
      await buildPlan(text)
      return
    }

    // ── Reviewing plan ────────────────────────────────────────────────────
    if (convState === 'reviewing_plan' && currentPlan) {
      if (/approve|looks good|let'?s go|yes|deploy|accept|perfect|great/i.test(lower)) {
        await handleApprovePlan()
        return
      }
      if (/revise|change|edit|different|no|update|adjust/i.test(lower)) {
        setIsTyping(true)
        await delay(500)
        setIsTyping(false)
        pushAssistant(`Of course! Tell me what you'd like to change — different strategy, trading pair, risk level, duration?`)
        setConvState('collecting')
        return
      }
      // Treat any other message as a new intent with the context of the current plan
      setIsTyping(true)
      await delay(500)
      setIsTyping(false)
      pushAssistant(`Got it — let me redesign the plan with that in mind.`)
      await buildPlan(`Original goal: ${currentPlan.description}. Adjustment: ${text}`)
      return
    }

    // ── Guardrails / confirm ──────────────────────────────────────────────
    if (convState === 'guardrails' && currentGuardrails) {

      // If we're waiting for a specific field edit
      if (pendingEditField) {
        const num = parseFloat(text.replace(/[^0-9.]/g, ''))
        if (isNaN(num) || num <= 0) {
          setIsTyping(true)
          await delay(400)
          setIsTyping(false)
          pushAssistant(`That doesn't look like a valid number. What should the new value be?`)
          return
        }

        const fieldLabels: Record<string, string> = {
          spendAllowance:       `spending limit to $${num.toLocaleString()}`,
          sessionDurationHours: `session duration to ${num} hours`,
          maxDailyLoss:         `max daily loss to $${num.toLocaleString()}`,
        }

        setCurrentGuardrails(prev => {
          if (!prev) return prev
          return { ...prev, [pendingEditField]: num }
        })
        setPendingEditField(null)

        setIsTyping(true)
        await delay(500)
        setIsTyping(false)
        pushAssistant(`Updated! I've set the ${fieldLabels[pendingEditField] ?? pendingEditField}. Anything else to adjust, or shall we deploy?`)
        setChips(['Deploy now', 'Change something else'])
        return
      }

      // Natural language guardrail edits like "change spend limit to $300"
      const spendMatch  = text.match(/spend(?:ing)?(?:\s+limit)?\s+(?:to\s+)?\$?([\d,]+)/i)
      const hoursMatch  = text.match(/(?:session\s+)?(?:duration|hours?)\s+(?:to\s+)?([\d]+)/i)
      const lossMatch   = text.match(/(?:daily\s+)?loss\s+(?:to\s+)?\$?([\d,]+)/i)

      let updated = false
      let updateMsg = ''

      if (spendMatch) {
        const v = parseFloat(spendMatch[1].replace(',', ''))
        setCurrentGuardrails(p => p ? { ...p, spendAllowance: v } : p)
        updateMsg += `spending limit → $${v.toLocaleString()} `
        updated = true
      }
      if (hoursMatch) {
        const v = parseFloat(hoursMatch[1])
        setCurrentGuardrails(p => p ? { ...p, sessionDurationHours: v } : p)
        updateMsg += `session → ${v}h `
        updated = true
      }
      if (lossMatch) {
        const v = parseFloat(lossMatch[1].replace(',', ''))
        setCurrentGuardrails(p => p ? { ...p, maxDailyLoss: v } : p)
        updateMsg += `max loss → $${v.toLocaleString()} `
        updated = true
      }

      if (updated) {
        setIsTyping(true)
        await delay(500)
        setIsTyping(false)
        pushAssistant(`Updated: ${updateMsg.trim()}. Ready to deploy, or change anything else?`)
        setChips(['Deploy now', 'Change something else'])
        return
      }

      if (/deploy|confirm|yes|go|launch|let'?s do it/i.test(lower)) {
        await handleDeploy()
        return
      }

      setIsTyping(true)
      await delay(400)
      setIsTyping(false)
      pushAssistant(`I can update the spending limit, session duration, or max daily loss — or just say "deploy" when you're ready.`)
      return
    }

    // ── Deploying ─────────────────────────────────────────────────────────
    if (convState === 'deploying') {
      setIsTyping(true)
      await delay(400)
      setIsTyping(false)
      pushAssistant(`Still deploying — hang tight for a moment!`)
      return
    }

    // ── Try again after error ─────────────────────────────────────────────
    if (/try again|retry|again/i.test(lower)) {
      if (currentPlan && currentGuardrails && convState === 'guardrails') {
        await handleDeploy()
      } else {
        setConvState('collecting')
        setIsTyping(true)
        await delay(400)
        setIsTyping(false)
        pushAssistant(`Sure, let's try again. What's your trading goal?`)
      }
      return
    }

    // ── Done / fallback ───────────────────────────────────────────────────
    setIsTyping(true)
    await delay(500)
    setIsTyping(false)
    pushAssistant(`I'm not sure what you mean at this stage. ${
      convState === 'done'
        ? 'Your agent is already deployed — head to the dashboard to monitor it.'
        : 'Try describing your trading goal and I\'ll build a plan.'
    }`)
    if (convState === 'done') setChips(['Go to dashboard'])

  }, [input, convState, currentPlan, currentGuardrails, pendingEditField, user, initiaAddress, router]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Keyboard handler ──────────────────────────────────────────────────────
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  // ── Auto-resize textarea ──────────────────────────────────────────────────
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value)
    e.target.style.height = 'auto'
    e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px'
  }

  const isBusy = convState === 'drafting' || convState === 'deploying' || isTyping

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <>
      {/* Deposit modal */}
      {showDeposit && (
        <DepositModal
          agentName={deployedAgentName}
          agentAddress={agentAddress}
          onDeposit={handleDeposit}
          onSkip={handleSkipDeposit}
          isDepositing={isDepositing}
          error={depositError}
        />
      )}

      <div className="flex flex-col h-screen bg-background">

        {/* ── Top bar ── */}
        <div className="flex-shrink-0 bg-background border-b border-border px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/dashboard">
              <Button variant="ghost" size="sm" className="text-muted-foreground">
                <ChevronLeft size={18} />
              </Button>
            </Link>
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-primary/30 to-secondary/30 border border-primary/20 flex items-center justify-center">
                <Bot size={15} className="text-primary" />
              </div>
              <div>
                <p className="text-sm font-semibold leading-none">Agent Creator</p>
                <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-400 inline-block" />
                  Powered by GPT-4o
                </p>
              </div>
            </div>
          </div>

          {/* Autosign pill */}
          <button
            onClick={() => !autosignEnabled && enableAutosign.mutate()}
            disabled={autosignEnabled || enableAutosign.isPending}
            className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full border transition-all ${
              autosignEnabled
                ? 'bg-green-500/10 border-green-500/30 text-green-400'
                : 'bg-yellow-500/10 border-yellow-500/30 text-yellow-400 hover:bg-yellow-500/20'
            }`}
          >
            {autosignEnabled
              ? <><ShieldCheck size={12} /> Autosign on</>
              : <><ShieldOff size={12} /> {enableAutosign.isPending ? 'Enabling…' : 'Enable autosign'}</>
            }
          </button>
        </div>

        {/* ── Message list ── */}
        <div className="flex-1 overflow-y-auto py-4 space-y-1">
          {messages.map(msg => (
            <div key={msg.id}>
              {msg.role === 'assistant' ? (
                <div className="flex items-end gap-2.5 px-4 py-1 max-w-3xl">
                  <div className="w-7 h-7 rounded-full bg-primary/20 border border-primary/30 flex items-center justify-center flex-shrink-0 mb-1">
                    <Bot size={13} className="text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    {msg.content && (
                      <div className="bg-card border border-border rounded-2xl rounded-bl-sm px-4 py-3 text-sm text-foreground leading-relaxed whitespace-pre-wrap">
                        {msg.content}
                      </div>
                    )}

                    {/* Rich cards */}
                    {msg.card?.type === 'plan' && (
                      <PlanCardView
                        plan={msg.card.plan}
                        onApprove={handleApprovePlan}
                        onEdit={() => { setConvState('collecting'); pushAssistant('What would you like to change about the plan?') }}
                        disabled={convState !== 'reviewing_plan'}
                      />
                    )}
                    {msg.card?.type === 'confirm' && currentGuardrails && (
                      <ConfirmCardView
                        plan={msg.card.plan}
                        guardrails={currentGuardrails}
                        onConfirm={handleDeploy}
                        onEdit={handleGuardrailEditRequest}
                        disabled={convState !== 'guardrails'}
                      />
                    )}
                    {msg.card?.type === 'deployed' && (
                      <DeployedCardView
                        agentName={msg.card.agentName}
                        agentId={msg.card.agentId}
                      />
                    )}
                    {msg.card?.type === 'error' && (
                      <div className="mt-2 text-xs text-destructive/70 bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2">
                        {msg.card.message}
                      </div>
                    )}

                    <p className="text-[10px] text-muted-foreground/50 mt-1 ml-1">
                      {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </p>
                  </div>
                </div>
              ) : (
                <div className="flex items-end justify-end gap-2.5 px-4 py-1">
                  <div className="max-w-[75%]">
                    <div className="bg-primary text-primary-foreground rounded-2xl rounded-br-sm px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap">
                      {msg.content}
                    </div>
                    <p className="text-[10px] text-muted-foreground/50 mt-1 mr-1 text-right">
                      {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </p>
                  </div>
                  <div className="w-7 h-7 rounded-full bg-muted/30 border border-border flex items-center justify-center flex-shrink-0 mb-1">
                    <User size={13} className="text-muted-foreground" />
                  </div>
                </div>
              )}
            </div>
          ))}

          {isTyping && <TypingIndicator />}
          <div ref={bottomRef} />
        </div>

        {/* ── Quick-reply chips ── */}
        {chips.length > 0 && !isBusy && (
          <Chips options={chips} onSelect={t => handleSend(t)} disabled={isBusy} />
        )}

        {/* ── Input bar ── */}
        <div className="flex-shrink-0 bg-background border-t border-border px-4 py-3">
          {!initiaAddress && (
            <p className="text-xs text-destructive text-center mb-2">
              Connect your Initia wallet to deploy agents.
            </p>
          )}
          <div className="flex items-end gap-2 bg-card border border-border rounded-2xl px-4 py-2.5 focus-within:border-primary/50 transition-colors">
            <textarea
              ref={inputRef}
              rows={1}
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              disabled={isBusy}
              placeholder={
                convState === 'done'         ? 'Ask me anything…'
                : convState === 'reviewing_plan' ? 'Say "approve" or describe changes…'
                : convState === 'guardrails'     ? 'Adjust limits or say "deploy"…'
                : 'Describe your trading goal…'
              }
              className="flex-1 bg-transparent text-foreground text-sm placeholder:text-muted-foreground resize-none focus:outline-none min-h-[24px] max-h-[120px] leading-6 disabled:opacity-50"
              style={{ height: '24px' }}
            />
            <Button
              size="sm"
              onClick={() => handleSend()}
              disabled={isBusy || !input.trim()}
              className="h-8 w-8 p-0 rounded-xl flex-shrink-0 bg-primary hover:bg-primary/90 disabled:opacity-40"
            >
              <Send size={14} />
            </Button>
          </div>
          <p className="text-[10px] text-muted-foreground/40 text-center mt-2">
            Enter to send · Shift+Enter for new line
          </p>
        </div>
      </div>
    </>
  )
}