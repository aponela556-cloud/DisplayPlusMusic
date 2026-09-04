import Song from './songModel';
import {
    createLocalLyricsRecord,
    finalizeLocalLyricsRecord,
    LocalLyricsRecord,
    parsePlainLyrics,
} from './localLyricsModel';

export type ImportedLrcMetadata = {
    title?: string;
    artist?: string;
    album?: string;
    lengthMs?: number;
};

export type ParsedLrcImport = {
    metadata: ImportedLrcMetadata;
    plainLyrics: string;
    timestampsMs: number[];
    hasTimestamps: boolean;
};

const METADATA_TAG_PATTERN = /^\[(ti|ar|al|length|by|offset):\s*(.*?)\s*\]$/iu;
const TIMESTAMP_PATTERN = /\[(\d+):(\d{2}(?:\.\d{1,3})?)\]/gu;

function normalizeInput(value: string): string {
    return value.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
}

function parseLength(value: string): number | undefined {
    const match = value.trim().match(/^(\d+):(\d{2})(?:\.(\d{1,3}))?$/u);
    if (!match) return undefined;
    const seconds = Number(match[2]);
    if (seconds >= 60) return undefined;
    const fraction = (match[3] ?? '').padEnd(3, '0');
    return (Number(match[1]) * 60_000) + (seconds * 1_000) + Number(fraction || 0);
}

function timestampToMs(minutes: string, seconds: string): number | null {
    const parsedSeconds = Number(seconds);
    if (!Number.isFinite(parsedSeconds) || parsedSeconds >= 60) return null;
    return (Number(minutes) * 60_000) + Math.round(parsedSeconds * 1_000);
}

function metadataValue(metadata: ImportedLrcMetadata, key: string, value: string): void {
    switch (key.toLocaleLowerCase()) {
        case 'ti': metadata.title = value; break;
        case 'ar': metadata.artist = value; break;
        case 'al': metadata.album = value; break;
        case 'length': metadata.lengthMs = parseLength(value); break;
    }
}

export function parseLrcImport(raw: string): ParsedLrcImport {
    const input = normalizeInput(raw);
    if (!input) throw new Error('Paste lyrics or select an LRC file first');

    const metadata: ImportedLrcMetadata = {};
    const timedLines: Array<{ text: string; timestampMs: number }> = [];
    const plainLines: string[] = [];
    let foundTimestamp = false;

    for (const rawLine of input.split('\n')) {
        const line = rawLine.trim();
        if (!line) continue;
        const metadataMatch = line.match(METADATA_TAG_PATTERN);
        if (metadataMatch) {
            metadataValue(metadata, metadataMatch[1], metadataMatch[2]);
            continue;
        }

        const timestamps = [...line.matchAll(TIMESTAMP_PATTERN)];
        if (timestamps.length === 0) {
            plainLines.push(line);
            continue;
        }

        foundTimestamp = true;
        const text = line.replace(TIMESTAMP_PATTERN, '').trim();
        if (!text) continue;
        for (const timestamp of timestamps) {
            const timestampMs = timestampToMs(timestamp[1], timestamp[2]);
            if (timestampMs === null) throw new Error(`Invalid timestamp: ${timestamp[0]}`);
            timedLines.push({ text, timestampMs });
        }
    }

    if (foundTimestamp && plainLines.length > 0) {
        throw new Error('Timed LRC cannot contain untimed lyric lines');
    }

    if (!foundTimestamp) {
        const lines = parsePlainLyrics(plainLines.join('\n'));
        if (lines.length === 0) throw new Error('No usable lyric lines found');
        return { metadata, plainLyrics: lines.join('\n'), timestampsMs: [], hasTimestamps: false };
    }

    const usableTimedLines = timedLines.flatMap(line => (
        parsePlainLyrics(line.text).map(text => ({ ...line, text }))
    ));
    if (usableTimedLines.length === 0) throw new Error('No usable timed lyric lines found');

    let previous = -1;
    for (const line of usableTimedLines) {
        if (line.timestampMs <= previous) {
            throw new Error('LRC timestamps must be in ascending order');
        }
        previous = line.timestampMs;
    }

    return {
        metadata,
        plainLyrics: usableTimedLines.map(line => line.text).join('\n'),
        timestampsMs: usableTimedLines.map(line => line.timestampMs),
        hasTimestamps: true,
    };
}

function normalizedMetadata(value: string): string {
    return value
        .normalize('NFKD')
        .toLocaleLowerCase()
        .replace(/\p{M}/gu, '')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim()
        .replace(/\s+/g, ' ');
}

export function getLrcMetadataWarnings(imported: ParsedLrcImport, song: Song): string[] {
    const warnings: string[] = [];
    const compare = (label: string, importedValue: string | undefined, songValue: string) => {
        if (importedValue && normalizedMetadata(importedValue) !== normalizedMetadata(songValue)) {
            warnings.push(`${label}: LRC “${importedValue}” ≠ Spotify “${songValue}”`);
        }
    };
    compare('Title', imported.metadata.title, song.title);
    compare('Artist', imported.metadata.artist, song.artist);
    compare('Album', imported.metadata.album, song.album);
    if (
        imported.metadata.lengthMs !== undefined &&
        Math.abs(imported.metadata.lengthMs - Math.round(song.durationSeconds * 1_000)) > 2_000
    ) {
        warnings.push('Length: LRC and Spotify differ by more than 2 seconds');
    }
    return warnings;
}

export function createRecordFromLrcImport(song: Song, imported: ParsedLrcImport): LocalLyricsRecord {
    const record = createLocalLyricsRecord(song, imported.plainLyrics);
    if (!imported.hasTimestamps) return record;
    const durationMs = Math.round(song.durationSeconds * 1_000);
    if (imported.timestampsMs.some(timestamp => timestamp > durationMs)) {
        throw new Error('An LRC timestamp is beyond the current Spotify song duration');
    }
    record.lineTimestampsMs = [...imported.timestampsMs];
    record.currentLineIndex = imported.timestampsMs.length;
    return finalizeLocalLyricsRecord(record, parsePlainLyrics(record.plainLyrics).length);
}
