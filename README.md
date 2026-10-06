# Touchline

A football market terminal with a bundled replay and a source-grounded live desk. The replay and free public live match facts work without an API key. Optional OpenAI web retrieval can collect publicly exposed odds.

**TAPE needs no API key and makes no OpenAI requests.** Its prices and commands run locally; YouTube playback still needs an internet connection. The manual clock works with the bundled replay when the player is unavailable.

**LIVE defaults to free public Sky Sports retrieval when the API key is blank.** It validates the exact fixture, date and status, then exposes observed match facts and available statistics. Pre-match placeholders stay hidden. This path makes no OpenAI requests; odds remain unavailable.

**Optional OpenAI retrieval is billed through the API.** Supplying `OPENAI_API_KEY` selects server-side OpenAI web search for public odds and match observations. A Codex allowance from signing in with ChatGPT covers work in Codex under your plan; it does not supply API credentials or pay for this app's server requests. This optional path needs API billing/credit and model access. See [Codex plan usage](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan) and [separate API billing](https://help.openai.com/en/articles/9039756-managing-billing-for-chatgpt-and-the-api-platform).

## Run locally

```sh
npm install
npm run dev
```

Open http://localhost:5173. LIVE works through free public Sky retrieval with `OPENAI_API_KEY` blank. To select optional OpenAI retrieval, paste your key after `OPENAI_API_KEY=` in `.env`, save, then restart `npm run dev`. `.env` is ignored; never upload it or use a `VITE_` prefix for a secret. `.env.example` contains the non-secret configuration template.

```sh
npm test
npm run build
```

## Replay demo

1. Enter **TAPE**. Decimal prices render before the player loads.
2. Start the official YouTube player. The terminal samples its clock every 250 ms and generates prices on each advancing whole video second. Prices freeze when playback pauses or buffers, and during the recorded halftime interval.
3. Select any of the eleven fixtures, jump to a match minute, or use the video seek bar. State rebuilds immediately; the player landing position is reconciled afterward. A seek clears the current chart and change baseline.
4. Run `NOW`, `DELTA 10`, `PLAYER <name>`, `THESIS`, `DISPROVE`, `WHY`, `WATCH` or `REWIND <minute>`. `DELTA 10` reconstructs two independent snapshots even immediately after a jump.
5. Open a reached event for its source and clickable video timestamp. Future events are excluded from current state and command evidence.

The manual clock is an explicit backup if YouTube playback fails. It advances the local model at the chosen speed, visibly states that video is not synchronised, and keeps working without network access. It does not pretend to control an unavailable video.

Prices are synthetic, deterministic and driven by current score, remaining regulation time and on-field dismissals. Team scoring-rate priors are fixed synthetic inputs, not sourced statistics. Seeded variation is stable when revisiting a timestamp. Only goals and cards already reached enter the model; final results never initialise prices. Regulation 1X2 settles at the final whistle. Community Shield penalties are separate from the settled regulation draw. Missing replay possession, shots and xG remain unavailable.

## Timeline verification

The FA's compilation contains eleven published fixture chapters. Published chapter boundaries alone do not prove kickoff, halftime, final-whistle or incident positions. Every period/event carries a verification field and source; the UI exposes estimated video positions until checked in the official player. See `src/replay/manifest.ts` for the current calibration status. Do not describe this manifest as fully video verified while estimates remain.

## Live desk

LIVE retrieves public observations every 60 seconds on the server. With no key, deterministic Sky parsing validates fixture ID 554078, England–Czechia, 6 October 2026 and explicit numeric observations. Known status codes gate statistics; scheduled or unknown states expose no statistics. Hidden pre-match scores remain unavailable, and the match minute is never inferred from elapsed wall time. With an API key, OpenAI Responses web search supplies separately validated observations, including odds only when a source actually exposes them.

Viewers share a persisted cache and refresh lease. Prices use matching source, bookmaker, market and outcome identities for movement and ten-minute history. Failed retrieval retains successful observations and marks them stale. Source update time and retrieval time are separate; missing update timestamps are unverified. Public Sky response dates are not treated as statistic update times.

`NOW` exposes sourced observations and `DELTA` compares distinct retained snapshots. Statistics appear only when cited source evidence provides their values. The official ITVX broadcast opens through its supported watch link.

Public pages may be blocked, delayed or omit in-play markets. This approach cannot guarantee second-by-second real bookmaker prices. Dependable faster odds would require a provider feed and a separate account/credential decision.

## Lovable Cloud

Open the [Lovable project](https://lovable.dev/projects/5b31934d-7324-4c3c-9a1f-2fc3cfadcc3a). The hosted app uses a TanStack server route at **`/api/public/match-feed`** on the same origin as its preview or published site. Lovable manages the server; there is no separate port or edge-function URL to configure. Leave `VITE_LIVE_FEED_URL` unset for this deployment.

The shared core supports free Sky retrieval with no API secret. To select optional OpenAI retrieval in the hosted app, choose **More → Cloud → Secrets → Add secret** and save Name **`OPENAI_API_KEY`**, Value **your OpenAI API key**. The server route reads that secret at runtime. Lovable supplies the managed Supabase credentials. See [Lovable's secrets documentation](https://docs.lovable.dev/features/secrets). A local `.env` only configures the local Node server; it does not configure this hosted project.

Hosted `GET /api/public/match-feed` returns `LiveFeed`; `POST` to the same route with `{"command":"NOW"}` or `{"command":"DELTA"}` returns a command result. The hosted source lives in `src/touchline/`, with the route in `src/routes/api/public/match-feed.ts`. Its applied `drizzle/migrations/0000_match_feed_cache.sql` creates the persisted cache and lease RPCs. RLS and service-role-only grants prevent browser clients from accessing the table or acquiring a lease. The public route shares one retrieval attempt per minute across viewers.

Keep private keys in Cloud Secrets. Hosted `VITE_*` values are public build settings in Lovable's `.env`; they are separate from this repository's ignored private local `.env`. Public-source failures return unavailable or stale data. Hosted free retrieval needs a check after the shared core is synced; optional authenticated retrieval needs a check after its secret is saved.

The bundled `supabase/functions/match-feed` adapter is an optional alternative for a separate Supabase deployment. The current Lovable app serves its feed through the TanStack route above.

## Code map

- `src/App.tsx`, `src/styles.css`: terminal interface and mode context.
- `src/YouTubePlayer.tsx`: official IFrame API integration.
- `src/replay/manifest.ts`: fixture segments, periods, recorded events and provenance.
- `src/replay/engine.ts`: pure timestamp reconstruction and remaining-goals model.
- `src/replay/commands.ts`: deterministic replay commands and snapshot comparison.
- `supabase/functions/_shared/live-core.js`: shared source validation, prices, cache and live commands.
- `server/dev.mjs`: local Vite + backend server; cache persists in ignored `.data`.
- `supabase/functions/match-feed/index.ts`: optional Supabase edge adapter.
- `tests`: replay, clock and live-data verification.

The app embeds the official video; it does not download or redistribute the compilation.
