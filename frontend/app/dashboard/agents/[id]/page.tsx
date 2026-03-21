'use client'

import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ExecutionTerminal } from '@/components/execution-terminal'
import { PnLChart } from '@/components/pnl-chart'
import { dummyAgents, executionLogs } from '@/lib/dummy-data'
import { ChevronLeft, Power, Copy } from 'lucide-react'
import Link from 'next/link'
import { useState } from 'react'

export default function AgentDetailPage({ params }: { params: { id: string } }) {
  const agent = dummyAgents.find((a) => a.id === parseInt(params.id))
  const [isCopied, setIsCopied] = useState(false)

  if (!agent) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-foreground mb-2">Agent Not Found</h1>
          <p className="text-muted-foreground">The agent you're looking for doesn't exist.</p>
          <Link href="/dashboard" className="mt-4 inline-block">
            <Button variant="outline">Return to Dashboard</Button>
          </Link>
        </div>
      </div>
    )
  }

  const handleCopyHash = () => {
    navigator.clipboard.writeText('0x3A1f2e4d5c6b7a8f9d0e1c2b3a4f5e6d7c8b9a0f')
    setIsCopied(true)
    setTimeout(() => setIsCopied(false), 2000)
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="sticky top-0 z-30 bg-background border-b border-border">
        <div className="px-6 py-4 lg:px-8">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <Link href="/dashboard">
                <Button variant="ghost" size="sm" className="hover:bg-muted">
                  <ChevronLeft size={20} className="mr-2" />
                  Back
                </Button>
              </Link>
              <div>
                <h1 className="text-3xl font-bold text-foreground">{agent.name}</h1>
                <p className="text-muted-foreground mt-1">{agent.strategy} Strategy</p>
              </div>
            </div>
            <Button
              variant="destructive"
              className="bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20"
            >
              <Power size={18} className="mr-2" />
              Revoke Session Key
            </Button>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="px-6 py-8 lg:px-8">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left Column: Chart and Stats */}
          <div className="lg:col-span-2 space-y-6">
            {/* Status Badge */}
            <div className="flex items-center gap-4">
              <Badge
                variant={agent.status === 'Running' ? 'default' : 'secondary'}
                className={
                  agent.status === 'Running'
                    ? 'bg-green-500/20 text-green-300 border-green-500/30'
                    : 'bg-yellow-500/20 text-yellow-300 border-yellow-500/30'
                }
              >
                {agent.status}
              </Badge>
              <div>
                <p className="text-sm text-muted-foreground">Session expires in</p>
                <p className="text-lg font-semibold text-foreground">{agent.sessionExpires}</p>
              </div>
            </div>

            {/* PnL Chart */}
            <div className="bg-card border border-border rounded-lg p-6">
              <h3 className="text-lg font-semibold text-foreground mb-4">Profit & Loss</h3>
              <PnLChart />
            </div>

            {/* Stats */}
            <div className="grid grid-cols-2 gap-4">
              <div className="bg-card border border-border rounded-lg p-6">
                <p className="text-sm text-muted-foreground mb-1">Current PnL</p>
                <p
                  className={`text-2xl font-bold ${
                    agent.pnl >= 0 ? 'text-green-400' : 'text-red-400'
                  }`}
                >
                  {agent.pnl >= 0 ? '+' : ''}{agent.pnl.toFixed(2)} USDC
                </p>
              </div>
              <div className="bg-card border border-border rounded-lg p-6">
                <p className="text-sm text-muted-foreground mb-1">Allocation</p>
                <p className="text-2xl font-bold text-foreground">${agent.allocation.toFixed(0)}</p>
              </div>
            </div>
          </div>

          {/* Right Column: Execution Terminal */}
          <div className="lg:col-span-1">
            <ExecutionTerminal logs={executionLogs} />
          </div>
        </div>

        {/* Transaction Hash Reference */}
        <div className="mt-8 bg-muted/10 border border-muted/30 rounded-lg p-6">
          <h3 className="font-semibold text-foreground mb-3">Latest Transaction</h3>
          <div className="flex items-center justify-between bg-background rounded p-4 font-mono text-sm">
            <span className="text-muted-foreground">TxHash: 0x3A1f2e4d5c6b7a8f9d0e1c2b3a4f5e6d7c8b9a0f</span>
            <button
              onClick={handleCopyHash}
              className="ml-2 p-2 hover:bg-muted rounded transition-colors"
              title="Copy transaction hash"
            >
              <Copy size={16} />
            </button>
          </div>
          {isCopied && <p className="text-sm text-green-400 mt-2">Copied!</p>}
        </div>
      </div>
    </div>
  )
}
