"use client"

import React, { useEffect, useState, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ExecutionTerminal } from '@/components/execution-terminal'
import { PnLChart } from '@/components/pnl-chart'
import {
  ChevronLeft, Power, Copy, Pause, Play,
  Trash2, RefreshCw, ShieldCheck, ShieldOff,
} from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  fetchAgent, fetchAgentLogs, updateAgentStatus, deleteAgent,
  formatSessionExpiry, strategyLabel, Agent, TradeLog,
} from '@/lib/api'
import { useInterwovenKit, TESTNET } from '@initia/interwovenkit-react'
import { useMutation } from '@tanstack/react-query'

export default function AgentDetailPage({ params }: { params: { id: string } }) {
  const router = useRouter()
  const agentId = params.id

  const { autoSign } = useInterwovenKit()
  const autosignEnabled = autoSign?.isEnabledByChain?.[TESTNET.defaultChainId] ?? false

  const enableAutosign = useMutation({
    mutationFn: () => autoSign.enable(TESTNET.defaultChainId),
  })

  const [agent,              setAgent]              = useState<Agent | null>(null)
  const [logs,               setLogs]               = useState<TradeLog[]>([])
  const [loading,            setLoading]            = useState(true)
  const [error,              setError]              = useState<string | null>(null)
  const [isCopied,           setIsCopied]           = useState(false)
  const [actionLoading,      setActionLoading]      = useState(false)
  const [showDeleteConfirm,  setShowDeleteConfirm]  = useState(false)

  const loadAgent = useCallback(async () => {
    try { setAgent(await fetchAgent(agentId)); setError(null) }
    catch { setError('Agent not found') }
    finally { setLoading(false) }
  }, [agentId])

  const loadLogs = useCallback(async () => {
    try { setLogs([...await fetchAgentLogs(agentId)].reverse()) }
    catch { /* silent */ }
  }, [agentId])

  useEffect(() => {
    loadAgent(); loadLogs()
    const id = setInterval(loadLogs, 5000)
    return () => clearInterval(id)
  }, [loadAgent, loadLogs])

  const handleCopy = (txt: string) => {
    navigator.clipboard.writeText(txt)
    setIsCopied(true)
    setTimeout(() => setIsCopied(false), 2000)
  }

  const handleStatusToggle = async () => {
    if (!agent) return
    setActionLoading(true)
    try {
      const next = agent.status === 'RUNNING' ? 'PAUSED' : 'RUNNING'
      setAgent(await updateAgentStatus(agentId, next))
      await loadLogs()
    } finally { setActionLoading(false) }
  }

  const handleRevoke = async () => {
    setActionLoading(true)
    try { await updateAgentStatus(agentId, 'REVOKED'); await loadAgent(); await loadLogs() }
    finally { setActionLoading(false) }
  }

  const handleDelete = async () => {
    setActionLoading(true)
    try { await deleteAgent(agentId); router.push('/dashboard') }
    finally { setActionLoading(false) }
  }

  const chartData = (() => {
    if (!agent) return [{ time: 'Start', value: 0 }, { time: 'Now', value: 0 }]
    const trades = logs.filter(l => l.type === 'EXECUTION_SELL' || l.type === 'PROFIT_SECURED')
    if (!trades.length) return [{ time: 'Start', value: 0 }, { time: 'Now', value: agent.currentPnl }]
    let cum = 0
    const pts = [{ time: 'Start', value: 0 }]
    trades.forEach(l => {
      cum += (l.price ?? 0) * (l.amount ?? 0) * 0.01
      const t = new Date(l.timestamp)
      pts.push({ time: `${t.getHours()}:${String(t.getMinutes()).padStart(2,'0')}`, value: parseFloat(cum.toFixed(2)) })
    })
    pts[pts.length - 1].value = agent.currentPnl
    return pts
  })()

  const latestTx = [...logs].reverse().find(l => l.txHash)

  if (loading) return (
    <div className="min-h-screen bg-background flex items-center justify-center">
      <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
    </div>
  )

  if (error || !agent) return (
    <div className="min-h-screen bg-background flex items-center justify-center text-center">
      <div>
        <h1 className="text-2xl font-bold mb-2">Agent Not Found</h1>
        <Link href="/dashboard"><Button variant="outline" className="mt-4">Back to Dashboard</Button></Link>
      </div>
    </div>
  )

  const statusColor: Record<string, string> = {
    RUNNING: 'bg-green-500/20 text-green-300 border-green-500/30',
    PAUSED:  'bg-yellow-500/20 text-yellow-300 border-yellow-500/30',
    REVOKED: 'bg-red-500/20 text-red-300 border-red-500/30',
    EXPIRED: 'bg-gray-500/20 text-gray-300 border-gray-500/30',
  }

  const isActive = agent.status !== 'REVOKED' && agent.status !== 'EXPIRED'

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="sticky top-0 z-30 bg-background border-b border-border">
        <div className="px-6 py-4 lg:px-8 flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-4">
            <Link href="/dashboard">
              <Button variant="ghost" size="sm"><ChevronLeft size={20} className="mr-1" />Back</Button>
            </Link>
            <div>
              <h1 className="text-3xl font-bold">{agent.name}</h1>
              <p className="text-muted-foreground text-sm mt-0.5">
                {strategyLabel(agent.strategy)} · {agent.targetPair}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {isActive && (
              <Button size="sm" variant="outline" onClick={handleStatusToggle} disabled={actionLoading}>
                {agent.status === 'RUNNING'
                  ? <><Pause size={14} className="mr-1.5" />Pause</>
                  : <><Play size={14} className="mr-1.5" />Resume</>}
              </Button>
            )}
            {isActive && (
              <Button size="sm" onClick={handleRevoke} disabled={actionLoading}
                className="bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20">
                <Power size={14} className="mr-1.5" />Revoke
              </Button>
            )}
            {!showDeleteConfirm ? (
              <Button variant="ghost" size="sm" onClick={() => setShowDeleteConfirm(true)}
                disabled={actionLoading} className="text-muted-foreground hover:text-destructive">
                <Trash2 size={14} />
              </Button>
            ) : (
              <div className="flex items-center gap-2">
                <span className="text-sm text-destructive">Delete?</span>
                <Button size="sm" variant="destructive" onClick={handleDelete} disabled={actionLoading}>Yes</Button>
                <Button size="sm" variant="ghost" onClick={() => setShowDeleteConfirm(false)}>No</Button>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="px-6 py-8 lg:px-8">
        {/* Autosign nudge */}
        {agent.status === 'RUNNING' && !autosignEnabled && (
          <div className="mb-6 p-4 bg-yellow-500/10 border border-yellow-500/30 rounded-lg flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <ShieldOff size={18} className="text-yellow-400 flex-shrink-0" />
              <p className="text-sm text-yellow-300">
                Enable Initia autosign so this agent can execute trades automatically.
              </p>
            </div>
            <Button size="sm" variant="outline"
              className="flex-shrink-0 border-yellow-500/30 text-yellow-300 hover:bg-yellow-500/10"
              onClick={() => enableAutosign.mutate()} disabled={enableAutosign.isPending}>
              <ShieldCheck size={14} className="mr-1.5" />
              Enable Autosign
            </Button>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left */}
          <div className="lg:col-span-2 space-y-6">
            <div className="flex items-center gap-4 flex-wrap">
              <Badge variant="default" className={statusColor[agent.status]}>{agent.status}</Badge>
              <div>
                <p className="text-xs text-muted-foreground">Session expires</p>
                <p className="text-base font-semibold">{formatSessionExpiry(agent.sessionExpiresAt)}</p>
              </div>
              {autosignEnabled && (
                <div className="flex items-center gap-1.5 text-green-400 text-xs">
                  <ShieldCheck size={13} />Autosign active
                </div>
              )}
              <Button variant="ghost" size="sm" onClick={() => { loadAgent(); loadLogs() }}
                className="ml-auto text-muted-foreground">
                <RefreshCw size={14} className="mr-1" />Refresh
              </Button>
            </div>

            <div className="bg-card border border-border rounded-lg p-6">
              <h3 className="text-lg font-semibold mb-4">Profit & Loss</h3>
              <PnLChart data={chartData} />
            </div>

            <div className="grid grid-cols-2 gap-4">
              {[
                { label: 'Current PnL', value: `${agent.currentPnl >= 0 ? '+' : ''}${agent.currentPnl.toFixed(2)} USDC`, color: agent.currentPnl >= 0 ? 'text-green-400' : 'text-red-400' },
                { label: 'Spend Allowance', value: `$${agent.spendAllowance.toFixed(0)}`, color: 'text-foreground' },
                { label: 'Trading Pair', value: agent.targetPair, color: 'text-foreground font-mono' },
                { label: 'Total Events', value: String(logs.length), color: 'text-foreground' },
              ].map(s => (
                <div key={s.label} className="bg-card border border-border rounded-lg p-5">
                  <p className="text-sm text-muted-foreground mb-1">{s.label}</p>
                  <p className={`text-2xl font-bold ${s.color}`}>{s.value}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Terminal */}
          <div className="lg:col-span-1">
            <ExecutionTerminal logs={logs} />
          </div>
        </div>

        {latestTx?.txHash && (
          <div className="mt-8 bg-muted/10 border border-muted/30 rounded-lg p-6">
            <h3 className="font-semibold mb-3">Latest Transaction</h3>
            <div className="flex items-center justify-between bg-background rounded p-4 font-mono text-sm">
              <span className="text-muted-foreground truncate pr-4">TxHash: {latestTx.txHash}</span>
              <button onClick={() => handleCopy(latestTx.txHash!)}
                className="ml-2 p-2 hover:bg-muted rounded transition-colors flex-shrink-0">
                <Copy size={16} />
              </button>
            </div>
            {isCopied && <p className="text-sm text-green-400 mt-2">Copied!</p>}
          </div>
        )}
      </div>
    </div>
  )
}