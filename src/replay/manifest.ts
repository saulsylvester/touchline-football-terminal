import type { Side, TapeEvent, TapeFixture, TapePeriod } from '../types';

export const VIDEO_ID = 'FNnpv_323KQ';
export const VIDEO_DURATION = 71815;

const estimated = 'report_verified_timing_estimated' as const;
const verified = 'video_verified' as const;
type Goal = [Side, string, number, number?];
type Seed = { id: string; home: string; away: string; competition: string; date: string; start: number; end: number; sourceUrl: string; rates: [number, number]; goals: Goal[]; reds?: Goal[]; shootoutResult?: [number, number] };

export interface VideoObservation {
  videoSecond: number;
  /** A timestamped URL to the official player, separate from report provenance. */
  videoUrl: string;
  note: string;
}
export interface TapeClockAnchor extends VideoObservation {
  phase: 'FIRST_HALF' | 'SECOND_HALF';
  matchSecond: number;
}
type Boundary = 'fixtureStart' | 'kickoff' | 'halfTime' | 'secondHalf' | 'fullTime' | 'penaltiesStart' | 'penaltiesEnd' | 'fixtureEnd';
export interface FixtureCalibration {
  clockAnchors: TapeClockAnchor[];
  boundaries: Partial<Record<Boundary, VideoObservation>>;
  eventPositions: Record<string, VideoObservation>;
  /** Conservative timing markers where the actual event is obscured. These
   * never promote event verification, even if the marker frame was viewed. */
  eventEstimates?: Record<string, VideoObservation>;
  /** Identifies unresolved disagreements in match-report minutes. */
  reportNotes?: string[];
}

export const officialVideoUrl = (videoSecond: number) => `https://www.youtube.com/watch?v=${VIDEO_ID}&t=${Math.floor(videoSecond)}s`;

/** Chapter boundaries are published by the FA. The match clocks and event
 * positions remain estimates until checked against the official player. */
function makeFixture(seed: Seed): TapeFixture {
  const length = seed.end - seed.start;
  const calibration = calibrationLedger[seed.id];
  const boundary = (key: Boundary, fallback: number) => calibration.boundaries[key]?.videoSecond ?? fallback;
  const fixtureStart = boundary('fixtureStart', seed.start);
  const fixtureEnd = boundary('fixtureEnd', seed.end);
  const firstStart = boundary('kickoff', fixtureStart + 20);
  const firstEnd = boundary('halfTime', firstStart + 2800);
  const regulationEnd = boundary('fullTime', fixtureEnd - (seed.shootoutResult ? 420 : 30));
  const secondStart = boundary('secondHalf', Math.max(firstEnd + 20, regulationEnd - 2940));
  const penaltiesStart = boundary('penaltiesStart', regulationEnd + 30);
  const penaltiesEnd = boundary('penaltiesEnd', fixtureEnd);
  const period = (phase: TapePeriod['phase'], start: number, end: number, matchSecondStart: number, from: Boundary, to: Boundary): TapePeriod => ({
    phase, start, end, matchSecondStart,
    // An observed clock or published chapter never verifies an entire period.
    verification: calibration.boundaries[from] && calibration.boundaries[to] ? verified : estimated,
  });
  const periods: TapePeriod[] = [
    period('PRE_MATCH', fixtureStart, firstStart, 0, 'fixtureStart', 'kickoff'),
    period('FIRST_HALF', firstStart, firstEnd, 0, 'kickoff', 'halfTime'),
    period('HALF_TIME', firstEnd, secondStart, 2700, 'halfTime', 'secondHalf'),
    period('SECOND_HALF', secondStart, regulationEnd, 2700, 'secondHalf', 'fullTime'),
    period('FULL_TIME', regulationEnd, seed.shootoutResult ? penaltiesStart : fixtureEnd, 5400, 'fullTime', seed.shootoutResult ? 'penaltiesStart' : 'fixtureEnd'),
  ];
  if (seed.shootoutResult) {
    periods.push(period('PENALTIES', penaltiesStart, penaltiesEnd, 5400, 'penaltiesStart', 'penaltiesEnd'));
    if (penaltiesEnd < fixtureEnd) periods.push(period('FULL_TIME', penaltiesEnd, fixtureEnd, 5400, 'penaltiesEnd', 'fixtureEnd'));
  }
  const at = (minute: number, addedTime = 0) => {
    const elapsed = Math.max(0, minute - 1) * 60 + addedTime * 60 + 30;
    const phase = minute <= 45 ? 'FIRST_HALF' : 'SECOND_HALF';
    const anchors = calibration.clockAnchors.filter(anchor => anchor.phase === phase);
    const nearest = anchors.sort((a, b) => Math.abs(a.matchSecond - elapsed) - Math.abs(b.matchSecond - elapsed))[0];
    const extrapolated = nearest ? nearest.videoSecond + elapsed - nearest.matchSecond : minute <= 45 ? firstStart + elapsed : secondStart + elapsed - 2700;
    return Math.min((minute <= 45 ? firstEnd : regulationEnd) - 1, Math.max(minute <= 45 ? firstStart : secondStart, extrapolated));
  };
  const event = (entry: Goal, type: TapeEvent['type'], index: number): TapeEvent => {
    const id = `${seed.id}-${type.toLowerCase()}-${index + 1}`;
    const observation = calibration.eventPositions[id];
    const timingEstimate = calibration.eventEstimates?.[id];
    return { id, type, side: entry[0], player: entry[1], minute: entry[2], ...(entry[3] ? { addedTime: entry[3] } : {}),
      videoSecond: observation?.videoSecond ?? timingEstimate?.videoSecond ?? at(entry[2], entry[3]), sourceUrl: seed.sourceUrl, verification: observation ? verified : estimated,
      note: observation ? `${observation.note} Official video evidence: ${observation.videoUrl}` : timingEstimate ? `${timingEstimate.note} Estimated timing marker: ${timingEstimate.videoUrl}. Historical event is report-verified; the actual event instant is not visually confirmed.` : 'Historical event verified from match reporting; compilation position estimated from period/clock anchors. Exact scoring or dismissal instant has not been checked.',
    };
  };
  const { goals, reds, ...fixture } = seed;
  const events = [...goals.map((g, i) => event(g, 'GOAL', i)), ...(reds ?? []).map((g, i) => event(g, 'RED_CARD', i))].sort((a, b) => a.videoSecond - b.videoSecond);
  return { ...fixture, start: fixtureStart, end: fixtureEnd, periods, events, calibrationNote: `FA-published fixture chapter ${seed.start}–${seed.end}s (${length}s); mapped compilation window ${fixtureStart}–${fixtureEnd}s. ${events.filter(e => e.verification === verified).length}/${events.length} event positions and ${periods.filter(p => p.verification === verified).length}/${periods.length} periods checked in the official player. Other positions are estimates. Observed timestamps are visible confirmation points; their notes distinguish scoring/whistle uncertainty. Rates are synthetic simulation inputs, not observed statistics.${calibration.reportNotes?.length ? ` ${calibration.reportNotes.join(' ')}` : ''}` };
}

const seeds: Seed[] = [
  { id: 'wrexham-sheffield-united', home: 'Wrexham', away: 'Sheffield United', competition: 'FA Cup · Fourth round', date: '2023-01-29', start: 0, end: 6637, rates: [1.3, 1.7], sourceUrl: 'https://www.thefa.com/news/2023/jan/29/emiratesfacupfourthroundsundaywrap20230129', goals: [['away', 'Oli McBurnie', 2], ['home', 'James Jones', 50], ['home', "Tom O’Connor", 61], ['away', 'Oliver Norwood', 65], ['home', 'Paul Mullin', 86], ['away', 'John Egan', 90, 5]], reds: [['away', 'Daniel Jebbison', 71]] },
  { id: 'man-city-man-united', home: 'Manchester City', away: 'Manchester United', competition: 'FA Cup · Final', date: '2023-06-03', start: 6637, end: 14275, rates: [2.1, 0.9], sourceUrl: 'https://www.thefa.com/news/2023/jun/03/emirates-fa-cup-final-report-20230603', goals: [['home', 'İlkay Gündoğan', 1], ['away', 'Bruno Fernandes (penalty)', 33], ['home', 'İlkay Gündoğan', 51]] },
  { id: 'brighton-liverpool', home: 'Brighton', away: 'Liverpool', competition: 'FA Cup · Fourth round', date: '2023-01-29', start: 14275, end: 20306, rates: [1.5, 1.6], sourceUrl: 'https://www.liverpoolfc.com/matches/mens-team/results/2022', goals: [['away', 'Harvey Elliott', 30], ['home', 'Lewis Dunk', 39], ['home', 'Kaoru Mitoma', 90, 2]] },
  { id: 'arsenal-man-city-shield', home: 'Arsenal', away: 'Manchester City', competition: 'Community Shield', date: '2023-08-06', start: 20306, end: 28552, rates: [1.2, 1.8], sourceUrl: 'https://www.thefa.com/news/2023/aug/06/fa-community-shield-arsenal-vs-manchester-city-report-20230806', goals: [['away', 'Cole Palmer', 77], ['home', 'Leandro Trossard', 90, 11]], shootoutResult: [4, 1] },
  { id: 'man-united-fulham', home: 'Manchester United', away: 'Fulham', competition: 'FA Cup · Quarter-final', date: '2023-03-19', start: 28552, end: 34665, rates: [1.9, 1.0], sourceUrl: 'https://www.thefa.com/news/2023/mar/19/manchester-united-fulham-emirates-fa-cup-report-20230319', goals: [['away', 'Aleksandar Mitrović', 50], ['home', 'Bruno Fernandes (penalty)', 75], ['home', 'Marcel Sabitzer', 77], ['home', 'Bruno Fernandes', 90, 6]], reds: [['away', 'Willian', 72], ['away', 'Aleksandar Mitrović', 72]] },
  { id: 'man-city-arsenal-cup', home: 'Manchester City', away: 'Arsenal', competition: 'FA Cup · Fourth round', date: '2023-01-27', start: 34665, end: 40799, rates: [1.8, 1.1], sourceUrl: 'https://www.mancity.com/news/mens/arsenal-fa-cup-fourth-round-match-report-63810434', goals: [['home', 'Nathan Aké', 64]] },
  { id: 'southampton-grimsby', home: 'Southampton', away: 'Grimsby Town', competition: 'FA Cup · Fifth round', date: '2023-03-01', start: 40799, end: 47264, rates: [1.9, 0.6], sourceUrl: 'https://gtfc.co.uk/match/southampton-grimsby-2023-03-01/', goals: [['away', 'Gavan Holohan (penalty)', 45, 1], ['away', 'Gavan Holohan (penalty)', 50], ['home', 'Duje Ćaleta-Car', 65]] },
  { id: 'sheffield-united-blackburn', home: 'Sheffield United', away: 'Blackburn Rovers', competition: 'FA Cup · Quarter-final', date: '2023-03-19', start: 47264, end: 53701, rates: [1.6, 1.1], sourceUrl: 'https://www.thefa.com/news/2023/mar/19/sheffield-united-blackburn-rovers-emirates-fa-cup-report-20230319', goals: [['away', 'Ben Brereton Díaz (penalty)', 21], ['home', 'Sam Gallagher (own goal)', 28], ['away', 'Sammie Szmodics', 60], ['home', 'Oli McBurnie', 81], ['home', 'Tommy Doyle', 90, 1]] },
  { id: 'aston-villa-stevenage', home: 'Aston Villa', away: 'Stevenage', competition: 'FA Cup · Third round', date: '2023-01-08', start: 53701, end: 59781, rates: [1.9, 0.5], sourceUrl: 'https://www.thefa.com/news/2023/jan/08/emiratesfacupsundaythirdroundwrap20230108', goals: [['home', 'Morgan Sanson', 33], ['away', 'Jamie Reid (penalty)', 88], ['away', 'Dean Campbell', 90]], reds: [['home', 'Leander Dendoncker', 85]] },
  { id: 'liverpool-wolves', home: 'Liverpool', away: 'Wolverhampton Wanderers', competition: 'FA Cup · Third round', date: '2023-01-07', start: 59781, end: 65926, rates: [2.0, 1.0], sourceUrl: 'https://www.wolves.co.uk/news/mens-first-team/20230107-report-liverpool-2-2-wolves/', goals: [['away', 'Gonçalo Guedes', 26], ['home', 'Darwin Núñez', 45], ['home', 'Mohamed Salah', 52], ['away', 'Hwang Hee-chan', 66]] },
  { id: 'man-city-chelsea', home: 'Manchester City', away: 'Chelsea', competition: 'FA Cup · Third round', date: '2023-01-08', start: 65926, end: 71815, rates: [2.0, 0.9], sourceUrl: 'https://www.mancity.com/news/mens/city-v-chelsea-fa-cup-match-report-63808783', goals: [['home', 'Riyad Mahrez', 23], ['home', 'Julián Álvarez (penalty)', 30], ['home', 'Phil Foden', 38], ['home', 'Riyad Mahrez (penalty)', 85]] },
];

/** Direct official-player observations belong in eventPositions. Obscured
 * events use explicit eventEstimates and retain unverified timing. Empty
 * records mean unverified timing, not a failed/missing historical match. */
const observation = (videoSecond: number, note: string): VideoObservation => ({ videoSecond, videoUrl: officialVideoUrl(videoSecond), note });

const observedCalibration: Record<string, FixtureCalibration> = {
  'wrexham-sheffield-united': {
    clockAnchors: [
      { ...observation(98, 'Visual first-half kickoff anchor: players waiting with ball on centre at 96s; referee signals and Sheffield United players move at 98s; play underway at 100s. Clean feed has no broadcast clock.'), phase: 'FIRST_HALF', matchSecond: 0 },
      { ...observation(3484.35, 'Visual second-half kickoff anchor: players waiting at centre at 3483.22s; kickoff ball moving at 3484.35s. Match clock is reconstructed from this phase start.'), phase: 'SECOND_HALF', matchSecond: 2700 },
    ],
    boundaries: {
      fixtureStart: observation(0, 'Initial official-player frame showing the Wrexham fixture lineup was visually viewed.'),
      fixtureEnd: observation(6638.3, 'Fixture transition visually confirmed: Wrexham still shown at 6637.28s; Manchester City/United centre-circle scene shown at 6638.30s. Published chapter offset is 6637s; replay uses first confirmed next-fixture frame.'),
      kickoff: observation(98, 'First-half kickoff visually confirmed between waiting players at 96s and play underway at 100s; referee signal and player movement at 98s.'),
      halfTime: observation(3303.2, 'Half-time halt visually confirmed: live play at 3300s; referee stops play and players walk away at 3303.20s.'),
      secondHalf: observation(3484.35, 'Second-half kickoff visually confirmed: players waiting at centre at 3483.22s; ball moving at 3484.35s.'),
      fullTime: observation(6604.24, 'Final whistle visually confirmed: live play at 6600s; referee has whistle at mouth and play halts at 6604.24s.'),
    },
    eventPositions: {
      'wrexham-sheffield-united-goal-1': observation(163, 'Oli McBurnie opening header visually confirmed. At 161s the corner/header is before the ball crosses; at 163s the ball is in and Sheffield United celebrate. Confirmation interval 161–163s; timestamp records visible confirmation, not an inferred match clock.'),
      'wrexham-sheffield-united-goal-2': observation(3728, 'James Jones equaliser visually confirmed. At 3725s the goalmouth scramble is unresolved; at 3728s the ball is in the net and arms rise. Confirmation interval 3725–3728s.'),
      'wrexham-sheffield-united-goal-3': observation(4420, 'Tom O’Connor goal visually confirmed. At 4410s the corner has not produced a goal; at 4420s the ball is in the net and Wrexham players raise their arms. Confirmation interval 4410–4420s.'),
      'wrexham-sheffield-united-goal-4': observation(4648.32, 'Oliver Norwood equaliser visually confirmed. Shot action at 4645.33s; ball past the keeper and Sheffield United celebration at 4648.32s. Confirmation interval 4645.33–4648.32s.'),
      'wrexham-sheffield-united-red_card-1': observation(4988.36, 'Daniel Jebbison dismissal visually confirmed. Referee draws the card at 4986s; the raised red card is visible at 4988.36s. Confirmation interval 4986–4988.36s.'),
      'wrexham-sheffield-united-goal-5': observation(5888.29, 'Paul Mullin goal visually confirmed. Shot at 5887.29s; ball in the net at 5888.29s. Confirmation interval 5887.29–5888.29s.'),
      'wrexham-sheffield-united-goal-6': observation(6439.31, 'John Egan late equaliser visually confirmed. Crossed corner and keeper beaten at 6438.22s; ball in the net and Sheffield United arms raised at 6439.31s. Confirmation interval 6438.22–6439.31s.'),
    },
  },
  'man-city-man-united': {
    clockAnchors: [
      { ...observation(6642.3, 'Visual first-half kickoff anchor: stationary centre ball at 6640s; Gündoğan kicks the centre ball at 6642.30s.'), phase: 'FIRST_HALF', matchSecond: 0 },
      { ...observation(6800.42, 'Broadcast clock directly read as 02:38.'), phase: 'FIRST_HALF', matchSecond: 158 },
      { ...observation(7100.35, 'Broadcast clock directly read as 07:38.'), phase: 'FIRST_HALF', matchSecond: 458 },
      { ...observation(9814.21, 'Visual second-half kickoff: centre tap with ball moving at 9814.21s; play underway at 9815.35s.'), phase: 'SECOND_HALF', matchSecond: 2700 },
      { ...observation(11305.22, 'Broadcast clock directly read as 69:50.'), phase: 'SECOND_HALF', matchSecond: 4190 },
    ],
    boundaries: {
      fixtureStart: observation(6638.3, 'Fixture transition visually confirmed: Wrexham still shown at 6637.28s; City/United players waiting at centre at 6638.30s.'),
      kickoff: observation(6642.3, 'Gündoğan kicks the centre ball at 6642.30s; ball stationary at 6640s.'),
      halfTime: observation(9590.35, 'Half-time phase confirmed at broadcast clock 49:08: players walking off while referee still talks to a group. Earlier 9580.35s shows referee holding the ball, but the whistle instant is not visible. This confirmation point can lag the actual whistle by seconds.'),
      secondHalf: observation(9814.21, 'Second-half kickoff visually confirmed: centre tap and ball moving at 9814.21s; play underway at 9815.35s.'),
      fullTime: observation(12811.19, 'Full-time halt visually confirmed at broadcast clock 94:56: referee walking, ball stopped and City crowd cheering; 12808.41s shows active play at 94:53.'),
      fixtureEnd: observation(14275.35, 'End transition visually checked: City trophy scene at 14240s; Brighton/Liverpool players waiting at centre at 14275.35s.'),
    },
    eventPositions: {
      'man-city-man-united-goal-1': observation(6656.38, 'İlkay Gündoğan opening goal visually confirmed by ball in net and raised arms at broadcast clock 00:14. Timestamp records visible confirmation, rather than the official fastest-goal timing of the earlier strike.'),
      'man-city-man-united-goal-2': observation(8620.24, 'Bruno Fernandes penalty visually confirmed: run-up at 8618.38s; ball travelling at 8619.27s; ball in net and Bruno celebrating at 8620.24s. Confirmation interval 8619.27–8620.24s.'),
      'man-city-man-united-goal-3': observation(10160.32, 'İlkay Gündoğan winning goal visually confirmed at broadcast clock 50:45: ball arriving and keeper diving at 10159.38s; ball in net and arms raised at 10160.32s; celebration at 10165s. Confirmation interval 10159.38–10160.32s.'),
    },
  },
  'brighton-liverpool': {
    clockAnchors: [
      { ...observation(14287.43, 'Broadcast clock 00:00 and visible centre kick/player movement.'), phase: 'FIRST_HALF', matchSecond: 0 },
      { ...observation(16040.18, 'Broadcast clock directly read as 29:13.'), phase: 'FIRST_HALF', matchSecond: 1753 },
      { ...observation(17000.39, 'Broadcast clock directly read as 45:13.'), phase: 'FIRST_HALF', matchSecond: 2713 },
      { ...observation(17137.24, 'Broadcast clock 45:00 and visible second-half centre kick.'), phase: 'SECOND_HALF', matchSecond: 2700 },
      { ...observation(17500.38, 'Broadcast clock directly read as 51:03.'), phase: 'SECOND_HALF', matchSecond: 3063 },
      { ...observation(20254.34, 'Broadcast clock directly read as 96:57 while play is active.'), phase: 'SECOND_HALF', matchSecond: 5817 },
    ],
    boundaries: {
      fixtureStart: observation(14275.35, 'Brighton/Liverpool players waiting at centre are visible at the checked fixture transition.'),
      kickoff: observation(14287.43, 'First-half kickoff visually confirmed by centre kick/player movement and broadcast clock 00:00.'),
      halfTime: observation(17108.43, 'Half-time phase confirmed by Elliott walking and removed score overlay. At 17105.22s play is still active at 46:58; at 17107.27s the wide view has the keeper holding the ball/referee walking. Close-up obscures the precise whistle, so this is a phase-confirmation point.'),
      secondHalf: observation(17137.24, 'Second-half kickoff visually confirmed by centre kick and broadcast clock 45:00.'),
      fullTime: observation(20257.28, 'Full-time phase confirmed by stopped referee/players and removed score overlay; active play at 20254.34s has broadcast clock 96:57. Precise whistle can precede this visible phase confirmation by seconds.'),
      fixtureEnd: observation(20306.38, 'Checked fixture transition: official Community Shield aerial scene is shown at 20306.38s.'),
    },
    eventPositions: {
      'brighton-liverpool-goal-1': observation(16081.38, 'Harvey Elliott goal visually confirmed: shot/keeper diving at 16079.18s (clock 29:52); ball in the left net, referee goal gesture and Liverpool arms raised at 16081.38s (29:54). Confirmation interval 16079.18–16081.38s.'),
      'brighton-liverpool-goal-2': observation(16622.41, 'Lewis Dunk deflected goal visually confirmed: ball outside the box at 16619.19s (clock 38:52); ball in the right net and keeper down after deflection at 16622.41s (38:55). Confirmation interval 16619.19–16622.41s.'),
      'brighton-liverpool-goal-3': observation(19929.28, 'Kaoru Mitoma winning goal visually confirmed: controlling/lifting the ball near goal at 19927.36s (clock 91:30); ball in the net and Brighton arms raised at 19929.28s (91:32). Confirmation interval 19927.36–19929.28s.'),
    },
  },
  'arsenal-man-city-shield': {
    clockAnchors: [
      { ...observation(20409.4, 'Visual first-half kickoff anchor: players waiting at 20408.38s; Havertz taps the centre ball at 20409.40s. Clean feed has no broadcast clock.'), phase: 'FIRST_HALF', matchSecond: 0 },
      { ...observation(23383.31, 'Visual second-half kickoff anchor: waiting at 23382.35s; Rodri taps the ball at 23383.31s; ball rolling in wide view at 23384.23s. Match clock is reconstructed from this phase start.'), phase: 'SECOND_HALF', matchSecond: 2700 },
    ],
    boundaries: {
      fixtureStart: observation(20306.38, 'Community Shield official aerial scene visually checked at the fixture cut.'),
      kickoff: observation(20409.4, 'First-half kickoff visually checked: Havertz centre-ball tap at 20409.40s follows waiting players at 20408.38s.'),
      halfTime: observation(23300.42, 'Half-time phase confirmed in wide view with all players walking towards the tunnel; FA transition shown at 23378.44s. Confirmation may lag the unseen whistle.'),
      secondHalf: observation(23383.31, 'Second-half kickoff visually checked: Rodri centre-ball tap at 23383.31s, between waiting players at 23382.35s and rolling ball at 23384.23s.'),
      fullTime: observation(26847.34, 'Regulation final whistle visually checked: referee has whistle at mouth and centre-circle play halts at 26847.34s; active play at 26840.24s.'),
      penaltiesStart: observation(26910.24, 'Shootout phase visually confirmed by Ødegaard setting up the first penalty kick.'),
      penaltiesEnd: observation(27205.31, 'Shootout finish visually confirmed by Vieira’s fourth and winning Arsenal penalty: ball in upper-right net at 27204.38s; goal/celebration at 27205.31s. The sourced 4–1 result becomes reached at this confirmation point, before the later trophy/post-match footage.'),
      fixtureEnd: observation(28552.19, 'Checked next-fixture cut at 28552.19s starts Manchester United–Fulham.'),
    },
    eventPositions: {
      'arsenal-man-city-shield-goal-1': observation(25260.27, 'Cole Palmer goal visually confirmed in the original play: ball travelling at 25259.36s; ball in net and arms raised at 25260.27s. Confirmation interval 25259.36–25260.27s; later replays are not used as the event position.'),
      'arsenal-man-city-shield-goal-2': observation(26703.3, 'Leandro Trossard equaliser visually confirmed in the original play: low goal-line view at 26702.38s; ball in net and arms raised at 26703.30s. Confirmation interval 26702.38–26703.30s; later celebration/replay frames are not used as the event position.'),
    },
  },
  'man-united-fulham': {
    clockAnchors: [
      { ...observation(28622.22, 'Broadcast clock 00:00 and visible first-half ball movement; players waiting at 28620.29s.'), phase: 'FIRST_HALF', matchSecond: 0 },
      { ...observation(31440.37, 'Broadcast clock directly read as 46:58.'), phase: 'FIRST_HALF', matchSecond: 2818 },
      { ...observation(31534.38, 'Broadcast clock 45:00 and visible second-half kickoff movement; manager close-up at 31533.19s.'), phase: 'SECOND_HALF', matchSecond: 2700 },
      { ...observation(32000.13, 'Broadcast clock directly read as 52:46.'), phase: 'SECOND_HALF', matchSecond: 3166 },
      { ...observation(34650.4, 'Broadcast clock directly read as 96:56.'), phase: 'SECOND_HALF', matchSecond: 5816 },
    ],
    boundaries: {
      fixtureStart: observation(28552.19, 'Checked fixture cut starts Manchester United–Fulham.'),
      kickoff: observation(28622.22, 'First-half kickoff confirmed by rolling ball and clock 00:00; waiting players at 28620.29s.'),
      halfTime: observation(31446.34, 'Half-time phase confirmed by vanished overlay and halted/walking players. At 31445.34s play is still at a throw with clock 47:03; this is the first inspected stopped-phase confirmation, not a claim of the exact whistle.'),
      secondHalf: observation(31534.38, 'Second-half kickoff confirmed by moving players/ball and clock 45:00.'),
      fullTime: observation(34654.44, 'Full-time phase confirmed by removed overlay and all players stopped/walking; 34653.20s still shows play. Confirmation may follow the exact whistle by seconds.'),
      fixtureEnd: observation(34665.22, 'Checked fixture transition starts Manchester City–Arsenal.'),
    },
    eventPositions: {
      'man-united-fulham-goal-1': observation(31819.37, 'Aleksandar Mitrović goal visually confirmed at clock 49:45 by ball in net and Fulham arms raised; De Gea is on the floor at 31818.44s. Confirmation interval 31818.44–31819.37s.'),
      'man-united-fulham-goal-2': observation(33323.42, 'Bruno Fernandes penalty visually confirmed: travelling ball at 33322.40s; ball in net, referee goal gesture and 1–1 score at 33323.42s (clock 74:49). Confirmation interval 33322.40–33323.42s.'),
      'man-united-fulham-goal-3': observation(33413.31, 'Marcel Sabitzer goal visually confirmed: shot at 33412.22s; ball in net and 2–1 score at 33413.31s (clock 76:19). Confirmation interval 33412.22–33413.31s.'),
      'man-united-fulham-goal-4': observation(34567.43, 'Bruno Fernandes late goal visually confirmed: travelling ball at 34566.24s; ball in net, referee goal gesture and 3–1 score at 34567.43s (clock 95:33). Confirmation interval 34566.24–34567.43s.'),
      'man-united-fulham-red_card-2': observation(33151.42, 'Aleksandar Mitrović dismissal directly confirmed: contact with referee and no card at 33150.40s; red card in referee’s hand while pointing No. 9 off at 33151.42s, repeated at 33152–33153s. Confirmation interval 33150.40–33151.42s.'),
    },
    eventEstimates: {
      'man-united-fulham-red_card-1': observation(33151.42, 'Willian’s card itself is not visibly confirmed: camera cuts to his reaction at 33138.99s after the VAR gesture. Official report/referee chronology puts his dismissal before Mitrović’s. Use the later, directly confirmed Mitrović dismissal as a conservative marker for both cards, while retaining estimated timing for Willian.'),
    },
  },
  'man-city-arsenal-cup': {
    clockAnchors: [
      { ...observation(34718.45, 'Smith Rowe centre-ball tap and broadcast clock 00:00 directly observed.'), phase: 'FIRST_HALF', matchSecond: 0 },
      { ...observation(34720.26, 'Broadcast clock directly read as 00:02.'), phase: 'FIRST_HALF', matchSecond: 2 },
      { ...observation(37763.43, 'Second-half centre-ball tap and clock 45:00 directly observed; waiting players at 37762.30s.'), phase: 'SECOND_HALF', matchSecond: 2700 },
      { ...observation(37800.32, 'Broadcast clock directly read as 45:37.'), phase: 'SECOND_HALF', matchSecond: 2737 },
      { ...observation(40760.29, 'Broadcast clock directly read as 94:57 during active play.'), phase: 'SECOND_HALF', matchSecond: 5697 },
    ],
    boundaries: {
      fixtureStart: observation(34665.22, 'Manchester City–Arsenal fixture transition visually checked.'),
      kickoff: observation(34718.45, 'First-half kickoff directly checked: Smith Rowe taps the centre ball at clock 00:00.'),
      halfTime: observation(37685.36, 'Half-time phase confirmed by Haaland walking and removed overlay. At 37680.23s players, ball and referee have ceased in wide view. First-half clock blanks at 45 minutes during stoppage, so no added-time clock value is invented. This confirmation can lag the whistle.'),
      secondHalf: observation(37763.43, 'Second-half kickoff directly checked at clock 45:00, after waiting players at 37762.30s.'),
      fullTime: observation(40761.42, 'Full-time halt directly checked: referee arm raised and players stopped at clock 94:58; live play at 40760.29s.'),
      fixtureEnd: observation(40798.25, 'Fixture cut visually checked: Manchester City post-match scene at 40797.40s; Grimsby introduction with blue-shirted players at 40798.25s.'),
    },
    eventPositions: {
      'man-city-arsenal-cup-goal-1': observation(38889.27, 'Nathan Aké goal directly checked: shooting at 38887.25s; ball at goal-line at 38888.23s; ball in net and raised arms at 38889.27s (clock 63:46). Confirmation interval 38888.23–38889.27s.'),
    },
  },
  'southampton-grimsby': {
    clockAnchors: [
      { ...observation(40858.42, 'Visual first-half kickoff anchor: blue-shirted player taps a moving centre ball at 40858.42s; stationary at 40857.35s. Clean feed has no broadcast clock.'), phase: 'FIRST_HALF', matchSecond: 0 },
      { ...observation(44004.23, 'Visual second-half kickoff anchor: white-shirted player taps the moving centre ball at 44004.23s; waiting at 44003.40s. Match clock is reconstructed from this phase start.'), phase: 'SECOND_HALF', matchSecond: 2700 },
    ],
    boundaries: {
      fixtureStart: observation(40798.25, 'Checked fixture cut shows the Grimsby introduction after the Manchester City post-match scene.'),
      kickoff: observation(40858.42, 'First-half centre-ball tap and movement directly checked at 40858.42s; stationary ball at 40857.35s.'),
      halfTime: observation(43898.32, 'Half-time halt directly checked in wide view: referee hand/whistle and players ceasing/walking at 43898.32s; last live play at 43897.38s. Holohan close-up at 43899s and tunnel at 43930s confirm the phase.'),
      secondHalf: observation(44004.23, 'Second-half centre-ball tap and movement directly checked at 44004.23s; players waiting at 44003.40s.'),
      fullTime: observation(47074.19, 'Full-time halt confirmed in wide view: all players halt, blue arms rise and keeper claps after the last action/ball out at 47073.28s. Players walking at 47075s and crowd at 47080s confirm the phase; exact whistle may precede the confirmation.'),
      fixtureEnd: observation(47260.23, 'Fixture transition directly checked: Grimsby night-time hugs at 47259.27s; Sheffield United/Blackburn daytime manager introduction at 47260.23s. Actual cut precedes the published 47264s chapter.'),
    },
    eventPositions: {
      'southampton-grimsby-goal-1': observation(43586.28, 'Gavan Holohan first penalty directly checked: travelling ball at 43585s; ball in net at 43586.28s. Confirmation interval 43585–43586.28s.'),
      'southampton-grimsby-goal-2': observation(44295.31, 'Gavan Holohan second penalty directly checked: penalty shot at 44294.42s; ball in net and Grimsby arms raised at 44295.31s. Confirmation interval 44294.42–44295.31s.'),
      'southampton-grimsby-goal-3': observation(45192.3, 'Duje Ćaleta-Car goal directly checked: ball at goal-line at 45191.35s; ball in net and scorer’s arms raised at 45192.30s. Confirmation interval 45191.35–45192.30s.'),
    },
  },
  'sheffield-united-blackburn': {
    clockAnchors: [
      { ...observation(47322.43, 'Visual first-half kickoff anchor: Szmodics taps the centre ball in close view at 47322.43s; stationary at 47321s. Clean feed has no broadcast clock.'), phase: 'FIRST_HALF', matchSecond: 0 },
      { ...observation(50367.19, 'Visual second-half kickoff anchor: Doyle taps the moving centre ball at 50367.19s; waiting at 50366.40s. Match clock is reconstructed from this phase start.'), phase: 'SECOND_HALF', matchSecond: 2700 },
    ],
    boundaries: {
      fixtureStart: observation(47260.23, 'Checked Sheffield United/Blackburn daytime introduction after Grimsby’s night-time post-match scene.'),
      kickoff: observation(47322.43, 'First-half kickoff directly checked: Szmodics centre-ball tap at 47322.43s; stationary ball at 47321s.'),
      halfTime: observation(50210.31, 'Half-time phase confirmed in wide view with all players walking/stopped and referee hand at mouth. Last live play at 50208.25s and referee gesture/transition at 50209.29s. Use the 50210.31s phase confirmation rather than claim the precise whistle.'),
      secondHalf: observation(50367.19, 'Second-half kickoff directly checked: Doyle centre-ball tap and movement at 50367.19s; waiting at 50366.40s.'),
      fullTime: observation(53528.21, 'Full-time phase confirmed in wide view by players halted/walking and referee hands at mouth. Last active play at 53525s, raised arms at 53526–53527s; phase confirmation is 53528.21s.'),
      fixtureEnd: observation(53701.23, 'Next-fixture introduction directly checked: Sheffield United/Doyle post-match at 53699.35–53700.20s; Stevenage captain Carl Piergianni introduction at 53701.23s.'),
    },
    eventPositions: {
      'sheffield-united-blackburn-goal-1': observation(48582.26, 'Ben Brereton Díaz penalty directly checked: shot at 48581.18s; ball in net and keeper on floor at 48582.26s. Confirmation interval 48581.18–48582.26s.'),
      'sheffield-united-blackburn-goal-2': observation(48960.38, 'Sheffield United equaliser, credited by official reporting as Sam Gallagher’s own goal, directly checked: shot at 48958.37s; blurred goal-line view at 48959.23s; ball in net and Sheffield United arms raised at 48960.38s. Confirmation interval 48959.23–48960.38s.'),
      'sheffield-united-blackburn-goal-3': observation(51250.23, 'Sammie Szmodics goal directly checked: approach at 51248.30s; ball in net, keeper on floor and Sheffield United offside appeals at 51250.23s. Confirmation interval 51248.30–51250.23s; goal stands in the official result.'),
      'sheffield-united-blackburn-goal-4': observation(52498.29, 'Oli McBurnie equaliser directly checked: shot at 52497.21s; ball in net and keeper diving at 52498.29s. Confirmation interval 52497.21–52498.29s.'),
      'sheffield-united-blackburn-goal-5': observation(53080.32, 'Tommy Doyle winning goal directly checked: shot at 53077.36s; ball in flight at 53078.21s; ball in net and Sheffield United celebration at 53080.32s. Confirmation interval 53078.21–53080.32s.'),
    },
  },
};

export const calibrationLedger: Record<string, FixtureCalibration> = Object.fromEntries(seeds.map(seed => [seed.id, observedCalibration[seed.id] ?? { clockAnchors: [], boundaries: {}, eventPositions: {} }]));

// One visually checked cut is both the prior fixture's end and the next
// fixture's start. Share only observed evidence, never a published chapter.
for (let index = 1; index < seeds.length; index++) {
  const previous = calibrationLedger[seeds[index - 1].id];
  const next = calibrationLedger[seeds[index].id];
  const previousEnd = previous.boundaries.fixtureEnd;
  const nextStart = next.boundaries.fixtureStart;
  if (previousEnd && !nextStart) next.boundaries.fixtureStart = { ...previousEnd, note: `Shared visually observed fixture cut with ${seeds[index - 1].home}–${seeds[index - 1].away}. ${previousEnd.note}` };
  if (nextStart && !previousEnd) previous.boundaries.fixtureEnd = { ...nextStart, note: `Shared visually observed fixture cut with ${seeds[index].home}–${seeds[index].away}. ${nextStart.note}` };
}

calibrationLedger['wrexham-sheffield-united'].reportNotes = ["O’Connor is 61′ in structured match records; the independent Wrexham archive lists 62′. The clean feed has no broadcast clock; the goal’s video position is independently confirmed. Published compilation description’s 2–2 is incorrect: the match finished 3–3."];
calibrationLedger['man-city-man-united'].reportNotes = ['Half-time boundary is a confirmed phase observation at clock 49:08 and may lag the unseen whistle by seconds. Opening-goal confirmation at 00:14 is separate from the official 12-second goal record.'];
calibrationLedger['brighton-liverpool'].reportNotes = ['Half-time and full-time boundaries record the first visually confirmed stopped-play/phase frames inspected; close-ups and removed overlays obscure the precise whistle instants.'];
calibrationLedger['arsenal-man-city-shield'].reportNotes = ['FA report records Trossard 90+11′; Arsenal fixture metadata says 90+9′. FA report takes precedence. Clean feed has no broadcast clock; observed kickoffs anchor a reconstructed clock. Half-time is a confirmed phase observation that may lag the whistle. Community Shield shootout score is stored separately from the 1–1 regulation result and released only after the observed winning penalty.'];
calibrationLedger['man-united-fulham'].reportNotes = ['Willian’s raised card is obscured by a camera cut; his timing remains estimated at a conservative marker, despite the report-verified dismissal. Mitrović’s No. 9 red card is directly observed. Official referee evidence confirms Willian precedes Mitrović at 72′: https://www.thefa.com/-/media/files/thefaportal/governance-docs/discipline-cases/2023/the-fa-v-fulham-fc-marco-da-silva-and-aleksandar-mitrovic-6-april-2023.ashx. Manager Marco Silva’s dismissal does not reduce the on-field player count. Phase-boundary confirmations can lag unseen whistles by seconds.'];
calibrationLedger['man-city-arsenal-cup'].reportNotes = ['Half-time is a confirmed stopped-phase observation that can lag the whistle; the broadcast blanks its first-half clock at 45 minutes, so first-half stoppage time is reconstructed rather than directly read.'];
calibrationLedger['southampton-grimsby'].reportNotes = ['Clean feed has no broadcast clock; observed phase kickoffs anchor a reconstructed match clock. Full-time records the inspected halted-play confirmation, which can follow the precise whistle.'];
calibrationLedger['sheffield-united-blackburn'].reportNotes = ['Clean feed has no broadcast clock; phase kickoffs anchor a reconstructed match clock. Half-time and full-time are inspected stopped-phase confirmations rather than claims of precise whistle instants. Gallagher’s own goal counts for Sheffield United.'];
calibrationLedger['man-city-chelsea'].reportNotes = ['Mahrez’s last penalty is listed as 85′ in structured records; City report prose says 84 minutes. Report minute and visually observed compilation position are separate evidence.'];

/** Consume these in the replay clock: anchor + elapsed video seconds within
 * the same phase. A clock anchor does not verify nearby event instants. */
export const clockAnchors: Record<string, TapeClockAnchor[]> = Object.fromEntries(Object.entries(calibrationLedger).map(([id, calibration]) => [id, calibration.clockAnchors]));

/** Separate official-video timestamp evidence for periods and events; report
 * sourceUrl values remain on fixtures/events. */
export const videoEvidence = Object.fromEntries(Object.entries(calibrationLedger).map(([id, calibration]) => [id, { boundaries: calibration.boundaries, eventPositions: calibration.eventPositions, eventEstimates: calibration.eventEstimates ?? {}, clockAnchors: calibration.clockAnchors }]));

/** Preserve published chapter provenance when visually checked cuts shift the
 * actual replay selection boundary by a fraction of a second. */
export const publishedChapters = Object.fromEntries(seeds.map(seed => [seed.id, { start: seed.start, end: seed.end }]));

export const fixtures: TapeFixture[] = seeds.map(makeFixture);
