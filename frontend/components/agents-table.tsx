'use client'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import Link from 'next/link'
import { Settings2 } from 'lucide-react'

interface Agent {
  id: number
  name: string
  strategy: string
  status: 'Running' | 'Paused'
  pnl: number
  sessionExpires: string
  allocation: number
}

interface AgentsTableProps {
  agents: Agent[]
}

export function AgentsTable({ agents }: AgentsTableProps) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr className="border-b border-border bg-muted/30">
            <th className="px-6 py-4 text-left text-sm font-semibold text-muted-foreground">Name</th>
            <th className="px-6 py-4 text-left text-sm font-semibold text-muted-foreground">Strategy</th>
            <th className="px-6 py-4 text-left text-sm font-semibold text-muted-foreground">Status</th>
            <th className="px-6 py-4 text-left text-sm font-semibold text-muted-foreground">Current PnL</th>
            <th className="px-6 py-4 text-left text-sm font-semibold text-muted-foreground">Session Expires</th>
            <th className="px-6 py-4 text-left text-sm font-semibold text-muted-foreground">Actions</th>
          </tr>
        </thead>
        <tbody>
          {agents.map((agent) => (
            <tr
              key={agent.id}
              className="border-b border-border hover:bg-muted/20 transition-colors"
            >
              <td className="px-6 py-4">
                <Link
                  href={`/dashboard/agents/${agent.id}`}
                  className="font-semibold text-foreground hover:text-primary transition-colors"
                >
                  {agent.name}
                </Link>
              </td>
              <td className="px-6 py-4 text-foreground">{agent.strategy}</td>
              <td className="px-6 py-4">
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
              </td>
              <td
                className={`px-6 py-4 font-semibold ${
                  agent.pnl >= 0 ? 'text-green-400' : 'text-red-400'
                }`}
              >
                {agent.pnl >= 0 ? '+' : ''}{agent.pnl.toFixed(2)} USDC
              </td>
              <td className="px-6 py-4 text-foreground text-sm">{agent.sessionExpires}</td>
              <td className="px-6 py-4">
                <Link href={`/dashboard/agents/${agent.id}`}>
                  <Button
                    size="sm"
                    variant="outline"
                    className="border-border hover:bg-muted"
                  >
                    <Settings2 size={16} className="mr-1" />
                    Manage
                  </Button>
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
