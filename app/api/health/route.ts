import { NextResponse } from "next/server";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export function GET() {
  return NextResponse.json({ ok: true }, { headers: cors });
}

export function OPTIONS() {
  return new Response(null, { headers: cors });
} 