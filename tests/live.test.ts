import { describe, expect, it, vi } from 'vitest';
import type { LiveFeed, LiveSnapshot } from '../src/types';
import { createFeedService, getRetrievedSources, LIVE_FIXTURE, parseObservedPrice, parsePublicSkySnapshot, PUBLIC_SKY, retrieveLiveSnapshot, runLiveCommand, snapshotFingerprint, validateExtraction } from '../src/live/core.js';

const url = 'https://www.oddschecker.com/football/uefa-nations-league/england-v-czechia/winner';
const fetchedAt = '2026-10-06T18:45:00.000Z';
const sources = [{ id: 'source-test', name: 'Oddschecker', url }];
function extraction(price = 1.4) {
  return {
    available: true, unavailableReason: null,
    fixture: { home: 'England', away: 'Czechia', date: LIVE_FIXTURE.date, competition: 'UEFA Nations League', sourceUrl: url },
    score: null, minute: null, phase: 'PRE_MATCH', factsSourceUrl: url,
    quotes: [{ outcome: 'England', rawPrice: String(price), priceFormat: 'decimal', bookmaker: 'William Hill', market: 'Match result', sourceUrl: url, sourceUpdatedAt: null }],
    stats: [], events: [],
  };
}
function snapshot(price = 1.4, time = fetchedAt) { return validateExtraction(extraction(price), sources, time); }
function feed(current: LiveSnapshot, history = [current]): LiveFeed {
  return { snapshot: current, history, status: 'ready', error: null, lastAttemptAt: fetchedAt, nextRefreshAt: null };
}
function apiResponse(data = extraction()) {
  return {
    status: 'completed', output: [
      { type: 'web_search_call', status: 'completed', action: { type: 'search', sources: [{ type: 'url', url }] } },
      { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(data), annotations: [] }] },
    ],
  };
}

function skyFixture(status = 1) {
  return { football: [{ id: PUBLIC_SKY.id, competition: { name: { full: 'UEFA Nations League' } },
    status, start: { timestamp: Date.parse('2026-10-06T18:45:00Z') },
    teams: { home: { name: { full: 'England' }, score: 2 }, away: { name: { full: 'Czech Republic' }, score: 1 } } }] };
}
function skyHtml(extra = '', possession = ['60.5%', '39.5%']) {
  const event = { '@type': 'SportsEvent', homeTeam: { name: 'England' }, awayTeam: { name: 'Czech Republic' },
    startDate: '2026-10-06T19:45:00+01:00', eventStatus: 'EventScheduled', url: 'https://www.skysports.com/football/england-vs-czech-republic/554078' };
  return `<script type="application/ld+json">${JSON.stringify(event)}</script><div data-component-name="ui-football-match-header" data-status="1"></div>
    <span data-testid="sport-event-stats__stat-home-value--possessionPercentage">${possession[0]}</span>
    <span data-testid="sport-event-stats__stat-away-value--possessionPercentage">${possession[1]}</span>
    <span data-testid="sport-event-stats__stat-home-value--totalScoringAtt">6</span>
    <span data-testid="sport-event-stats__stat-away-value--totalScoringAtt">4</span>${extra}`;
}

describe('free public Sky observations', () => {
  it('suppresses hidden pre-match score and zero statistics despite available numeric markup', () => {
    const result = parsePublicSkySnapshot(skyFixture(30), skyHtml('', ['0%', '0%']), fetchedAt);
    expect(result.phase).toBe('PRE_MATCH'); expect(result.score).toBeNull();
    expect(result.quotes).toEqual([]); expect(result.stats).toEqual([]); expect(result.minute).toBeNull();
  });
  it.each([[1, 'LIVE'], [3, 'LIVE'], [2, 'HALF_TIME'], [4, 'FULL_TIME'], [8, 'FULL_TIME'], [5, 'EXTRA_TIME']])('uses Sky status %s rather than its misleading scheduled JSON-LD', (status, phase) => {
    const result = parsePublicSkySnapshot(skyFixture(Number(status)), skyHtml(), fetchedAt);
    expect(result.phase).toBe(phase); expect(result.score).toEqual([2, 1]);
    expect(result.stats[0]).toMatchObject({ name: 'Possession', home: 60.5, away: 39.5, unit: '%', sourceUpdatedAt: null, fetchedAt, sourceUrl: PUBLIC_SKY.statsUrl });
    expect(result.quotes).toEqual([]);
  });
  it('keeps unknown status explicit and suppresses statistics until its phase is verified', () => {
    const result = parsePublicSkySnapshot(skyFixture(99), skyHtml(), fetchedAt);
    expect(result.phase).toBe('UNKNOWN'); expect(result.score).toEqual([2, 1]); expect(result.stats).toEqual([]);
  });
  it('rejects scheduled statistics HTML after the score source has moved into play', () => {
    expect(() => parsePublicSkySnapshot(skyFixture(1), skyHtml().replace('data-status="1"', 'data-status="30"'), fetchedAt)).toThrow('pre-match status');
  });
  it('rejects a wrong fixture ID, team, competition, date or numeric score', () => {
    const wrongId = skyFixture(); wrongId.football[0].id = 554024;
    const wrongTeam = skyFixture(); wrongTeam.football[0].teams.away.name.full = 'Slovakia';
    const wrongCompetition = skyFixture(); wrongCompetition.football[0].competition.name.full = 'Friendly';
    const wrongDate = skyFixture(); wrongDate.football[0].start.timestamp = Date.parse('2026-09-29T18:45:00Z');
    const invalidScore = skyFixture(); invalidScore.football[0].teams.home.score = Number.NaN;
    for (const fixture of [wrongId, wrongTeam, wrongCompetition, wrongDate, invalidScore]) expect(() => parsePublicSkySnapshot(fixture, skyHtml(), fetchedAt)).toThrow();
  });
  it('rejects unrelated, mismatched and blocked statistics pages', () => {
    for (const html of [skyHtml().replace('/554078', '/554024'), skyHtml().replace('2026-10-06T19:45', '2026-10-05T19:45'), skyHtml().replace('Czech Republic', 'Slovakia'), '<html>Access denied</html>']) {
      expect(() => parsePublicSkySnapshot(skyFixture(), html, fetchedAt)).toThrow();
    }
  });
  it('deduplicates repeated identical stats and rejects conflicting duplicates or invalid numbers', () => {
    const same = '<span data-testid="sport-event-stats__stat-home-value--totalScoringAtt">6</span>';
    expect(parsePublicSkySnapshot(skyFixture(), skyHtml(same), fetchedAt).stats).toHaveLength(2);
    expect(() => parsePublicSkySnapshot(skyFixture(), skyHtml(same.replace('>6<', '>7<')), fetchedAt)).toThrow('conflicting');
    for (const html of [skyHtml('', ['101%', '39.5%']), skyHtml('', ['60%', '60%']), skyHtml().replace('>6<', '>6.5<'), skyHtml().replace('>6<', '>NaN<'), skyHtml().replace(/<span data-testid="sport-event-stats__stat-away-value--totalScoringAtt">4<\/span>/, '')]) {
      expect(() => parsePublicSkySnapshot(skyFixture(), html, fetchedAt)).toThrow();
    }
    expect(parsePublicSkySnapshot(skyFixture(), skyHtml('', ['0%', '0%']), fetchedAt).stats.map(stat => stat.name)).toEqual(['Shots']);
  });
  it('keeps receipt-only polls out of history and retains prior public observations on failure', async () => {
    let time = Date.parse(fetchedAt), fail = false;
    const service = createFeedService({ now: () => time, retrieve: async () => {
      if (fail) throw new Error('Public Sky unavailable');
      return parsePublicSkySnapshot(skyFixture(), skyHtml(), new Date(time).toISOString());
    } });
    await service.getFeed(); time += 60_000;
    const unchanged = await service.getFeed(); expect(unchanged.history).toHaveLength(1);
    fail = true; time += 60_000;
    const stale = await service.getFeed();
    expect(stale.status).toBe('stale'); expect(stale.snapshot).toEqual(unchanged.snapshot); expect(stale.error).toBe('Public Sky unavailable');
  });
});

describe('validated live observations', () => {
  it('keeps retrieval time separate from an unavailable source-update time', () => {
    const result = snapshot();
    expect(result.quotes[0].sourceUpdatedAt).toBeNull();
    expect(result.quotes[0].fetchedAt).toBe(fetchedAt);
    expect(result.sources).toEqual(sources);
  });
  it('rejects a different fixture or a different date', () => {
    const wrongTeam = extraction(); wrongTeam.fixture.away = 'Slovakia';
    const wrongDate = extraction(); wrongDate.fixture.date = '2025-10-06';
    expect(() => validateExtraction(wrongTeam, sources, fetchedAt)).toThrow('does not match');
    expect(() => validateExtraction(wrongDate, sources, fetchedAt)).toThrow('does not match');
  });
  it('rejects invented URLs even if their domain is trusted', () => {
    const data = extraction(); data.quotes[0].sourceUrl = 'https://www.oddschecker.com/a-page-not-retrieved';
    expect(() => validateExtraction(data, sources, fetchedAt)).toThrow('did not retrieve');
    expect(() => getRetrievedSources({ output: [{ type: 'message', content: [{ type: 'output_text', annotations: [{ type: 'url_citation', url }] }] }] })).toThrow('No completed external web search');
    expect(() => getRetrievedSources({ output: [{ type: 'web_search_call', status: 'completed', action: { sources: [{ url: 'https://oddschecker.com.evil.test/fixture' }] } }] })).toThrow('approved public domain');
  });
  it.each(['0', '1', '-2', 'Infinity', 'NaN', '100001', '1e3', 'banana', 1.4])('rejects invalid observed decimal odds %s', (price) => {
    const data = extraction() as unknown as { quotes: {rawPrice:unknown}[] };
    data.quotes[0].rawPrice = price;
    expect(() => validateExtraction(data, sources, fetchedAt)).toThrow();
  });
  it('converts only explicitly observed fractional odds using deterministic arithmetic', () => {
    expect(parseObservedPrice('1/7', 'fractional')).toBeCloseTo(1 + 1 / 7, 12);
    expect(parseObservedPrice('10/1', 'fractional')).toBe(11);
    expect(parseObservedPrice('25/1', 'fractional')).toBe(26);
    expect(parseObservedPrice('EVS', 'fractional')).toBe(2);
    const data = extraction(); data.quotes[0].rawPrice = '1/7'; data.quotes[0].priceFormat = 'fractional';
    expect(validateExtraction(data, sources, fetchedAt).quotes[0].price).toBeCloseTo(1 + 1 / 7, 12);
    for (const value of ['1/0', '0/1', '-1/7', 'estimated 1/7', '1/7 or 1/6']) expect(() => parseObservedPrice(value, 'fractional')).toThrow();
  });
  it('rejects stale and future source timestamps while accepting a current one', () => {
    const data = extraction() as unknown as { quotes: {sourceUpdatedAt:string|null}[] };
    data.quotes[0].sourceUpdatedAt = '2026-10-04T12:00:00Z';
    expect(() => validateExtraction(data, sources, fetchedAt)).toThrow('24-hour window');
    data.quotes[0].sourceUpdatedAt = '2026-10-06T19:45:00Z';
    expect(() => validateExtraction(data, sources, fetchedAt)).toThrow('24-hour window');
    data.quotes[0].sourceUpdatedAt = '2026-10-06T18:44:00Z';
    expect(validateExtraction(data, sources, fetchedAt).quotes[0].sourceUpdatedAt).toBe('2026-10-06T18:44:00.000Z');
  });
  it('rejects unsupported markets and duplicate bookmaker/outcome identities', () => {
    const unsupported = extraction(); unsupported.quotes[0].market = 'Draw no bet';
    expect(() => validateExtraction(unsupported, sources, fetchedAt)).toThrow('match-result odds');
    const duplicate = extraction(); duplicate.quotes.push({ ...duplicate.quotes[0] });
    expect(() => validateExtraction(duplicate, sources, fetchedAt)).toThrow('Duplicate quote');
  });
});

describe('shared refresh cache', () => {
  it('shares an in-flight request across viewers and enforces the refresh interval', async () => {
    let time = Date.parse(fetchedAt);
    let resolve!: (snapshot: LiveSnapshot) => void;
    const retrieve = vi.fn(() => new Promise<LiveSnapshot>((done) => { resolve = done; }));
    const service = createFeedService({ retrieve, now: () => time });
    const first = service.getFeed(), second = service.getFeed();
    expect(first).toBe(second);
    await Promise.resolve(); await Promise.resolve();
    resolve(snapshot()); await Promise.all([first, second]);
    expect(retrieve).toHaveBeenCalledTimes(1);
    time += 59_999;
    expect((await service.getFeed()).status).toBe('ready');
    expect(retrieve).toHaveBeenCalledTimes(1);
  });
  it('persists history, deduplicates receipt-only changes, and appends real price changes', async () => {
    let time = Date.parse(fetchedAt), price = 1.4;
    let persisted: LiveFeed | null = null;
    const storage = { read: async () => persisted, write: async (state:LiveFeed) => { persisted = structuredClone(state); } };
    const retrieve = vi.fn(async () => snapshot(price, new Date(time).toISOString()));
    const service = createFeedService({ retrieve, storage, now: () => time });
    await service.getFeed(); time += 60_000;
    const unchanged = await service.getFeed();
    expect(unchanged.history).toHaveLength(1);
    expect(unchanged.snapshot?.fetchedAt).toBe(new Date(time).toISOString());
    price = 1.55; time += 60_000;
    const changed = await service.getFeed();
    expect(changed.history).toHaveLength(2);
    expect(runLiveCommand('DELTA', changed).lines.some((line) => line.includes('1.40 → 1.55'))).toBe(true);
    const restarted = createFeedService({ retrieve, storage, now: () => time });
    expect((await restarted.getFeed()).history).toHaveLength(2);
    expect(retrieve).toHaveBeenCalledTimes(3);
  });
  it('retains verified data and its stale state after subsequent failures and restarts', async () => {
    let time = Date.parse(fetchedAt), failed = false;
    let persisted: LiveFeed | null = null;
    const storage = { read: async () => persisted, write: async (state:LiveFeed) => { persisted = structuredClone(state); } };
    const retrieve = async () => { if (failed) throw new Error('Public page unavailable'); return snapshot(); };
    const service = createFeedService({ retrieve, storage, now: () => time });
    const success = await service.getFeed(); failed = true; time += 60_000;
    const failure = await service.getFeed();
    expect(failure.status).toBe('stale'); expect(failure.error).toBe('Public page unavailable');
    expect(failure.snapshot).toEqual(success.snapshot); expect(failure.history).toEqual(success.history);
    const restarted = createFeedService({ retrieve, storage, now: () => time });
    expect((await restarted.getFeed()).status).toBe('stale');
    expect(runLiveCommand('NOW', failure).lines[0]).toContain('Stale data');
  });
  it('returns unavailable without inventing a snapshot when retrieval fails first', async () => {
    const service = createFeedService({ retrieve: async () => { throw new Error('OPENAI_API_KEY is not configured'); } });
    const result = await service.getFeed();
    expect(result.status).toBe('unavailable'); expect(result.snapshot).toBeNull(); expect(result.history).toEqual([]);
    expect(runLiveCommand('NOW', result).lines[0]).toContain('OPENAI_API_KEY');
  });
  it('does not refresh when another Cloud instance holds the database lease', async () => {
    const retrieve = vi.fn(async () => snapshot());
    const service = createFeedService({ retrieve, storage: { read: async () => feed(snapshot()), acquire: async () => false } });
    expect((await service.getFeed()).status).toBe('refreshing');
    expect(retrieve).not.toHaveBeenCalled();
  });
  it('does not label a source timestamp advance as a bookmaker price change', () => {
    const before = snapshot(); const after = snapshot();
    after.quotes[0].sourceUpdatedAt = fetchedAt; after.id = 'new-source-time';
    expect(snapshotFingerprint(before)).not.toBe(snapshotFingerprint(after));
    expect(runLiveCommand('DELTA', feed(after, [before, after])).lines.at(-1)).toContain('No observed score, phase, statistic or bookmaker price changes');
  });
});

describe('live statistical comparisons', () => {
  it('reports actual score, phase and paired statistic changes without requiring any odds', () => {
    const before = parsePublicSkySnapshot(skyFixture(1), skyHtml(), fetchedAt);
    const nextFixture = skyFixture(2); nextFixture.football[0].teams.home.score = 3;
    const after = parsePublicSkySnapshot(nextFixture, skyHtml('', ['65%', '35%']).replace('>6<', '>8<'), '2026-10-06T18:47:00.000Z');
    const result = runLiveCommand('DELTA', feed(after, [before, after]));
    expect(result.lines).toContain('Score: 2–1 → 3–1 · verified match sources');
    expect(result.lines).toContain('Phase: LIVE → HALF TIME · verified match sources');
    expect(result.lines).toContain('Possession: 60.5 / 39.5% → 65 / 35% · Sky Sports');
    expect(result.lines).toContain('Shots: 6 / 4 → 8 / 4 · Sky Sports');
    expect(result.evidenceIds).toEqual([before.id, after.id]);
    expect(result.lines).toContain(`${before.fetchedAt} → ${after.fetchedAt}`);
  });
  it('never compares a statistic across different sources or units, or assumes absent data is zero', () => {
    const before = parsePublicSkySnapshot(skyFixture(), skyHtml(), fetchedAt);
    const after = structuredClone(before); after.id = 'different-source'; after.fetchedAt = '2026-10-06T18:46:00.000Z';
    after.stats[0] = { ...after.stats[0], home: 70, away: 30, sourceUrl: url, sourceName: 'Oddschecker' };
    after.stats[1] = { ...after.stats[1], home: null, unit: '%' };
    const result = runLiveCommand('DELTA', feed(after, [before, after]));
    expect(result.lines).toContain('Possession: newly observed 70 / 30% · Oddschecker');
    expect(result.lines).toContain('Possession: no longer exposed · Sky Sports');
    expect(result.lines).toContain('Shots: newly observed — / 4% · Sky Sports');
    expect(result.lines.some(line => line.includes('60.5 / 39.5% →'))).toBe(false);
    expect(result.lines.some(line => line.includes('6 / 4 →'))).toBe(false);
  });
  it('bounds DELTA 10 to actual observations and uses their timestamps rather than a fabricated cutoff snapshot', () => {
    const old = snapshot(1.1, '2026-10-06T18:30:00.000Z');
    const first = snapshot(1.2, '2026-10-06T18:42:00.000Z');
    const recent = snapshot(1.3, '2026-10-06T18:48:00.000Z');
    const current = snapshot(1.4, '2026-10-06T18:50:00.000Z');
    const result = runLiveCommand('DELTA10', feed(current, [old, first, recent, current]));
    expect(result.lines).toContain(`${first.fetchedAt} → ${current.fetchedAt}`);
    expect(result.lines.some(line => line.includes('1.20 → 1.40'))).toBe(true);
    expect(result.lines.join(' ')).not.toContain(old.fetchedAt);
    expect(result.evidenceIds).toEqual([first.id, current.id]);
    expect(runLiveCommand('DELTA 10', feed(current, [old, current])).title).toContain('Waiting');
    expect(runLiveCommand('DELTA', feed(current, [old, first, recent, current])).evidenceIds).toEqual([recent.id, current.id]);
  });
  it('keeps stale retrieval warnings and ignores future or unrelated fixture observations', () => {
    const before = snapshot(1.2); const current = snapshot(1.4, '2026-10-06T18:47:00.000Z');
    const future = snapshot(1.8, '2026-10-06T18:48:00.000Z');
    const unrelated = { ...snapshot(1.9, '2026-10-06T18:46:00.000Z'), fixtureId: 'other-fixture' };
    const state = { ...feed(current, [before, unrelated, future, current]), status: 'stale' as const, error: 'Public source failed' };
    const result = runLiveCommand('DELTA', state);
    expect(result.lines[0]).toBe('Stale data: Public source failed');
    expect(result.evidenceIds).toEqual([before.id, current.id]);
  });
});

describe('OpenAI Responses integration', () => {
  it('forces live web search, includes retrieved sources, and keeps the key in the server authorization header', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(apiResponse()), { status: 200 }));
    await retrieveLiveSnapshot({ apiKey: 'test-server-secret', fetchImpl: fetchMock as unknown as typeof fetch, now: () => Date.parse(fetchedAt) });
    const [requestUrl, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(options.body));
    expect(requestUrl).toBe('https://api.openai.com/v1/responses');
    expect(body.model).toBe('gpt-6-astra'); expect(body.tools[0].external_web_access).toBe(true);
    expect(body.tool_choice).toEqual({ type: 'web_search' }); expect(body.include).toContain('web_search_call.action.sources');
    expect(JSON.stringify(body)).not.toContain('test-server-secret');
    expect((options.headers as Record<string,string>).Authorization).toBe('Bearer test-server-secret');
  });
  it('uses free public sources when no API key is supplied, without contacting OpenAI', async () => {
    const fetchMock = vi.fn(async (requestUrl: string) => requestUrl === PUBLIC_SKY.dataUrl
      ? new Response(JSON.stringify(skyFixture(30)), { headers: { 'Content-Type': 'application/json' } })
      : new Response(skyHtml(), { headers: { 'Content-Type': 'text/html' } }));
    const result = await retrieveLiveSnapshot({ fetchImpl: fetchMock as unknown as typeof fetch, now: () => Date.parse(fetchedAt) });
    expect(result.phase).toBe('PRE_MATCH'); expect(result.quotes).toEqual([]);
    expect(fetchMock.mock.calls.map(call => call[0]).sort()).toEqual([PUBLIC_SKY.dataUrl, PUBLIC_SKY.statsUrl].sort());
  });
  it('rejects refusals, incomplete responses, and malformed JSON', async () => {
    const refusal = apiResponse();
    refusal.output[1] = { type: 'message', content: [{ type: 'refusal', text: 'No', annotations: [] }] };
    for (const result of [refusal, { ...apiResponse(), status: 'incomplete' }, { ...apiResponse(), output: [{ type: 'message', content: [{ type: 'output_text', text: 'not json' }] }] }]) {
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify(result))) as unknown as typeof fetch;
      await expect(retrieveLiveSnapshot({ apiKey: 'test', fetchImpl })).rejects.toThrow();
    }
  });
});
