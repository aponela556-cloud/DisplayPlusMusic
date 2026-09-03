import { describe, expect, it } from 'vitest';
import Song from './songModel';
import {
    createRecordFromLrcImport,
    getLrcMetadataWarnings,
    parseLrcImport,
} from './lrcImportModel';

function makeSong(): Song {
    const song = new Song();
    song.addID('track-1');
    song.addTitle('Test Song');
    song.addArtist('Test Artist');
    song.addAlbum('Test Album');
    song.addDurationSeconds(180);
    return song;
}

describe('LRC import parsing', () => {
    it('parses metadata, BOM, CRLF, and standard timed lines', () => {
        const parsed = parseLrcImport('\uFEFF[ti:Test Song]\r\n[ar:Test Artist]\r\n[al:Test Album]\r\n[length:03:00]\r\n[00:01.25]First\r\n[01:23.456]Second');
        expect(parsed).toMatchObject({
            metadata: { title: 'Test Song', artist: 'Test Artist', album: 'Test Album', lengthMs: 180000 },
            plainLyrics: 'First\nSecond',
            timestampsMs: [1250, 83456],
            hasTimestamps: true,
        });
    });

    it('treats untimed text as a draft source', () => {
        const parsed = parseLrcImport('First line\n\n[Verse]\nSecond line');
        expect(parsed).toMatchObject({ plainLyrics: 'First line\nSecond line', timestampsMs: [], hasTimestamps: false });
        expect(createRecordFromLrcImport(makeSong(), parsed)).toMatchObject({ status: 'draft', currentLineIndex: 0 });
    });

    it('creates a complete local record from timed LRC', () => {
        const parsed = parseLrcImport('[00:01.00]First\n[00:02.00]Second');
        expect(createRecordFromLrcImport(makeSong(), parsed)).toMatchObject({
            status: 'complete',
            lineTimestampsMs: [1000, 2000],
            syncedLyrics: expect.stringContaining('[00:02.00]Second'),
        });
    });

    it('rejects invalid, unordered, and out-of-duration timestamps', () => {
        expect(() => parseLrcImport('[00:61.00]No')).toThrow(/Invalid timestamp/);
        expect(() => parseLrcImport('[00:02.00]Second\n[00:01.00]First')).toThrow(/ascending/);
        const parsed = parseLrcImport('[03:01.00]Too late');
        expect(() => createRecordFromLrcImport(makeSong(), parsed)).toThrow(/beyond/);
    });

    it('reports only supplied metadata that conflicts with Spotify', () => {
        const matching = parseLrcImport('[ti:Test Song]\n[ar:Test Artist]\n[00:01.00]First');
        expect(getLrcMetadataWarnings(matching, makeSong())).toEqual([]);
        const mismatch = parseLrcImport('[ti:Another Song]\n[length:03:10]\n[00:01.00]First');
        expect(getLrcMetadataWarnings(mismatch, makeSong())).toEqual([
            'Title: LRC “Another Song” ≠ Spotify “Test Song”',
            'Length: LRC and Spotify differ by more than 2 seconds',
        ]);
    });
});
