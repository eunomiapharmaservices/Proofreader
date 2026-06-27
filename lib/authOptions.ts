import type { NextAuthOptions } from 'next-auth';
import GoogleProvider from 'next-auth/providers/google';

// To restrict access to specific email addresses or a domain,
// uncomment and edit the signIn callback below.
const ALLOWED_DOMAIN = process.env.ALLOWED_EMAIL_DOMAIN; // e.g. "eunomiapharma.com"
const ALLOWED_EMAILS = process.env.ALLOWED_EMAILS?.split(',').map(e => e.trim()); // comma-separated

export const authOptions: NextAuthOptions = {
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
  ],
  pages: {
    signIn: '/login',
  },
  callbacks: {
    async signIn({ user }) {
      const email = user.email ?? '';
      // If neither env var is set, allow any Google account (open access)
      if (!ALLOWED_DOMAIN && !ALLOWED_EMAILS?.length) return true;
      if (ALLOWED_EMAILS?.includes(email)) return true;
      if (ALLOWED_DOMAIN && email.endsWith(`@${ALLOWED_DOMAIN}`)) return true;
      return false;
    },
    async session({ session, token }) {
      if (session.user) (session.user as any).id = token.sub;
      return session;
    },
  },
};
