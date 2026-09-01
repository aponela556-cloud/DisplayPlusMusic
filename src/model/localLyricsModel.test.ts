import { afterEach, describe, expect, it, vi } from 'vitest';
import Song from './songModel';
import localLyricsStore, {
    buildLrc,
    clampTimestampMs,
    createLocalLyricsRecord,
    finalizeLocalLyricsRecord,
    formatLrcTimestamp,
    markLocalLyricsLine,
    parsePlainLyrics,
    resolveLyricsPriority,
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
});
