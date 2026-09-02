import { describe, expect, it } from 'vitest';
import Song from './songModel';

const DISPLAY_WIDTH = 576;
const MAX_SAFE_COLUMNS = 47;

describe('Song.createPlaybackBar', () => {
    it.each([
        { progress: 0, isPlaying: false },
        { progress: 30, isPlaying: false },
        { progress: 60, isPlaying: false },
        { progress: 0, isPlaying: true },
        { progress: 30, isPlaying: true },
        { progress: 60, isPlaying: true },
    ])('keeps the complete bar on one display line at $progress seconds (playing: $isPlaying)', ({ progress, isPlaying }) => {
        const song = new Song();
        song.addDurationSeconds(60);
        song.addProgressSeconds(progress);
        song.addisPlaying(isPlaying);

        const bar = song.createPlaybackBar(DISPLAY_WIDTH);

        expect(bar.endsWith(']')).toBe(true);
        expect(bar.length).toBe(MAX_SAFE_COLUMNS);
    });
});
