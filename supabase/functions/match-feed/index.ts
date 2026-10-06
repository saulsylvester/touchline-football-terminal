import { createFeedService, LIVE_FIXTURE, retrieveLiveSnapshot, runLiveCommand } from '../_shared/live-core.js';

const origin = Deno.env.get('LIVE_FEED_ALLOWED_ORIGIN') ?? '*';
const cors = { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'content-type, authorization, apikey, x-client-info', 'Vary': 'Origin' };
const databaseUrl = Deno.env.get('SUPABASE_URL');
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const headers = { apikey: serviceKey ?? '', Authorization: `Bearer ${serviceKey ?? ''}`, 'Content-Type': 'application/json' };
async function database(path: string, body?: Record<string, unknown>) {
  if (!databaseUrl || !serviceKey) throw new Error('Cloud cache requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  const response = await fetch(`${databaseUrl}/rest/v1/${path}`, { method: body ? 'POST' : 'GET', headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok) throw new Error(`Cloud cache returned HTTP ${response.status}; apply the match_feed_cache migration.`);
  return response.status === 204 ? null : response.json();
}
function respond(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (!['GET', 'POST'].includes(request.method)) return respond({ error: 'Use GET to retrieve the live feed.' }, 405);
  const owner = crypto.randomUUID();
  const service = createFeedService({
    retrieve: () => retrieveLiveSnapshot({ apiKey: Deno.env.get('OPENAI_API_KEY') }),
    storage: {
      async read() {
        const rows = await database(`match_feed_cache?fixture_id=eq.${LIVE_FIXTURE.id}&select=feed`);
        return rows?.[0]?.feed ?? null;
      },
      async acquire() { return await database('rpc/claim_match_feed', { p_fixture_id: LIVE_FIXTURE.id, p_owner: owner }) === true; },
      async write(feed: unknown) {
        const saved = await database('rpc/save_match_feed', { p_fixture_id: LIVE_FIXTURE.id, p_owner: owner, p_feed: feed });
        if (saved !== true) throw new Error('Cloud cache lease expired before the observation could be saved.');
      },
      async release() { await database('rpc/release_match_feed', { p_fixture_id: LIVE_FIXTURE.id, p_owner: owner }); },
    },
  });
  const feed = await service.getFeed();
  if (request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return respond({ error: 'Request body must be JSON.' }, 400); }
    if (body.command) {
      if (!['NOW', 'DELTA'].includes(String(body.command).trim().toUpperCase())) return respond({ error: 'Supported live commands: NOW, DELTA.' }, 400);
      return respond(runLiveCommand(body.command, feed));
    }
  }
  return respond(feed);
});
