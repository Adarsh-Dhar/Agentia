import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const symbol = searchParams.get('symbol') || 'SOLUSDT';
  const interval = searchParams.get('interval') || '1h'; // 1m, 5m, 1h, 1d

  try {
    const res = await fetch(
      `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=100`
    );
    
    const data = await res.json();

    // Map the raw array to a readable object
    const formattedData = data.map((d: any) => ({
      time: d[0],
      open: parseFloat(d[1]),
      high: parseFloat(d[2]),
      low: parseFloat(d[3]),
      close: parseFloat(d[4]),
      volume: parseFloat(d[5]),
    }));

    return NextResponse.json(formattedData);
  } catch (error) {
    return NextResponse.json({ error: 'Failed to fetch klines' }, { status: 500 });
  }
}