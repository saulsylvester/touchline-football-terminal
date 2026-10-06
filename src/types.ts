export type Side = 'home' | 'away';
export type Phase = 'PRE_MATCH' | 'FIRST_HALF' | 'HALF_TIME' | 'SECOND_HALF' | 'FULL_TIME' | 'PENALTIES';
export type Verification = 'video_verified' | 'report_verified_timing_estimated';
export interface TapeEvent { id:string; type:'GOAL'|'RED_CARD'|'DISALLOWED_GOAL'|'PENALTY_RESULT'; side:Side; player:string; minute:number; addedTime?:number; videoSecond:number; sourceUrl:string; verification:Verification; note?:string; }
export interface TapePeriod { phase:Phase; start:number; end:number; matchSecondStart:number; verification:Verification; }
export interface TapeFixture { id:string; home:string; away:string; competition:string; date:string; start:number; end:number; periods:TapePeriod[]; events:TapeEvent[]; rates:[number,number]; sourceUrl:string; shootoutResult?:[number,number]; calibrationNote?:string; }
export interface Quote { outcome:string; price:number|null; settled?:'WIN'|'LOSE'; }
export interface ReplayState { fixture:TapeFixture; videoSecond:number; matchSecond:number; phase:Phase; score:[number,number]; redCards:[number,number]; events:TapeEvent[]; quotes:Quote[]; verification:Verification; shootoutResult?:[number,number]; }
export interface LiveSource {id:string; name:string; url:string;}
export interface LiveQuote {outcome:string; price:number; sourceUrl:string; sourceName:string; bookmaker:string; market:string; sourceUpdatedAt:string|null; fetchedAt:string;}
export interface LiveStat {name:string; home:number|null; away:number|null; unit:string; sourceUrl:string; sourceName:string; sourceUpdatedAt:string|null; fetchedAt:string;}
export interface LiveEvent {id:string; minute:number|null; description:string; type:string; sourceUrl:string; sourceName:string; fetchedAt:string;}
export interface LiveSnapshot {id:string; fixtureId:string; home:string; away:string; score:[number,number]|null; minute:number|null; phase:string; fetchedAt:string; quotes:LiveQuote[]; stats:LiveStat[]; events:LiveEvent[]; sources:LiveSource[];}
export interface LiveFeed {snapshot:LiveSnapshot|null; history:LiveSnapshot[]; status:'ready'|'unavailable'|'stale'|'refreshing'; error:string|null; lastAttemptAt:string|null; nextRefreshAt:string|null;}
export interface CommandResult {title:string; lines:string[]; evidenceIds:string[]; comparison?:{before:number;after:number};}
