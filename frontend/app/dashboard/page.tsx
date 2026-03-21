'use client'

import { DollarSign, TrendingUp, Zap } from 'lucide-react'
import { StatCard } from '@/components/stat-card'
import { AgentsTable } from '@/components/agents-table'
import { dashboardStats, dummyAgents } from '@/lib/dummy-data'
import { Button } from '@/components/ui/button'
import Link from 'next/link'

export default function DashboardPage() {
  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="sticky top-0 z-30 bg-background border-b border-border">
        <div className="px-6 py-4 lg:px-8">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold text-foreground">Dashboard</h1>
              <p className="text-muted-foreground mt-1">Overview of your AI trading agents</p>
            </div>
            <Link href="/dashboard/deploy">
              <Button className="bg-gradient-to-r from-primary to-secondary hover:opacity-90 text-primary-foreground">
                <Zap size={18} className="mr-2" />
                Deploy New Agent
              </Button>
            </Link>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="px-6 py-8 lg:px-8 max-w-7xl mx-auto">
        {/* Stats Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
          <StatCard
            label="Total Balance"
            value={`$${dashboardStats.totalBalance.toFixed(2)}`}
            subvalue="USDC"
            icon={<DollarSign size={24} />}
          />
          <StatCard
            label="24h PnL"
            value={`+$${dashboardStats.balance24hPnL.toFixed(2)}`}
            subvalue="USDC"
            trend="up"
            trendPercent={dashboardStats.balance24hPnLPercent}
          />
          <StatCard
            label="Active Agents"
            value={dashboardStats.activeAgents}
            subvalue="Running"
            icon={<TrendingUp size={24} />}
          />
        </div>

        {/* Agents Table */}
        <div className="bg-card border border-border rounded-lg overflow-hidden">
          <div className="p-6 border-b border-border">
            <h2 className="text-xl font-bold text-foreground">Active AI Agents</h2>
            <p className="text-sm text-muted-foreground mt-1">
              Monitor and manage your deployed trading strategies
            </p>
          </div>
          <AgentsTable agents={dummyAgents} />
        </div>
      </div>
    </div>
  )
}
