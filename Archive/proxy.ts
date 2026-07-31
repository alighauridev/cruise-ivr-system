import { auth } from '@/lib/auth';
import { NextResponse } from 'next/server';

export default auth((req) => {
  const { pathname } = req.nextUrl;
  const isLoggedIn = !!req.auth;

  // Twilio webhook routes must be public — Twilio has no session cookie.
  // All /api/ routes do their own auth check internally, so they're safe to
  // pass through middleware. This also allows warmup requests to compile routes.
  const publicPaths = [
    '/login',
    '/register',
    '/api/',
    '/media-stream', // Twilio WebSocket — no browser session, auth handled in media-ws.ts
    '/tts/',         // TTS audio files served to Twilio <Play> — no session
  ];
  const isPublic = publicPaths.some((p) => pathname.startsWith(p));

  if (!isLoggedIn && !isPublic) {
    return NextResponse.redirect(new URL('/login', req.url));
  }

  if (isLoggedIn && (pathname === '/login' || pathname === '/register')) {
    return NextResponse.redirect(new URL('/dashboard/agent', req.url));
  }

  return NextResponse.next();
});

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|public).*)'],
};
