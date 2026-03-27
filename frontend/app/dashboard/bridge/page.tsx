"use client"

import React, { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ArrowRight, Zap, Shield, ExternalLink } from 'lucide-react'
import { useInterwovenKit } from '@initia/interwovenkit-react'
import { SUPPORTED_NETWORKS } from '@/lib/constant'

export default function BridgePage() {
  const { address, initiaAddress } = useInterwovenKit()
  const connected = !!(address || initiaAddress)

  const [fromNetwork, setFromNetwork] = useState('')
  const [amount,      setAmount]      = useState('')
  const [isBridging,  setIsBridging]  = useState(false)
  const [success,     setSuccess]     = useState(false)

  const bridgeFee    = 0.5
  const receiveAmt   = amount && parseFloat(amount) > 0
    ? Math.max(0, parseFloat(amount) - bridgeFee).toFixed(2)
    : '0.00'
  const isFormValid  = connected && fromNetwork && amount && parseFloat(amount) > 0

  const handleBridge = () => {
    if (!isFormValid) return
    setIsBridging(true)
    setTimeout(() => {
      setIsBridging(false)
      setSuccess(true)
      setTimeout(() => { setSuccess(false); setAmount(''); setFromNetwork('') }, 3500)
    }, 2000)
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="sticky top-0 z-30 bg-background border-b border-border">
        <div className="px-6 py-4 lg:px-8">
          <h1 className="text-3xl font-bold">Cross-Chain Bridge</h1>
          <p className="text-muted-foreground mt-1">Deposit funds from other chains to Agentia on Initia</p>
        </div>
      </div>

      <div className="px-6 py-8 lg:px-8">
        <div className="max-w-2xl mx-auto">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Bridge form */}
            <div className="lg:col-span-2 bg-card border border-border rounded-lg p-8">
              {!connected && (
                <div className="mb-6 p-4 bg-yellow-500/10 border border-yellow-500/30 rounded-lg text-yellow-300 text-sm">
                  Connect your wallet to use the bridge.
                </div>
              )}

              {success && (
                <div className="mb-6 p-4 bg-green-500/10 border border-green-500/30 rounded-lg text-green-400 text-sm font-medium">
                  ✓ Successfully bridged {amount} USDC from {SUPPORTED_NETWORKS.find(n => n.id === fromNetwork)?.name}!
                </div>
              )}

              <div className="space-y-6">
                <div>
                  <Label htmlFor="from-network" className="mb-2 block font-semibold">From Network</Label>
                  <Select value={fromNetwork} onValueChange={setFromNetwork}>
                    <SelectTrigger id="from-network" className="bg-background border-border h-12">
                      <SelectValue placeholder="Select source network…" />
                    </SelectTrigger>
                    <SelectContent>
                      {SUPPORTED_NETWORKS.map(n => (
                        <SelectItem key={n.id} value={n.id}>
                          {n.icon} {n.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <Label htmlFor="amount" className="mb-2 block font-semibold">Amount to Bridge</Label>
                  <div className="relative">
                    <Input
                      id="amount" type="number" min="0" placeholder="Enter amount"
                      value={amount} onChange={e => setAmount(e.target.value)}
                      className="bg-background border-border text-foreground pr-16 h-12"
                    />
                    <span className="absolute right-4 top-1/2 -translate-y-1/2 font-semibold text-muted-foreground">USDC</span>
                  </div>
                </div>

                <div className="flex justify-center py-2">
                  <div className="bg-primary/10 border border-primary/20 rounded-full p-3">
                    <ArrowRight size={24} className="text-primary" />
                  </div>
                </div>

                <div>
                  <Label className="mb-2 block font-semibold">To Network</Label>
                  <div className="bg-background border border-border rounded-lg p-4 flex items-center gap-3">
                    <span className="text-2xl">⚡</span>
                    <div>
                      <p className="font-semibold">Agentia · Initia Rollup</p>
                      <p className="text-sm text-muted-foreground">100ms block times</p>
                    </div>
                  </div>
                </div>

                {/* Connected wallet display */}
                {connected && (initiaAddress ?? address) && (
                  <div className="bg-primary/5 border border-primary/20 rounded-lg p-3 flex items-center gap-2 text-sm">
                    <div className="w-2 h-2 rounded-full bg-green-400" />
                    <span className="text-muted-foreground">Depositing to:</span>
                    <span className="font-mono text-foreground truncate">
                      {(initiaAddress ?? address)!.slice(0, 12)}…{(initiaAddress ?? address)!.slice(-6)}
                    </span>
                  </div>
                )}

                <Button
                  onClick={handleBridge}
                  disabled={!isFormValid || isBridging}
                  className="w-full bg-gradient-to-r from-primary to-secondary hover:opacity-90 text-primary-foreground font-semibold py-6 text-base disabled:opacity-50"
                >
                  {isBridging ? (
                    <><div className="animate-spin mr-2 w-4 h-4 border-2 border-transparent border-t-primary-foreground rounded-full" />Bridging…</>
                  ) : (
                    <><Zap size={20} className="mr-2" />Bridge & Deposit Instantly</>
                  )}
                </Button>

                {amount && parseFloat(amount) > 0 && (
                  <div className="bg-muted/10 border border-muted/30 rounded-lg p-4 text-sm">
                    <p className="text-muted-foreground mb-2">Estimated Breakdown</p>
                    <div className="space-y-1">
                      <div className="flex justify-between"><span>Amount</span><span>{amount} USDC</span></div>
                      <div className="flex justify-between text-muted-foreground"><span>Bridge Fee</span><span>~$0.50</span></div>
                      <div className="border-t border-muted mt-2 pt-2 flex justify-between font-medium">
                        <span>You receive</span><span>~{receiveAmt} USDC</span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Sidebar */}
            <div className="space-y-6">
              <div className="bg-card border border-border rounded-lg p-6">
                <div className="flex items-start gap-3 mb-3">
                  <Shield size={20} className="text-primary flex-shrink-0 mt-0.5" />
                  <div>
                    <h3 className="font-semibold">Secure Bridge</h3>
                    <p className="text-xs text-muted-foreground mt-1">
                      Multi-signature validation via Initia&apos;s Interwoven Bridge protocol.
                    </p>
                  </div>
                </div>
                <a
                  href="https://app.initia.xyz/bridge"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 text-xs text-primary hover:underline mt-3"
                >
                  Open Initia Bridge App <ExternalLink size={11} />
                </a>
              </div>

              <div className="bg-card border border-border rounded-lg p-6">
                <h3 className="font-semibold mb-4">Supported Assets</h3>
                {[
                  { name: 'USDC', status: 'Active', active: true },
                  { name: 'USDT', status: 'Coming Soon', active: false },
                  { name: 'ETH',  status: 'Coming Soon', active: false },
                ].map(a => (
                  <div key={a.name} className="flex items-center justify-between py-1">
                    <span className="text-sm">{a.name}</span>
                    <span className={`text-xs px-2 py-0.5 rounded ${a.active ? 'bg-primary/10 text-primary' : 'bg-muted/20 text-muted-foreground'}`}>
                      {a.status}
                    </span>
                  </div>
                ))}
              </div>

              <div className="bg-card border border-border rounded-lg p-6">
                <h3 className="font-semibold mb-2 flex items-center gap-2">
                  <Zap size={16} className="text-primary" /> Fast Transactions
                </h3>
                <p className="text-sm text-muted-foreground">
                  Initia&apos;s 100ms block times mean deposits arrive almost instantly after bridge confirmation.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}