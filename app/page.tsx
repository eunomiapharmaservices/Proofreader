import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/authOptions';
import { redirect } from 'next/navigation';
import ProofreadingAgent from '@/components/ProofreadingAgent';

export default async function Home() {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/login');

  return (
    <main className="min-h-screen bg-gray-50">
      <ProofreadingAgent user={session.user as { name: string; email: string; image?: string }} />
    </main>
  );
}
