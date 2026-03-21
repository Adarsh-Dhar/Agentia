"use client"

import React from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { useRouter } from 'next/navigation'
import { useInterwovenKit } from '@initia/interwovenkit-react'

export function LandingHeader() {
  const router = useRouter()
  const { address, initiaAddress, openConnect } = useInterwovenKit()

  const connected = !!(address || initiaAddress)
  const shortAddr = (initiaAddress ?? address)
    ? `${(initiaAddress ?? address)!.slice(0, 8)}...`
    : null

  const handleConnect = async () => {
    if (connected) {
      router.push('/dashboard')
    } else {
      await openConnect()
    }
  }

  return (
    <header className="fixed top-0 w-full z-50 bg-background/80 backdrop-blur-md border-b border-border">
      <nav className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2 hover:opacity-80 transition-opacity">
          <div className="w-8 h-8 bg-gradient-to-br from-primary to-secondary rounded-lg flex items-center justify-center">
            <span className="text-white font-bold text-sm">A</span>
          </div>
          <span className="font-bold text-lg">Agentia</span>
        </Link>

        <div className="hidden md:flex items-center gap-8">
          <a href="#features" className="text-sm text-foreground/70 hover:text-foreground transition-colors">
            Features
          </a>
          <a href="#security" className="text-sm text-foreground/70 hover:text-foreground transition-colors">
            Security
          </a>
          <a href="#" className="text-sm text-foreground/70 hover:text-foreground transition-colors">
            Docs
          </a>
          {connected && (
            <Link href="/dashboard" className="text-sm text-foreground/70 hover:text-foreground transition-colors">
              Dashboard
            </Link>
          )}
        </div>

        {connected ? (
          <div className="flex items-center gap-3">
            <span className="hidden sm:block text-xs font-mono text-muted-foreground bg-muted/30 px-3 py-1.5 rounded-full border border-border/50">
              {shortAddr}
            </span>
            <Button
              onClick={() => router.push('/dashboard')}
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              Open App
            </Button>
          </div>
        ) : (
          <Button
            onClick={handleConnect}
            className="bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            Connect Wallet
          </Button>
        )}
      </nav>
    </header>
  )
}