// ============================================================
// FILE: src/oneinch-swap.ts
// 1inch Aggregator V5 — EVM swap execution
// Chain ID: 42161 | Router: 0x1111111254EEB25477B68fb85Ed929f73A960582
// ============================================================

import axios from "axios";
import { ethers } from "ethers";

const ONEINCH_API = "https://api.1inch.dev/swap/v6.0/42161";
const ROUTER_ADDRESS = "0x1111111254EEB25477B68fb85Ed929f73A960582";

// API key from 1inch dev portal (https://portal.1inch.dev/)
const API_KEY = process.env.ONEINCH_API_KEY!;

export interface OneInchSwapParams {
  fromTokenAddress: string;
  toTokenAddress: string;
  amount: string;          // In fromToken's smallest unit (wei for 18-decimal tokens)
  fromAddress: string;     // The wallet that will execute the swap
  slippage: number;        // 0.5 = 0.5% slippage tolerance
  disableEstimate?: boolean;
}


/**
 * Approves the 1inch router to spend your tokens.
 * Call once before the first swap with a given token.
 */
export async function approveToken(
  signer: ethers.Signer,
  tokenAddress: string,
  amount: bigint = ethers.MaxUint256  // Infinite approval (common DeFi practice)
): Promise<string> {
  const ERC20_ABI = [
    "function approve(address spender, uint256 amount) returns (bool)",
    "function allowance(address owner, address spender) view returns (uint256)",
  ];
  
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
  const walletAddress = await signer.getAddress();

  // Check existing allowance first
  const existing = await token.allowance(walletAddress, ROUTER_ADDRESS);
  if (existing >= amount) {
    console.log("[1inch] Token already approved");
    return "already-approved";
  }

  const tx = await token.approve(ROUTER_ADDRESS, amount);
  await tx.wait();
  console.log(`[1inch] Token approved: ${tx.hash}`);
  return tx.hash;
}


/**
 * Fetches swap transaction data from 1inch API.
 * Returns calldata ready to be submitted to the router contract.
 */
export async function getSwapTransaction(
  params: OneInchSwapParams
): Promise<{
  to: string;
  data: string;
  value: string;
  gas: number;
  fromTokenAmount: string;
  toTokenAmount: string;
}> {
  const { data } = await axios.get(`${ONEINCH_API}/swap`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
    params: {
      src: params.fromTokenAddress,
      dst: params.toTokenAddress,
      amount: params.amount,
      from: params.fromAddress,
      slippage: params.slippage,
      disableEstimate: params.disableEstimate ?? false,
      allowPartialFill: false,
    },
  });

  return {
    to: data.tx.to,
    data: data.tx.data,
    value: data.tx.value,
    gas: data.tx.gas,
    fromTokenAmount: data.fromTokenAmount,
    toTokenAmount: data.toTokenAmount,
  };
}

/**
 * Executes a 1inch swap.
 * Approves token if needed, then submits the swap transaction.
 */
export async function executeSwap(
  signer: ethers.Signer,
  params: OneInchSwapParams
): Promise<{ success: boolean; txHash?: string; outputAmount?: string; error?: string }> {
  try {
    // Get optimized swap calldata from 1inch
    const swapData = await getSwapTransaction(params);

    console.log(`[1inch] Swapping: input=${params.amount} | expected output=${swapData.toTokenAmount}`);

    // Submit transaction
    const tx = await signer.sendTransaction({
      to: swapData.to,
      data: swapData.data,
      value: BigInt(swapData.value || "0"),
      gasLimit: BigInt(Math.ceil(swapData.gas * 1.2)), // 20% buffer
    });

    console.log(`[1inch] TX submitted: ${tx.hash}`);
    const receipt = await tx.wait();
    
    if (receipt?.status === 0) {
      return { success: false, txHash: tx.hash, error: "Transaction reverted" };
    }

    return { 
      success: true, 
      txHash: tx.hash,
      outputAmount: swapData.toTokenAmount,
    };

  } catch (err: any) {
    return { success: false, error: err.response?.data?.description || err.message };
  }
}