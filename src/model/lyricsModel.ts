import Song from './songModel';
import spotifyPresenter from '../presenter/spotifyPresenter';
import { storage } from '../utils/storage';
import {
    cleanArtistName,
    cleanTrackTitle,
    createChineseSearchVariants,
    LrclibRecord,
    LrclibTrackMetadata,
    selectBestLyricsMatch,
} from './lrclibMatching';

const LRCLIB_CLIENT_HEADER = 'DisplayPlusMusic/2.6.0 (https://github.com/Oliemanq/DisplayPlusMusic)';
const LRCLIB_REQUEST_INTERVAL_MS = 250;
let lrclibRequestQueue: Promise<void> = Promise.resolve();
let lastLrclibRequestFinishedAt = 0;

type NavidromeCue = {
    start?: number;
    end?: number;
    value?: string;
};

type NavidromeCueLine = {
    index?: number;
    start?: number;
    end?: number;
    value?: string;
    cue?: NavidromeCue[];
};

type NavidromeStructuredLyricLine = {
    start?: number;
    value?: string;
};

type NavidromeStructuredLyrics = {
    kind?: string;
    synced?: boolean;
    line?: NavidromeStructuredLyricLine[];
    cueLine?: NavidromeCueLine[];
};

type NavidromeLyricsResponse = {
    'subsonic-response'?: {
        lyricsList?: {
            structuredLyrics?: NavidromeStructuredLyrics[];
        };
    };
};

type NavidromeLyricsList = NonNullable<NonNullable<NavidromeLyricsResponse['subsonic-response']>['lyricsList']>;

function emptyLyrics() {
    return {
        plainLyrics: null,
        syncedLyrics: null,
        source: '' as const,
    };
}

function delay(milliseconds: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function fetchLrclib(url: URL): Promise<Response> {
    const request = lrclibRequestQueue.then(async () => {
        const elapsed = Date.now() - lastLrclibRequestFinishedAt;
        if (elapsed < LRCLIB_REQUEST_INTERVAL_MS) {
            await delay(LRCLIB_REQUEST_INTERVAL_MS - elapsed);
        }

        const response = await fetch(url.toString(), {
            headers: { 'Lrclib-Client': LRCLIB_CLIENT_HEADER },
        });
        lastLrclibRequestFinishedAt = Date.now();
        return response;
    });

    lrclibRequestQueue = request.then(() => undefined, () => undefined);
    return request;
}

async function fetchLrclibJson<T>(url: URL): Promise<T | null> {
    const response = await fetchLrclib(url);
    if (response.status === 404) return null;
    if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After');
        throw new Error(`LRCLIB rate limit reached${retryAfter ? `; retry after ${retryAfter}s` : ''}`);
    }
    if (!response.ok) {
        throw new Error(`LRCLIB request failed with status ${response.status}`);
    }
    return response.json() as Promise<T>;
}

function createExactLyricsUrl(song: Song): URL {
    const url = new URL('https://lrclib.net/api/get');
    url.searchParams.set('track_name', song.title);
    url.searchParams.set('artist_name', song.artist);
    if (song.album && song.album !== 'None') {
        url.searchParams.set('album_name', song.album);
    }
    if (song.durationSeconds > 0 && song.durationSeconds <= 3600) {
        url.searchParams.set('duration', Math.round(song.durationSeconds).toString());
    }
    return url;
}

function createLyricsSearchUrl(title: string, artist: string): URL {
    const url = new URL('https://lrclib.net/api/search');
    url.searchParams.set('track_name', title);
    url.searchParams.set('artist_name', artist);
    return url;
}

function lrclibRecordKey(record: LrclibRecord): string {
    if (typeof record.id === 'number') return `id:${record.id}`;
    return [record.trackName ?? record.name, record.artistName, record.albumName, record.duration]
        .map(value => String(value ?? '').trim().toLocaleLowerCase())
        .join('|');
}

function lyricsFromLrclibRecord(record: LrclibRecord) {
    return {
        plainLyrics: record.plainLyrics ?? null,
        syncedLyrics: record.syncedLyrics ?? null,
        source: 'web' as const,
    };
}

function buildNavidromeAuthParams(username: string, password: string): URLSearchParams {
    return new URLSearchParams({
        u: username,
        p: password,
        v: '1.16.1',
        c: 'evenhub',
        f: 'json',
    });
}

/** Formats milliseconds as an LRC timestamp tag, e.g. `[01:23.45]` or `<01:23.45>`. */
function formatLrcTimestamp(totalMilliseconds: number, brackets: '[]' | '<>'): string {
    const clamped = Math.max(0, Math.floor(totalMilliseconds));
    const minutes = Math.floor(clamped / 60000);
    const seconds = Math.floor((clamped % 60000) / 1000);
    const centiseconds = Math.floor((clamped % 1000) / 10);
    const timestamp = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(centiseconds).padStart(2, '0')}`;
    return brackets === '[]' ? `[${timestamp}]` : `<${timestamp}>`;
}

/**
 * Builds a single LRC line, embedding per-word/syllable timing tags (the "enhanced" or
 * ".elrc" convention: `[00:12.00]<00:12.00>word <00:12.50>word2`) when cue-level timing
 * is available from the source data.
 *
 * When `end` is provided, a trailing timestamp tag with no following text is appended
 * (e.g. `...<00:15.00>word2<00:15.60>`). This is the standard enhanced-LRC convention for
 * marking when the last word/syllable in the line finishes, which downstream consumers
 * use to detect instrumental gaps between word-timed lines.
 */
function buildEnhancedLrcLine(start: number, value: string, cues: NavidromeCue[] | undefined, end?: number): string {
    const lineTag = formatLrcTimestamp(start, '[]');
    if (!cues || cues.length === 0) {
        return `${lineTag}${value}`;
    }

    const wordTags = cues
        .filter(cue => typeof cue.start === 'number')
        .map(cue => `${formatLrcTimestamp(cue.start!, '<>')}${cue.value ?? ''}`)
        .join('');

    const endTag = typeof end === 'number' ? formatLrcTimestamp(end, '<>') : '';

    return `${lineTag}${wordTags || value}${endTag}`;
}

function lyricsFromStructuredLyricsList(lyricsList: NavidromeLyricsList | undefined) {
    const structuredLyrics = lyricsList?.structuredLyrics;
    if (!structuredLyrics || structuredLyrics.length === 0) {
        return { plainLyrics: null, syncedLyrics: null };
    }

    const firstLyrics = structuredLyrics[0];
    const cueLines = firstLyrics.cueLine;
    const lines: NavidromeStructuredLyricLine[] = firstLyrics.line ?? [];
    const isSynced = lines.some(line => typeof line.start === 'number');
    const plainLyrics = lines.map(line => line.value ?? '').join('\n');

    // Prefer cueLine (word/syllable-level timing) when present — it carries the same
    // line text plus nested `cue` arrays for word-by-word timestamps.
    const syncedLyrics = cueLines && cueLines.length > 0
        ? cueLines
            .filter(cueLine => typeof cueLine.start === 'number')
            .map(cueLine => buildEnhancedLrcLine(cueLine.start!, cueLine.value ?? '', cueLine.cue, cueLine.end))
            .join('\n')
        : isSynced
            ? lines
                .map(line => {
                    if (typeof line.start !== 'number') {
                        return line.value ?? '';
                    }
                    return buildEnhancedLrcLine(line.start, line.value ?? '', undefined);
                })
                .join('\n')
            : null;

    return {
        plainLyrics: plainLyrics || null,
        syncedLyrics,
    };
}

async function fetchLyricsFromNavidrome(song: Song) {
    if (spotifyPresenter.getActiveSource() !== 'navidrome' || song.songID === '0') {
        return { plainLyrics: null, syncedLyrics: null, source: '' as const };
    }

    const baseUrl = (await storage.getItem('navidrome_base_url')) ?? '';
    const username = (await storage.getItem('navidrome_username')) ?? '';
    const password = (await storage.getItem('navidrome_password')) ?? '';

    if (!baseUrl || !username || !password) {
        return { plainLyrics: null, syncedLyrics: null, source: '' as const };
    }

    const url = new URL(`${baseUrl.replace(/\/+$/, '')}/rest/getLyricsBySongId.view`);
    url.search = buildNavidromeAuthParams(username, password).toString();
    url.searchParams.set('id', song.songID);
    // Request word/syllable-level cue timing (OpenSubsonic songLyrics v2) when the server supports it.
    // Servers that don't understand this parameter simply ignore it and return v1 line-level data.
    url.searchParams.set('enhanced', 'true');

    const response = await fetch(url.toString());
    if (!response.ok) {
        return { plainLyrics: null, syncedLyrics: null };
    }

    const data = (await response.json()) as NavidromeLyricsResponse;
    const lyrics = lyricsFromStructuredLyricsList(data['subsonic-response']?.lyricsList);
    return { ...lyrics, source: 'local server' as const };
}

async function fetchLyrics(song: Song) {
    const title = song.title.trim().toLowerCase();
    const artist = song.artist.trim().toLowerCase();

    if (
        song.songID === '0' ||
        title === '' ||
        title === 'no song found' ||
        artist.includes('please log in via')
    ) {
        return {
            plainLyrics: null,
            syncedLyrics: null
            ,source: '' as const
        }
    }

    try {
        const navidromeLyrics = await fetchLyricsFromNavidrome(song);
        if (navidromeLyrics.plainLyrics || navidromeLyrics.syncedLyrics) {
            console.log(`Lyrics fetched from Navidrome for ${song.title}`);
            return navidromeLyrics;
        }
    } catch (e) {
        console.error('Failed to fetch lyrics from Navidrome:', e);
    }

    try {
        const track: LrclibTrackMetadata = {
            title: song.title,
            artist: song.artist,
            album: song.album,
            durationSeconds: song.durationSeconds,
        };
        const candidates = new Map<string, LrclibRecord>();
        const exactRecord = await fetchLrclibJson<LrclibRecord>(createExactLyricsUrl(song));

        if (exactRecord?.instrumental) {
            console.log(`LRCLIB identifies ${song.title} as instrumental`);
            return lyricsFromLrclibRecord(exactRecord);
        }
        if (exactRecord) {
            candidates.set(lrclibRecordKey(exactRecord), exactRecord);
        }

        let bestMatch = selectBestLyricsMatch([...candidates.values()], track);
        if (bestMatch?.record.syncedLyrics) {
            console.log(`Exact synced lyrics fetched for ${song.title}`);
            return lyricsFromLrclibRecord(bestMatch.record);
        }

        const cleanedTitle = cleanTrackTitle(song.title);
        const cleanedArtist = cleanArtistName(song.artist);
        const searchQueries = [
            ...createChineseSearchVariants(song.title, song.artist),
            ...createChineseSearchVariants(cleanedTitle, cleanedArtist),
        ].filter((query, index, queries) => {
            const key = `${query.title.trim().toLocaleLowerCase()}|${query.artist.trim().toLocaleLowerCase()}`;
            return queries.findIndex(candidate => (
                `${candidate.title.trim().toLocaleLowerCase()}|${candidate.artist.trim().toLocaleLowerCase()}` === key
            )) === index;
        });

        for (const query of searchQueries) {
            const records = await fetchLrclibJson<LrclibRecord[]>(
                createLyricsSearchUrl(query.title, query.artist),
            );
            for (const record of records ?? []) {
                candidates.set(lrclibRecordKey(record), record);
            }

            bestMatch = selectBestLyricsMatch([...candidates.values()], track);
            if (bestMatch?.record.syncedLyrics) break;
        }

        if (!bestMatch) {
            console.log(`Lyrics not found for ${song.title} after exact and fallback searches`);
            return emptyLyrics();
        }

        console.log(
            `Lyrics matched for ${song.title} (score ${bestMatch.score.toFixed(3)}, ` +
            `${bestMatch.record.syncedLyrics ? 'synced' : 'plain'})`,
        );
        return lyricsFromLrclibRecord(bestMatch.record);
    } catch (e) {
        console.error('Failed to fetch lyrics:', e);
        return emptyLyrics();
    }
}

export { fetchLyrics };
