export interface PlaybackSample {
  time: number;
  wallTime: number;
  rate: number;
  playing: boolean;
}

export interface PlaybackClock {
  last: PlaybackSample | null;
  pending: {
    target: number; requestedAt: number; deadline: number; announced: boolean;
    origin: number | null;
    landing: { time: number; wallTime: number } | null;
  } | null;
}

export interface PlaybackUpdate {
  clock: PlaybackClock;
  update: { time: number; seek: boolean } | null;
  seekStatus?: 'pending' | 'confirmed' | 'failed';
}

export const newPlaybackClock = (): PlaybackClock => ({ last: null, pending: null });
const SEEK_TOLERANCE = 0.35;

/** A seek on an unstarted YouTube player can autoplay; preserve paused intent. */
export function playbackTransport(active: boolean, requestedPlaying: boolean, preservingPausedSeek: boolean, actualPlaying: boolean) {
  const mustPause = !active || (preservingPausedSeek && !requestedPlaying);
  return { pause: mustPause && actualPlaying, playing: actualPlaying && !mustPause };
}

/** Announced requests have already reset the UI; acknowledgement must not reset it twice. */
export function requestPlaybackSeek(clock: PlaybackClock, target: number, wallTime: number, announced = false): PlaybackClock {
  if (!Number.isFinite(target) || !Number.isFinite(wallTime)) return clock;
  return { ...clock, pending: { target: Math.max(0, target), requestedAt: wallTime, deadline: wallTime + 8000, announced,
    origin: clock.last?.time ?? null, landing: null } };
}

/** Infer jumps from player time, never advance video time from the wall clock. */
export function reconcilePlaybackSample(clock: PlaybackClock, sample: PlaybackSample): PlaybackUpdate {
  if (!Number.isFinite(sample.time) || sample.time < 0 || !Number.isFinite(sample.wallTime)
    || !Number.isFinite(sample.rate) || sample.rate <= 0) return { clock, update: null };
  if (clock.pending) {
    const pending = clock.pending;
    const secondsSinceRequest = Math.max(0, (sample.wallTime - pending.requestedAt) / 1000);
    const permittedProgress = sample.playing ? sample.rate * Math.min(secondsSinceRequest, 1) : 0;
    const acknowledged = sample.time >= pending.target - SEEK_TOLERANCE
      && sample.time <= pending.target + permittedProgress + SEEK_TOLERANCE;
    if (acknowledged) return {
      clock: { last: sample, pending: null }, update: { time: sample.time, seek: !pending.announced }, seekStatus: 'confirmed',
    };
    // Unbuffered YouTube seeks can settle at the preceding keyframe. Require
    // movement away from the actual origin and two observations before using
    // that landing, rather than accepting an unchanged nearby stale reading.
    const nearTarget = Math.abs(sample.time - pending.target) <= 3;
    const moved = pending.origin === null || Math.abs(sample.time - pending.origin) > SEEK_TOLERANCE;
    const landingElapsed = pending.landing ? (sample.wallTime - pending.landing.wallTime) / 1000 : 0;
    const landedDelta = pending.landing ? sample.time - pending.landing.time : 0;
    const stablePausedLanding = !!pending.landing && !sample.playing && landingElapsed >= 0.18 && Math.abs(landedDelta) <= 0.08;
    const playingFromLanding = !!pending.landing && sample.playing && landingElapsed >= 0.18
      && landedDelta >= -0.08 && landedDelta <= landingElapsed * sample.rate + 0.12;
    if (nearTarget && moved && (stablePausedLanding || playingFromLanding)) return {
      // A keyframe correction needs its own actual-position baseline; a
      // request at a later second must not manufacture intervening movement.
      clock: { last: sample, pending: null }, update: { time: sample.time, seek: true }, seekStatus: 'confirmed',
    };
    if (sample.wallTime >= pending.deadline) return {
      clock: { last: sample, pending: null }, update: { time: sample.time, seek: true }, seekStatus: 'failed',
    };
    const landing = nearTarget && moved && !sample.playing
      ? pending.landing && Math.abs(sample.time - pending.landing.time) <= 0.08 ? pending.landing : { time: sample.time, wallTime: sample.wallTime }
      : null;
    const origin = pending.origin ?? (!nearTarget ? sample.time : null);
    return { clock: { last: sample, pending: { ...pending, origin, landing } }, update: null, seekStatus: 'pending' };
  }
  const previous = clock.last;
  const elapsed = previous ? Math.max(0, (sample.wallTime - previous.wallTime) / 1000) : 0;
  // Rate changes may happen between polls. Pause/buffer transitions can account
  // for any advancement from zero through the largest observed playback rate.
  const maximumAdvance = previous && (previous.playing || sample.playing)
    ? elapsed * Math.max(previous.rate, sample.rate) : 0;
  const difference = previous ? sample.time - previous.time : 0;
  const seek = !!previous && (difference < -SEEK_TOLERANCE || difference > maximumAdvance + SEEK_TOLERANCE);
  return { clock: { last: sample, pending: null }, update: { time: sample.time, seek } };
}
