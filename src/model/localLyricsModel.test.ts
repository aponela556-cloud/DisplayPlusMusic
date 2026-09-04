import { afterEach, describe, expect, it, vi } from 'vitest';
import Song from './songModel';
import localLyricsStore, {
    buildLrc,
    clampTimestampMs,
    createLocalLyricsRecord,
    createSavedLyricsRecord,
    finalizeLocalLyricsRecord,
    formatLrcTimestamp,
    getLyricsEditorContext,
    markLocalLyricsLine,
    parsePlainLyrics,
    queryLocalLyricsSummaries,
    resolveLyricsPriority,
    savedLyricsStore,
    undoLocalLyricsLine,
} from './localLyricsModel';
import { storage } from '../utils/storage';

function makeSong(): Song {
    const song = new Song();
    song.addID('track-1');
    song.addTitle('Test Song');
    song.addArtist('Test Artist');
    song.addAlbum('Test Album');
    song.addDurationSeconds(180);
    return song;
}

afterEach(() => vi.restoreAllMocks());

describe('plain lyrics parsing', () => {
    it('removes blank lines and structural section labels', () => {
        expect(parsePlainLyrics('[Verse 1]\nFirst line\n\n[副歌]\nSecond line')).toEqual([
            'First line',
            'Second line',
        ]);
    });

    it('keeps ordinary bracketed lyric text', () => {
        expect(parsePlainLyrics('[whispering]\n(you are here)')).toEqual([
            '[whispering]',
            '(you are here)',
        ]);
    });
});

describe('timestamp editing and LRC output', () => {
    it('selects exactly one current line by index even when lyric text repeats', () => {
        const lines = ['Same chorus', 'Middle line', 'Same chorus'];
        expect(getLyricsEditorContext(lines, 0)).toMatchObject({
            currentLineNumber: 1,
            currentLine: 'Same chorus',
            nextLine: 'Middle line',
        });
        expect(getLyricsEditorContext(lines, 2)).toMatchObject({
            currentLineNumber: 3,
            previousLine: 'Middle line',
            currentLine: 'Same chorus',
            allMarked: false,
        });
        expect(getLyricsEditorContext(lines, 3)).toMatchObject({
            currentLineNumber: 3,
            currentLine: '',
            allMarked: true,
        });
    });

    it('clamps and formats timestamps', () => {
        expect(clampTimestampMs(-50, 180000)).toBe(0);
        expect(clampTimestampMs(190000, 180000)).toBe(180000);
        expect(formatLrcTimestamp(83450)).toBe('[01:23.45]');
    });

    it('marks in order and removes the current and later marks when undoing', () => {
        let record = createLocalLyricsRecord(makeSong(), 'First\nSecond\nThird');
        record = markLocalLyricsLine(record, 3, 12000);
        record = markLocalLyricsLine(record, 3, 17000);
        expect(record.currentLineIndex).toBe(2);
        expect(record.lineTimestampsMs).toEqual([12000, 17000]);
        record = undoLocalLyricsLine(record);
        expect(record.currentLineIndex).toBe(1);
        expect(record.lineTimestampsMs).toEqual([12000]);
    });

    it('rejects a non-monotonic mark', () => {
        let record = createLocalLyricsRecord(makeSong(), 'First\nSecond');
        record = markLocalLyricsLine(record, 2, 12000);
        expect(() => markLocalLyricsLine(record, 2, 11999)).toThrow(/previous mark/);
    });

    it('serializes standard LRC metadata and timed lines', () => {
        const record = createLocalLyricsRecord(makeSong(), '[Verse]\nFirst\nSecond');
        record.lineTimestampsMs = [12340, 56780];
        const lrc = buildLrc(record);
        expect(lrc).toContain('[ti:Test Song]');
        expect(lrc).toContain('[length:03:00]');
        expect(lrc).toContain('[00:12.34]First');
        expect(lrc).toContain('[00:56.78]Second');
    });

    it('keeps a partially marked record as a resumable draft', () => {
        let record = createLocalLyricsRecord(makeSong(), 'First\nSecond');
        record = markLocalLyricsLine(record, 2, 1000);
        expect(finalizeLocalLyricsRecord(record, 2)).toMatchObject({
            status: 'draft',
            currentLineIndex: 1,
            syncedLyrics: '',
        });
    });

    it('turns a fully marked record into playable synced lyrics', () => {
        let record = createLocalLyricsRecord(makeSong(), 'First\nSecond');
        record = markLocalLyricsLine(record, 2, 1000);
        record = markLocalLyricsLine(record, 2, 2000);
        expect(finalizeLocalLyricsRecord(record, 2)).toMatchObject({
            status: 'complete',
            currentLineIndex: 2,
            syncedLyrics: expect.stringContaining('[00:02.00]Second'),
        });
    });
});

describe('lyrics source priority', () => {
    const remotePlain = { plainLyrics: 'plain', syncedLyrics: null, source: 'web' as const };

    it('prefers remote synced lyrics over a complete local record', () => {
        const local = createLocalLyricsRecord(makeSong(), 'local');
        local.status = 'complete';
        local.syncedLyrics = '[00:01.00]local';
        const result = resolveLyricsPriority(
            { plainLyrics: 'remote', syncedLyrics: '[00:01.00]remote', source: 'web' },
            local,
        );
        expect(result.syncedLyrics).toContain('remote');
        expect(result.remoteSynced).toBe(true);
    });

    it('uses a complete local record before remote plain lyrics', () => {
        const local = createLocalLyricsRecord(makeSong(), 'local');
        local.status = 'complete';
        local.syncedLyrics = '[00:01.00]local';
        expect(resolveLyricsPriority(remotePlain, local).source).toBe('local library');
    });

    it('does not use a draft during normal playback', () => {
        const draft = createLocalLyricsRecord(makeSong(), 'draft');
        draft.syncedLyrics = '[00:01.00]draft';
        expect(resolveLyricsPriority(remotePlain, draft)).toMatchObject({
            source: 'web',
            syncedLyrics: null,
            remoteSynced: false,
        });
    });

    it('returns no lyrics when neither remote nor complete local lyrics exist', () => {
        expect(resolveLyricsPriority(
            { plainLyrics: null, syncedLyrics: null, source: '' },
            null,
        )).toMatchObject({ plainLyrics: null, syncedLyrics: null, source: '' });
    });
});

describe('storage recovery', () => {
    it('ignores a corrupted local record', async () => {
        vi.spyOn(storage, 'getItem').mockResolvedValue('{not valid json');
        await expect(localLyricsStore.get('track-1')).resolves.toBeNull();
    });

    it('saves, lists, and removes records through private storage', async () => {
        const values = new Map<string, string>();
        vi.spyOn(storage, 'getItem').mockImplementation(async key => values.get(key) ?? null);
        vi.spyOn(storage, 'setItem').mockImplementation(async (key, value) => { values.set(key, value); });
        vi.spyOn(storage, 'removeItem').mockImplementation(async key => { values.delete(key); });

        const record = createLocalLyricsRecord(makeSong(), 'First\nSecond');
        await localLyricsStore.save(record);
        await expect(localLyricsStore.list()).resolves.toMatchObject([
            { spotifyTrackId: 'track-1', status: 'draft', currentLineIndex: 0 },
        ]);

        await localLyricsStore.remove('track-1');
        await expect(localLyricsStore.get('track-1')).resolves.toBeNull();
        await expect(localLyricsStore.list()).resolves.toEqual([]);
    });

    it('migrates the old ID index to summaries and pages filtered results', async () => {
        const values = new Map<string, string>();
        vi.spyOn(storage, 'getItem').mockImplementation(async key => values.get(key) ?? null);
        vi.spyOn(storage, 'setItem').mockImplementation(async (key, value) => { values.set(key, value); });
        vi.spyOn(storage, 'removeItem').mockImplementation(async key => { values.delete(key); });
        const first = createLocalLyricsRecord(makeSong(), 'First');
        first.updatedAt = '2026-01-01T00:00:00.000Z';
        const second = { ...first, spotifyTrackId: 'track-2', title: 'Another Song', artist: 'Another Artist', status: 'complete' as const, syncedLyrics: '[00:01.00]First', updatedAt: '2026-01-02T00:00:00.000Z' };
        values.set('local_lyrics_index_v1', JSON.stringify(['track-1', 'track-2']));
        values.set('local_lyrics_v1:track-1', JSON.stringify(first));
        values.set('local_lyrics_v1:track-2', JSON.stringify(second));

        await expect(localLyricsStore.getPage('another', 'complete', 'title', 0, 20)).resolves.toMatchObject({
            totalItems: 1,
            items: [{ spotifyTrackId: 'track-2', status: 'complete', totalLines: 1 }],
        });
        expect(values.get('local_lyrics_index_v2')).toContain('track-2');
    });
});

describe('saved remote lyrics', () => {
    it('stores remote plain lyrics independently from the user timing record and de-duplicates it', async () => {
        const values = new Map<string, string>();
        vi.spyOn(storage, 'getItem').mockImplementation(async key => values.get(key) ?? null);
        vi.spyOn(storage, 'setItem').mockImplementation(async (key, value) => { values.set(key, value); });
        vi.spyOn(storage, 'removeItem').mockImplementation(async key => { values.delete(key); });

        const song = makeSong();
        const saved = createSavedLyricsRecord(song, {
            plainLyrics: 'Remote first line\nRemote second line',
            syncedLyrics: null,
            source: 'web',
        });
        expect(saved).toMatchObject({ format: 'plain', spotifyTrackId: 'track-1' });
        expect(await savedLyricsStore.save(saved!)).toBe(true);
        expect(await savedLyricsStore.save(saved!)).toBe(false);
        await localLyricsStore.save(createLocalLyricsRecord(song, 'My first line'));

        await expect(savedLyricsStore.list()).resolves.toMatchObject([
            { id: saved!.id, format: 'plain', plainLyrics: 'Remote first line\nRemote second line' },
        ]);
        await expect(localLyricsStore.get(song.songID)).resolves.toMatchObject({
            plainLyrics: 'My first line',
            status: 'draft',
        });
    });

    it('keeps a synced remote copy as LRC content', () => {
        const saved = createSavedLyricsRecord(makeSong(), {
            plainLyrics: 'Remote line',
            syncedLyrics: '[00:01.00]Remote line',
            source: 'web',
        });
        expect(saved).toMatchObject({ format: 'synced', syncedLyrics: '[00:01.00]Remote line' });
    });
});

describe('library summary queries', () => {
    it('filters and sorts metadata without reading lyric text', () => {
        const results = queryLocalLyricsSummaries([
            { spotifyTrackId: 'a', title: 'Zebra', artist: 'Artist', album: '', status: 'draft', markedLines: 1, totalLines: 2, updatedAt: '2026-01-01T00:00:00.000Z' },
            { spotifyTrackId: 'b', title: 'Álbum Song', artist: 'Other', album: '', status: 'complete', markedLines: 2, totalLines: 2, updatedAt: '2026-01-02T00:00:00.000Z' },
        ], 'album', 'complete', 'title');
        expect(results.map(item => item.spotifyTrackId)).toEqual(['b']);
    });
});
