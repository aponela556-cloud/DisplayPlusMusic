import spotifyPresenter from './spotifyPresenter';
import navidromeModel from '../model/navidromeModel';
import { storage } from '../utils/storage';
import spotifyAuthModel from '../model/spotifyAuthModel';
import Song from '../model/songModel';
import { formatTime } from '../Scripts/formatTime';
import playbackOffsetModel, { OFFSET_STEP_MS } from '../model/playbackOffsetModel';
import localLyricsStore, { LocalLyricsFilter, LocalLyricsRecord, LocalLyricsSort, parsePlainLyrics } from '../model/localLyricsModel';
import {
    createRecordFromLrcImport,
    getLrcMetadataWarnings,
    parseLrcImport,
} from '../model/lrcImportModel';
import lyricsPresenter from './lyricsPresenter';
import lyricsSyncPresenter from './lyricsSyncPresenter';
import { requestImmediateViewRefresh } from '../view/GlassesView';

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function showPlayerMessage(message: string): void {
    const target = document.getElementById('player-message');
    if (target) target.textContent = message;
}

class ViewPresenter {
    private lastSongID: string = ""
    private lastBlobUrl?: string;
    private lastLyricsSyncEditing = false;
    private lrcImportMetadataConfirmed = false;
    private libraryFilter: LocalLyricsFilter = 'all';
    private librarySort: LocalLyricsSort = 'recent';
    private libraryPage = 0;
    private libraryTrackId?: string;

    constructor() { }

    initListeners() {
        const sourceSelect = document.getElementById('music-source') as HTMLSelectElement | null;
        const spotifyFields = document.getElementById('spotify-auth-fields');
        const navidromeFields = document.getElementById('navidrome-auth-fields');
        const clientList = document.getElementById('navidrome-client-list');
        const miniButtons = document.getElementById('mini-buttons-container');
        const localLyricsList = document.getElementById('local-lyrics-list');

        const toggleAuthFields = () => {
            const source = sourceSelect?.value || 'spotify';
            if (spotifyFields) spotifyFields.style.display = source === 'spotify' ? 'flex' : 'none';
            if (navidromeFields) navidromeFields.style.display = source === 'navidrome' ? 'flex' : 'none';
            const clientPicker = document.getElementById('navidrome-client-picker');
            if (clientPicker) clientPicker.style.display = source === 'navidrome' ? 'flex' : 'none';
            if (miniButtons) miniButtons.style.display = source === 'navidrome' ? 'none' : 'flex';
        };

        sourceSelect?.addEventListener('change', toggleAuthFields);

        // Media Controls
        document.getElementById('skip-track')?.addEventListener('click', async () => {
            await this.forwardTrack();
        });
        document.getElementById('play-pause')?.addEventListener('click', async () => {
            await this.playPauseTrack();
        });
        document.getElementById('previous-track')?.addEventListener('click', async () => {
            await this.backTrack();
        });

        document.getElementById('offset-decrease')?.addEventListener('click', () => {
            this.adjustPlaybackOffset(-OFFSET_STEP_MS);
        });
        document.getElementById('offset-increase')?.addEventListener('click', () => {
            this.adjustPlaybackOffset(OFFSET_STEP_MS);
        });
        document.getElementById('playback-offset-value')?.addEventListener('click', () => {
            this.setPlaybackOffset(0);
        });

        document.getElementById('start-lyrics-sync')?.addEventListener('click', async () => {
            if (await lyricsSyncPresenter.startSync()) {
                requestImmediateViewRefresh(spotifyPresenter.currentSong);
            }
            this.renderLyricsSyncControls();
            await this.renderLocalLyricsLibrary();
        });
        document.getElementById('mark-lyrics-sync')?.addEventListener('click', async () => {
            if (await lyricsSyncPresenter.markCurrentLine()) {
                try { navigator.vibrate?.(25); } catch { /* Optional feedback only. */ }
                requestImmediateViewRefresh(spotifyPresenter.currentSong);
            }
            this.renderLyricsSyncControls();
        });
        document.getElementById('undo-lyrics-sync')?.addEventListener('click', async () => {
            if (await lyricsSyncPresenter.undoLine()) {
                requestImmediateViewRefresh(spotifyPresenter.currentSong);
            }
            this.renderLyricsSyncControls();
        });
        document.getElementById('toggle-lyrics-sync-playback')?.addEventListener('click', async () => {
            await lyricsSyncPresenter.togglePlayback();
            requestImmediateViewRefresh(spotifyPresenter.currentSong);
            this.renderLyricsSyncControls();
        });
        document.getElementById('save-lyrics-sync')?.addEventListener('click', async () => {
            await lyricsSyncPresenter.saveAndExit();
            requestImmediateViewRefresh(spotifyPresenter.currentSong);
            this.renderLyricsSyncControls();
            await this.renderLocalLyricsLibrary();
        });
        document.getElementById('cancel-lyrics-sync')?.addEventListener('click', async () => {
            await lyricsSyncPresenter.cancelAndExit();
            requestImmediateViewRefresh(spotifyPresenter.currentSong);
            this.renderLyricsSyncControls();
            await this.renderLocalLyricsLibrary();
        });
        document.getElementById('open-local-lyrics-library')?.addEventListener('click', () => this.openLocalLyricsLibrary());
        document.getElementById('close-local-lyrics-library')?.addEventListener('click', () => this.closeLocalLyricsLibrary());
        document.getElementById('local-lyrics-search')?.addEventListener('input', () => {
            this.libraryPage = 0;
            this.renderLocalLyricsLibrary();
        });
        document.querySelectorAll<HTMLButtonElement>('[data-library-filter]').forEach(button => button.addEventListener('click', () => {
            this.libraryFilter = (button.dataset.libraryFilter || 'all') as LocalLyricsFilter;
            this.libraryPage = 0;
            this.renderLocalLyricsLibrary();
        }));
        document.getElementById('local-lyrics-sort')?.addEventListener('change', event => {
            this.librarySort = (event.target as HTMLSelectElement).value as LocalLyricsSort;
            this.libraryPage = 0;
            this.renderLocalLyricsLibrary();
        });
        document.getElementById('local-lyrics-page-previous')?.addEventListener('click', () => {
            this.libraryPage = Math.max(0, this.libraryPage - 1);
            this.renderLocalLyricsLibrary();
        });
        document.getElementById('local-lyrics-page-next')?.addEventListener('click', () => {
            this.libraryPage += 1;
            this.renderLocalLyricsLibrary();
        });
        document.getElementById('open-lrc-import')?.addEventListener('click', () => {
            this.openLrcImport();
        });
        document.getElementById('lrc-import-file')?.addEventListener('change', async event => {
            const input = event.target as HTMLInputElement;
            const file = input.files?.[0];
            if (!file) return;
            try {
                const textArea = document.getElementById('lrc-import-text') as HTMLTextAreaElement | null;
                if (textArea) textArea.value = await file.text();
                this.resetLrcImportConfirmation();
                this.setLrcImportStatus(`Loaded ${file.name}`);
            } catch {
                this.setLrcImportStatus('Could not read this file. Paste its text instead.');
            }
        });
        document.getElementById('lrc-import-text')?.addEventListener('input', () => {
            this.resetLrcImportConfirmation();
        });
        document.getElementById('confirm-lrc-import')?.addEventListener('click', async () => {
            await this.importLrc();
        });
        document.getElementById('cancel-lrc-import')?.addEventListener('click', () => {
            this.closeLrcImport();
        });
        document.getElementById('copy-lrc')?.addEventListener('click', async () => {
            const value = (document.getElementById('lrc-export-text') as HTMLTextAreaElement | null)?.value ?? '';
            if (value) await this.copyText(value);
        });
        document.getElementById('close-lrc-export')?.addEventListener('click', () => {
            const popup = document.getElementById('lrc-export-popup');
            if (popup) popup.style.display = 'none';
        });

        localLyricsList?.addEventListener('click', async event => {
            const button = (event.target as HTMLElement).closest('button[data-lyrics-action]') as HTMLButtonElement | null;
            const action = button?.dataset.lyricsAction;
            const trackId = button?.dataset.trackId;
            if (!action || !trackId) return;
            await this.handleLocalLyricsAction(action, trackId);
        });
        document.getElementById('local-lyrics-detail-sync')?.addEventListener('click', () => this.libraryTrackId && this.handleLocalLyricsAction('sync', this.libraryTrackId));
        document.getElementById('local-lyrics-detail-copy')?.addEventListener('click', () => this.libraryTrackId && this.handleLocalLyricsAction('copy', this.libraryTrackId));
        document.getElementById('local-lyrics-detail-export')?.addEventListener('click', () => this.libraryTrackId && this.handleLocalLyricsAction('export', this.libraryTrackId));
        document.getElementById('local-lyrics-detail-delete')?.addEventListener('click', () => this.libraryTrackId && this.handleLocalLyricsAction('delete', this.libraryTrackId));
        document.getElementById('close-local-lyrics-detail')?.addEventListener('click', () => this.closeLocalLyricsDetail());

        playbackOffsetModel.init().then(() => this.renderPlaybackOffset());

        clientList?.addEventListener('click', async (event) => {
            const target = event.target as HTMLElement;
            const button = target.closest('button[data-client-name]') as HTMLButtonElement | null;
            const clientName = button?.dataset.clientName;
            if (!clientName) {
                return;
            }

            await spotifyPresenter.setNavidromeClient(clientName);
            this.renderNavidromeClients();
        });

        // Auth Controls
        document.getElementById('save-auth')?.addEventListener('click', async () => {
            this.saveAndAuthorize();
        });
        document.getElementById('clear-local-refresh-token')?.addEventListener('click', async () => {
            this.clearLocalStorage();
        });

        // Load saved auth data into inputs
        storage.getItem('spotify_client_id').then(val => {
            const clientIdInput = document.getElementById('client-id') as HTMLInputElement;
            if (clientIdInput && val) {
                clientIdInput.value = val;
            }
        });
        storage.getItem('spotify_client_secret').then(val => {
            const clientSecretInput = document.getElementById('client-secret') as HTMLInputElement;
            if (clientSecretInput && val) {
                clientSecretInput.value = val;
            }
        });
        storage.getItem('navidrome_base_url').then(val => {
            const input = document.getElementById('navidrome-base-url') as HTMLInputElement;
            if (input && val) {
                input.value = val;
            }
        });
        storage.getItem('navidrome_username').then(val => {
            const input = document.getElementById('navidrome-username') as HTMLInputElement;
            if (input && val) {
                input.value = val;
            }
        });
        storage.getItem('navidrome_password').then(val => {
            const input = document.getElementById('navidrome-password') as HTMLInputElement;
            if (input && val) {
                input.value = val;
            }
        });
        storage.getItem('music_source').then(val => {
            if (sourceSelect && val) {
                sourceSelect.value = val;
            }
            toggleAuthFields();
        });
        this.renderLocalLyricsLibrary();
        window.addEventListener('localLyricsChanged', () => {
            this.renderLyricsSyncControls();
            this.renderLocalLyricsLibrary();
        });

        // Make popup links copyable
        document.querySelectorAll('.popup-link').forEach(link => {
            link.addEventListener('click', async (e) => {
                const target = e.target as HTMLElement;
                const textToCopy = target.innerText.trim();
                const originalText = textToCopy;

                try {
                    if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
                        await navigator.clipboard.writeText(textToCopy);
                    } else {
                        // Fallback for HTTP / non-secure contexts
                        const textArea = document.createElement("textarea");
                        textArea.value = textToCopy;
                        document.body.appendChild(textArea);
                        textArea.focus();
                        textArea.select();
                        document.execCommand('copy');
                        document.body.removeChild(textArea);
                    }

                    target.innerText = "Copied!";
                    setTimeout(() => {
                        target.innerText = originalText;
                    }, 1000);
                } catch (err) {
                    console.error('Failed to copy', err);
                }
            });
        });
    }

    async adjustPlaybackOffset(deltaMs: number) {
        await playbackOffsetModel.adjust(deltaMs);
        this.renderPlaybackOffset();
    }
    async setPlaybackOffset(ms: number) {
        await playbackOffsetModel.set(ms);
        this.renderPlaybackOffset();
    }

    renderPlaybackOffset() {
        const el = document.getElementById('playback-offset-value');
        if (!el) return;
        const offsetMs = playbackOffsetModel.getOffsetMs();
        el.textContent = `${offsetMs > 0 ? '+' : ''}${offsetMs}ms`;
    }

    async forwardTrack(): Promise<void> {
        if (lyricsSyncPresenter.isEditing()) return;
        await spotifyPresenter.song_forward();
    }
    async playPauseTrack(): Promise<void> {
        if (lyricsSyncPresenter.isEditing()) {
            await lyricsSyncPresenter.togglePlayback();
            this.renderLyricsSyncControls();
            return;
        }
        spotifyPresenter.song_pauseplay();
    }
    async backTrack(): Promise<void> {
        if (lyricsSyncPresenter.isEditing()) return;
        const result = await spotifyPresenter.song_back();
        if (result.changed) return;

        const button = document.getElementById('previous-track') as HTMLButtonElement | null;
        if (!button) return;
        const originalLabel = button.textContent;
        button.textContent = result.message;
        window.setTimeout(() => { button.textContent = originalLabel; }, 2500);
    }

    async saveAndAuthorize() {
        const selectedSource = ((document.getElementById('music-source') as HTMLSelectElement | null)?.value || 'spotify') as 'spotify' | 'navidrome';
        await storage.setItem('music_source', selectedSource);

        if (selectedSource === 'navidrome') {
            const baseUrl = (document.getElementById('navidrome-base-url') as HTMLInputElement).value.trim();
            const username = (document.getElementById('navidrome-username') as HTMLInputElement).value.trim();
            const password = (document.getElementById('navidrome-password') as HTMLInputElement).value;

            if (!baseUrl || !username || !password) {
                alert('Please provide Navidrome server URL, username, and password.');
                return;
            }

            await storage.setItem('navidrome_base_url', baseUrl);
            await storage.setItem('navidrome_username', username);
            await storage.setItem('navidrome_password', password);

            window.location.reload();
            return;
        }

        const clientId = (document.getElementById('client-id') as HTMLInputElement).value.trim();
        const clientSecret = (document.getElementById('client-secret') as HTMLInputElement).value.trim();

        if (!clientId || !clientSecret) {
            alert("Please provide both Client ID and Client Secret.");
            return;
        }

        await storage.setItem('spotify_client_id', clientId);
        await storage.setItem('spotify_client_secret', clientSecret);

        await spotifyAuthModel.generateAuthUrl(clientId);
    }

    async clearLocalStorage() {
        console.log("Started clear");
        await storage.removeItem('spotify_refresh_token');
        await storage.removeItem('spotify_access_token');
        await storage.removeItem('spotify_client_id');
        await storage.removeItem('spotify_client_secret');
        await storage.removeItem('spotify_auth_state');
        await storage.removeItem('navidrome_base_url');
        await storage.removeItem('navidrome_username');
        await storage.removeItem('navidrome_password');
        await storage.removeItem('navidrome_selected_client');
        await storage.removeItem('music_source');
        console.log("Spotify session cleared!");
        window.location.reload();
    }

    async updateHTML(song: Song) {
        try {
            const setText = (id: string, val: string) => {
                const el = document.getElementById(id);
                if (el) el.textContent = val;
            };
            setText('song-name', song.title);
            setText('song-artist', song.artist);
            setText('song-album', song.album);
            setText('song-current-time', formatTime(song.progressSeconds));
            setText('song-total-time', `${formatTime(song.durationSeconds)}`);
            this.renderNavidromeClients();
            this.renderLyricsSyncControls();

            if (song.songID !== this.lastSongID) {
                const imgElement = document.getElementById('album-art') as HTMLImageElement;
                if (imgElement && song.albumArtColor?.length > 0) {
                    if (this.lastBlobUrl) URL.revokeObjectURL(this.lastBlobUrl);
                    const blob = new Blob([song.albumArtColor] as BlobPart[], { type: 'image/png' });
                    this.lastBlobUrl = URL.createObjectURL(blob);
                    imgElement.src = this.lastBlobUrl;
                }
                this.lastSongID = song.songID;
            }
        } catch (e) {
            console.error("[viewPresenter] updateHTML threw:", e);
        }
    }

    renderLyricsSyncControls() {
        const startButton = document.getElementById('start-lyrics-sync') as HTMLButtonElement | null;
        const activeControls = document.getElementById('lyrics-sync-active-controls');
        const status = document.getElementById('lyrics-sync-status');
        const progress = document.getElementById('lyrics-sync-progress');
        const previousLine = document.getElementById('lyrics-sync-previous-line');
        const currentLine = document.getElementById('lyrics-sync-current-line');
        const nextLine = document.getElementById('lyrics-sync-next-line');
        const markButton = document.getElementById('mark-lyrics-sync') as HTMLButtonElement | null;
        const undoButton = document.getElementById('undo-lyrics-sync') as HTMLButtonElement | null;
        const playbackButton = document.getElementById('toggle-lyrics-sync-playback') as HTMLButtonElement | null;
        const editing = lyricsSyncPresenter.isEditing();
        const actionLabel = lyricsSyncPresenter.getActionLabel();
        const editorState = lyricsSyncPresenter.getEditorState();
        const editingChanged = editing !== this.lastLyricsSyncEditing;

        document.body.classList.toggle('lyrics-sync-editing', editing);

        if (startButton) {
            startButton.textContent = actionLabel || 'Create LRC';
            startButton.style.display = !editing && actionLabel ? 'flex' : 'none';
        }
        if (activeControls) activeControls.style.display = editing ? 'flex' : 'none';
        if (progress) {
            progress.textContent = editorState.allMarked
                ? `Complete · ${editorState.markedCount}/${editorState.totalLines} lines`
                : `Line ${editorState.currentLineNumber} / ${editorState.totalLines}`;
        }
        if (previousLine) {
            previousLine.textContent = editorState.previousLine ? `Previous: ${editorState.previousLine}` : '';
            previousLine.style.display = editorState.previousLine ? 'block' : 'none';
        }
        if (currentLine) {
            currentLine.textContent = editorState.allMarked
                ? '✓ All lines marked'
                : editorState.currentLine ? `▶ ${editorState.currentLine}` : '';
        }
        if (nextLine) {
            nextLine.textContent = editorState.nextLine ? `Next: ${editorState.nextLine}` : '';
            nextLine.style.display = editorState.nextLine ? 'block' : 'none';
        }
        if (markButton) {
            markButton.textContent = editorState.allMarked
                ? 'ALL LINES MARKED'
                : `MARK LINE ${editorState.currentLineNumber}`;
            markButton.disabled = !editorState.canMark;
        }
        if (undoButton) undoButton.disabled = !editorState.canUndo;
        if (playbackButton) {
            playbackButton.textContent = editorState.playbackResetReady
                ? editorState.isPlaying ? 'Pause' : 'Play'
                : 'Retry Reset';
        }
        if (status) {
            if (editing) status.textContent = editorState.message || 'Use the phone to time each lyric line.';
            else if (lyricsSyncPresenter.getMessage()) status.textContent = lyricsSyncPresenter.getMessage();
            else if (actionLabel) status.textContent = 'Plain lyrics are ready for line-by-line timing.';
            else if (lyricsPresenter.hasSyncedLyrics()) status.textContent = lyricsPresenter.getLyricsSourceLabel();
            else status.textContent = 'No editable lyrics for the current song.';
        }
        if (editingChanged) {
            this.lastLyricsSyncEditing = editing;
            requestAnimationFrame(() => {
                document.getElementById('lyrics-sync-panel')?.scrollIntoView({ block: 'start' });
            });
        }
    }

    async renderLocalLyricsLibrary() {
        const summaries = await localLyricsStore.listSummaries();
        const summary = document.getElementById('local-lyrics-summary');
        const draftCount = summaries.filter(record => record.status === 'draft').length;
        const completeCount = summaries.length - draftCount;
        if (summary) summary.textContent = `${summaries.length} local lyrics · ${draftCount} drafts · ${completeCount} complete`;

        const popup = document.getElementById('local-lyrics-library-popup');
        if (!popup || popup.style.display === 'none') return;
        const list = document.getElementById('local-lyrics-list');
        const search = (document.getElementById('local-lyrics-search') as HTMLInputElement | null)?.value ?? '';
        const page = await localLyricsStore.getPage(search, this.libraryFilter, this.librarySort, this.libraryPage);
        this.libraryPage = page.page;
        const pageSummary = document.getElementById('local-lyrics-page-summary');
        const previous = document.getElementById('local-lyrics-page-previous') as HTMLButtonElement | null;
        const next = document.getElementById('local-lyrics-page-next') as HTMLButtonElement | null;
        document.querySelectorAll<HTMLButtonElement>('[data-library-filter]').forEach(button => {
            const value = button.dataset.libraryFilter as LocalLyricsFilter;
            button.classList.toggle('accent', value === this.libraryFilter);
        });
        if (pageSummary) pageSummary.textContent = page.totalItems === 0 ? 'No local lyrics found.' : `${page.totalItems} results · Page ${page.page + 1} of ${page.totalPages}`;
        if (previous) previous.disabled = page.page === 0;
        if (next) next.disabled = page.page >= page.totalPages - 1;
        if (!list) return;
        list.innerHTML = page.items.map(record => {
            const progress = `${record.markedLines}/${record.totalLines} lines`;
            return `
                <button class="local-lyrics-card" data-lyrics-action="details" data-track-id="${escapeHtml(record.spotifyTrackId)}">
                    <p class="local-lyrics-card-title">${escapeHtml(record.title)}</p>
                    <p class="local-lyrics-card-meta">${escapeHtml(record.artist)} · ${record.status} · ${progress}</p>
                    <p class="local-lyrics-card-meta">Updated ${new Date(record.updatedAt).toLocaleDateString()}</p>
                </button>`;
        }).join('');
    }

    private openLocalLyricsLibrary(): void {
        const popup = document.getElementById('local-lyrics-library-popup');
        if (popup) popup.style.display = 'flex';
        this.renderLocalLyricsLibrary();
    }

    private closeLocalLyricsLibrary(): void {
        const popup = document.getElementById('local-lyrics-library-popup');
        if (popup) popup.style.display = 'none';
    }

    private async openLocalLyricsDetail(trackId: string): Promise<void> {
        const record = await localLyricsStore.get(trackId);
        if (!record) return;
        this.libraryTrackId = trackId;
        const popup = document.getElementById('local-lyrics-detail-popup');
        const title = document.getElementById('local-lyrics-detail-title');
        const meta = document.getElementById('local-lyrics-detail-meta');
        const sync = document.getElementById('local-lyrics-detail-sync');
        const copy = document.getElementById('local-lyrics-detail-copy') as HTMLButtonElement | null;
        const exportButton = document.getElementById('local-lyrics-detail-export') as HTMLButtonElement | null;
        if (title) title.textContent = record.title;
        if (meta) meta.textContent = `${record.artist} · ${record.album}\n${record.status} · ${record.lineTimestampsMs.length}/${parsePlainLyrics(record.plainLyrics).length} lines`;
        if (sync) sync.textContent = record.status === 'complete' ? 'Re-time LRC' : 'Continue LRC';
        if (copy) copy.style.display = record.status === 'complete' ? 'block' : 'none';
        if (exportButton) exportButton.style.display = record.status === 'complete' ? 'block' : 'none';
        if (popup) popup.style.display = 'flex';
    }

    private closeLocalLyricsDetail(): void {
        const popup = document.getElementById('local-lyrics-detail-popup');
        if (popup) popup.style.display = 'none';
        this.libraryTrackId = undefined;
    }

    private async handleLocalLyricsAction(action: string, trackId: string): Promise<void> {
        if (action === 'details') {
            await this.openLocalLyricsDetail(trackId);
            return;
        }
        const record = await localLyricsStore.get(trackId);
        if (!record) return;
        if (action === 'sync') {
            if (spotifyPresenter.currentSong.songID !== trackId) {
                alert('Play this song in Spotify before resuming its sync session.');
                return;
            }
            if (await lyricsSyncPresenter.startSync(record.status === 'complete')) requestImmediateViewRefresh(spotifyPresenter.currentSong);
            this.closeLocalLyricsDetail();
        } else if (action === 'export') {
            this.downloadLrc(record);
        } else if (action === 'copy') {
            this.showLrcExport(record);
            await this.copyText(record.syncedLyrics);
        } else if (action === 'delete') {
            if (!window.confirm(`Delete local lyrics for ${record.title}?`)) return;
            await localLyricsStore.remove(trackId);
            this.closeLocalLyricsDetail();
            if (spotifyPresenter.currentSong.songID === trackId) {
                await lyricsPresenter.refreshLyrics(spotifyPresenter.currentSong);
                await lyricsSyncPresenter.prepareForSong(spotifyPresenter.currentSong, lyricsPresenter.getPlainLyrics(), lyricsPresenter.hasRemoteSyncedLyrics(), true);
            }
        }
        this.renderLyricsSyncControls();
        await this.renderLocalLyricsLibrary();
    }

    private showLrcExport(record: LocalLyricsRecord) {
        const popup = document.getElementById('lrc-export-popup');
        const title = document.getElementById('lrc-export-title');
        const textArea = document.getElementById('lrc-export-text') as HTMLTextAreaElement | null;
        if (title) title.textContent = `Export ${record.title}`;
        if (textArea) textArea.value = record.syncedLyrics;
        if (popup) popup.style.display = 'flex';
    }

    private openLrcImport(): void {
        const song = spotifyPresenter.currentSong;
        if (spotifyPresenter.getActiveSource() !== 'spotify' || !song.songID || song.songID === '0') {
            alert('Play the Spotify song that should receive this LRC first.');
            return;
        }
        const popup = document.getElementById('lrc-import-popup');
        const songLabel = document.getElementById('lrc-import-song');
        const input = document.getElementById('lrc-import-file') as HTMLInputElement | null;
        const text = document.getElementById('lrc-import-text') as HTMLTextAreaElement | null;
        if (songLabel) songLabel.textContent = `Import for: ${song.title} — ${song.artist}`;
        if (input) input.value = '';
        if (text) text.value = '';
        this.resetLrcImportConfirmation();
        this.setLrcImportStatus('');
        if (popup) popup.style.display = 'flex';
    }

    private closeLrcImport(): void {
        const popup = document.getElementById('lrc-import-popup');
        if (popup) popup.style.display = 'none';
        this.resetLrcImportConfirmation();
    }

    private resetLrcImportConfirmation(): void {
        this.lrcImportMetadataConfirmed = false;
        const button = document.getElementById('confirm-lrc-import');
        const warning = document.getElementById('lrc-import-warning');
        if (button) button.textContent = 'Import';
        if (warning) {
            warning.textContent = '';
            warning.style.display = 'none';
        }
    }

    private setLrcImportStatus(message: string): void {
        const status = document.getElementById('lrc-import-status');
        if (status) status.textContent = message;
    }

    private async importLrc(): Promise<void> {
        const song = spotifyPresenter.currentSong;
        if (spotifyPresenter.getActiveSource() !== 'spotify' || !song.songID || song.songID === '0') {
            this.setLrcImportStatus('Play the Spotify song that should receive this LRC first.');
            return;
        }
        const textArea = document.getElementById('lrc-import-text') as HTMLTextAreaElement | null;
        try {
            const imported = parseLrcImport(textArea?.value ?? '');
            const warnings = getLrcMetadataWarnings(imported, song);
            if (warnings.length > 0 && !this.lrcImportMetadataConfirmed) {
                const warning = document.getElementById('lrc-import-warning');
                const button = document.getElementById('confirm-lrc-import');
                if (warning) {
                    warning.textContent = `LRC metadata differs from Spotify:\n${warnings.map(item => `• ${item}`).join('\n')}`;
                    warning.style.display = 'block';
                }
                if (button) button.textContent = 'Import anyway';
                this.lrcImportMetadataConfirmed = true;
                this.setLrcImportStatus('Review the differences, then tap Import anyway to continue.');
                return;
            }

            const existing = await localLyricsStore.get(song.songID);
            if (existing && !window.confirm(`Replace the existing ${existing.status} local lyrics for this song?`)) {
                this.setLrcImportStatus('Import cancelled; existing local lyrics were kept.');
                return;
            }

            const record = createRecordFromLrcImport(song, imported);
            await localLyricsStore.save(record);
            await lyricsPresenter.refreshLyrics(song);
            await lyricsSyncPresenter.prepareForSong(
                song,
                record.plainLyrics,
                lyricsPresenter.hasRemoteSyncedLyrics(),
                true,
            );
            this.closeLrcImport();

            if (record.status === 'draft') {
                if (lyricsPresenter.hasRemoteSyncedLyrics()) {
                    alert('Plain lyrics were saved as a draft. Remote synced lyrics are already available, so the remote version remains active.');
                } else if (await lyricsSyncPresenter.startSync()) {
                    requestImmediateViewRefresh(song);
                }
            } else {
                requestImmediateViewRefresh(song);
            }
            this.renderLyricsSyncControls();
            await this.renderLocalLyricsLibrary();
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Could not import these lyrics';
            this.setLrcImportStatus(message);
        }
    }

    private downloadLrc(record: LocalLyricsRecord) {
        this.showLrcExport(record);
        const safeName = `${record.artist} - ${record.title}`.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
        const blob = new Blob([record.syncedLyrics], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${safeName}.lrc`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    private async copyText(value: string): Promise<void> {
        try {
            if (navigator.clipboard?.writeText && window.isSecureContext) {
                await navigator.clipboard.writeText(value);
                return;
            }
            const textArea = document.createElement('textarea');
            textArea.value = value;
            document.body.appendChild(textArea);
            textArea.select();
            document.execCommand('copy');
            textArea.remove();
        } catch (error) {
            console.error('Failed to copy LRC:', error);
            const textArea = document.getElementById('lrc-export-text') as HTMLTextAreaElement | null;
            textArea?.focus();
            textArea?.select();
        }
    }

    renderNavidromeClients() {
        const picker = document.getElementById('navidrome-client-picker');
        const list = document.getElementById('navidrome-client-list');
        if (!picker || !list) {
            return;
        }

        const isNavidrome = spotifyPresenter.getActiveSource() === 'navidrome';
        picker.style.display = isNavidrome ? 'flex' : 'none';
        if (!isNavidrome) {
            list.innerHTML = '';
            return;
        }

        const clients = navidromeModel.getPlaybackClients();
        const selectedClient = navidromeModel.getSelectedPlaybackClient();

        if (clients.length === 0) {
            list.innerHTML = '<p class="navidrome-client-empty">No active Navidrome clients found.</p>';
            return;
        }

        list.innerHTML = clients.map(client => {
            const isSelected = client.clientName === selectedClient;
            return `
                <button class="navidrome-client-card ${isSelected ? 'selected' : ''}" data-client-name="${escapeHtml(client.clientName)}">
                    <span class="navidrome-client-name">${escapeHtml(client.clientName)}</span>
                    <span class="navidrome-client-track">${escapeHtml(client.title)}</span>
                    <span class="navidrome-client-artist">${escapeHtml(client.artist)}</span>
                </button>
            `;
        }).join('');
    }
}

const viewPresenter = new ViewPresenter();
export default viewPresenter;
