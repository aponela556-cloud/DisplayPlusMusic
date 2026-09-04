import Song from './songModel';
import { storage } from '../utils/storage';

export type LocalLyricsStatus = 'draft' | 'complete';

export interface LocalLyricsRecord {
    schemaVersion: 1;
    spotifyTrackId: string;
    title: string;
    artist: string;
    album: string;
    durationMs: number;
    plainLyrics: string;
    lineTimestampsMs: number[];
    syncedLyrics: string;
    currentLineIndex: number;
    status: LocalLyricsStatus;
    updatedAt: string;
}

export interface LocalLyricsSummary {
    spotifyTrackId: string;
    title: string;
    artist: string;
    album: string;
    status: LocalLyricsStatus;
    markedLines: number;
    totalLines: number;
    updatedAt: string;
}

export type LocalLyricsFilter = 'all' | LocalLyricsStatus;
export type LocalLyricsSort = 'recent' | 'title';

export interface LocalLyricsPage {
    items: LocalLyricsSummary[];
    totalItems: number;
    totalPages: number;
    page: number;
}

export interface LyricsCandidate {
    plainLyrics: string | null;
    syncedLyrics: string | null;
    source: 'local server' | 'local library' | 'web' | '';
}

export interface LyricsEditorContext {
    currentLineIndex: number;
    currentLineNumber: number;
    totalLines: number;
    previousLine: string;
    currentLine: string;
    nextLine: string;
    allMarked: boolean;
}

export type SavedLyricsFormat = 'synced' | 'plain';

/**
 * An immutable copy of lyrics downloaded from the remote lyrics provider.
 * These records are intentionally kept separate from the user's timing record
 * for the same Spotify track, so saving a source never changes playback.
 */
export interface SavedLyricsRecord {
    schemaVersion: 1;
    id: string;
    spotifyTrackId: string;
    title: string;
    artist: string;
    album: string;
    durationMs: number;
    format: SavedLyricsFormat;
    plainLyrics: string;
    syncedLyrics: string;
    source: 'web';
    savedAt: string;
}

const INDEX_STORAGE_KEY = 'local_lyrics_index_v1';
const SUMMARY_INDEX_STORAGE_KEY = 'local_lyrics_index_v2';
const RECORD_STORAGE_PREFIX = 'local_lyrics_v1:';
const SAVED_INDEX_STORAGE_KEY = 'saved_lyrics_index_v1';
const SAVED_RECORD_STORAGE_PREFIX = 'saved_lyrics_v1:';
const SECTION_LABEL_PATTERN = /^\s*[\[【(（]\s*(?:verse|pre[- ]?chorus|chorus|bridge|intro|outro|hook|refrain|instrumental|interlude|主歌|副歌|導歌|导歌|橋段|桥段|前奏|尾奏|間奏|间奏)(?:\s*\d+)?\s*[\]】)）]\s*$/iu;

function recordKey(trackId: string): string {
    return `${RECORD_STORAGE_PREFIX}${trackId}`;
}

function savedRecordKey(id: string): string {
    return `${SAVED_RECORD_STORAGE_PREFIX}${id}`;
}

function safeMetadata(value: string): string {
    return value.replace(/[\r\n]+/g, ' ').trim();
}

function isLocalLyricsRecord(value: unknown): value is LocalLyricsRecord {
    if (!value || typeof value !== 'object') return false;
    const record = value as Partial<LocalLyricsRecord>;
    return record.schemaVersion === 1 &&
        typeof record.spotifyTrackId === 'string' &&
        typeof record.title === 'string' &&
        typeof record.artist === 'string' &&
        typeof record.album === 'string' &&
        typeof record.durationMs === 'number' &&
        typeof record.plainLyrics === 'string' &&
        Array.isArray(record.lineTimestampsMs) &&
        record.lineTimestampsMs.every(timestamp => Number.isFinite(timestamp) && timestamp >= 0) &&
        typeof record.syncedLyrics === 'string' &&
        typeof record.currentLineIndex === 'number' &&
        (record.status === 'draft' || record.status === 'complete') &&
        typeof record.updatedAt === 'string';
}

function isLocalLyricsSummary(value: unknown): value is LocalLyricsSummary {
    if (!value || typeof value !== 'object') return false;
    const summary = value as Partial<LocalLyricsSummary>;
    return typeof summary.spotifyTrackId === 'string' &&
        typeof summary.title === 'string' &&
        typeof summary.artist === 'string' &&
        typeof summary.album === 'string' &&
        (summary.status === 'draft' || summary.status === 'complete') &&
        typeof summary.markedLines === 'number' &&
        typeof summary.totalLines === 'number' &&
        typeof summary.updatedAt === 'string';
}

function isSavedLyricsRecord(value: unknown): value is SavedLyricsRecord {
    if (!value || typeof value !== 'object') return false;
    const record = value as Partial<SavedLyricsRecord>;
    return record.schemaVersion === 1 &&
        typeof record.id === 'string' &&
        typeof record.spotifyTrackId === 'string' &&
        typeof record.title === 'string' &&
        typeof record.artist === 'string' &&
        typeof record.album === 'string' &&
        typeof record.durationMs === 'number' &&
        (record.format === 'synced' || record.format === 'plain') &&
        typeof record.plainLyrics === 'string' &&
        typeof record.syncedLyrics === 'string' &&
        record.source === 'web' &&
        typeof record.savedAt === 'string';
}

export function toLocalLyricsSummary(record: LocalLyricsRecord): LocalLyricsSummary {
    return {
        spotifyTrackId: record.spotifyTrackId,
        title: record.title,
        artist: record.artist,
        album: record.album,
        status: record.status,
        markedLines: record.lineTimestampsMs.length,
        totalLines: parsePlainLyrics(record.plainLyrics).length,
        updatedAt: record.updatedAt,
    };
}

function normalizedSearchText(value: string): string {
    return value.normalize('NFKD').toLocaleLowerCase().replace(/\p{M}/gu, '');
}

export function queryLocalLyricsSummaries(
    summaries: LocalLyricsSummary[],
    query: string,
    filter: LocalLyricsFilter,
    sort: LocalLyricsSort,
): LocalLyricsSummary[] {
    const normalizedQuery = normalizedSearchText(query.trim());
    return summaries
        .filter(summary => filter === 'all' || summary.status === filter)
        .filter(summary => !normalizedQuery || normalizedSearchText(`${summary.title} ${summary.artist} ${summary.album}`).includes(normalizedQuery))
        .sort((left, right) => sort === 'title'
            ? left.title.localeCompare(right.title, undefined, { sensitivity: 'base' }) || left.artist.localeCompare(right.artist, undefined, { sensitivity: 'base' })
            : right.updatedAt.localeCompare(left.updatedAt));
}

export function parsePlainLyrics(plainLyrics: string): string[] {
    return plainLyrics
        .replace(/\r/g, '')
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0 && !SECTION_LABEL_PATTERN.test(line));
}

export function getLyricsEditorContext(lines: string[], requestedIndex: number): LyricsEditorContext {
    const totalLines = lines.length;
    const currentLineIndex = Math.min(Math.max(0, Math.trunc(requestedIndex)), totalLines);
    const allMarked = totalLines > 0 && currentLineIndex >= totalLines;
    return {
        currentLineIndex,
        currentLineNumber: totalLines === 0 ? 0 : Math.min(currentLineIndex + 1, totalLines),
        totalLines,
        previousLine: currentLineIndex > 0 ? lines[currentLineIndex - 1] ?? '' : '',
        currentLine: allMarked ? '' : lines[currentLineIndex] ?? '',
        nextLine: !allMarked && currentLineIndex + 1 < totalLines ? lines[currentLineIndex + 1] : '',
        allMarked,
    };
}

export function clampTimestampMs(timestampMs: number, durationMs: number): number {
    const maximum = Math.max(0, Math.round(durationMs));
    return Math.min(maximum, Math.max(0, Math.round(timestampMs)));
}

export function formatLrcTimestamp(timestampMs: number): string {
    const centiseconds = Math.floor(Math.max(0, timestampMs) / 10);
    const minutes = Math.floor(centiseconds / 6000);
    const seconds = Math.floor((centiseconds % 6000) / 100);
    const fraction = centiseconds % 100;
    return `[${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(fraction).padStart(2, '0')}]`;
}

export function buildLrc(record: Pick<LocalLyricsRecord,
    'title' | 'artist' | 'album' | 'durationMs' | 'plainLyrics' | 'lineTimestampsMs'
>): string {
    const lines = parsePlainLyrics(record.plainLyrics);
    const durationSeconds = Math.round(record.durationMs / 1000);
    const durationText = `${String(Math.floor(durationSeconds / 60)).padStart(2, '0')}:${String(durationSeconds % 60).padStart(2, '0')}`;
    const headers = [
        `[ti:${safeMetadata(record.title)}]`,
        `[ar:${safeMetadata(record.artist)}]`,
        `[al:${safeMetadata(record.album)}]`,
        `[length:${durationText}]`,
        '[by:DisplayLyric Music]',
    ];
    const timedLines = record.lineTimestampsMs
        .slice(0, lines.length)
        .map((timestamp, index) => `${formatLrcTimestamp(timestamp)}${lines[index]}`);
    return [...headers, '', ...timedLines].join('\n');
}

export function createLocalLyricsRecord(song: Song, plainLyrics: string): LocalLyricsRecord {
    return {
        schemaVersion: 1,
        spotifyTrackId: song.songID,
        title: song.title,
        artist: song.artist,
        album: song.album,
        durationMs: Math.max(0, Math.round(song.durationSeconds * 1000)),
        plainLyrics,
        lineTimestampsMs: [],
        syncedLyrics: '',
        currentLineIndex: 0,
        status: 'draft',
        updatedAt: new Date().toISOString(),
    };
}

function contentFingerprint(value: string): string {
    // Stable, non-cryptographic fingerprint used only to avoid duplicate local saves.
    let hash = 2166136261;
    for (let index = 0; index < value.length; index++) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
}

export function createSavedLyricsRecord(song: Song, lyrics: LyricsCandidate): SavedLyricsRecord | null {
    const syncedLyrics = lyrics.syncedLyrics?.trim() ?? '';
    const plainLyrics = lyrics.plainLyrics?.trim() ?? '';
    const format: SavedLyricsFormat | null = syncedLyrics ? 'synced' : plainLyrics ? 'plain' : null;
    if (!format || song.songID === '0') return null;
    const content = syncedLyrics || plainLyrics;
    return {
        schemaVersion: 1,
        id: `${song.songID}:${format}:${contentFingerprint(content)}`,
        spotifyTrackId: song.songID,
        title: song.title,
        artist: song.artist,
        album: song.album,
        durationMs: Math.max(0, Math.round(song.durationSeconds * 1000)),
        format,
        plainLyrics,
        syncedLyrics,
        source: 'web',
        savedAt: new Date().toISOString(),
    };
}

export function cloneLocalLyricsRecord(record: LocalLyricsRecord | null): LocalLyricsRecord | null {
    return record ? { ...record, lineTimestampsMs: [...record.lineTimestampsMs] } : null;
}

export function markLocalLyricsLine(
    record: LocalLyricsRecord,
    lineCount: number,
    timestampMs: number,
): LocalLyricsRecord {
    if (record.currentLineIndex >= lineCount) return cloneLocalLyricsRecord(record)!;
    const timestamp = clampTimestampMs(timestampMs, record.durationMs);
    const previous = record.lineTimestampsMs.at(-1);
    if (previous !== undefined && timestamp <= previous) {
        throw new Error('Timestamp must be after the previous mark');
    }
    return {
        ...record,
        lineTimestampsMs: [...record.lineTimestampsMs, timestamp],
        currentLineIndex: record.currentLineIndex + 1,
        status: 'draft',
        syncedLyrics: '',
    };
}

export function undoLocalLyricsLine(record: LocalLyricsRecord): LocalLyricsRecord {
    if (record.currentLineIndex === 0) return cloneLocalLyricsRecord(record)!;
    const currentLineIndex = record.currentLineIndex - 1;
    return {
        ...record,
        lineTimestampsMs: record.lineTimestampsMs.slice(0, currentLineIndex),
        currentLineIndex,
        status: 'draft',
        syncedLyrics: '',
    };
}

export function finalizeLocalLyricsRecord(
    record: LocalLyricsRecord,
    lineCount: number,
): LocalLyricsRecord {
    const complete = lineCount > 0 && record.lineTimestampsMs.length === lineCount;
    const finalized: LocalLyricsRecord = {
        ...record,
        currentLineIndex: Math.min(record.lineTimestampsMs.length, lineCount),
        status: complete ? 'complete' : 'draft',
        syncedLyrics: '',
    };
    if (complete) finalized.syncedLyrics = buildLrc(finalized);
    return finalized;
}

export function resolveLyricsPriority(
    remoteLyrics: LyricsCandidate,
    localLyrics: LocalLyricsRecord | null,
): LyricsCandidate & { remoteSynced: boolean } {
    if (remoteLyrics.syncedLyrics) return { ...remoteLyrics, remoteSynced: true };
    if (localLyrics?.status === 'complete' && localLyrics.syncedLyrics) {
        return {
            plainLyrics: remoteLyrics.plainLyrics ?? localLyrics.plainLyrics,
            syncedLyrics: localLyrics.syncedLyrics,
            source: 'local library',
            remoteSynced: false,
        };
    }
    return { ...remoteLyrics, remoteSynced: false };
}

class LocalLyricsStore {
    private async readIndex(): Promise<string[]> {
        const raw = await storage.getItem(INDEX_STORAGE_KEY);
        if (!raw) return [];
        try {
            const parsed: unknown = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
        } catch {
            return [];
        }
    }

    private async readSummaryIndex(): Promise<LocalLyricsSummary[] | null> {
        const raw = await storage.getItem(SUMMARY_INDEX_STORAGE_KEY);
        if (!raw) return null;
        try {
            const parsed: unknown = JSON.parse(raw);
            return Array.isArray(parsed) && parsed.every(isLocalLyricsSummary) ? parsed : null;
        } catch {
            return null;
        }
    }

    private async writeSummaryIndex(summaries: LocalLyricsSummary[]): Promise<void> {
        await storage.setItem(SUMMARY_INDEX_STORAGE_KEY, JSON.stringify(summaries));
    }

    async listSummaries(): Promise<LocalLyricsSummary[]> {
        const current = await this.readSummaryIndex();
        if (current) return current;
        const ids = await this.readIndex();
        const records = await Promise.all(ids.map(id => this.get(id)));
        const summaries = records
            .filter((record): record is LocalLyricsRecord => record !== null)
            .map(toLocalLyricsSummary);
        await this.writeSummaryIndex(summaries);
        return summaries;
    }

    async getPage(
        query = '',
        filter: LocalLyricsFilter = 'all',
        sort: LocalLyricsSort = 'recent',
        requestedPage = 0,
        pageSize = 20,
    ): Promise<LocalLyricsPage> {
        const matching = queryLocalLyricsSummaries(await this.listSummaries(), query, filter, sort);
        const safePageSize = Math.max(1, Math.trunc(pageSize));
        const totalPages = Math.max(1, Math.ceil(matching.length / safePageSize));
        const page = Math.min(Math.max(0, Math.trunc(requestedPage)), totalPages - 1);
        return {
            items: matching.slice(page * safePageSize, (page + 1) * safePageSize),
            totalItems: matching.length,
            totalPages,
            page,
        };
    }

    async get(trackId: string): Promise<LocalLyricsRecord | null> {
        if (!trackId || trackId === '0') return null;
        const raw = await storage.getItem(recordKey(trackId));
        if (!raw) return null;
        try {
            const parsed: unknown = JSON.parse(raw);
            return isLocalLyricsRecord(parsed) ? parsed : null;
        } catch {
            return null;
        }
    }

    async list(): Promise<LocalLyricsRecord[]> {
        const ids = await this.readIndex();
        const records = await Promise.all(ids.map(id => this.get(id)));
        return records
            .filter((record): record is LocalLyricsRecord => record !== null)
            .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    }

    async save(record: LocalLyricsRecord): Promise<void> {
        const normalized: LocalLyricsRecord = {
            ...record,
            lineTimestampsMs: record.lineTimestampsMs.map(timestamp => clampTimestampMs(timestamp, record.durationMs)),
            updatedAt: new Date().toISOString(),
        };
        await storage.setItem(recordKey(record.spotifyTrackId), JSON.stringify(normalized));
        const ids = await this.readIndex();
        const nextIds = [record.spotifyTrackId, ...ids.filter(id => id !== record.spotifyTrackId)];
        await storage.setItem(INDEX_STORAGE_KEY, JSON.stringify(nextIds));
        const summaries = await this.listSummaries();
        const summary = toLocalLyricsSummary(normalized);
        await this.writeSummaryIndex([summary, ...summaries.filter(item => item.spotifyTrackId !== summary.spotifyTrackId)]);
    }

    async remove(trackId: string): Promise<void> {
        await storage.removeItem(recordKey(trackId));
        const ids = await this.readIndex();
        await storage.setItem(INDEX_STORAGE_KEY, JSON.stringify(ids.filter(id => id !== trackId)));
        const summaries = await this.listSummaries();
        await this.writeSummaryIndex(summaries.filter(item => item.spotifyTrackId !== trackId));
    }
}

const localLyricsStore = new LocalLyricsStore();
export default localLyricsStore;

class SavedLyricsStore {
    private async readIndex(): Promise<string[]> {
        const raw = await storage.getItem(SAVED_INDEX_STORAGE_KEY);
        if (!raw) return [];
        try {
            const parsed: unknown = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
        } catch {
            return [];
        }
    }

    async get(id: string): Promise<SavedLyricsRecord | null> {
        if (!id) return null;
        const raw = await storage.getItem(savedRecordKey(id));
        if (!raw) return null;
        try {
            const parsed: unknown = JSON.parse(raw);
            return isSavedLyricsRecord(parsed) ? parsed : null;
        } catch {
            return null;
        }
    }

    async list(): Promise<SavedLyricsRecord[]> {
        const ids = await this.readIndex();
        const records = await Promise.all(ids.map(id => this.get(id)));
        return records
            .filter((record): record is SavedLyricsRecord => record !== null)
            .sort((left, right) => right.savedAt.localeCompare(left.savedAt));
    }

    /** Returns true only when a new remote copy was saved. */
    async save(record: SavedLyricsRecord): Promise<boolean> {
        if (await this.get(record.id)) return false;
        await storage.setItem(savedRecordKey(record.id), JSON.stringify(record));
        const ids = await this.readIndex();
        await storage.setItem(SAVED_INDEX_STORAGE_KEY, JSON.stringify([record.id, ...ids.filter(id => id !== record.id)]));
        return true;
    }

    async remove(id: string): Promise<void> {
        await storage.removeItem(savedRecordKey(id));
        const ids = await this.readIndex();
        await storage.setItem(SAVED_INDEX_STORAGE_KEY, JSON.stringify(ids.filter(candidate => candidate !== id)));
    }
}

export const savedLyricsStore = new SavedLyricsStore();
