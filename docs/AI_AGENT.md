# AI call agent (rebuild, Oct 2026)

When a call has an AI task and a live rep answers, an OpenAI Realtime agent talks to
the rep for Military Cruise Deals. Code: `server/ai-call-agent.ts` (prompt, tools,
summaries) and the "OpenAI Realtime API" section of `server/media-ws.ts`.

## Behavior

- No connect message and no TwiML redirect on AI calls. The stream is already
  bidirectional, so the AI's opening line plays immediately. (The old redirect tore
  the stream down while the greeting was being sent; reps heard silence.)
- First sentence: "AI assistant calling for <advisor> at Military Cruise Deals",
  booking number, request.
- Works only from the task form. Never invents facts. Never reads or accepts card numbers.
- Tools:
  - `end_call(outcome, summary)`: after saying goodbye. Waits for the goodbye audio to
    finish playing (Twilio mark, 8s fallback), saves outcome + summary, hangs up.
  - `transfer_to_team(reason, summary)`: for payment, missing verification, a rep who
    won't work with an AI, or confusion. Rep hears "please hold"; the Transfer To
    number rings with a spoken reason; both join one conference.
- Barge-in: when the rep talks over the AI, queued AI audio is cleared.
- Hangs up when a recorded post-call survey starts.
- If the call ends any other way (rep hangs up, max duration, AI voice drops), a
  summary + outcome is generated from the transcript. If the AI voice drops while the
  rep is still on, the call is handed to the team.
- Outcome + summary are saved on `calls.ai_outcome` / `calls.ai_summary`, shown in
  Call Logs, and texted to the user's notification phone when
  `NOTIFICATION_SMS_ENABLED=true`.
- The legacy Deepgram→GPT→TTS conversation path is no longer used for AI calls.

## Claude engine (Deepgram → Claude → TTS)

AI task calls can run on Claude instead of OpenAI Realtime. Claude has no speech-to-speech
API, so `server/claude-voice.ts` runs a pipeline: Twilio audio → Deepgram → Claude (streamed,
with the same `end_call` / `transfer_to_team` tools and prompt) → sentence chunker → TTS
(`lib/openai-tts.ts`) → Twilio. Call actions (hang up, handoff, summaries, SMS) are shared with
the Realtime engine in `server/media-ws.ts`.

- **Switch:** Settings → "AI call engine" (stored as the `ai_engine` setting, applies to the next
  call). Falls back to the `AI_ENGINE` env var (`claude` | `openai`), then to Claude when
  `ANTHROPIC_API_KEY` is set, otherwise OpenAI Realtime.
- **Env:** `ANTHROPIC_API_KEY` (required for Claude). Optional: `CLAUDE_VOICE_MODEL`
  (default `claude-sonnet-5-5`; `claude-haiku-5-5` for faster, cheaper replies), `CLAUDE_ENDPOINTING_MS`
  (default 700 — how long the rep must pause before Claude answers).
- **Latency:** thinking is off and effort is `low`; each sentence goes to TTS as soon as Claude
  finishes it. Expect about 1.5–2.5s per turn versus ~0.5s on Realtime.
- **Barge-in:** two or more words from the rep while the AI is talking cancels the Claude
  stream and TTS, clears Twilio's audio queue, and keeps only the words that were actually
  voiced in Claude's history. One-word "okay"/"mm-hmm" does not interrupt.
- **Failures:** if Claude, Deepgram or TTS fail mid-call, the call is handed to the team
  (same as an OpenAI Realtime drop).
- **Voice:** still the OpenAI `nova` TTS voice (needs `OPENAI_API_KEY`).

## Deploy checklist

1. Run `db/migrations/phase4.sql` in the Neon SQL editor **before** deploying.
   (The call-initiate API writes `ai_task_details`; without the column every call fails.)
2. For the Claude engine, add `ANTHROPIC_API_KEY` on Render (see the section above).
   Optional env vars on Render: `AGENCY_NAME` (default "Military Cruise Deals"),
   `OPENAI_REALTIME_MODEL` (default `gpt-realtime-2.1`),
   `NOTIFICATION_SMS_ENABLED=true` for summary texts.
3. Merge to `master` (Render auto-deploys on commit).
4. Test: AI task call to a team member's phone acting as the rep, Transfer To = Mitch's
   cell (not the 866 line). Check opening line, a handoff, a clean end_call, Call Logs
   summary, and the SMS. Then one low-risk real call (waitlist / status check).

## Not changed yet (from the Oct 20 review)

- Business-hours / holiday check per cruise line.
- Carnival Existing Booking script stalls at "Have your booking number? Press 1".
- Calls stuck in navigating_ivr / on_hold / connected.
- Transfers to the 866 line get answered by the AI greeter.
