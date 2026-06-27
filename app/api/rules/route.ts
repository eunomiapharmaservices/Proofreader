import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/authOptions';
import { getRules, addRule, deleteRule } from '@/lib/kv';

const uid = (s: any) => s.user?.id ?? s.user?.email;

export async function GET() {
  const s = await getServerSession(authOptions);
  if (!s?.user) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 });
  return NextResponse.json(await getRules(uid(s)));
}

export async function POST(req: NextRequest) {
  const s = await getServerSession(authOptions);
  if (!s?.user) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 });
  const { text, type } = await req.json();
  return NextResponse.json(await addRule(uid(s), text, type));
}

export async function DELETE(req: NextRequest) {
  const s = await getServerSession(authOptions);
  if (!s?.user) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 });
  const { id } = await req.json();
  return NextResponse.json(await deleteRule(uid(s), id));
}
