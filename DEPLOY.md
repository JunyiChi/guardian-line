# Deploy the public demo (free, on Render)

This puts the **judge demo** online: the homepage, **Try it** (the real AI detector), the dashboard's **Demo mode**, and read-only setup and privacy pages. It runs with `PUBLIC_DEMO=true`, so:

- No phone calls and no speech-to-text service are needed.
- SMS alerts and voice warnings are **previews only**. Nothing is ever sent and no call is ever made.
- Settings are read-only sample data. Nobody's real numbers are stored.
- API keys stay on the server, and each visitor IP gets `RATE_LIMIT_PER_HOUR` checks (default 20) with a friendly message after that.

## 1. Before you deploy

1. Push the repo to GitHub (see the checklist at the bottom).
2. Recommended: add your recorded `public/audio/warning.mp3` to the repo. It's the only kind of file in `public/audio/` that git tracks. Without it, **Play warning** falls back to the browser's built-in speech.
3. Get a Defapi API key at [defapi.org](https://defapi.org/model/typesafe/jev-1.13) and add a little credit. Wessuwan calls Jev at `JEV_URL` (default `https://api.defapi.org/api/v1/decisions`); set `JEV_URL` to use another Jev provider. Each Jev check costs a fraction of a cent, and the per-IP rate limit caps what judges can spend. The demo only ever sees the sample scripts and what judges type. Check Defapi's and TypeSafe's data policy before processing real calls.

## 2. Deploy on Render (Blueprint, about 5 minutes)

1. Sign in at [render.com](https://render.com) with GitHub.
2. Click **New → Blueprint** and pick the Wessuwan repo. Render reads `render.yaml` and proposes one free web service, `wessuwan-demo`.
3. Fill in the values it asks for:
   - `JEV_API_KEY`: your key
   - `GITHUB_URL`: the repo URL (shown on the homepage and privacy page)
   - `PITCH_DECK_URL`: your deck link, or leave it empty
4. Click **Apply**. The first build takes about 3 minutes (`npm ci && npm run build`). Render then checks `/health`.
5. Open `https://wessuwan-demo.onrender.com` (Render shows the exact URL), then:
   - `/health` should return `{"ok":true,"publicDemo":true}`.
   - On **Try it**, pick "Fake bank fraud team" and press **Play it like a call**. Risk should pass 70, and the SMS and voice previews should appear.
   - On the **Dashboard**, press **Demo mode**. A full scam call replays in about a minute.

To use the chat-model detector instead, set `DETECTOR=llm` plus `GEMINI_API_KEY` (or `LLM_PROVIDER=anthropic` and `ANTHROPIC_API_KEY`).

### Manual setup (if you don't use the Blueprint)

New → **Web Service** → pick the repo, then:

| Setting | Value |
|---|---|
| Runtime | Node |
| Build command | `npm ci --include=dev && npm run build` |
| Start command | `node dist/index.js` |
| Health check path | `/health` |
| Instance type | Free |
| Environment | `NODE_ENV=production`, `PUBLIC_DEMO=true`, `DETECTOR=jev`, `JEV_API_KEY=…`, `COUNTRY=US`, `LOG_LEVEL=info`, `NODE_VERSION=22` |

## 3. Things to know about the free plan

- **It sleeps after 15 minutes without traffic.** The first visit after that takes 30–60 seconds to wake up, so open the site a minute before judging starts.
- **Rate limits reset when the service restarts**, because they're kept in memory. That's fine for a demo.
- **Demo mode on the dashboard is shared.** Everyone watching the dashboard sees the same replay.
- `NODE_ENV=production` redirects HTTP to HTTPS and sends HSTS. Render terminates TLS for you.

## Alternative: Railway

1. [railway.app](https://railway.app) → **New Project → Deploy from GitHub repo**.
2. Variables: `NODE_ENV=production`, `PUBLIC_DEMO=true`, `DETECTOR=jev`, `JEV_API_KEY=…`.
3. Settings: build `npm ci --include=dev && npm run build`, start `node dist/index.js`, health check `/health`. Railway sets `PORT` itself.
4. **Networking → Generate Domain**.

Railway's free trial is credit-based rather than always-free.

## Running for real users (not the demo)

Don't use `PUBLIC_DEMO`. Set `NODE_ENV=production`, an HTTPS `PUBLIC_URL`, `SETUP_PASSWORD`, `ENCRYPTION_KEY`, a paid no-training AI tier, and Twilio and speech-to-text credentials. Render's free disk is wiped on every deploy, so encrypted summaries and settings won't survive it. Use a paid plan with a persistent disk mounted at `data/`.

## Checklist before making the repo public

- [ ] `git status` shows no `.env`, no `*-key.json` and nothing under `data/` except `test-scripts/`.
- [ ] No real phone numbers in test scripts, docs or `.env.example`.
- [ ] `GITHUB_URL` and `PITCH_DECK_URL` are set on Render, and the README placeholders are filled in.
