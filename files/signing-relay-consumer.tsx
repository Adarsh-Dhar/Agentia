"use client";

/**
 * frontend/components/signing-relay-consumer.tsx
 *
 * Polls /api/signing-relay for pending move_execute requests submitted
 * by the bot running in WebContainer, then signs each one using
 * InterwovenKit's submitTxBlock (AutoSign Ghost Wallet — no user popup).
 *
 * This is the correct way to sign Initia transactions from a bot:
 * the bot never touches the private key; the browser signs via AutoSign.
 */

import { useEffect, useRef, useCallback } from "react";
import { useInterwovenKit } from "@initia/interwovenkit-react";
import type { SigningRequest } from "@/lib/signing-relay-store";

const POLL_INTERVAL_MS = 1_500;

// Encode a Move arg string to a Uint8Array via BCS-compatible encoding.
// The Initia MsgExecute.args field expects BCS-encoded bytes for each arg.
// We handle the most common scalar types; complex types fall back to raw utf-8.
function encodeMoveArg(arg: string): Uint8Array {
  const trimmed = String(arg ?? "").trim();

  // Hex address (0x...) or bech32 (init1...) → 32-byte fixed-length address
  if (/^0x[0-9a-fA-F]{1,64}$/.test(trimmed)) {
    const hex = trimmed.slice(2).padStart(64, "0");
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }

  // Pure decimal integer → u64 little-endian (8 bytes)
  if (/^[0-9]+$/.test(trimmed)) {
    try {
      const val = BigInt(trimmed);
      const buf = new Uint8Array(8);
      let v = val;
      for (let i = 0; i < 8; i++) {
        buf[i] = Number(v & 0xffn);
        v >>= 8n;
      }
      return buf;
    } catch {
      // fall through
    }
  }

  // Boolean
  if (trimmed === "true") return new Uint8Array([1]);
  if (trimmed === "false") return new Uint8Array([0]);

  // Hex bytes (0x followed by even number of hex digits, longer than 32 bytes)
  if (/^0x[0-9a-fA-F]+$/.test(trimmed) && trimmed.length > 66) {
    const hex = trimmed.slice(2);
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }

  // Fallback: UTF-8 string encoded as BCS bytes (ULEB128 length prefix + raw bytes)
  const enc = new TextEncoder().encode(trimmed);
  const lenBytes = uleb128Encode(enc.length);
  const result = new Uint8Array(lenBytes.length + enc.length);
  result.set(lenBytes, 0);
  result.set(enc, lenBytes.length);
  return result;
}

function uleb128Encode(value: number): Uint8Array {
  const buf: number[] = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value !== 0) byte |= 0x80;
    buf.push(byte);
  } while (value !== 0);
  return new Uint8Array(buf);
}

interface SigningRelayConsumerProps {
  /** Called with a log line when a signing event occurs */
  onLog?: (line: string) => void;
  /** Whether the bot is actually running (stop polling when it's not) */
  botRunning?: boolean;
}

export function SigningRelayConsumer({
  onLog,
  botRunning = true,
}: SigningRelayConsumerProps) {
  const { submitTxBlock, initiaAddress, estimateGas } = useInterwovenKit();
  const processingRef = useRef<Set<string>>(new Set());
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const log = useCallback(
    (msg: string) => {
      const line = `[SignRelay] ${msg}`;
      console.log(line);
      onLog?.(line);
    },
    [onLog]
  );

  const signRequest = useCallback(
    async (request: SigningRequest) => {
      if (processingRef.current.has(request.id)) return;
      processingRef.current.add(request.id);

      log(
        `Signing move_execute: ${request.moduleAddress}::${request.moduleName}::${request.functionName}`
      );

      try {
        if (!initiaAddress) {
          throw new Error("Wallet not connected.");
        }

        // Encode args to Uint8Array for BCS
        const encodedArgs = (request.args ?? []).map(encodeMoveArg);

        // Construct the MsgExecute cosmos message
        const messages = [
          {
            typeUrl: "/initia.move.v1.MsgExecute",
            value: {
              sender: initiaAddress,
              module_address: request.moduleAddress,
              module_name: request.moduleName,
              function_name: request.functionName,
              type_args: request.typeArgs ?? [],
              args: encodedArgs,
            },
          },
        ];

        // Estimate gas and sign automatically via AutoSign Ghost Wallet
        let gas: number;
        try {
          gas = await estimateGas({ messages });
        } catch {
          gas = 200_000; // safe fallback
        }

        const { calculateFee, GasPrice } = await import("@cosmjs/stargate");
        const fee = calculateFee(
          Math.ceil(gas * 1.4),
          GasPrice.fromString("0.015uinit")
        );

        // submitTxBlock uses AutoSign (no popup) when enabled
        const { transactionHash } = await submitTxBlock({ messages, fee });

        log(`✓ Signed & broadcast: ${transactionHash}`);

        // Post result back to relay
        await fetch(`/api/signing-relay/${request.id}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ txHash: transactionHash }),
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        log(`✗ Signing failed: ${errorMsg}`);

        // Post error back so the bot doesn't hang
        await fetch(`/api/signing-relay/${request.id}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ error: errorMsg }),
        }).catch(() => {});
      } finally {
        processingRef.current.delete(request.id);
      }
    },
    [initiaAddress, submitTxBlock, estimateGas, log]
  );

  useEffect(() => {
    if (!botRunning) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      return;
    }

    const poll = async () => {
      try {
        const res = await fetch("/api/signing-relay", {
          headers: { "Cache-Control": "no-store" },
        });
        if (!res.ok) return;
        const data = (await res.json()) as { requests: SigningRequest[] };
        for (const request of data.requests ?? []) {
          void signRequest(request);
        }
      } catch {
        // ignore transient poll errors
      }
    };

    void poll();
    intervalRef.current = setInterval(poll, POLL_INTERVAL_MS);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [botRunning, signRequest]);

  // This component renders nothing — it's a background worker
  return null;
}
