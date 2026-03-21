'use client'

import { useEffect, useRef } from 'react'

interface Log {
  timestamp: string
  message: string
  type: 'info' | 'success' | 'error'
}

interface ExecutionTerminalProps {
  logs: Log[]
}

export function ExecutionTerminal({ logs }: ExecutionTerminalProps) {
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs])

  return (
    <div className="bg-card border border-border rounded-lg overflow-hidden flex flex-col h-[500px]">
      {/* Header */}
      <div className="bg-muted/30 border-b border-border px-4 py-3 flex items-center justify-between">
        <h3 className="font-semibold text-foreground text-sm">Live Execution Terminal</h3>
        <div className="flex gap-1">
          <div className="w-3 h-3 rounded-full bg-green-400 animate-pulse" />
        </div>
      </div>

      {/* Terminal Content */}
      <div className="flex-1 overflow-y-auto bg-background p-4 font-mono text-xs space-y-2">
        {logs.map((log, index) => {
          let textColor = 'text-muted-foreground'
          if (log.type === 'success') textColor = 'text-green-400'
          if (log.type === 'error') textColor = 'text-red-400'

          return (
            <div key={index} className={`${textColor} flex gap-3`}>
              <span className="flex-shrink-0 text-muted-foreground">[{log.timestamp}]</span>
              <span className="flex-1">{log.message}</span>
            </div>
          )
        })}
        <div ref={endRef} />
      </div>

      {/* Footer */}
      <div className="bg-muted/30 border-t border-border px-4 py-3 text-xs text-muted-foreground">
        System ready for new transactions
      </div>
    </div>
  )
}
