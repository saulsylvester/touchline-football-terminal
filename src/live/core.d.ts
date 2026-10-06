import type { CommandResult, LiveFeed, LiveQuote, LiveSnapshot, LiveSource } from '../types';
export const LIVE_FIXTURE: Readonly<{id:string;home:string;away:string;date:string;competition:string}>;
export const REFRESH_MS: number;
export const TRUSTED_DOMAINS: string[];
export const PUBLIC_SKY: Readonly<{id:number;statsUrl:string;dataUrl:string}>;
export const EXTRACTION_SCHEMA: Record<string, unknown>;
export function getRetrievedSources(response: unknown): LiveSource[];
export function validateExtraction(data: unknown, sources: LiveSource[], fetchedAt: string): LiveSnapshot;
export function quoteIdentity(quote: LiveQuote): string;
export function parseObservedPrice(rawPrice:string, priceFormat:'decimal'|'fractional'):number;
export function snapshotFingerprint(snapshot: LiveSnapshot): string;
export function parsePublicSkySnapshot(fixtureData:unknown,statsHtml:string,fetchedAt:string):LiveSnapshot;
export function retrievePublicSkySnapshot(options?:{fetchImpl?:typeof fetch;now?:()=>number}):Promise<LiveSnapshot>;
export function retrieveLiveSnapshot(options?: {apiKey?:string;fetchImpl?:typeof fetch;now?:()=>number}): Promise<LiveSnapshot>;
export interface FeedStorage {read?():Promise<LiveFeed|null>;write?(feed:LiveFeed):Promise<void>;acquire?():Promise<boolean>;release?():Promise<void>}
export function createFeedService(options:{retrieve:()=>Promise<LiveSnapshot>;storage?:FeedStorage;now?:()=>number;refreshMs?:number}): {getFeed():Promise<LiveFeed>;peek():LiveFeed};
export function runLiveCommand(command:string,feed:LiveFeed):CommandResult;
