'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Label } from '@/components/ui/label'
import { Zap, HelpCircle, ArrowRight } from 'lucide-react'
import { aiModels } from '@/lib/dummy-data'

export default function DeployPage() {
  const [selectedModel, setSelectedModel] = useState<string>('')
  const [tradingPair, setTradingPair] = useState<string>('')
  const [maxSpend, setMaxSpend] = useState<string>('')
  const [sessionDuration, setSessionDuration] = useState<string>('')
  const [isDeploying, setIsDeploying] = useState(false)

  const handleDeploy = () => {
    setIsDeploying(true)
    setTimeout(() => {
      setIsDeploying(false)
      alert('Agent deployed successfully!')
    }, 2000)
  }

  const isFormValid =
    selectedModel && tradingPair && maxSpend && sessionDuration

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="sticky top-0 z-30 bg-background border-b border-border">
        <div className="px-6 py-4 lg:px-8">
          <h1 className="text-3xl font-bold text-foreground">Deploy Autonomous Agent</h1>
          <p className="text-muted-foreground mt-1">Configure and deploy your AI trading strategy</p>
        </div>
      </div>

      {/* Main Content */}
      <div className="px-6 py-8 lg:px-8">
        <div className="max-w-2xl mx-auto">
          <div className="bg-card border border-border rounded-lg p-8">
            <div className="space-y-8">
              {/* Step 1: AI Model Selection */}
              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <div className="flex items-center justify-center w-8 h-8 rounded-full bg-primary text-primary-foreground font-bold text-sm">
                    1
                  </div>
                  <h2 className="text-lg font-semibold text-foreground">Select AI Model</h2>
                </div>
                <div>
                  <Label htmlFor="model" className="text-foreground mb-2 block">
                    Choose your trading strategy
                  </Label>
                  <Select value={selectedModel} onValueChange={setSelectedModel}>
                    <SelectTrigger id="model" className="bg-background border-border">
                      <SelectValue placeholder="Select an AI model..." />
                    </SelectTrigger>
                    <SelectContent>
                      {aiModels.map((model) => (
                        <SelectItem key={model.id} value={model.id.toString()}>
                          <div className="flex flex-col">
                            <span className="font-medium">{model.name}</span>
                            <span className="text-xs text-muted-foreground">{model.description}</span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Step 2: Trading Pair */}
              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <div className="flex items-center justify-center w-8 h-8 rounded-full bg-primary text-primary-foreground font-bold text-sm">
                    2
                  </div>
                  <h2 className="text-lg font-semibold text-foreground">Target Trading Pair</h2>
                </div>
                <div>
                  <Label htmlFor="pair" className="text-foreground mb-2 block">
                    Trading pair (e.g., INIT/USDC)
                  </Label>
                  <Input
                    id="pair"
                    placeholder="INIT/USDC"
                    value={tradingPair}
                    onChange={(e) => setTradingPair(e.target.value)}
                    className="bg-background border-border text-foreground"
                  />
                </div>
              </div>

              {/* Step 3: Session Configuration */}
              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <div className="flex items-center justify-center w-8 h-8 rounded-full bg-primary text-primary-foreground font-bold text-sm">
                    3
                  </div>
                  <h2 className="text-lg font-semibold text-foreground">Session Key Limits</h2>
                </div>
                <p className="text-sm text-muted-foreground flex items-start gap-2">
                  <HelpCircle size={16} className="flex-shrink-0 mt-0.5" />
                  <span>
                    Grants the AI a time-bound, secure session key without exposing your private keys
                  </span>
                </p>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="spend" className="text-foreground mb-2 block">
                      Max Spend Allowance
                    </Label>
                    <div className="relative">
                      <Input
                        id="spend"
                        type="number"
                        placeholder="1000"
                        value={maxSpend}
                        onChange={(e) => setMaxSpend(e.target.value)}
                        className="bg-background border-border text-foreground pr-12"
                      />
                      <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                        USDC
                      </span>
                    </div>
                  </div>
                  <div>
                    <Label htmlFor="duration" className="text-foreground mb-2 block">
                      Session Duration
                    </Label>
                    <div className="relative">
                      <Input
                        id="duration"
                        type="number"
                        placeholder="24"
                        value={sessionDuration}
                        onChange={(e) => setSessionDuration(e.target.value)}
                        className="bg-background border-border text-foreground pr-12"
                      />
                      <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                        Hours
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Deploy Button */}
              <div className="pt-4">
                <Button
                  onClick={handleDeploy}
                  disabled={!isFormValid || isDeploying}
                  className="w-full bg-gradient-to-r from-primary to-secondary hover:opacity-90 text-primary-foreground font-semibold py-6 text-base disabled:opacity-50"
                >
                  {isDeploying ? (
                    <>
                      <div className="animate-spin mr-2 w-4 h-4 border-2 border-transparent border-t-primary-foreground rounded-full" />
                      Deploying...
                    </>
                  ) : (
                    <>
                      <Zap size={20} className="mr-2" />
                      Sign Session Key & Deploy
                      <ArrowRight size={20} className="ml-2" />
                    </>
                  )}
                </Button>
              </div>
            </div>
          </div>

          {/* Info Box */}
          <div className="mt-8 bg-secondary/10 border border-secondary/20 rounded-lg p-6">
            <h3 className="font-semibold text-foreground mb-3">About Session Keys</h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Session keys provide fine-grained control over what your AI agent can do. Your agent
              will only have access to the allocated funds for the specified duration, and cannot
              access other assets or accounts. This keeps your funds secure while allowing autonomous
              trading.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
