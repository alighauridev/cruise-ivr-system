# CruisePro IVR System — Setup Guide

## 1. Database Setup (Neon)

1. Go to [console.neon.tech](https://console.neon.tech) and create a project
2. Copy the connection string (looks like `postgresql://user:pass@host/db?sslmode=require`)
3. Open the **SQL Editor** in Neon console
4. Paste and run the contents of `db/schema.sql`
5. Update `DATABASE_URL` in `.env.local` with your connection string

## 2. Environment Variables

Update `.env.local` with your real values:

```env
DATABASE_URL=postgresql://...   # From Neon
NEXTAUTH_SECRET=<random string> # Run: openssl rand -base64 32
NEXTAUTH_URL=http://localhost:3000
```

The Twilio, Deepgram, and OpenAI keys are already filled in.

## 3. Run Locally

```bash
npm run dev
```

Go to http://localhost:3000 → click "Create one" to register your account.

## 4. Add Cruise Lines

After registering:
1. Go to **Leads** → your "Cruise Lines" directory is auto-created
2. Click **Add Lead** and add cruise lines:
   - Royal Caribbean: +18664627444
   - Carnival: +18002278456
   - Norwegian: +18664623702
   - etc.

## 5. Build an IVR Config

1. Go to **IVR Builder** → New Config
2. Name it (e.g. "Royal Caribbean — Reservations")
3. Add steps: Wait → Press 1 → Wait → Press 2 → Hold & Detect
4. Save and link it to the lead

## 6. Place Your First Call

1. Go to **Call Agent**
2. Select a cruise line
3. Click **Place Call**
4. Watch the progress panel — it navigates the IVR, waits on hold, and alerts you when an agent answers

## 7. Deploy to Vercel

```bash
npx vercel
```

Set all env vars in your Vercel project settings, then update `NEXTAUTH_URL` to your deployed URL.

Update your Twilio phone number's webhook to:
- Voice URL: `https://your-app.vercel.app/api/calls/ivr-handler`
- Status callback: `https://your-app.vercel.app/api/calls/status`

## Cost vs Bland.ai

| Scenario | CruisePro | Bland.ai | Savings |
|---|---|---|---|
| 30-min hold | ~$0.63 | ~$2.70 | 77% |
| 60-min hold | ~$1.18 | ~$5.40 | 78% |
