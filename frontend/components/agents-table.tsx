"use client"

import React, { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import Link from 'next/link'
import { Settings2, Pause, Play, Loader2 } from 'lucide-react'
import { Agent, updateAgentStatus, formatSessionExpiry, strategyLabel } from '@/lib/api'
import { AgentsTableProps } from '@/lib/types'

export function AgentsTable({ agents, onRefresh }: AgentsTableProps) {
  const [loadingId, setLoadingId] = useState<string | null>(null)

  const handleToggle = async (agent: Agent) => {
    setLoadingId(agent.id)
    try {
      const next = agent.status === 'RUNNING' ? 'PAUSED' : 'RUNNING'
      await updateAgentStatus(agent.id, next)
      onRefresh?.()
    } catch (err) {
      console.error('Status toggle failed', err)
    } finally {
      setLoadingId(null)
    }
  }

  const statusStyles: Record<Agent['status'], string> = {
    RUNNING: 'bg-green-500/20 text-green-300 border-green-500/30',
    PAUSED:  'bg-yellow-500/20 text-yellow-300 border-yellow-500/30',
    REVOKED: 'bg-red-500/20 text-red-300 border-red-500/30',
    EXPIRED: 'bg-gray-500/20 text-gray-300 border-gray-500/30',
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr className="border-b border-border bg-muted/30">
            {['Name', 'Strategy', 'Pair', 'Status', 'PnL', 'Session', 'Actions'].map((h) => (
              <th key={h} className="px-6 py-4 text-left text-sm font-semibold text-muted-foreground">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {agents.map((agent) => {
            const isTerminal = agent.status === 'REVOKED' || agent.status === 'EXPIRED'
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
                </td>

                {/* Strategy */}
                <td className="px-6 py-4 text-sm text-foreground">
                  {strategyLabel(agent.strategy)}
                </td>

                {/* Pair */}
                <td className="px-6 py-4 text-sm font-mono text-foreground">
                  {agent.targetPair}
                </td>

                {/* Status */}
                <td className="px-6 py-4">
                  <Badge variant="default" className={statusStyles[agent.status]}>
                    {agent.status}
                  </Badge>
                </td>

                {/* PnL */}
                <td className={`px-6 py-4 font-semibold ${
                  agent.currentPnl >= 0 ? 'text-green-400' : 'text-red-400'
                }`}>
                  {agent.currentPnl >= 0 ? '+' : ''}{agent.currentPnl.toFixed(2)} USDC
                </td>

                {/* Session expiry */}
                <td className="px-6 py-4 text-sm text-foreground">
                  {formatSessionExpiry(agent.sessionExpiresAt)}
                </td>

                {/* Actions */}
                <td className="px-6 py-4">
                  <div className="flex items-center gap-2">
                    {!isTerminal && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => handleToggle(agent)}
                        disabled={loadingId === agent.id}
                        className="text-muted-foreground hover:text-foreground h-8 w-8 p-0"
                        title={agent.status === 'RUNNING' ? 'Pause agent' : 'Resume agent'}
                      >
                        {loadingId === agent.id ? (
                          <Loader2 size={14} className="animate-spin" />
                        ) : agent.status === 'RUNNING' ? (
                          <Pause size={14} />
                        ) : (
                          <Play size={14} />
                        )}
                      </Button>
                    )}
                    <Link href={`/dashboard/agents/${agent.id}`}>
                      <Button
                        size="sm"
                        variant="outline"
                        className="border-border hover:bg-muted"
                      >
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