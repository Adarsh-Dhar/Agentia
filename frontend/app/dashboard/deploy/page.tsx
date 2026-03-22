"use client"

import React, { useState } from 'react'
import { Button } from '@/components/ui/button.tsx'
import { Input } from '@/components/ui/input.tsx'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select.tsx'
import { Label } from '@/components/ui/label.tsx'
import { Zap, HelpCircle, ArrowRight, CheckCircle, ShieldCheck, ShieldOff } from 'lucide-react'
import { useUser } from '@/lib/user-context.tsx'
import { deployAgent } from '@/lib/api.tsx'
import { useRouter } from 'next/navigation.ts'
import { useInterwovenKit, TESTNET } from '@initia/interwovenkit-react'
import { useMutation } from '@tanstack/react-query'
import { MsgSend } from 'cosmjs-types/cosmos/bank/v1beta1/tx.js'

const AI_MODELS = [
  { id: 'MEME_SNIPER',       name: 'Meme Token Sniper',       description: 'Identify and trade emerging meme tokens' },
  { id: 'ARBITRAGE',         name: 'Arbitrage Bot',            description: 'Exploit price differences across pairs' },
  { id: 'SENTIMENT_TRADER',  name: 'Social Sentiment Trader',  description: 'Trade based on social media sentiment' },
]

export default function DeployPage() {
  const { user } = useUser()
  const { autoSign, initiaAddress, requestTxBlock } = useInterwovenKit()
  const router = useRouter()

  const [agentName,    setAgentName]    = useState('')
  const [strategy,     setStrategy]     = useState('')
  const [tradingPair,  setTradingPair]  = useState('')
  const [maxSpend,     setMaxSpend]     = useState('')
  const [sessionHours, setSessionHours] = useState('')
  const [isDeploying,  setIsDeploying]  = useState(false)
  const [deployStep,   setDeployStep]   = useState<string | null>(null)
  const [error,        setError]        = useState<string | null>(null)
  const [deployed,     setDeployed]     = useState(false)

  const autosignEnabled = autoSign?.isEnabledByChain?.[TESTNET.defaultChainId] ?? false

  const enableAutosign = useMutation({
    mutationFn: () => autoSign.enable(TESTNET.defaultChainId),
    onError: (e) => console.error('Autosign enable failed', e),
  })

  const isFormValid = agentName && strategy && tradingPair && maxSpend && sessionHours

  const handleDeploy = async () => {
    if (!user || !initiaAddress || !isFormValid) return
    setIsDeploying(true)
    setError(null)

    try {
      // Step 1: Generate the agent session key pair entirely client-side
      setDeployStep('Generating session key…')
      const { RawKey } = await import('@initia/initia.js')

      const randomBytes = window.crypto.getRandomValues(new Uint8Array(32))
      const privHex = Array.from(randomBytes)
        .map(b => b.toString(16).padStart(2, '0'))
        .join('')

      const sessionKey = RawKey.fromHex(privHex)
      if (!sessionKey.publicKey) throw new Error('Failed to derive public key')

      const agentAddress = sessionKey.accAddress
      const sessionKeyPub = (sessionKey.publicKey as { key: string }).key
      const sessionKeyPriv = sessionKey.privateKey.toString('hex')

      // Step 2: Fund the agent wallet from the user's main wallet.
      // requestTxBlock opens a confirmation modal in the wallet UI.
      // The MsgSend creates the account on-chain and funds it for gas.
      setDeployStep('Awaiting wallet confirmation…')
      const spendAmount = parseFloat(maxSpend)
      if (isNaN(spendAmount) || spendAmount <= 0) throw new Error('Invalid spend amount')

      // 1 INIT = 1,000,000 uinit
      const uinitAmount = String(Math.floor(spendAmount * 1_000_000))

      const messages = [
        {
          typeUrl: '/cosmos.bank.v1beta1.MsgSend',
          value: MsgSend.fromPartial({
            fromAddress: initiaAddress,
            toAddress: agentAddress,
            amount: [{ amount: uinitAmount, denom: 'uinit' }],
          }),
        },
      ]

      const { transactionHash } = await requestTxBlock({ messages })
      console.log('Agent wallet funded. Tx hash:', transactionHash)

      // Step 3: Save the agent to the database only after funding succeeds
      setDeployStep('Registering agent…')
      const expiresAt = new Date(
        Date.now() + parseFloat(sessionHours) * 3_600_000,
      ).toISOString()

      await deployAgent({
        userId: user.id,
        name: agentName,
        strategy,
        targetPair: tradingPair,
        spendAllowance: spendAmount,
        sessionExpiresAt: expiresAt,
        sessionKeyPub,
        sessionKeyPriv,
      })

      setDeployed(true)
      setTimeout(() => router.push('/dashboard'), 1500)
    } catch (err) {
      console.error('Deployment failed:', err)
      setError(err instanceof Error ? err.message : 'Deployment failed')
      setIsDeploying(false)
      setDeployStep(null)
    }
  }

  if (deployed) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center space-y-4">
          <div className="w-16 h-16 bg-green-500/20 rounded-full flex items-center justify-center mx-auto">
            <CheckCircle size={32} className="text-green-400" />
          </div>
          <h2 className="text-2xl font-bold text-foreground">Agent Deployed!</h2>
          <p className="text-muted-foreground">Agent wallet funded and ready to trade.</p>
          <p className="text-sm text-muted-foreground">Redirecting to dashboard…</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="sticky top-0 z-30 bg-background border-b border-border">
        <div className="px-6 py-4 lg:px-8">
          <h1 className="text-3xl font-bold text-foreground">Deploy Autonomous Agent</h1>
          <p className="text-muted-foreground mt-1">Configure and deploy your AI trading strategy on Initia</p>
        </div>
      </div>

      <div className="px-6 py-8 lg:px-8">
        <div className="max-w-2xl mx-auto space-y-6">

          {/* Autosign banner */}
          <div className={`rounded-lg p-4 border flex items-start gap-3 ${
            autosignEnabled
              ? 'bg-green-500/10 border-green-500/30'
              : 'bg-yellow-500/10 border-yellow-500/30'
          }`}>
            {autosignEnabled
              ? <ShieldCheck size={20} className="text-green-400 flex-shrink-0 mt-0.5" />
              : <ShieldOff  size={20} className="text-yellow-400 flex-shrink-0 mt-0.5" />
            }
            <div className="flex-1 min-w-0">
              <p className={`text-sm font-medium ${autosignEnabled ? 'text-green-300' : 'text-yellow-300'}`}>
                {autosignEnabled ? 'Autosign is active' : 'Autosign not enabled'}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {autosignEnabled
                  ? 'Your agents can sign transactions automatically without interrupting you.'
                  : 'Enable Initia autosign so your agents can trade without repeated confirmation popups.'}
              </p>
            </div>
            {!autosignEnabled && (
              <Button
                size="sm"
                variant="outline"
                className="flex-shrink-0 border-yellow-500/30 text-yellow-300 hover:bg-yellow-500/10"
                onClick={() => enableAutosign.mutate()}
                disabled={enableAutosign.isPending || autoSign?.isLoading}
              >
                <Zap size={14} className="mr-1.5" />
                {enableAutosign.isPending ? 'Enabling…' : 'Enable'}
              </Button>
            )}
          </div>

          {/* Deploy form */}
          <div className="bg-card border border-border rounded-lg p-8">
            <div className="space-y-8">
              {error && (
                <div className="p-4 bg-destructive/10 border border-destructive/30 rounded-lg text-destructive text-sm">
                  {error}
                </div>
              )}

              {/* Step 1 */}
              <Step number={1} title="Agent Name">
                <Input
                  placeholder="e.g., INIT Sniffer, Arb Master…"
                  value={agentName}
                  onChange={(e) => setAgentName(e.target.value)}
                  className="bg-background border-border text-foreground"
                />
              </Step>

              {/* Step 2 */}
              <Step number={2} title="Select AI Model">
                <Select value={strategy} onValueChange={setStrategy}>
                  <SelectTrigger className="bg-background border-border">
                    <SelectValue placeholder="Select a trading strategy…" />
                  </SelectTrigger>
                  <SelectContent>
                    {AI_MODELS.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        <div className="flex flex-col">
                          <span className="font-medium">{m.name}</span>
                          <span className="text-xs text-muted-foreground">{m.description}</span>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Step>

              {/* Step 3 */}
              <Step number={3} title="Target Trading Pair">
                <Input
                  placeholder="INIT/USDC"
                  value={tradingPair}
                  onChange={(e) => setTradingPair(e.target.value)}
                  className="bg-background border-border text-foreground"
                />
              </Step>

              {/* Step 4 */}
              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <div className="flex items-center justify-center w-8 h-8 rounded-full bg-primary text-primary-foreground font-bold text-sm">4</div>
                  <h2 className="text-lg font-semibold text-foreground">Session Key Limits</h2>
                </div>
                <p className="text-sm text-muted-foreground flex items-start gap-2">
                  <HelpCircle size={16} className="flex-shrink-0 mt-0.5" />
                  <span>
                    A fresh wallet is generated for your agent and funded from your main wallet.
                    The agent trades only within these limits — your main wallet is never exposed.
                  </span>
                </p>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="spend" className="mb-2 block">Initial Funding</Label>
                    <div className="relative">
                      <Input
                        id="spend"
                        type="number"
                        min="0"
                        placeholder="100"
                        value={maxSpend}
                        onChange={(e) => setMaxSpend(e.target.value)}
                        className="bg-background border-border text-foreground pr-16"
                      />
                      <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">INIT</span>
                    </div>
                  </div>
                  <div>
                    <Label htmlFor="duration" className="mb-2 block">Session Duration</Label>
                    <div className="relative">
                      <Input
                        id="duration"
                        type="number"
                        min="1"
                        placeholder="24"
                        value={sessionHours}
                        onChange={(e) => setSessionHours(e.target.value)}
                        className="bg-background border-border text-foreground pr-16"
                      />
                      <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">Hours</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Deploy button */}
              <div className="pt-4 space-y-3">
                {maxSpend && parseFloat(maxSpend) > 0 && (
                  <div className="p-3 bg-primary/5 border border-primary/20 rounded-lg text-sm text-muted-foreground flex items-start gap-2">
                    <Zap size={15} className="text-primary flex-shrink-0 mt-0.5" />
                    <span>
                      Deploying will send{' '}
                      <span className="text-foreground font-semibold">
                        {parseFloat(maxSpend).toLocaleString()} INIT
                      </span>{' '}
                      from your main wallet to the agent&apos;s dedicated on-chain wallet, then register the agent.
                    </span>
                  </div>
                )}

                <Button
                  onClick={handleDeploy}
                  disabled={!isFormValid || isDeploying || !initiaAddress}
                  className="w-full bg-gradient-to-r from-primary to-secondary hover:opacity-90 text-primary-foreground font-semibold py-6 text-base disabled:opacity-50"
                >
                  {isDeploying ? (
                    <>
                      <div className="animate-spin mr-2 w-4 h-4 border-2 border-transparent border-t-primary-foreground rounded-full" />
                      {deployStep ?? 'Deploying…'}
                    </>
                  ) : (
                    <><Zap size={20} className="mr-2" />Fund & Deploy Agent<ArrowRight size={20} className="ml-2" /></>
                  )}
                </Button>

                {!initiaAddress && (
                  <p className="text-xs text-destructive text-center">
                    Connect your Initia wallet before deploying.
                  </p>
                )}
                {!autosignEnabled && initiaAddress && (
                  <p className="text-xs text-muted-foreground text-center">
                    Tip: Enable autosign above so your agent can trade without future confirmations.
                  </p>
                )}
              </div>
            </div>
          </div>

          <div className="bg-secondary/10 border border-secondary/20 rounded-lg p-6">
            <h3 className="font-semibold text-foreground mb-2">How agent funding works</h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              When you deploy, a brand-new Initia wallet is generated in your browser for the agent.
              Your connected wallet sends the specified INIT amount directly to that agent wallet via a
              standard <code className="font-mono text-xs bg-muted px-1 py-0.5 rounded">MsgSend</code> — creating its
              on-chain account and covering gas. The worker then uses the stored private key to execute
              trades autonomously within the session limits.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

function Step({ number, title, children }: { number: number; title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <div className="flex items-center justify-center w-8 h-8 rounded-full bg-primary text-primary-foreground font-bold text-sm">
          {number}
        </div>
        <h2 className="text-lg font-semibold text-foreground">{title}</h2>
      </div>
      {children}
    </div>
  )
}