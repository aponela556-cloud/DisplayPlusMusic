import Song from './songModel';

export const SYNC_DEMO_PLAIN_LYRICS = `[Verse 1]
First demo line
Second demo line

[Chorus]
This line tests phone marking
The final line completes the draft`;

export function createSyncDemoSong(): Song {
    const song = new Song();
    song.type = 'SyncDemo';
    song.addID('displayplus-sync-demo');
    song.addTitle('Local Lyrics Sync Demo');
    song.addArtist('DisplayPlus Music');
    song.addAlbum('Development Mode');
    song.addDurationSeconds(60);
    song.addProgressSeconds(0);
    song.addisPlaying(false);
    song.addChangedState(true);
    return song;
}
