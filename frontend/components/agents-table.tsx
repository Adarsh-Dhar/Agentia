"use client"

import React, { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import Link from 'next/link'
import { Settings2, Play, Square, Loader2 } from 'lucide-react'
import { Agent } from '@/lib/api'
import { AgentsTableProps } from '@/lib/types'

// ── Status styles ─────────────────────────────────────────────────────────────

const STATUS_STYLES: Record<string, string> = {
  RUNNING:  'bg-green-500/20 text-green-300 border-green-500/30',
  STARTING: 'bg-blue-500/20 text-blue-300 border-blue-500/30',
  STOPPING: 'bg-yellow-500/20 text-yellow-300 border-yellow-500/30',
  STOPPED:  'bg-gray-500/20 text-gray-300 border-gray-500/30',
  ERROR:    'bg-red-500/20 text-red-300 border-red-500/30',
  PAUSED:   'bg-yellow-500/20 text-yellow-300 border-yellow-500/30',
  REVOKED:  'bg-red-500/20 text-red-300 border-red-500/30',
  EXPIRED:  'bg-gray-500/20 text-gray-300 border-gray-500/30',
}

// ── API helpers ───────────────────────────────────────────────────────────────

async function callWorkerAction(agentId: string, action: 'start' | 'stop') {
  const res = await fetch(`/api/agents/${agentId}/${action}`, { method: 'POST' })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `HTTP ${res.status}`)
  }
  return res.json()
}

// ── Component ─────────────────────────────────────────────────────────────────

export function AgentsTable({ agents, onRefresh }: AgentsTableProps) {
  const [loadingId, setLoadingId] = useState<string | null>(null)
  const [errors, setErrors]       = useState<Record<string, string>>({})

  const handleToggle = async (agent: Agent) => {
    setLoadingId(agent.id)
    setErrors((prev) => { const n = { ...prev }; delete n[agent.id]; return n })

    try {
      const action = agent.status === 'RUNNING' ? 'stop' : 'start'
      await callWorkerAction(agent.id, action)
      // Give the worker a moment to update the DB status, then refresh
      setTimeout(() => onRefresh?.(), 800)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setErrors((prev) => ({ ...prev, [agent.id]: msg }))
    } finally {
      setLoadingId(null)
    }
  }

  const isTerminal = (status: string) =>
    status === 'REVOKED' || status === 'EXPIRED'

  const canToggle = (status: string) =>
    !isTerminal(status) && status !== 'STARTING' && status !== 'STOPPING'

  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr className="border-b border-border bg-muted/30">
            {['Name', 'Status', 'Configuration', 'Actions'].map((h) => (
              <th
                key={h}
                className="px-6 py-4 text-left text-sm font-semibold text-muted-foreground"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {agents.map((agent) => {
            const isLoading  = loadingId === agent.id
            const toggleable = canToggle(agent.status)
            const isRunning  = agent.status === 'RUNNING'
            const errMsg     = errors[agent.id]

            return (
              <tr
                key={agent.id}
                className="border-b border-border hover:bg-muted/20 transition-colors"
              >
                {/* Name */}
                <td className="px-6 py-4">
                  <Link
                    href={`/dashboard/agents/${agent.id}`}
                    className="font-semibold text-foreground hover:text-primary transition-colors"
                  >
                    {agent.name}
                  </Link>
                  {errMsg && (
                    <p className="text-xs text-red-400 mt-1 max-w-xs truncate" title={errMsg}>
                      ⚠ {errMsg}
                    </p>
                  )}
                </td>

                {/* Status */}
                <td className="px-6 py-4">
                  <div className="flex items-center gap-2">
                    <Badge
                      variant="default"
                      className={STATUS_STYLES[agent.status] ?? STATUS_STYLES.STOPPED}
                    >
                      {agent.status}
                    </Badge>
                    {(agent.status === 'STARTING' || agent.status === 'STOPPING') && (
                      <Loader2 size={12} className="animate-spin text-muted-foreground" />
                    )}
                  </div>
                </td>

                {/* Configuration summary */}
                <td className="px-6 py-4 text-sm text-muted-foreground">
                  {agent.configuration
                    ? (() => {
                        const cfg = agent.configuration as Record<string, unknown>
                        return (
                          <span className="font-mono text-xs">
                            {[cfg.strategy, cfg.targetPair]
                              .filter(Boolean)
                              .join(' · ') || 'configured'}
                          </span>
                        )
                      })()
                    : <span className="italic text-muted-foreground/50">no config</span>}
                </td>

                {/* Actions */}
                <td className="px-6 py-4">
                  <div className="flex items-center gap-2">
                    {/* Start / Stop toggle */}
                    {toggleable && (
                      <Button
                        size="sm"
                        variant={isRunning ? 'destructive' : 'outline'}
                        onClick={() => handleToggle(agent)}
                        disabled={isLoading}
                        className={
                          isRunning
                            ? 'bg-red-500/10 text-red-400 border border-red-500/30 hover:bg-red-500/20'
                            : 'border-green-500/30 text-green-400 hover:bg-green-500/10'
                        }
                      >
                        {isLoading ? (
                          <Loader2 size={13} className="animate-spin" />
                        ) : isRunning ? (
                          <><Square size={13} className="mr-1.5" />Stop</>
                        ) : (
                          <><Play size={13} className="mr-1.5" />Start</>
                        )}
                      </Button>
                    )}

                    {/* Manage link */}
                    <Link href={`/dashboard/agents/${agent.id}`}>
                      <Button size="sm" variant="outline" className="border-border hover:bg-muted">
                        <Settings2 size={14} className="mr-1.5" />
                        Manage
                      </Button>
                    </Link>
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}