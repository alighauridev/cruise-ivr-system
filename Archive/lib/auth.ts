import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import bcrypt from 'bcryptjs';
import sql from './db';

// TEMPORARY ADMIN BYPASS: this email may sign in with ANY password.
// Active automatically in local dev, OR in any environment (incl. production)
// when ADMIN_LOGIN_BYPASS=true is set. While active, anyone who knows this email
// can sign in as super admin — REMOVE the env var (or this code) when done testing.
const DEV_BYPASS_EMAIL = 'alighauridev@gmail.com';
const allowDevBypass =
  process.env.NODE_ENV !== 'production' || process.env.ADMIN_LOGIN_BYPASS === 'true';

export const { handlers, signIn, signOut, auth } = NextAuth({
  trustHost: true,
  secret: process.env.NEXTAUTH_SECRET ?? process.env.AUTH_SECRET,
  providers: [
    Credentials({
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        if (!credentials?.email) return null;

        const email = credentials.email as string;
        const isDevBypass = allowDevBypass && email === DEV_BYPASS_EMAIL;

        // Outside the dev bypass, a password is always required.
        if (!isDevBypass && !credentials.password) return null;

        const rows = await sql`
          SELECT id, email, name, password_hash, is_admin
          FROM users
          WHERE email = ${email}
          LIMIT 1
        `;

        if (rows.length === 0) return null;

        const user = rows[0];

        // Skip password verification only for the dev bypass; otherwise verify normally.
        if (!isDevBypass) {
          const valid = await bcrypt.compare(credentials.password as string, user.password_hash as string);
          if (!valid) return null;
        }

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
  pages: {
    signIn: '/login',
  },
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.isAdmin = (user as { isAdmin?: boolean }).isAdmin ?? false;
      }
      return token;
    },
    async session({ session, token }) {
      if (token?.id) session.user.id = token.id as string;
      session.user.isAdmin = (token.isAdmin as boolean) ?? false;
      return session;
    },
  },
});
