import { describe, expect, it } from 'vitest';
import { song_placeholder } from './songModel';
import { createSyncDemoSong } from './syncDemoModel';

describe('createSyncDemoSong', () => {
    it('starts from the same halfway placeholder state as the upstream player', () => {
        const song = createSyncDemoSong();

        expect(song.durationSeconds).toBe(60);
        expect(song.progressSeconds).toBe(30);
        expect(song.isPlaying).toBe(false);
        expect(song.createPlaybackBar(576)).toBe(song_placeholder.createPlaybackBar(576));
    });
});
