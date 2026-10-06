Run `npm run dev` for the Vite UI and live API at `http://localhost:5173`.
Leave `OPENAI_API_KEY` blank for free direct Sky Sports match facts/statistics.
The parser verifies fixture ID, teams, date and status, suppresses scheduled
placeholders and unknown-phase statistics, and leaves odds empty. Supplying a
key in the project `.env` and restarting selects optional billed OpenAI web
retrieval. The key stays on the server; historical replay data is never used as
a live fallback.

`GET /api/match-feed` returns `LiveFeed` JSON. Requests share one 60-second
refresh, and `.data/live-feed.json` persists the last verified observation and
history across restarts. `POST /api/command` accepts `{"command":"NOW"}` or
`{"command":"DELTA"}`. Failed retrieval retains verified data and marks it stale.
Source timestamps remain null when public pages do not expose them. Retrieval
timestamps describe when the app checked a page, not when the page updated odds.
When optional OpenAI retrieval is enabled, the model transcribes displayed decimal/fractional prices as raw text. The server
parses decimal strings and converts observed fractions using `1 + numerator /
denominator`; it does not ask the model to calculate a price. Aggregated best odds
are explicitly labeled when a page does not expose the underlying bookmaker.

The current [Lovable project](https://lovable.dev/projects/5b31934d-7324-4c3c-9a1f-2fc3cfadcc3a)
uses a TanStack server route, `GET /api/public/match-feed`, on its preview or
published site's origin. `POST` to that route with a command returns
`CommandResult`. The hosted UI defaults to this route; leave `VITE_LIVE_FEED_URL`
unset. Lovable manages the hosted server and port. Local development continues
to use port 5173 and `/api/match-feed`.

Free hosted retrieval needs no OpenAI secret after the shared core is synced.
For optional OpenAI retrieval, save `OPENAI_API_KEY` using **More → Cloud →
Secrets → Add secret**. The TanStack route reads it server-side at runtime; a local `.env`
does not populate Cloud Secrets. Lovable supplies the managed Supabase
credentials. Private credentials must never use a `VITE_` prefix. See
[Lovable's secrets documentation](https://docs.lovable.dev/features/secrets).

Hosted source is in `src/touchline/`; its route imports the shared core from
`src/touchline/live/core.js`. The applied migration at
`drizzle/migrations/0000_match_feed_cache.sql` creates `match_feed_cache` and
claim/save/release RPCs. RLS and service-role-only grants prevent anonymous and
authenticated browser clients from accessing the cache. A database lease shares
one retrieval attempt per minute across server instances. The last successful
observation survives failures. Public-source failure produces unavailable or
stale data. Check hosted free retrieval after syncing the shared core, and
optional authenticated retrieval after the hosted key is saved.

For a separate Supabase deployment, the optional adapter remains in
`supabase/functions/match-feed/index.ts`. Apply the bundled
`supabase/migrations/202610060001_match_feed_cache.sql`, deploy that function,
optionally configure `OPENAI_API_KEY`, and point `VITE_LIVE_FEED_URL` at its URL. Its
runtime is bundled from `supabase/functions/_shared/live-core.js`; JWT checks
are disabled for the public feed. `LIVE_FEED_ALLOWED_ORIGIN` configures the
optional adapter's CORS origin. This adapter is separate from the current
Lovable TanStack deployment.
