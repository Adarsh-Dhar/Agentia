"use client";

/**
 * frontend/components/signing-relay-consumer.tsx
 */

import { useCallback, useEffect, useRef } from "react";
import { useInterwovenKit } from "@initia/interwovenkit-react";
import type { SigningRequest } from "@/lib/signing-relay-store";

const POLL_INTERVAL_MS = 1_500;

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

function encodeMoveArg(arg: string): Uint8Array {
  const trimmed = String(arg ?? "").trim();
  if (/^0x[0-9a-fA-F]{1,64}$/.test(trimmed)) {
    const hex = trimmed.slice(2).padStart(64, "0");
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i += 1) {
      bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }
  if (/^[0-9]+$/.test(trimmed)) {
    try {
      let value = BigInt(trimmed);
      const buf = new Uint8Array(8);
      for (let i = 0; i < 8; i += 1) {
        buf[i] = Number(value & 0xffn);
        value >>= 8n;
      }
      return buf;
    } catch {
      // fall through
    }
  }
  if (trimmed === "true") return new Uint8Array([1]);
  if (trimmed === "false") return new Uint8Array([0]);
  if (/^0x[0-9a-fA-F]+$/.test(trimmed) && trimmed.length > 66) {
    const hex = trimmed.slice(2);
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }
  const enc = new TextEncoder().encode(trimmed);
  const lenBytes = uleb128Encode(enc.length);
  const result = new Uint8Array(lenBytes.length + enc.length);
  result.set(lenBytes, 0);
  result.set(enc, lenBytes.length);
  return result;
}

interface SigningRelayConsumerProps {
  onLog?: (line: string) => void;
  botRunning?: boolean;
}

export function SigningRelayConsumer({ onLog, botRunning = true }: SigningRelayConsumerProps) {
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

      log(`Signing move_execute: ${request.moduleAddress}::${request.moduleName}::${request.functionName}`);

      try {
        if (!initiaAddress) throw new Error("Wallet not connected.");

        const encodedArgs = (request.args ?? []).map(encodeMoveArg);
        const messages = [{
          typeUrl: "/initia.move.v1.MsgExecute",
          value: {
            sender: initiaAddress,
            module_address: request.moduleAddress,
            module_name: request.moduleName,
            function_name: request.functionName,
            type_args: request.typeArgs ?? [],
            args: encodedArgs,
          },
        }];

        let gas: number;
        try {
          gas = await estimateGas({ messages });
        } catch {
          gas = 200_000;
        }

        const { calculateFee, GasPrice } = await import("@cosmjs/stargate");
        const fee = calculateFee(Math.ceil(gas * 1.4), GasPrice.fromString("0.015uinit"));
        const { transactionHash } = await submitTxBlock({ messages, fee });

        log(`✓ Signed & broadcast: ${transactionHash}`);
        await fetch(`/api/signing-relay/${request.id}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ txHash: transactionHash }),
        });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        log(`✗ Signing failed: ${errorMsg}`);
        await fetch(`/api/signing-relay/${request.id}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ error: errorMsg }),
        }).catch(() => {});
      } finally {
        processingRef.current.delete(request.id);
      }
    },
    [estimateGas, initiaAddress, log, submitTxBlock]
  );

  useEffect(() => {
    if (!botRunning) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      intervalRef.current = null;
      return;
    }

    const poll = async () => {
      try {
        const res = await fetch("/api/signing-relay", { headers: { "Cache-Control": "no-store" } });
        if (!res.ok) return;
        const data = (await res.json()) as { requests: SigningRequest[] };
        for (const request of data.requests ?? []) {
          void signRequest(request);
        }
      } catch {
        // ignore transient errors
      }
    };

    void poll();
    intervalRef.current = setInterval(poll, POLL_INTERVAL_MS);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      intervalRef.current = null;
    };
  }, [botRunning, signRequest]);

  return null;
}
