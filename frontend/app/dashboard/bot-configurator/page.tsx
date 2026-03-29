'use client'

/**
 * frontend/app/dashboard/bot-configurator/page.tsx
 *
 * The main bot configuration chat page.
 * Guides users step-by-step to build a custom arbitrage bot.
 */

import React, { useRef, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Bot, Send, Zap, Terminal, ArrowRight, RotateCcw, Check, ChevronRight } from 'lucide-react'
import { useBotConfigChat } from '@/hooks/use-bot-config-chat'
import {
  SUPPORTED_CHAINS,
  SUPPORTED_DEXES,
  SUPPORTED_SECURITY,
  type BotConfig,
} from '@/lib/types'

// ─── Typing indicator ─────────────────────────────────────────────────────────

function TypingIndicator() {
  return (
    <div className="flex items-end gap-2.5 px-4 py-2">
      <div className="w-7 h-7 rounded-full bg-cyan-500/20 border border-cyan-500/30 flex items-center justify-center flex-shrink-0">
        <Bot size={13} className="text-cyan-400" />
      </div>
      <div className="bg-slate-900 border border-slate-700 rounded-2xl rounded-bl-sm px-4 py-3">
        <div className="flex gap-1 items-center h-4">
          <span className="w-1.5 h-1.5 rounded-full bg-cyan-400/60 animate-bounce [animation-delay:0ms]" />
          <span className="w-1.5 h-1.5 rounded-full bg-cyan-400/60 animate-bounce [animation-delay:150ms]" />
          <span className="w-1.5 h-1.5 rounded-full bg-cyan-400/60 animate-bounce [animation-delay:300ms]" />
        </div>
      </div>
    </div>
  )
}

// ─── Review Card ──────────────────────────────────────────────────────────────

function ReviewCard({ config, onGenerate }: { config: BotConfig; onGenerate: () => void }) {
  const chainInfo = SUPPORTED_CHAINS[config.chain]
  const dexInfo   = SUPPORTED_DEXES[config.dex]
  const secInfo   = SUPPORTED_SECURITY[config.securityProvider]

  const rows: [string, string, string][] = [
    ['🌐', 'Network',         chainInfo?.label ?? config.chain],
    ['💰', 'Flash Loan Asset', config.baseToken],
    ['🎯', 'Target Token',    config.targetToken],
    ['📈', 'DEX',             dexInfo?.label ?? config.dex],
    ['🛡️', 'Security',        secInfo?.label ?? config.securityProvider],
    ['🏦', 'Borrow Amount',   `${config.borrowAmountHuman} ${config.baseToken}`],
    ['💵', 'Min Profit',      `$${config.minProfitUsd} USD`],
    ['⏱️', 'Poll Interval',   `${config.pollingIntervalSec}s`],
    ['🔒', 'Mode',            config.simulationMode ? 'Simulation (Safe)' : '⚠️ Live (Real TXs)'],
  ]

  return (
    <div className="mt-3 bg-slate-900 border border-slate-700 rounded-xl overflow-hidden w-full max-w-sm">
      <div className="bg-gradient-to-r from-cyan-500/10 to-violet-500/10 border-b border-slate-700 px-4 py-3 flex items-center gap-2">
        <Zap size={14} className="text-cyan-400" />
        <span className="text-sm font-semibold text-slate-200">{config.botName}</span>
        <span className="ml-auto text-xs text-slate-400 font-mono">Preview</span>
      </div>
      <div className="p-3 space-y-1.5">
        {rows.map(([icon, label, value]) => (
          <div key={label} className="flex items-center justify-between text-xs">
            <span className="text-slate-500 flex items-center gap-1.5">
              <span>{icon}</span>
              {label}
            </span>
            <span className={`font-mono font-medium ${
              value.includes('Live') ? 'text-red-400' :
              value.includes('Sim') ? 'text-yellow-400' : 'text-slate-200'
            }`}>{value}</span>
          </div>
        ))}
      </div>
      <div className="px-3 pb-3">
        <button
          onClick={onGenerate}
          className="w-full flex items-center justify-center gap-2 bg-gradient-to-r from-cyan-600 to-violet-600 hover:opacity-90 text-white text-sm font-bold py-2.5 rounded-lg transition-opacity"
        >
          <Zap size={14} />
          Generate My Bot
        </button>
      </div>
    </div>
  )
}

// ─── Success Card ─────────────────────────────────────────────────────────────

function SuccessCard({ agentId, botName }: { agentId: string; botName: string }) {
  const router = useRouter()
  return (
    <div className="mt-3 bg-green-500/10 border border-green-500/30 rounded-xl p-4 w-full max-w-sm">
      <div className="flex items-center gap-3 mb-3">
        <div className="w-10 h-10 bg-green-500/20 rounded-full flex items-center justify-center">
          <Check size={20} className="text-green-400" />
        </div>
        <div>
          <p className="text-sm font-semibold text-green-300">{botName} is ready!</p>
          <p className="text-xs text-green-400/70 font-mono truncate">ID: {agentId}</p>
        </div>
      </div>
      <button
        onClick={() => router.push('/dashboard/webcontainer')}
        className="w-full flex items-center justify-center gap-2 border border-green-500/30 text-green-300 hover:bg-green-500/10 text-sm font-medium py-2 rounded-lg transition-colors"
      >
        <Terminal size={14} />
        Open in Bot IDE
        <ArrowRight size={12} />
      </button>
    </div>
  )
}

// ─── Option Picker Card ───────────────────────────────────────────────────────

function OptionCard({ options, onSelect }: { options: string[]; onSelect: (v: string) => void }) {
  return (
    <div className="mt-2 space-y-1.5 w-full max-w-sm">
      {options.map(opt => {
        const [label, value] = opt.includes('||') ? opt.split('||') : [opt, opt]
        const [title, ...rest] = label.split(' — ')
        return (
          <button
            key={value}
            onClick={() => onSelect(value ?? label)}
            className="w-full text-left bg-slate-800/60 border border-slate-700 hover:border-cyan-500/50 hover:bg-slate-800 rounded-lg px-3 py-2.5 transition-all group"
          >
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-slate-200 group-hover:text-cyan-300 transition-colors">{title}</span>
              <ChevronRight size={12} className="text-slate-600 group-hover:text-cyan-400 transition-colors" />
            </div>
            {rest.length > 0 && (
              <p className="text-xs text-slate-500 mt-0.5">{rest.join(' — ')}</p>
            )}
          </button>
        )
      })}
    </div>
  )
}

// ─── Number Input Card ────────────────────────────────────────────────────────

function NumberInputCard({
  label, placeholder, min, step, onSubmit,
}: {
  label: string; placeholder: string; min: number; step: number;
  onSubmit: (v: string) => void;
}) {
  const ref = useRef<HTMLInputElement>(null)
  return (
    <div className="mt-2 flex items-center gap-2 w-full max-w-sm">
      <input
        ref={ref}
        type="number"
        min={min}
        step={step}
        placeholder={placeholder}
        defaultValue={placeholder}
        className="flex-1 bg-slate-800 border border-slate-700 focus:border-cyan-500/60 rounded-lg px-3 py-2 text-sm text-slate-200 outline-none transition-colors font-mono"
        onKeyDown={e => { if (e.key === 'Enter') onSubmit(ref.current?.value ?? placeholder) }}
      />
      <button
        onClick={() => onSubmit(ref.current?.value ?? placeholder)}
        className="bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg px-3 py-2 text-sm font-bold transition-colors flex items-center gap-1"
      >
        <Check size={13} /> Set
      </button>
    </div>
  )
}

// ─── Bool Toggle Card ─────────────────────────────────────────────────────────

function BoolToggleCard({ label, onSelect }: { label: string; onSelect: (v: string) => void }) {
  return (
    <div className="mt-2 flex gap-2 w-full max-w-sm">
      <button
        onClick={() => onSelect('simulation')}
        className="flex-1 bg-yellow-500/10 border border-yellow-500/30 hover:bg-yellow-500/20 text-yellow-300 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors"
      >
        🧪 Simulation
        <p className="text-xs text-yellow-400/60 font-normal mt-0.5">No real transactions</p>
      </button>
      <button
        onClick={() => onSelect('live')}
        className="flex-1 bg-red-500/10 border border-red-500/30 hover:bg-red-500/20 text-red-300 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors"
      >
        ⚡ Live
        <p className="text-xs text-red-400/60 font-normal mt-0.5">Real on-chain trades</p>
      </button>
    </div>
  )
}

// ─── Progress Bar ─────────────────────────────────────────────────────────────

const STEPS_ORDER = [
  'greeting', 'ask_chain', 'ask_base_token', 'ask_target_token',
  'ask_dex', 'ask_security', 'ask_borrow_amount', 'ask_min_profit',
  'ask_polling', 'ask_sim_mode', 'ask_bot_name', 'review', 'generating', 'done',
]

function ProgressBar({ step }: { step: string }) {
  const idx = STEPS_ORDER.indexOf(step)
  const pct = Math.round(((idx) / (STEPS_ORDER.length - 1)) * 100)
  return (
    <div className="px-4 py-2 border-b border-slate-800 flex items-center gap-3">
      <span className="text-xs text-slate-500 font-mono w-8">{pct}%</span>
      <div className="flex-1 h-1 bg-slate-800 rounded-full overflow-hidden">
        <div
          className="h-full bg-gradient-to-r from-cyan-500 to-violet-500 rounded-full transition-all duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-xs text-slate-500 font-mono capitalize">
        {step.replace(/_/g, ' ')}
      </span>
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function BotConfiguratorPage() {
  const router = useRouter()
  const {
    messages, step, config,
    input, setInput, isTyping, chips, bottomRef,
    generatedAgentId,
    handleSend, handleKeyDown, handleInputChange,
    isBusy,
    submitCredentials,
  } = useBotConfigChat()

  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const fireChip = (chip: string) => {
    if (!isBusy) handleSend(chip)
  }

  return (
    <div className="flex flex-col h-full bg-slate-950 min-h-screen">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-950/80 backdrop-blur-sm sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-cyan-500/20 to-violet-500/20 border border-cyan-500/30 flex items-center justify-center">
            <Zap size={18} className="text-cyan-400" />
          </div>
          <div>
            <h1 className="text-sm font-bold text-slate-100">Bot Configurator</h1>
            <p className="text-xs text-slate-500">Build your custom arbitrage bot</p>
          </div>
        </div>
        {generatedAgentId && (
          <button
            onClick={() => router.push('/dashboard/webcontainer')}
            className="flex items-center gap-2 text-xs border border-cyan-500/30 text-cyan-400 hover:bg-cyan-500/10 px-3 py-1.5 rounded-lg transition-colors"
          >
            <Terminal size={12} />
            Open Bot IDE
          </button>
        )}
      </div>

      {/* Progress */}
      <ProgressBar step={step} />

      {/* Messages */}
      <div className="flex-1 overflow-y-auto py-4 space-y-1">
        {messages.map(msg => (
          <div key={msg.id}>
            {msg.role === 'assistant' ? (
              <div className="flex items-end gap-2.5 px-4 py-1 max-w-2xl">
                <div className="w-7 h-7 rounded-full bg-cyan-500/20 border border-cyan-500/30 flex items-center justify-center flex-shrink-0 mb-1">
                  <Bot size={13} className="text-cyan-400" />
                </div>
                <div className="flex-1 min-w-0">
                  {msg.content && (
                    <div className="bg-slate-900 border border-slate-700/60 rounded-2xl rounded-bl-sm px-4 py-3 text-sm text-slate-200 leading-relaxed whitespace-pre-wrap">
                      {/* Simple markdown: bold */}
                      {msg.content.split(/(\*\*[^*]+\*\*)/).map((part, i) =>
                        part.startsWith('**') && part.endsWith('**')
                          ? <strong key={i} className="text-white">{part.slice(2, -2)}</strong>
                          : <span key={i}>{part}</span>
                      )}
                    </div>
                  )}

                  {/* Cards */}
                  {msg.card?.type === 'chain_picker' && (
                    <OptionCard options={msg.card.options} onSelect={v => !isBusy && handleSend(v)} />
                  )}
                  {msg.card?.type === 'token_picker' && (
                    <OptionCard options={msg.card.options} onSelect={v => !isBusy && handleSend(v)} />
                  )}
                  {msg.card?.type === 'dex_picker' && (
                    <OptionCard options={msg.card.options} onSelect={v => !isBusy && handleSend(v)} />
                  )}
                  {msg.card?.type === 'security_picker' && (
                    <OptionCard options={msg.card.options} onSelect={v => !isBusy && handleSend(v)} />
                  )}
                  {msg.card?.type === 'number_input' && (
                    <NumberInputCard
                      label={msg.card.label}
                      placeholder={msg.card.placeholder}
                      min={msg.card.min}
                      step={msg.card.step}
                      onSubmit={v => !isBusy && handleSend(v)}
                    />
                  )}
                  {msg.card?.type === 'bool_toggle' && (
                    <BoolToggleCard label={msg.card.label} onSelect={v => !isBusy && handleSend(v)} />
                  )}
                  {msg.card?.type === 'review_card' && (
                    <ReviewCard
                      config={msg.card.config}
                      onGenerate={() => !isBusy && handleSend('generate it')}
                    />
                  )}
                  {msg.card?.type === 'success_card' && (
                    <SuccessCard agentId={msg.card.agentId} botName={msg.card.botName} />
                  )}
                  {/* Credentials Form Card */}
                  {msg.card?.type === 'credentials_form' && (
                    <div className="mt-3 bg-slate-900 border border-slate-700 rounded-xl p-4 space-y-3 max-w-sm">
                      <div className="space-y-1">
                        <label className="text-xs text-slate-400 font-semibold uppercase">RPC URL</label>
                        <input id="rpcUrl" type="text" placeholder="https://mainnet.base.org" className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-cyan-500" />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs text-slate-400 font-semibold uppercase">Wallet Private Key</label>
                        <input id="privateKey" type="password" placeholder="0x..." className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-cyan-500" />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs text-slate-400 font-semibold uppercase">1inch API Key</label>
                        <input id="oneInchKey" type="password" placeholder="Enter API Key" className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-cyan-500" />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs text-slate-400 font-semibold uppercase">Webacy API Key (Optional)</label>
                        <input id="webacyKey" type="password" placeholder="Enter API Key" className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-cyan-500" />
                      </div>
                      <button
                        onClick={() => {
                          submitCredentials({
                            rpcUrl: (document.getElementById('rpcUrl') as HTMLInputElement).value,
                            privateKey: (document.getElementById('privateKey') as HTMLInputElement).value,
                            oneInchApiKey: (document.getElementById('oneInchKey') as HTMLInputElement).value,
                            webacyApiKey: (document.getElementById('webacyKey') as HTMLInputElement).value,
                          })
                        }}
                        className="w-full mt-2 bg-cyan-600 hover:bg-cyan-500 text-white font-medium py-2 rounded-lg transition-colors text-sm"
                      >
                        Save & Review
                      </button>
                    </div>
                  )}

                  <p className="text-[10px] text-slate-600 mt-1 ml-1">
                    {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </p>
                </div>
              </div>
            ) : (
              <div className="flex items-end justify-end gap-2.5 px-4 py-1">
                <div className="max-w-[70%]">
                  <div className="bg-cyan-600/20 border border-cyan-500/30 text-cyan-100 rounded-2xl rounded-br-sm px-4 py-3 text-sm leading-relaxed">
                    {msg.content}
                  </div>
                  <p className="text-[10px] text-slate-600 mt-1 mr-1 text-right">
                    {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </p>
                </div>
              </div>
            )}
          </div>
        ))}

        {isTyping && <TypingIndicator />}
        <div ref={bottomRef} />
      </div>

      {/* Chip suggestions */}
      {chips.length > 0 && !isBusy && (
        <div className="flex flex-wrap gap-2 px-4 pb-2">
          {chips.map(chip => (
            <button
              key={chip}
              onClick={() => fireChip(chip)}
              disabled={isBusy}
              className="text-xs bg-slate-800 border border-slate-700 hover:border-cyan-500/50 hover:bg-slate-700 text-slate-300 px-3 py-1.5 rounded-full transition-all disabled:opacity-40"
            >
              {chip}
            </button>
          ))}
        </div>
      )}

      {/* Input bar */}
      <div className="px-4 pb-4 pt-2 border-t border-slate-800">
        <div className="flex items-end gap-2 bg-slate-900 border border-slate-700 focus-within:border-cyan-500/50 rounded-xl px-4 py-2 transition-colors">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            disabled={isBusy}
            placeholder={
              step === 'generating' ? 'Generating your bot...' :
              step === 'done'       ? 'Bot is ready! Open the IDE →' :
              'Type your answer or pick an option above...'
            }
            rows={1}
            className="flex-1 bg-transparent text-sm text-slate-200 placeholder:text-slate-600 resize-none outline-none min-h-[24px] max-h-[120px] leading-6 disabled:opacity-50"
          />
          <button
            onClick={() => handleSend()}
            disabled={isBusy || !input.trim()}
            className="flex-shrink-0 w-8 h-8 flex items-center justify-center bg-cyan-600 hover:bg-cyan-500 disabled:bg-slate-700 rounded-lg transition-colors"
          >
            {isBusy ? (
              <div className="w-4 h-4 border-2 border-transparent border-t-white rounded-full animate-spin" />
            ) : (
              <Send size={14} className="text-white" />
            )}
          </button>
        </div>
        <p className="text-center text-[10px] text-slate-700 mt-2">
          Base architecture is fixed · Only parameters change
        </p>
      </div>
    </div>
  )
}