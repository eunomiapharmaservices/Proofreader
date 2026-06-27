import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/authOptions';
import { getStats, incrementStat } from '@/lib/kv';

const uid = (s: any) => s.user?.id ?? s.user?.email;

export async function GET() {
  const s = await getServerSession(authOptions);
  if (!s?.user) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 });
  return NextResponse.json(await getStats(uid(s)));
}

export async function POST(req: NextRequest) {
  const s = await getServerSession(authOptions);
  if (!s?.user) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 });
  const { field } = await req.json();
  await incrementStat(uid(s), field);
  return NextResponse.json({ ok: true });
}
