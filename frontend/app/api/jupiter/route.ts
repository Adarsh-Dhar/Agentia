// // frontend/app/api/jupiter/route.ts
// import { NextRequest, NextResponse } from "next/server";

// export async function GET(req: NextRequest) {
//   // Extract all query parameters sent by the WebContainer
//   const searchParams = req.nextUrl.searchParams;
//   const jupiterUrl = `https://quote-api.jup.ag/v6/quote?${searchParams.toString()}`;

//   try {
//     const response = await fetch(jupiterUrl, {
//       headers: {
//         // A standard server-to-server User-Agent
//         'User-Agent': 'Agentia-Backend-Service/1.0',
//         'Accept': 'application/json'
//       }
//     });

//     if (!response.ok) {
//       return NextResponse.json({ error: `Jupiter returned ${response.status}` }, { status: response.status });
//     }

//     const data = await response.json();
//     return NextResponse.json(data);

//   } catch (error: any) {
//     return NextResponse.json({ error: error.message }, { status: 500 });
//   }
// }