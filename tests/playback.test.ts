import { describe, expect, it } from 'vitest';
import { newPlaybackClock, playbackTransport, reconcilePlaybackSample, requestPlaybackSeek, type PlaybackSample } from '../src/playbackClock';
import { stateAt } from '../src/replay/engine';
import { fixtures } from '../src/replay/manifest';

const sample = (time: number, wallTime: number, playing = true, rate = 1): PlaybackSample => ({ time, wallTime, playing, rate });
const startedAt = (time: number, playing = true, rate = 1) => reconcilePlaybackSample(newPlaybackClock(), sample(time, 0, playing, rate)).clock;

describe('official player clock reconciliation', () => {
  it('preserves pause when an initial seek autoplays, then allows explicit playback', () => {
    expect(playbackTransport(true, false, true, true)).toEqual({ pause: true, playing: false });
    expect(playbackTransport(true, true, false, true)).toEqual({ pause: false, playing: true });
  });

  it('keeps the hidden player paused in manual mode even if the iframe emits PLAYING', () => {
    expect(playbackTransport(false, false, false, true)).toEqual({ pause: true, playing: false });
    expect(playbackTransport(false, true, false, true)).toEqual({ pause: true, playing: false });
    expect(playbackTransport(false, false, true, false)).toEqual({ pause: false, playing: false });
  });

  it('allows an active iframe user to play after a paused seek has settled', () => {
    expect(playbackTransport(true, false, false, true)).toEqual({ pause: false, playing: true });
  });
  it('accepts normal playback and speed changes without manufacturing seek events', () => {
    const regular = reconcilePlaybackSample(startedAt(100), sample(100.25, 250));
    expect(regular.update).toEqual({ time: 100.25, seek: false });
    const faster = reconcilePlaybackSample(regular.clock, sample(100.75, 500, true, 2));
    expect(faster.update?.seek).toBe(false);
    expect(reconcilePlaybackSample(faster.clock, sample(101.25, 750, true, 2)).update?.seek).toBe(false);
  });

  it('freezes on pause/buffering and does not advance prices from elapsed wall time', () => {
    const paused = reconcilePlaybackSample(startedAt(100, false), sample(100, 10000, false));
    expect(paused.update).toEqual({ time: 100, seek: false });
    const buffering = reconcilePlaybackSample(startedAt(100), sample(100, 10000, false));
    expect(buffering.update).toEqual({ time: 100, seek: false });
    expect(stateAt(buffering.update!.time).quotes).toEqual(stateAt(100).quotes);
    expect(reconcilePlaybackSample(buffering.clock, sample(100.25, 10250, true)).update?.seek).toBe(false);
  });

  it('detects backward and forward iframe scrubbing, including while paused', () => {
    expect(reconcilePlaybackSample(startedAt(100), sample(30, 250)).update).toEqual({ time: 30, seek: true });
    expect(reconcilePlaybackSample(startedAt(100), sample(900, 250)).update).toEqual({ time: 900, seek: true });
    expect(reconcilePlaybackSample(startedAt(100, false), sample(101, 250, false)).update?.seek).toBe(true);
    expect(reconcilePlaybackSample(startedAt(100), sample(101, 250)).update?.seek).toBe(true);
  });

  it('allows a stalled polling interval at 2× playback without mistaking it for a seek', () => {
    expect(reconcilePlaybackSample(startedAt(100, true, 2), sample(110, 5000, true, 2)).update?.seek).toBe(false);
  });

  it('does not acknowledge an old position merely because it is within two seconds of the target', () => {
    const requested = requestPlaybackSeek(startedAt(100), 101.5, 0);
    const stale = reconcilePlaybackSample(requested, sample(100, 250, false));
    expect(stale.seekStatus).toBe('pending');
    expect(stale.update).toBeNull();
    const confirmed = reconcilePlaybackSample(stale.clock, sample(101.5, 500, false));
    expect(confirmed.update).toEqual({ time: 101.5, seek: true });
    expect(confirmed.clock.pending).toBeNull();
  });

  it('accepts a changed paused keyframe landing after stable observations', () => {
    const requested = requestPlaybackSeek(startedAt(100, false), 500, 0, true);
    const landed = reconcilePlaybackSample(requested, sample(498, 250, false));
    expect(landed.update).toBeNull();
    const confirmed = reconcilePlaybackSample(landed.clock, sample(498, 500, false));
    expect(confirmed.seekStatus).toBe('confirmed');
    expect(confirmed.update).toEqual({ time: 498, seek: true });
    expect(confirmed.clock.pending).toBeNull();
  });

  it('rejects a stable unchanged origin even when it resembles a nearby keyframe landing', () => {
    let waiting = requestPlaybackSeek(startedAt(498, false), 500, 0, true);
    for (const wallTime of [250, 500, 1000, 3000]) {
      const output = reconcilePlaybackSample(waiting, sample(498, wallTime, false));
      expect(output.update).toBeNull();
      expect(output.seekStatus).toBe('pending');
      waiting = output.clock;
    }
  });

  it('does not accept a transient changing near-target reading before it settles', () => {
    const requested = requestPlaybackSeek(startedAt(100, false), 500, 0);
    const transient = reconcilePlaybackSample(requested, sample(498, 250, false));
    const stillMoving = reconcilePlaybackSample(transient.clock, sample(498.5, 500, false));
    expect(stillMoving.update).toBeNull();
    expect(reconcilePlaybackSample(stillMoving.clock, sample(498.5, 750, false)).update?.time).toBe(498.5);
  });

  it('allows native Play during reconciliation and acknowledges advancement from its landing', () => {
    const requested = requestPlaybackSeek(startedAt(100, false), 500, 0, true);
    const landed = reconcilePlaybackSample(requested, sample(498, 250, false));
    // The player's actual PAUSED state clears its temporary pause guard.
    expect(playbackTransport(true, false, false, true).playing).toBe(true);
    const played = reconcilePlaybackSample(landed.clock, sample(498.25, 500, true));
    expect(played.seekStatus).toBe('confirmed');
    expect(played.update).toEqual({ time: 498.25, seek: true });
    expect(reconcilePlaybackSample(played.clock, sample(498.5, 750, true)).update?.seek).toBe(false);
  });

  it('acknowledges playback progression after seeking without resetting an already announced baseline', () => {
    const requested = requestPlaybackSeek(startedAt(100), 500, 0, true);
    const confirmed = reconcilePlaybackSample(requested, sample(500.5, 250, true, 2));
    expect(confirmed.seekStatus).toBe('confirmed');
    expect(confirmed.update).toEqual({ time: 500.5, seek: false });
    expect(reconcilePlaybackSample(confirmed.clock, sample(501, 500, true, 2)).update?.seek).toBe(false);
  });

  it('honours same-position explicit seeks even without a clock discontinuity', () => {
    const requested = requestPlaybackSeek(startedAt(100, false), 100, 0);
    expect(reconcilePlaybackSample(requested, sample(100, 250, false)).update).toEqual({ time: 100, seek: true });
    const announced = requestPlaybackSeek(startedAt(100, false), 100, 0, true);
    expect(reconcilePlaybackSample(announced, sample(100, 250, false)).update?.seek).toBe(false);
  });

  it('restores actual player time after a failed seek instead of leaving fabricated progress', () => {
    const requested = requestPlaybackSeek(startedAt(100), 500, 0, true);
    const waiting = reconcilePlaybackSample(requested, sample(102, 7999));
    expect(waiting.update).toBeNull();
    const failed = reconcilePlaybackSample(waiting.clock, sample(102, 8000));
    expect(failed.seekStatus).toBe('failed');
    expect(failed.update).toEqual({ time: 102, seek: true });
    expect(failed.clock.pending).toBeNull();
  });

  it('lets the newest seek replace a pending request', () => {
    const first = requestPlaybackSeek(startedAt(100), 500, 0);
    const second = requestPlaybackSeek(first, 900, 100);
    expect(reconcilePlaybackSample(second, sample(500, 250, false)).update).toBeNull();
    expect(reconcilePlaybackSample(second, sample(900, 500, false)).update).toEqual({ time: 900, seek: true });
  });

  it('ignores invalid API samples without destroying pending reconciliation', () => {
    const requested = requestPlaybackSeek(startedAt(100), 500, 0);
    expect(reconcilePlaybackSample(requested, sample(Number.NaN, 100)).clock).toBe(requested);
    expect(reconcilePlaybackSample(requested, sample(100, 100, true, 0)).update).toBeNull();
  });

  it('holds model prices through the recorded halftime even while the video continues', () => {
    const halftime = fixtures[0].periods.find(p => p.phase === 'HALF_TIME')!;
    const before = stateAt(halftime.start + 0.1);
    const later = stateAt(halftime.end - 0.1);
    expect(before.phase).toBe('HALF_TIME');
    expect(later.matchSecond).toBe(before.matchSecond);
    expect(later.quotes).toEqual(before.quotes);
  });
});
