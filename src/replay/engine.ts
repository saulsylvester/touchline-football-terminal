import type { Quote, ReplayState, TapeEvent, TapeFixture, TapePeriod } from '../types';
import { clockAnchors, fixtures, VIDEO_DURATION, type TapeClockAnchor } from './manifest';

const isPlaying = (period: TapePeriod) => period.phase === 'FIRST_HALF' || period.phase === 'SECOND_HALF';
const bounded = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const safeTime = (value: number, fallback = 0) => Number.isFinite(value) ? value : fallback;

function anchorsForPeriod(period: TapePeriod, anchors: readonly TapeClockAnchor[]) {
  const ordered = [...new Map(anchors.filter(a => a.phase === period.phase && Number.isFinite(a.videoSecond)
    && Number.isFinite(a.matchSecond) && a.matchSecond >= period.matchSecondStart
    && a.videoSecond >= period.start && a.videoSecond <= period.end).map(a => [a.videoSecond, a])).values()]
    .sort((a, b) => a.videoSecond - b.videoSecond);
  return ordered.reduce<TapeClockAnchor[]>((accepted, anchor) => {
    if (!accepted.length || anchor.matchSecond >= accepted[accepted.length - 1].matchSecond) accepted.push(anchor);
    return accepted;
  }, []);
}

function periodClock(period: TapePeriod, videoSecond: number, anchors: readonly TapeClockAnchor[]) {
  const points = anchorsForPeriod(period, anchors);
  const time = bounded(videoSecond, period.start, period.end);
  if (!points.length) return period.matchSecondStart + time - period.start;
  if (time <= points[0].videoSecond) return Math.max(period.matchSecondStart, points[0].matchSecond + time - points[0].videoSecond);
  const last = points[points.length - 1];
  if (time >= last.videoSecond) return last.matchSecond + time - last.videoSecond;
  const rightIndex = points.findIndex(point => point.videoSecond >= time);
  const left = points[rightIndex - 1], right = points[rightIndex];
  return left.matchSecond + (time - left.videoSecond) / (right.videoSecond - left.videoSecond) * (right.matchSecond - left.matchSecond);
}

function periodVideoTime(period: TapePeriod, matchSecond: number, anchors: readonly TapeClockAnchor[]) {
  const points = anchorsForPeriod(period, anchors);
  if (!points.length) return period.start + matchSecond - period.matchSecondStart;
  if (matchSecond <= points[0].matchSecond) return points[0].videoSecond + matchSecond - points[0].matchSecond;
  const last = points[points.length - 1];
  if (matchSecond >= last.matchSecond) return last.videoSecond + matchSecond - last.matchSecond;
  const rightIndex = points.findIndex(point => point.matchSecond >= matchSecond);
  const left = points[rightIndex - 1], right = points[rightIndex];
  const span = right.matchSecond - left.matchSecond;
  return span > 0 ? left.videoSecond + (matchSecond - left.matchSecond) / span * (right.videoSecond - left.videoSecond) : left.videoSecond;
}

function phaseAt(fixture: TapeFixture, videoSecond: number, anchors: readonly TapeClockAnchor[]) {
  const periods = [...fixture.periods].sort((a, b) => a.start - b.start);
  const period = periods.find(p => videoSecond >= p.start && videoSecond < p.end)
    ?? [...periods].reverse().find(p => videoSecond >= p.start);
  if (!period) return { phase: 'PRE_MATCH' as const, matchSecond: 0, period: undefined };
  if (period.phase === 'FULL_TIME' || period.phase === 'PENALTIES') {
    const finalPlayingPeriod = [...periods].reverse().find(p => isPlaying(p) && p.end <= period.start);
    const matchSecond = finalPlayingPeriod
      ? periodClock(finalPlayingPeriod, finalPlayingPeriod.end, anchors) : period.matchSecondStart;
    return { phase: period.phase, matchSecond, period };
  }
  return { phase: period.phase, matchSecond: isPlaying(period) ? periodClock(period, videoSecond, anchors) : period.matchSecondStart, period };
}

function eventIsCoachDismissal(event: TapeEvent) {
  return /\b(coach|manager|technical staff)\b/i.test(event.note ?? '');
}

function reduceEvents(events: TapeEvent[]) {
  const score: [number, number] = [0, 0];
  const redCards: [number, number] = [0, 0];
  const countedGoals = new Map<string, 0 | 1>();
  for (const event of events) {
    const side = event.side === 'home' ? 0 : 1;
    if (event.type === 'GOAL' && !countedGoals.has(event.id)) {
      score[side] += 1;
      countedGoals.set(event.id, side);
    } else if (event.type === 'RED_CARD' && !eventIsCoachDismissal(event)) {
      redCards[side] += 1;
    } else if (event.type === 'DISALLOWED_GOAL') {
      const target = event.note?.match(/overturned:([^\s;,]+)/i)?.[1];
      const countedSide = target ? countedGoals.get(target) : undefined;
      if (countedSide !== undefined) {
        score[countedSide] = Math.max(0, score[countedSide] - 1);
        countedGoals.delete(target!);
      }
    }
  }
  return { score, redCards };
}

function hashSeed(input: string) {
  let seed = 2166136261;
  for (const character of input) seed = Math.imul(seed ^ character.charCodeAt(0), 16777619);
  return (seed >>> 0) / 4294967296 * Math.PI * 2;
}

function poisson(rate: number) {
  const distribution = [Math.exp(-rate)];
  for (let goals = 1; goals <= 18; goals++) distribution.push(distribution[goals - 1] * rate / goals);
  const total = distribution.reduce((sum, p) => sum + p, 0);
  return distribution.map(p => p / total);
}

function simulatedQuotes(fixture: TapeFixture, videoSecond: number, score: [number, number], redCards: [number, number]): Quote[] {
  const playingPeriods = fixture.periods.filter(isPlaying);
  const total = playingPeriods.reduce((sum, p) => sum + Math.max(0, p.end - p.start), 0);
  const quoteSecond = Math.floor(videoSecond);
  const elapsed = playingPeriods.reduce((sum, p) => {
    const duration = Math.max(0, p.end - p.start);
    // Prices tick on whole player seconds; reached events still reduce at their
    // exact position. Completed periods freeze at their actual boundary.
    return sum + (videoSecond >= p.end ? duration : bounded(quoteSecond - p.start, 0, duration));
  }, 0);
  const fraction = total > 0 ? bounded(1 - elapsed / total, 0, 1) : 1;
  const seed = hashSeed(fixture.id);
  const variation = (side: number) => 1 + 0.025 * Math.sin(elapsed / 12 + seed + side * 2.3)
    + 0.012 * Math.sin(elapsed / 47 + seed * 1.7 + side);
  const rates = fixture.rates.map((rate, side) => bounded(rate, 0.05, 5) * fraction
    * Math.pow(0.67, redCards[side]) * Math.pow(1.18, redCards[1 - side]) * variation(side));
  const home = poisson(rates[0]);
  const away = poisson(rates[1]);
  const probabilities = [0, 0, 0];
  for (let h = 0; h < home.length; h++) {
    for (let a = 0; a < away.length; a++) {
      const difference = score[0] + h - score[1] - a;
      probabilities[difference > 0 ? 0 : difference < 0 ? 2 : 1] += home[h] * away[a];
    }
  }
  const totalProbability = probabilities.reduce((sum, p) => sum + p, 0);
  return [fixture.home, 'Draw', fixture.away].map((outcome, index) => ({
    outcome,
    price: Math.round(bounded(1 / Math.max(0.000001, probabilities[index] / totalProbability), 1.01, 1000) * 100) / 100,
  }));
}

function reachedShootoutScore(fixture: TapeFixture, events: TapeEvent[], videoSecond: number): [number, number] | undefined {
  const shootout = fixture.periods.find(p => p.phase === 'PENALTIES');
  if (!shootout || videoSecond < shootout.start) return undefined;
  if (videoSecond >= shootout.end && fixture.shootoutResult) return [...fixture.shootoutResult];
  if (!fixture.events.some(e => e.type === 'PENALTY_RESULT')) return undefined;
  const result: [number, number] = [0, 0];
  for (const event of events.filter(e => e.type === 'PENALTY_RESULT')) {
    if (/\b(scored|converted|successful)\b/i.test(event.note ?? '') && !/\b(not|missed|saved)\b/i.test(event.note ?? '')) {
      result[event.side === 'home' ? 0 : 1] += 1;
    }
  }
  return result;
}

/** Rebuild from the tape position, so seeks never retain events from the future. */
export function stateForFixture(fixture: TapeFixture, seconds: number, anchors: readonly TapeClockAnchor[] = clockAnchors[fixture.id] ?? []): ReplayState {
  const videoSecond = bounded(safeTime(seconds, fixture.start), fixture.start, fixture.end);
  const current = phaseAt(fixture, videoSecond, anchors);
  const events = [...new Map(fixture.events.filter(e => e.videoSecond >= fixture.start && e.videoSecond <= videoSecond)
    .map(event => [event.id, event])).values()].sort((a, b) => a.videoSecond - b.videoSecond);
  const { score, redCards } = reduceEvents(events);
  const settled = current.phase === 'FULL_TIME' || current.phase === 'PENALTIES';
  const winner = score[0] > score[1] ? 0 : score[0] < score[1] ? 2 : 1;
  const quotes: Quote[] = settled
    ? [fixture.home, 'Draw', fixture.away].map((outcome, index) => ({ outcome, price: null, settled: index === winner ? 'WIN' : 'LOSE' }))
    : simulatedQuotes(fixture, videoSecond, score, redCards);
  const verification = current.period?.verification !== 'video_verified'
    || events.some(e => e.verification !== 'video_verified')
    ? 'report_verified_timing_estimated' : 'video_verified';
  return { fixture, videoSecond, matchSecond: current.matchSecond, phase: current.phase, score, redCards, events, quotes,
    verification, shootoutResult: reachedShootoutScore(fixture, events, videoSecond) };
}

export function stateAt(seconds: number): ReplayState {
  const videoSecond = bounded(safeTime(seconds), 0, VIDEO_DURATION);
  const fixture = [...fixtures].reverse().find(f => f.start <= videoSecond) ?? fixtures[0];
  if (!fixture) throw new Error('The replay manifest contains no matches.');
  return stateForFixture(fixture, videoSecond);
}

/** Match minutes in the second half prefer that half over first-half stoppage time. */
export function replayTimeForMatchSecond(fixture: TapeFixture, seconds: number, anchors: readonly TapeClockAnchor[] = clockAnchors[fixture.id] ?? []): number {
  const matchSecond = Math.max(0, safeTime(seconds));
  const playing = fixture.periods.filter(isPlaying).sort((a, b) => a.matchSecondStart - b.matchSecondStart);
  const period = [...playing].reverse().find(p => periodClock(p, p.start, anchors) <= matchSecond) ?? playing[0];
  if (!period) return fixture.start;
  return bounded(periodVideoTime(period, matchSecond, anchors), period.start, period.end);
}

/** A discontinuity starts a fresh ticker baseline instead of flashing a seek as a trade. */
export function priceChanges(previous: ReplayState | null, current: ReplayState): number[] {
  if (!previous || previous.fixture.id !== current.fixture.id
    || current.videoSecond < previous.videoSecond || current.videoSecond - previous.videoSecond > 2.5) {
    return current.quotes.map(() => 0);
  }
  return current.quotes.map((quote, index) => {
    const old = previous.quotes[index];
    return quote.price !== null && old?.price !== null && old?.price !== undefined && old.outcome === quote.outcome
      ? Math.round((quote.price - old.price) * 100) / 100 : 0;
  });
}
