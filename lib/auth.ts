import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import bcrypt from 'bcryptjs';
import sql from './db';

export const { handlers, signIn, signOut, auth, unstable_update } = NextAuth({
  trustHost: true,
  secret: process.env.NEXTAUTH_SECRET ?? process.env.AUTH_SECRET,
  providers: [
    Credentials({
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null;

        const rows = await sql`
          SELECT id, email, name, password_hash, is_admin
          FROM users
          WHERE email = ${credentials.email as string}
          LIMIT 1
        `;

        if (rows.length === 0) return null;

        const user = rows[0];
        const valid = await bcrypt.compare(credentials.password as string, user.password_hash as string);
        if (!valid) return null;

        return {
          id: user.id as string,
          email: user.email as string,
          name: user.name as string,
          isAdmin: user.is_admin as boolean,
        };
      },
    }),
  ],
  session: { strategy: 'jwt' },
  pages: { signIn: '/login' },
  callbacks: {
    async jwt({ token, user, trigger, session }) {
      if (user) {
        token.id = user.id;
        token.isAdmin = (user as { isAdmin?: boolean }).isAdmin ?? false;
      }
      // Handle session update calls (impersonation)
      if (trigger === 'update' && session) {
        if (session.impersonatedUserId !== undefined) {
          // Only admins can impersonate
          if (token.isAdmin) {
            token.impersonatedUserId = session.impersonatedUserId || null;
          }
        }
      }
      return token;
    },
    async session({ session, token }) {
      // If impersonating, surface the impersonated user's ID
      session.user.id = (token.impersonatedUserId as string | null) ?? (token.id as string);
      session.user.isAdmin = token.isAdmin as boolean;
      session.user.realId = token.id as string;
      session.user.impersonating = !!(token.impersonatedUserId as string | null);
      return session;
    },
  },
});
