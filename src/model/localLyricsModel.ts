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

const INDEX_STORAGE_KEY = 'local_lyrics_index_v1';
const RECORD_STORAGE_PREFIX = 'local_lyrics_v1:';
const SECTION_LABEL_PATTERN = /^\s*[\[【(（]\s*(?:verse|pre[- ]?chorus|chorus|bridge|intro|outro|hook|refrain|instrumental|interlude|主歌|副歌|導歌|导歌|橋段|桥段|前奏|尾奏|間奏|间奏)(?:\s*\d+)?\s*[\]】)）]\s*$/iu;

function recordKey(trackId: string): string {
    return `${RECORD_STORAGE_PREFIX}${trackId}`;
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
        '[by:DisplayPlus Music]',
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
    }

    async remove(trackId: string): Promise<void> {
        await storage.removeItem(recordKey(trackId));
        const ids = await this.readIndex();
        await storage.setItem(INDEX_STORAGE_KEY, JSON.stringify(ids.filter(id => id !== trackId)));
    }
}

const localLyricsStore = new LocalLyricsStore();
export default localLyricsStore;
