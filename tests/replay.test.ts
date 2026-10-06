import { describe, expect, it } from 'vitest';
import { fixtures, VIDEO_DURATION, type TapeClockAnchor } from '../src/replay/manifest';
import { priceChanges, replayTimeForMatchSecond, stateAt, stateForFixture } from '../src/replay/engine';
import { runReplayCommand } from '../src/replay/commands';
import type { TapeEvent, TapeFixture } from '../src/types';

const event = (id: string, type: TapeEvent['type'], side: TapeEvent['side'], videoSecond: number, note?: string): TapeEvent => ({
  id, type, side, videoSecond, player: id, minute: Math.ceil(videoSecond / 60), sourceUrl: 'https://example.com/match', verification: 'video_verified', note,
});

const fixture: TapeFixture = {
  id: 'verified-test-match', home: 'Home', away: 'Away', competition: 'Cup', date: '2023-01-01', start: 0, end: 5800,
  rates: [1.6, 1.2], sourceUrl: 'https://example.com/match',
  periods: [
    { phase: 'PRE_MATCH', start: 0, end: 20, matchSecondStart: 0, verification: 'video_verified' },
    { phase: 'FIRST_HALF', start: 20, end: 2720, matchSecondStart: 0, verification: 'video_verified' },
    { phase: 'HALF_TIME', start: 2720, end: 3020, matchSecondStart: 2700, verification: 'video_verified' },
    { phase: 'SECOND_HALF', start: 3020, end: 5720, matchSecondStart: 2700, verification: 'video_verified' },
    { phase: 'FULL_TIME', start: 5720, end: 5800, matchSecondStart: 5400, verification: 'video_verified' },
  ],
  events: [event('home-goal', 'GOAL', 'home', 3200), event('away-red', 'RED_CARD', 'away', 3800), event('coach-red', 'RED_CARD', 'away', 3805, 'Manager dismissal')],
};

describe('replay time and fixture selection', () => {
  it('selects every one of the eleven matches at its chapter boundary', () => {
    expect(fixtures).toHaveLength(11);
    for (const match of fixtures) {
      expect(stateAt(match.start).fixture.id).toBe(match.id);
      expect(stateAt(match.end - 0.01).fixture.id).toBe(match.id);
    }
    expect(stateAt(VIDEO_DURATION).fixture.id).toBe(fixtures.at(-1)!.id);
  });

  it('rebuilds score and cards in either seek direction without retaining future events', () => {
    expect(stateForFixture(fixture, 3900).score).toEqual([1, 0]);
    expect(stateForFixture(fixture, 3900).redCards).toEqual([0, 1]);
    const rewound = stateForFixture(fixture, 3100);
    expect(rewound.score).toEqual([0, 0]);
    expect(rewound.redCards).toEqual([0, 0]);
    expect(rewound.events).toEqual([]);
    expect(stateForFixture(fixture, 3900)).toEqual(stateForFixture(fixture, 3900));
  });

  it('maps each half and freezes time through halftime and prematch', () => {
    expect(replayTimeForMatchSecond(fixture, 46 * 60)).toBe(3080);
    expect(stateForFixture(fixture, 1500).matchSecond).toBe(1480);
    expect(stateForFixture(fixture, 2800).matchSecond).toBe(2700);
    expect(stateForFixture(fixture, 2900).matchSecond).toBe(2700);
    expect(stateForFixture(fixture, 5).matchSecond).toBe(0);
    expect(stateForFixture(fixture, 2800).quotes).toEqual(stateForFixture(fixture, 2900).quotes);
    expect(stateForFixture(fixture, 5).quotes).toEqual(stateForFixture(fixture, 15).quotes);
  });

  it('retains second-half stoppage time through final whistle and penalties', () => {
    const extended: TapeFixture = { ...fixture, end: 6400, periods: [
      ...fixture.periods.filter(p => p.phase !== 'FULL_TIME').map(p => p.phase === 'SECOND_HALF' ? { ...p, end: 6080 } : p),
      { phase: 'FULL_TIME', start: 6080, end: 6110, matchSecondStart: 5400, verification: 'video_verified' },
      { phase: 'PENALTIES', start: 6110, end: 6400, matchSecondStart: 5400, verification: 'video_verified' },
    ] };
    expect(stateForFixture(extended, 6080).matchSecond).toBe(5760);
    expect(stateForFixture(extended, 6200).matchSecond).toBe(5760);
    expect(stateForFixture(extended, 6080).matchSecond).toBeGreaterThanOrEqual(stateForFixture(extended, 6079.9).matchSecond);
  });

  it('retains event provenance and reports estimated calibration explicitly', () => {
    const estimated: TapeFixture = { ...fixture, periods: fixture.periods.map(p => ({ ...p, verification: 'report_verified_timing_estimated' })),
      events: fixture.events.map(e => ({ ...e, verification: 'report_verified_timing_estimated' })) };
    const state = stateForFixture(estimated, 3900);
    expect(state.verification).toBe('report_verified_timing_estimated');
    expect(state.events.every(e => e.sourceUrl.startsWith('https://'))).toBe(true);
    expect(runReplayCommand('NOW', state).lines.join(' ')).toContain('timing is estimated');
  });

  it('recognises the observed Wrexham event timing without changing its report provenance', () => {
    const wrexham = fixtures.find(match => match.id === 'wrexham-sheffield-united')!;
    expect(wrexham.events.every(recorded => recorded.verification === 'video_verified')).toBe(true);
    const firstGoal = wrexham.events.find(recorded => recorded.type === 'GOAL')!;
    const reached = stateForFixture(wrexham, firstGoal.videoSecond + 0.01);
    expect(reached.verification).toBe('video_verified');
    expect(reached.events[0].sourceUrl).toBe(wrexham.sourceUrl);
    expect(reached.events[0].note).toContain('Official video evidence:');
  });

  it('uses observed same-phase clocks for playback and inverse seeking without verifying other events', () => {
    const anchors: TapeClockAnchor[] = [
      { phase: 'FIRST_HALF', videoSecond: 100, matchSecond: 60, videoUrl: 'https://youtube.com/watch?v=test&t=100', note: 'Observed clock.' },
      { phase: 'FIRST_HALF', videoSecond: 220, matchSecond: 170, videoUrl: 'https://youtube.com/watch?v=test&t=220', note: 'Observed clock after a cut.' },
    ];
    const estimated: TapeFixture = { ...fixture, periods: fixture.periods.map(p => ({ ...p, verification: 'report_verified_timing_estimated' })) };
    expect(stateForFixture(estimated, 100, anchors).matchSecond).toBe(60);
    expect(stateForFixture(estimated, 160, anchors).matchSecond).toBe(115);
    expect(replayTimeForMatchSecond(estimated, 115, anchors)).toBe(160);
    expect(stateForFixture(estimated, 160, anchors).verification).toBe('report_verified_timing_estimated');
    expect(stateForFixture(estimated, 3100, anchors).matchSecond).toBe(2780);
  });

  it('removes every future event after backward seeking in every fixture', () => {
    for (const match of fixtures) {
      for (const recorded of match.events) {
        expect(stateForFixture(match, recorded.videoSecond + 0.01).events.some(e => e.id === recorded.id)).toBe(true);
        const before = stateForFixture(match, recorded.videoSecond - 0.01);
        expect(before.events.some(e => e.id === recorded.id)).toBe(false);
        expect(before.events.every(e => e.videoSecond <= before.videoSecond)).toBe(true);
      }
    }
  });
});

describe('simulated prices', () => {
  it('returns immediate, deterministic, finite quotes across all chapters', () => {
    for (const match of fixtures) {
      for (const position of [match.start, ...match.events.map(e => e.videoSecond + 0.1)]) {
        const state = stateAt(position);
        expect(state.quotes).toEqual(stateAt(position).quotes);
        for (const quote of state.quotes) {
          if (quote.price !== null) {
            expect(Number.isFinite(quote.price)).toBe(true);
            expect(quote.price).toBeGreaterThanOrEqual(1.01);
            expect(quote.price).toBeLessThanOrEqual(1000);
          }
        }
      }
    }
    expect(stateAt(Number.NaN).videoSecond).toBe(0);
  });

  it('reprices a goal far more than an ordinary single-second tick', () => {
    const before = stateForFixture(fixture, 3199);
    const ordinary = stateForFixture(fixture, 3198);
    const after = stateForFixture(fixture, 3200);
    const goalChange = Math.abs(after.quotes[0].price! - before.quotes[0].price!);
    const tickChange = Math.abs(before.quotes[0].price! - ordinary.quotes[0].price!);
    expect(after.quotes[0].price!).toBeLessThan(before.quotes[0].price!);
    expect(goalChange).toBeGreaterThan(Math.max(0.1, tickChange * 10));
    expect(stateForFixture(fixture, 3250).quotes).not.toEqual(stateForFixture(fixture, 3300).quotes);
  });

  it('holds prices within a playback second while applying an event immediately', () => {
    expect(stateForFixture(fixture, 3250.01).quotes).toEqual(stateForFixture(fixture, 3250.99).quotes);
    const fractionalGoal: TapeFixture = { ...fixture, events: [event('fractional-goal', 'GOAL', 'home', 3100.6)] };
    const before = stateForFixture(fractionalGoal, 3100.5);
    const after = stateForFixture(fractionalGoal, 3100.7);
    expect(before.score).toEqual([0, 0]);
    expect(after.score).toEqual([1, 0]);
    expect(after.quotes[0].price!).toBeLessThan(before.quotes[0].price!);
  });

  it('shortens the opponent after an on-field red card and ignores a coach dismissal', () => {
    expect(stateForFixture(fixture, 3800).quotes[0].price!).toBeLessThan(stateForFixture(fixture, 3799).quotes[0].price!);
    const coachOnly: TapeFixture = { ...fixture, events: [event('manager-red', 'RED_CARD', 'away', 1000, 'coach')] };
    expect(stateForFixture(coachOnly, 1001).redCards).toEqual([0, 0]);
  });

  it('settles regulation independently of a shootout and reveals no future kick score', () => {
    const shield = fixtures.find(f => f.shootoutResult)!;
    const penalty = shield.periods.find(p => p.phase === 'PENALTIES')!;
    expect(stateForFixture(shield, penalty.start - 1).shootoutResult).toBeUndefined();
    const during = stateForFixture(shield, penalty.start + 1);
    expect(during.score).toEqual([1, 1]);
    expect(during.quotes[1].settled).toBe('WIN');
    expect(during.quotes.every(q => q.price === null)).toBe(true);
    expect(during.shootoutResult).not.toEqual(shield.shootoutResult);
    expect(stateForFixture(shield, penalty.end).shootoutResult).toEqual([4, 1]);
    expect(stateForFixture(fixture, 5721).quotes[0].settled).toBe('WIN');
  });

  it('retains the reached shootout result in post-shootout full time without leaking it earlier', () => {
    const shield: TapeFixture = { ...fixture, shootoutResult: [4, 1], events: [], end: 6100, periods: [
      ...fixture.periods.filter(p => p.phase !== 'FULL_TIME'),
      { phase: 'FULL_TIME', start: 5720, end: 5750, matchSecondStart: 5400, verification: 'video_verified' },
      { phase: 'PENALTIES', start: 5750, end: 6000, matchSecondStart: 5400, verification: 'video_verified' },
      { phase: 'FULL_TIME', start: 6000, end: 6100, matchSecondStart: 5400, verification: 'video_verified' },
    ] };
    expect(stateForFixture(shield, 5999).shootoutResult).toBeUndefined();
    const after = stateForFixture(shield, 6001);
    expect(after.phase).toBe('FULL_TIME');
    expect(after.shootoutResult).toEqual([4, 1]);
    expect(after.score).toEqual([0, 0]);
    expect(after.quotes[1].settled).toBe('WIN');
  });

  it('does not treat an unconfirmed disallowed goal as a scored goal', () => {
    const disallowed: TapeFixture = { ...fixture, events: [event('disallowed', 'DISALLOWED_GOAL', 'home', 1000)] };
    expect(stateForFixture(disallowed, 1100).score).toEqual([0, 0]);
    const overturned: TapeFixture = { ...fixture, events: [event('provisional', 'GOAL', 'home', 1000), event('cancel', 'DISALLOWED_GOAL', 'home', 1050, 'overturned:provisional')] };
    expect(stateForFixture(overturned, 1020).score).toEqual([1, 0]);
    expect(stateForFixture(overturned, 1100).score).toEqual([0, 0]);
  });

  it('suppresses ticker comparisons after seeks and chapter changes', () => {
    const old = stateForFixture(fixture, 3199);
    expect(priceChanges(old, stateForFixture(fixture, 3200))[0]).not.toBe(0);
    expect(priceChanges(old, stateForFixture(fixture, 3900))).toEqual([0, 0, 0]);
    expect(priceChanges(old, stateForFixture(fixture, 1000))).toEqual([0, 0, 0]);
    expect(priceChanges(stateAt(fixtures[0].end - 1), stateAt(fixtures[1].start))).toEqual([0, 0, 0]);
  });
});

describe('replay commands and evidence', () => {
  it('compares distinct snapshots and returns only reached evidence in DELTA', () => {
    const current = stateForFixture(fixture, 3900);
    const output = runReplayCommand('DELTA 10', current);
    expect(output.comparison!.before).toBeLessThan(output.comparison!.after);
    expect(output.evidenceIds).toEqual(['away-red', 'coach-red']);
    expect(output.lines.join(' ')).toContain('On-field dismissals: 0–0 → 0–1');
    expect(output.lines.join(' ')).toContain('SIMULATED');
  });

  it('never exposes a later goal or card in any command after a rewind', () => {
    const state = stateForFixture(fixture, 3100);
    for (const command of ['NOW', 'DELTA 10', 'THESIS', 'DISPROVE', 'PLAYER away-red', 'WHY', 'WATCH']) {
      const output = runReplayCommand(command, state);
      expect(output.evidenceIds).toEqual([]);
      expect(output.lines.join(' ')).not.toContain('home-goal');
    }
  });

  it('handles case, accent-insensitive players, expected commands and invalid windows', () => {
    const state = stateForFixture({ ...fixture, events: [event('Éric', 'GOAL', 'home', 1000)] }, 1100);
    expect(runReplayCommand(' player eric ', state).evidenceIds).toEqual(['Éric']);
    expect(runReplayCommand('DELTA 0', state).lines.join(' ')).toContain('greater than 0');
    expect(runReplayCommand('REWIND 5', state).comparison).toEqual({ before: 320, after: 320 });
    expect(runReplayCommand('unknown', state).title).toBe('COMMANDS');
    expect(runReplayCommand('DISPROVE', state).lines.join(' ')).toContain('does not prove tactical control');
  });
});
