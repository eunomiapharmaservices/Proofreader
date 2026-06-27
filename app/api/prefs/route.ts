import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/authOptions';
import { getPrefs, savePrefs } from '@/lib/kv';

const uid = (s: any) => s.user?.id ?? s.user?.email;

export async function GET() {
  const s = await getServerSession(authOptions);
  if (!s?.user) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 });
  return NextResponse.json(await getPrefs(uid(s)));
}

export async function POST(req: NextRequest) {
  const s = await getServerSession(authOptions);
  if (!s?.user) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 });
  await savePrefs(uid(s), await req.json());
  return NextResponse.json({ ok: true });
}
