import Song from '../model/songModel';
import localLyricsStore, {
    clampTimestampMs,
    cloneLocalLyricsRecord,
    createLocalLyricsRecord,
    finalizeLocalLyricsRecord,
    formatLrcTimestamp,
    getLyricsEditorContext,
    LocalLyricsRecord,
    markLocalLyricsLine,
    parsePlainLyrics,
    undoLocalLyricsLine,
} from '../model/localLyricsModel';
import playbackOffsetModel from '../model/playbackOffsetModel';
import lyricsPresenter from './lyricsPresenter';
import spotifyPresenter from './spotifyPresenter';

export interface LyricsSyncEditorState {
    editing: boolean;
    currentLineIndex: number;
    currentLineNumber: number;
    totalLines: number;
    markedCount: number;
    previousLine: string;
    currentLine: string;
    nextLine: string;
    allMarked: boolean;
    canUndo: boolean;
    canMark: boolean;
    isPlaying: boolean;
    message: string;
}

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
    private marking = false;
    private lastMarkAt = 0;

    isEditing(): boolean {
        return this.editing;
    }

    getMessage(): string {
        return this.message;
    }

    getActionLabel(): 'Create LRC' | 'Continue LRC' | '' {
        if (
            this.editing ||
            spotifyPresenter.getActiveSource() !== 'spotify' ||
            this.remoteSyncedAvailable ||
            !this.preparedPlainLyrics ||
            this.preparedSongID === '0' ||
            this.localRecord?.status === 'complete'
        ) return '';
        return this.localRecord?.status === 'draft' ? 'Continue LRC' : 'Create LRC';
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
        this.lastMarkAt = 0;
        this.message = 'Paused at start - tap Play';

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
        this.message = spotifyPresenter.currentSong.isPlaying ? 'Playing - tap MARK for the current line' : 'Paused';
    }

    async markCurrentLine(): Promise<boolean> {
        const now = performance.now();
        if (this.marking || (this.lastMarkAt > 0 && now - this.lastMarkAt < 250)) return false;
        if (!this.editing || !this.workingRecord || !this.isCurrentSongValid() || !this.isPlaybackReady()) return false;
        if (!spotifyPresenter.currentSong.isPlaying) {
            this.message = 'Paused - tap Play first';
            return false;
        }
        if (this.workingRecord.currentLineIndex >= this.lines.length) {
            this.message = 'All lines marked - tap Save';
            return false;
        }

        this.marking = true;
        try {
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
            this.lastMarkAt = now;
            await this.persistWorkingDraft();
            const timestampText = formatLrcTimestamp(timestampMs).slice(1, -1);

            if (this.workingRecord.currentLineIndex >= this.lines.length) {
                await spotifyPresenter.pausePlayback();
                this.message = `Marked line ${this.lines.length} at ${timestampText} - tap Save`;
            } else {
                this.message = `Marked line ${this.workingRecord.currentLineIndex} at ${timestampText}`;
            }
            return true;
        } finally {
            this.marking = false;
        }
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
        const state = this.getEditorState();
        return [
            `LRC  ${state.currentLineNumber}/${state.totalLines}`,
            state.previousLine ? `  ${this.truncateLine(state.previousLine)}` : '',
            `> ${this.truncateLine(state.currentLine || 'All lines marked')}`,
            state.nextLine ? `  ${this.truncateLine(state.nextLine)}` : '',
            state.message,
            'Use phone controls',
        ].join('\n');
    }

    getEditorState(): LyricsSyncEditorState {
        const index = this.workingRecord?.currentLineIndex ?? 0;
        const context = getLyricsEditorContext(this.lines, index);
        const validSong = Boolean(
            this.workingRecord &&
            spotifyPresenter.currentSong.songID === this.workingRecord.spotifyTrackId,
        );
        const isPlaying = Boolean(this.editing && validSong && spotifyPresenter.currentSong.isPlaying);
        return {
            editing: this.editing,
            currentLineIndex: context.currentLineIndex,
            currentLineNumber: context.currentLineNumber,
            totalLines: context.totalLines,
            markedCount: Math.min(this.workingRecord?.lineTimestampsMs.length ?? 0, context.totalLines),
            previousLine: context.previousLine,
            currentLine: context.currentLine,
            nextLine: context.nextLine,
            allMarked: this.editing && context.allMarked,
            canUndo: this.editing && index > 0,
            canMark: this.editing && validSong && isPlaying && !context.allMarked,
            isPlaying,
            message: this.message,
        };
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
        this.marking = false;
        this.lastMarkAt = 0;
    }

    private notifyLibraryChanged(): void {
        window.dispatchEvent(new CustomEvent('localLyricsChanged'));
    }
}

const lyricsSyncPresenter = new LyricsSyncPresenter();
export default lyricsSyncPresenter;
