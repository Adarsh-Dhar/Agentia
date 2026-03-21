'use client'

import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { useRouter } from 'next/navigation'

export function LandingHeader() {
  const router = useRouter()

  const handleConnect = () => {
    router.push('/dashboard')
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
        </div>

        <Button 
          onClick={handleConnect}
          className="bg-primary hover:bg-primary/90 text-primary-foreground"
        >
          Connect to App
        </Button>
      </nav>
    </header>
  )
}
