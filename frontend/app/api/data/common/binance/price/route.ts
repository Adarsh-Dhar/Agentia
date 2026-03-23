import { NextResponse } from 'next/server';

export async function GET() {
  try {
    const response = await fetch(
      'https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT'
    );

    if (!response.ok) {
      throw new Error('Failed to fetch from Binance');
    }

    const data = await response.json();

    // Returns just the number as a string (e.g., "64230.12")
    return new NextResponse(data.price, {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    });
  } catch (error) {
    return new NextResponse('Error fetching price', { status: 500 });
  }
}