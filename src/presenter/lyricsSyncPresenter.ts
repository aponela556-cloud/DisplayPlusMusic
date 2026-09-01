import Song from '../model/songModel';
import localLyricsStore, {
    clampTimestampMs,
    cloneLocalLyricsRecord,
    createLocalLyricsRecord,
    finalizeLocalLyricsRecord,
    LocalLyricsRecord,
    markLocalLyricsLine,
    parsePlainLyrics,
    undoLocalLyricsLine,
} from '../model/localLyricsModel';
import playbackOffsetModel from '../model/playbackOffsetModel';
import lyricsPresenter from './lyricsPresenter';
import spotifyPresenter from './spotifyPresenter';

class LyricsSyncPresenter {
    private editing = false;
    private preparedSongID = '';
    private preparedPlainLyrics = '';
    private remoteSyncedAvailable = false;
    private localRecord: LocalLyricsRecord | null = null;
    private sessionSnapshot: LocalLyricsRecord | null = null;
    private workingRecord: LocalLyricsRecord | null = null;
    private lines: string[] = [];
    private message = '';
    private preparingToken = 0;
    private saving = false;

    isEditing(): boolean {
        return this.editing;
    }

    getMessage(): string {
        return this.message;
    }

    getActionLabel(): 'Start Sync' | 'Resume Sync' | '' {
        if (
            this.editing ||
            spotifyPresenter.getActiveSource() !== 'spotify' ||
            this.remoteSyncedAvailable ||
            !this.preparedPlainLyrics ||
            this.preparedSongID === '0' ||
            this.localRecord?.status === 'complete'
        ) return '';
        return this.localRecord?.status === 'draft' ? 'Resume Sync' : 'Start Sync';
    }

    async prepareForSong(
        song: Song,
        plainLyrics: string,
        remoteSyncedAvailable: boolean,
        force = false,
    ): Promise<void> {
        if (this.editing) {
            if (!spotifyPresenter.isPlaybackAvailable()) {
                this.message = 'Spotify playback device unavailable';
                await spotifyPresenter.pausePlayback();
                return;
            }
            if (this.workingRecord && song.songID !== this.workingRecord.spotifyTrackId) {
                this.message = 'Song changed - save or cancel on phone';
                if (song.isPlaying) await spotifyPresenter.pausePlayback();
            }
            return;
        }

        if (!force &&
            this.preparedSongID === song.songID &&
            this.preparedPlainLyrics === plainLyrics &&
            this.remoteSyncedAvailable === remoteSyncedAvailable
        ) return;

        const token = ++this.preparingToken;
        const record = await localLyricsStore.get(song.songID);
        if (token !== this.preparingToken) return;
        this.preparedSongID = song.songID;
        this.preparedPlainLyrics = plainLyrics || record?.plainLyrics || '';
        this.remoteSyncedAvailable = remoteSyncedAvailable;
        this.localRecord = record;
        this.message = '';
    }

    async startSync(forceRestart = false): Promise<boolean> {
        const song = spotifyPresenter.currentSong;
        if (
            this.editing ||
            spotifyPresenter.getActiveSource() !== 'spotify' ||
            this.remoteSyncedAvailable ||
            !this.preparedPlainLyrics ||
            song.songID !== this.preparedSongID
        ) return false;

        const parsedLines = parsePlainLyrics(this.preparedPlainLyrics);
        if (parsedLines.length === 0) {
            this.message = 'No usable lyric lines';
            return false;
        }

        const existing = this.localRecord;
        this.sessionSnapshot = cloneLocalLyricsRecord(existing);
        this.workingRecord = !forceRestart && existing?.status === 'draft'
            ? cloneLocalLyricsRecord(existing)
            : createLocalLyricsRecord(song, this.preparedPlainLyrics);
        if (!this.workingRecord) return false;

        this.lines = parsedLines;
        this.workingRecord.currentLineIndex = Math.min(
            this.workingRecord.lineTimestampsMs.length,
            this.lines.length,
        );
        this.editing = true;
        this.message = 'Paused at start - click to play';

        const ready = await spotifyPresenter.pauseAndSeekToBeginning();
        if (!ready) {
            this.editing = false;
            this.workingRecord = null;
            this.lines = [];
            this.message = 'Spotify playback device unavailable';
            return false;
        }

        await this.persistWorkingDraft();
        return true;
    }

    async togglePlayback(): Promise<void> {
        if (!this.editing || !this.isCurrentSongValid() || !this.isPlaybackReady()) return;
        await spotifyPresenter.togglePlayback();
        this.message = spotifyPresenter.currentSong.isPlaying ? 'Playing - swipe down to mark' : 'Paused';
    }

    async markCurrentLine(): Promise<boolean> {
        if (!this.editing || !this.workingRecord || !this.isCurrentSongValid() || !this.isPlaybackReady()) return false;
        if (!spotifyPresenter.currentSong.isPlaying) {
            this.message = 'Paused - click to play first';
            return false;
        }
        if (this.workingRecord.currentLineIndex >= this.lines.length) {
            this.message = 'All lines marked - double click to save';
            return false;
        }

        const rawProgressMs = (
            spotifyPresenter.currentSong.progressSeconds - playbackOffsetModel.getOffsetSeconds()
        ) * 1000;
        const timestampMs = clampTimestampMs(rawProgressMs, this.workingRecord.durationMs);
        try {
            this.workingRecord = markLocalLyricsLine(this.workingRecord, this.lines.length, timestampMs);
        } catch {
            this.message = 'Playback is before the previous mark';
            return false;
        }
        await this.persistWorkingDraft();

        if (this.workingRecord.currentLineIndex >= this.lines.length) {
            await spotifyPresenter.pausePlayback();
            this.message = 'All lines marked - double click to save';
        } else {
            this.message = `Marked ${this.workingRecord.currentLineIndex}/${this.lines.length}`;
        }
        return true;
    }

    async undoLine(): Promise<boolean> {
        if (!this.editing || !this.workingRecord || this.workingRecord.currentLineIndex === 0) return false;
        this.workingRecord = undoLocalLyricsLine(this.workingRecord);
        await this.persistWorkingDraft();
        this.message = `Redo line ${this.workingRecord.currentLineIndex + 1}`;
        return true;
    }

    async saveAndExit(): Promise<LocalLyricsRecord | null> {
        if (!this.editing || !this.workingRecord || this.saving) return null;
        this.saving = true;
        try {
            await spotifyPresenter.pausePlayback();
            this.workingRecord = finalizeLocalLyricsRecord(this.workingRecord, this.lines.length);
            const complete = this.workingRecord.status === 'complete';
            await localLyricsStore.save(this.workingRecord);
            this.localRecord = cloneLocalLyricsRecord(this.workingRecord);
            const saved = cloneLocalLyricsRecord(this.workingRecord);
            this.exitEditing();
            this.notifyLibraryChanged();
            if (complete) await lyricsPresenter.refreshLyrics(spotifyPresenter.currentSong);
            return saved;
        } finally {
            this.saving = false;
        }
    }

    async cancelAndExit(): Promise<void> {
        if (!this.editing || !this.workingRecord) return;
        await spotifyPresenter.pausePlayback();
        if (this.sessionSnapshot) {
            await localLyricsStore.save(this.sessionSnapshot);
            this.localRecord = cloneLocalLyricsRecord(this.sessionSnapshot);
        } else {
            await localLyricsStore.remove(this.workingRecord.spotifyTrackId);
            this.localRecord = null;
        }
        const shouldRefresh = this.sessionSnapshot?.status === 'complete';
        this.exitEditing();
        this.notifyLibraryChanged();
        if (shouldRefresh) await lyricsPresenter.refreshLyrics(spotifyPresenter.currentSong);
    }

    getGlassesContent(): string {
        if (!this.editing || !this.workingRecord) return '';
        const index = this.workingRecord.currentLineIndex;
        const previous = index > 0 ? this.truncateLine(this.lines[index - 1]) : '';
        const current = index < this.lines.length ? this.truncateLine(this.lines[index]) : '✓ All lines marked';
        const next = index + 1 < this.lines.length ? this.truncateLine(this.lines[index + 1]) : '';
        return [
            `SYNC  ${Math.min(index + 1, this.lines.length)}/${this.lines.length}`,
            previous ? `Previous: ${previous}` : 'Previous:',
            `> ${current}`,
            next ? `Next: ${next}` : 'Next:',
            this.message,
            'Up Undo  Down Mark  Click Play  2x Save',
        ].join('\n');
    }

    getCurrentRecord(): LocalLyricsRecord | null {
        return cloneLocalLyricsRecord(this.workingRecord ?? this.localRecord);
    }

    private isCurrentSongValid(): boolean {
        if (!this.workingRecord || spotifyPresenter.currentSong.songID !== this.workingRecord.spotifyTrackId) {
            this.message = 'Song changed - save or cancel on phone';
            return false;
        }
        return true;
    }

    private isPlaybackReady(): boolean {
        if (spotifyPresenter.isPlaybackAvailable()) return true;
        this.message = 'Spotify playback device unavailable';
        return false;
    }

    private truncateLine(line: string): string {
        return line.length > 46 ? `${line.slice(0, 45)}…` : line;
    }

    private async persistWorkingDraft(): Promise<void> {
        if (!this.workingRecord) return;
        this.workingRecord.status = 'draft';
        this.workingRecord.syncedLyrics = '';
        await localLyricsStore.save(this.workingRecord);
        this.notifyLibraryChanged();
        this.localRecord = cloneLocalLyricsRecord(this.workingRecord);
    }

    private exitEditing(): void {
        this.editing = false;
        this.sessionSnapshot = null;
        this.workingRecord = null;
        this.lines = [];
        this.message = '';
    }

    private notifyLibraryChanged(): void {
        window.dispatchEvent(new CustomEvent('localLyricsChanged'));
    }
}

const lyricsSyncPresenter = new LyricsSyncPresenter();
export default lyricsSyncPresenter;
