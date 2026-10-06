import type { CommandResult, ReplayState, TapeEvent } from '../types';
import { replayTimeForMatchSecond, stateForFixture } from './engine';

const minuteLabel = (event: TapeEvent) => `${event.minute}${event.addedTime ? `+${event.addedTime}` : ''}′`;
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
const team = (state: ReplayState, event: TapeEvent) => state.fixture[event.side];
const timing = (event: TapeEvent) => event.verification === 'video_verified' ? '' : ' [video timing estimated]';
const normalize = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

function describe(state: ReplayState, event: TapeEvent) {
  const label = event.type === 'GOAL' ? 'Goal' : event.type === 'RED_CARD' ? 'Red card'
    : event.type === 'DISALLOWED_GOAL' ? 'Disallowed goal' : 'Shootout kick';
  return `${minuteLabel(event)} ${label}: ${event.player}, ${team(state, event)}${event.type === 'PENALTY_RESULT' && event.note ? ` (${event.note})` : ''}.${timing(event)}`;
}

function result(title: string, lines: string[], events: TapeEvent[] = []): CommandResult {
  return { title, lines, evidenceIds: [...new Set(events.map(event => event.id))] };
}

function briefing(state: ReplayState) {
  const quote = state.quotes.map(q => `${q.outcome}: ${q.price === null ? q.settled : q.price.toFixed(2)}`).join(' · ');
  return [
    `${state.fixture.home} ${state.score[0]}–${state.score[1]} ${state.fixture.away} · ${clock(state.matchSecond)} · ${state.phase.replaceAll('_', ' ')}`,
    `SIMULATED regulation 1X2: ${quote}.`,
    ...(state.shootoutResult ? [`Shootout so far: ${state.shootoutResult[0]}–${state.shootoutResult[1]}; regulation score remains separate.`] : []),
    state.verification === 'video_verified' ? 'Reached event timing verified against the recording.' : 'Historical reports support events; playback timing is estimated and may differ from the video.',
  ];
}

function delta(state: ReplayState, minutes: number): CommandResult {
  const earlierTime = Math.min(state.videoSecond, replayTimeForMatchSecond(state.fixture, Math.max(0, state.matchSecond - minutes * 60)));
  const before = stateForFixture(state.fixture, earlierTime);
  if (earlierTime >= state.videoSecond) return result(`DELTA ${minutes}`, ['No earlier playback snapshot is available yet.']);
  const beforeIds = new Set(before.events.map(event => event.id));
  const events = state.events.filter(event => !beforeIds.has(event.id));
  const lines: string[] = [`Compared ${clock(before.matchSecond)} → ${clock(state.matchSecond)} in this match.`];
  if (before.score.join(':') !== state.score.join(':')) lines.push(`Score: ${before.score[0]}–${before.score[1]} → ${state.score[0]}–${state.score[1]}.`);
  if (before.redCards.join(':') !== state.redCards.join(':')) lines.push(`On-field dismissals: ${before.redCards[0]}–${before.redCards[1]} → ${state.redCards[0]}–${state.redCards[1]}.`);
  lines.push(...events.map(event => describe(state, event)));
  if (!events.length) lines.push('No new recorded goal or dismissal in this window. Tactical pressure cannot be established from these events alone.');
  for (let i = 0; i < state.quotes.length; i++) {
    const old = before.quotes[i];
    const current = state.quotes[i];
    if (old.price !== null && current.price !== null && Math.abs(current.price - old.price) >= 0.02) {
      lines.push(`SIMULATED ${current.outcome}: ${old.price.toFixed(2)} → ${current.price.toFixed(2)}; model movement, not a bookmaker observation.`);
    }
  }
  if (state.phase !== before.phase) lines.push(`Match phase: ${before.phase.replaceAll('_', ' ')} → ${state.phase.replaceAll('_', ' ')}.`);
  return { ...result(`LAST ${minutes} MINUTES`, lines, events), comparison: { before: earlierTime, after: state.videoSecond } };
}

export function runReplayCommand(input: string, state: ReplayState): CommandResult {
  const command = input.trim();
  const upper = command.toUpperCase();
  if (upper === 'NOW') return result('NOW · REPLAY', briefing(state), state.events.slice(-4));
  const deltaMatch = upper.match(/^DELTA(?:\s+(\d+(?:\.\d+)?))?$/);
  if (deltaMatch) {
    const minutes = Number(deltaMatch[1] ?? 10);
    return minutes > 0 && minutes <= 120 ? delta(state, minutes) : result('DELTA', ['Choose a window greater than 0 and no longer than 120 minutes.']);
  }
  if (upper === 'THESIS') {
    const latestGoal = [...state.events].reverse().find(event => event.type === 'GOAL');
    const latestCard = [...state.events].reverse().find(event => event.type === 'RED_CARD');
    if (latestCard && state.redCards.some(count => count > 0)) return result('THESIS · LIMITED EVIDENCE', [
      `FACT: the reached timeline records ${state.redCards[0]} ${state.fixture.home} and ${state.redCards[1]} ${state.fixture.away} on-field dismissals.`,
      'INFERENCE: a numerical disadvantage may affect the match. Its tactical effect needs possession, shot or positional evidence that this replay does not contain.',
      'Simulated prices encode a dismissal assumption; their movement is not independent supporting evidence.',
    ], state.events.filter(event => event.type === 'RED_CARD'));
    if (latestGoal) return result('THESIS · LIMITED EVIDENCE', [
      `FACT: ${state.fixture.home} ${state.score[0]}–${state.score[1]} ${state.fixture.away}.`,
      'The score has changed, but scoring alone does not demonstrate territorial pressure, an overload or tactical control.',
      'No stronger tactical hypothesis is supported by this annotated event set.',
    ], [latestGoal]);
    return result('THESIS · INSUFFICIENT EVIDENCE', ['No tactical hypothesis is justified by a score and clock alone. Recorded goals and dismissals will supply event evidence as playback reaches them.']);
  }
  if (upper === 'DISPROVE') return result('DISPROVE · REPLAY', [
    'Counterargument: a lead or a shorter simulated price does not prove tactical control.',
    'A goal can occur against the run of play; a dismissal does not measure the resulting pressure.',
    'No possession, shot, pass or spatial observations were extracted from this video. Confidence in a tactical-control claim remains unestablished.',
  ], state.events.filter(event => event.type === 'GOAL' || event.type === 'RED_CARD').slice(-4));
  const playerMatch = command.match(/^PLAYER\s+(.+)$/i);
  if (playerMatch) {
    const name = playerMatch[1].trim();
    const events = state.events.filter(event => normalize(event.player).includes(normalize(name)));
    return result(`PLAYER ${name.toUpperCase()}`, events.length
      ? [...events.map(event => describe(state, event)), 'This annotation set records major incidents; it cannot establish touches, passing, positioning or involvement trends.']
      : ['No reached annotation matches this player. That does not imply they were uninvolved.'], events);
  }
  if (upper === 'WHY') return result('WHY · SIMULATED PRICES', [
    'Prices are generated locally from the reached score, remaining playing time, on-field dismissals and fixed synthetic starting strengths.',
    'Small deterministic variation creates ticker movement. The same playback position always generates the same prices.',
    'They are simulated fair odds, with no bookmaker margin. They are not measured betting prices or evidence of tactical control.',
    state.verification === 'video_verified' ? 'Reached event timestamps are video verified.' : 'Event reports are sourced, but video timing remains estimated.',
  ], state.events.filter(event => event.type === 'GOAL' || event.type === 'RED_CARD').slice(-5));
  const rewindMatch = upper.match(/^REWIND\s+(\d+(?:\.\d+)?)$/);
  if (rewindMatch) {
    const position = replayTimeForMatchSecond(state.fixture, Number(rewindMatch[1]) * 60);
    const rewound = stateForFixture(state.fixture, position);
    return { ...result(`REWIND ${rewindMatch[1]}`, briefing(rewound), rewound.events.slice(-4)), comparison: { before: position, after: position } };
  }
  if (upper === 'WATCH') return result('WATCH · NEXT SIGNALS', [
    'Watch the next confirmed goal and whether it changes the score advantage.',
    'Watch for an on-field dismissal; coach dismissals do not change the player count.',
    'Look for direct shot, possession or positional evidence before inferring tactical control from the score.',
  ]);
  return result('COMMANDS', ['NOW · DELTA 10 · THESIS · DISPROVE · PLAYER <name> · WHY · REWIND <minute> · WATCH']);
}
