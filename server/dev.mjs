import http from 'node:http';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer, loadEnv } from 'vite';
import { createFeedService, retrieveLiveSnapshot, runLiveCommand } from '../src/live/core.js';

const root = process.cwd();
const env = { ...loadEnv('development', root, ''), ...process.env };
const cacheFile = path.join(root, '.data', 'live-feed.json');
const service = createFeedService({
  retrieve: () => retrieveLiveSnapshot({ apiKey: env.OPENAI_API_KEY }),
  storage: {
    async read() {
      try { return JSON.parse(await readFile(cacheFile, 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    },
    async write(feed) {
      await mkdir(path.dirname(cacheFile), { recursive: true });
      const temp = `${cacheFile}.tmp`;
      await writeFile(temp, JSON.stringify(feed), { mode: 0o600 });
      await rename(temp, cacheFile);
    },
  },
});
function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    if (url.pathname === '/api/match-feed') {
      if (req.method !== 'GET') return json(res, 405, { error: 'Use GET for match-feed.' });
      return json(res, 200, await service.getFeed());
    }
    if (url.pathname === '/api/command') {
      if (req.method !== 'POST') return json(res, 405, { error: 'Use POST for commands.' });
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 2048) return json(res, 413, { error: 'Command request is too large.' }); }
      let parsed;
      try { parsed = JSON.parse(body); } catch { return json(res, 400, { error: 'Command request must be JSON.' }); }
      if (!['NOW', 'DELTA', 'DELTA10', 'DELTA 10'].includes(String(parsed.command).trim().toUpperCase())) return json(res, 400, { error: 'Supported live commands: NOW, DELTA, DELTA 10.' });
      return json(res, 200, runLiveCommand(parsed.command, await service.getFeed()));
    }
    vite.middlewares(req, res);
  } catch (error) { json(res, 500, { error: error instanceof Error ? error.message : 'Request failed.' }); }
});
const vite = await createServer({ root, appType: 'spa', server: { middlewareMode: true, hmr: { server } } });
server.listen(5173, '0.0.0.0', () => {
  console.log('Touchline Terminal: http://localhost:5173');
  console.log(env.OPENAI_API_KEY ? 'Optional OpenAI live web retrieval enabled; shared 60-second cache.' : 'Free public Sky match retrieval enabled; odds require verified sources. Shared 60-second cache.');
});
server.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await vite.close(); server.close(); process.exit(0); });
