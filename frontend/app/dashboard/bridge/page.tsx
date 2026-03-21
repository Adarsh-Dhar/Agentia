'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ArrowRight, Zap, Shield } from 'lucide-react'
import { supportedNetworks } from '@/lib/dummy-data'

export default function BridgePage() {
  const [fromNetwork, setFromNetwork] = useState<string>('')
  const [amount, setAmount] = useState<string>('')
  const [isBridging, setIsBridging] = useState(false)

  const handleBridge = () => {
    setIsBridging(true)
    setTimeout(() => {
      setIsBridging(false)
      alert(`Successfully bridged ${amount} USDC from ${fromNetwork}!`)
      setAmount('')
      setFromNetwork('')
    }, 2000)
  }

  const isFormValid = fromNetwork && amount && parseFloat(amount) > 0

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="sticky top-0 z-30 bg-background border-b border-border">
        <div className="px-6 py-4 lg:px-8">
          <h1 className="text-3xl font-bold text-foreground">Cross-Chain Bridge</h1>
          <p className="text-muted-foreground mt-1">Deposit funds from other chains to Agentia</p>
        </div>
      </div>

      {/* Main Content */}
      <div className="px-6 py-8 lg:px-8">
        <div className="max-w-2xl mx-auto">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Main Bridge Card */}
            <div className="lg:col-span-2 bg-card border border-border rounded-lg p-8">
              <div className="space-y-6">
                {/* From Network */}
                <div>
                  <Label htmlFor="from-network" className="text-foreground mb-2 block font-semibold">
                    From Network
                  </Label>
                  <Select value={fromNetwork} onValueChange={setFromNetwork}>
                    <SelectTrigger id="from-network" className="bg-background border-border h-12">
                      <SelectValue placeholder="Select source network..." />
                    </SelectTrigger>
                    <SelectContent>
                      {supportedNetworks.map((network) => (
                        <SelectItem key={network.id} value={network.id.toString()}>
                          <span>{network.icon} {network.name}</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Amount Input */}
                <div>
                  <Label htmlFor="amount" className="text-foreground mb-2 block font-semibold">
                    Amount to Bridge
                  </Label>
                  <div className="relative">
                    <Input
                      id="amount"
                      type="number"
                      placeholder="Enter amount"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      className="bg-background border-border text-foreground pr-16 h-12"
                    />
                    <span className="absolute right-4 top-1/2 -translate-y-1/2 font-semibold text-muted-foreground">
                      USDC
                    </span>
                  </div>
                </div>

                {/* Arrow */}
                <div className="flex justify-center py-4">
                  <div className="bg-primary/10 border border-primary/20 rounded-full p-3">
                    <ArrowRight size={24} className="text-primary" />
                  </div>
                </div>

                {/* To Network */}
                <div>
                  <Label className="text-foreground mb-2 block font-semibold">
                    To Network
                  </Label>
                  <div className="bg-background border border-border rounded-lg p-4">
                    <div className="flex items-center gap-3">
                      <span className="text-2xl">⚡</span>
                      <div>
                        <p className="font-semibold text-foreground">Agentia Initia Rollup</p>
                        <p className="text-sm text-muted-foreground">Lightning-fast 100ms block times</p>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Bridge Button */}
                <Button
                  onClick={handleBridge}
                  disabled={!isFormValid || isBridging}
                  className="w-full bg-gradient-to-r from-primary to-secondary hover:opacity-90 text-primary-foreground font-semibold py-6 text-base disabled:opacity-50"
                >
                  {isBridging ? (
                    <>
                      <div className="animate-spin mr-2 w-4 h-4 border-2 border-transparent border-t-primary-foreground rounded-full" />
                      Bridging...
                    </>
                  ) : (
                    <>
                      <Zap size={20} className="mr-2" />
                      Bridge & Deposit Instantly
                    </>
                  )}
                </Button>

                {/* Fee Info */}
                {amount && (
                  <div className="bg-muted/10 border border-muted/30 rounded-lg p-4">
                    <p className="text-sm text-muted-foreground mb-2">Estimated Breakdown</p>
                    <div className="space-y-1 text-sm font-medium">
                      <div className="flex justify-between text-foreground">
                        <span>Amount</span>
                        <span>{amount} USDC</span>
                      </div>
                      <div className="flex justify-between text-muted-foreground">
                        <span>Bridge Fee</span>
                        <span>~$0.50</span>
                      </div>
                      <div className="border-t border-muted mt-2 pt-2 flex justify-between text-foreground">
                        <span>You will receive</span>
                        <span>~{(parseFloat(amount) - 0.5).toFixed(2)} USDC</span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Sidebar */}
            <div className="space-y-6">
              {/* Security Info */}
              <div className="bg-card border border-border rounded-lg p-6">
                <div className="flex items-start gap-3 mb-4">
                  <Shield size={24} className="text-primary flex-shrink-0" />
                  <div>
                    <h3 className="font-semibold text-foreground">Secure Bridge</h3>
                    <p className="text-xs text-muted-foreground mt-1">
                      Multi-signature validation ensures safe cross-chain transfers
                    </p>
                  </div>
                </div>
              </div>

              {/* Supported Assets */}
              <div className="bg-card border border-border rounded-lg p-6">
                <h3 className="font-semibold text-foreground mb-4">Supported Assets</h3>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-foreground">USDC</span>
                    <span className="text-xs bg-primary/10 text-primary px-2 py-1 rounded">Active</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-foreground">USDT</span>
                    <span className="text-xs bg-muted/20 text-muted-foreground px-2 py-1 rounded">
                      Coming Soon
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-foreground">ETH</span>
                    <span className="text-xs bg-muted/20 text-muted-foreground px-2 py-1 rounded">
                      Coming Soon
                    </span>
                  </div>
                </div>
              </div>

              {/* Transaction Speed */}
              <div className="bg-card border border-border rounded-lg p-6">
                <h3 className="font-semibold text-foreground mb-3 flex items-center gap-2">
                  <Zap size={18} className="text-primary" />
                  Fast Transactions
                </h3>
                <p className="text-sm text-muted-foreground">
                  Initia's 100ms block times mean your deposits arrive almost instantly.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
