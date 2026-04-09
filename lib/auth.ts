import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import bcrypt from 'bcryptjs';
import sql from './db';

export const { handlers, signIn, signOut, auth } = NextAuth({
  trustHost: true,
  secret: process.env.NEXTAUTH_SECRET ?? process.env.AUTH_SECRET,
  providers: [
    Credentials({
      id: 'credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null;

        const rows = await sql`
          SELECT id, email, name, password_hash
          FROM users
          WHERE email = ${credentials.email as string}
          LIMIT 1
        `;

        if (rows.length === 0) return null;

        const user = rows[0];
        const valid = await bcrypt.compare(credentials.password as string, user.password_hash as string);
        if (!valid) return null;

        return { id: user.id as string, email: user.email as string, name: user.name as string };
      },
    }),
    Credentials({
      id: 'impersonate',
      credentials: {
        userId: { label: 'User ID', type: 'text' },
      },
      async authorize(credentials) {
        if (!credentials?.userId) return null;

        const rows = await sql`
          SELECT id, email, name
          FROM users
          WHERE id = ${credentials.userId as string}
          LIMIT 1
        `;

        if (rows.length === 0) return null;
        const user = rows[0];
        return { id: user.id as string, email: user.email as string, name: user.name as string };
      },
    }),
  ],
  session: { strategy: 'jwt' },
  pages: {
    signIn: '/login',
  },
  callbacks: {
    async jwt({ token, user }) {
      if (user) token.id = user.id;
      return token;
    },
    async session({ session, token }) {
      if (token?.id) session.user.id = token.id as string;
      return session;
    },
  },
});
