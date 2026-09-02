import spotifyPresenter from './spotifyPresenter';
import navidromeModel from '../model/navidromeModel';
import { storage } from '../utils/storage';
import spotifyAuthModel from '../model/spotifyAuthModel';
import Song from '../model/songModel';
import { formatTime } from '../Scripts/formatTime';
import playbackOffsetModel, { OFFSET_STEP_MS } from '../model/playbackOffsetModel';
import localLyricsStore, { LocalLyricsRecord, parsePlainLyrics } from '../model/localLyricsModel';
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

class ViewPresenter {
    private lastSongID: string = ""
    private lastBlobUrl?: string;
    private lastLyricsSyncEditing = false;

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
        document.getElementById('skip-track')?.addEventListener('click', () => {
            this.forwardTrack();
        });
        document.getElementById('play-pause')?.addEventListener('click', async () => {
            await this.playPauseTrack();
        });
        document.getElementById('previous-track')?.addEventListener('click', () => {
            this.backTrack();
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
        document.getElementById('refresh-local-lyrics')?.addEventListener('click', () => {
            this.renderLocalLyricsLibrary();
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
            const record = await localLyricsStore.get(trackId);
            if (!record) return;

            if (action === 'sync') {
                if (spotifyPresenter.currentSong.songID !== trackId) {
                    alert('Play this song in Spotify before resuming its sync session.');
                    return;
                }
                if (await lyricsSyncPresenter.startSync(record.status === 'complete')) {
                    requestImmediateViewRefresh(spotifyPresenter.currentSong);
                }
            } else if (action === 'export') {
                this.downloadLrc(record);
            } else if (action === 'copy') {
                this.showLrcExport(record);
                await this.copyText(record.syncedLyrics);
            } else if (action === 'delete') {
                if (!window.confirm(`Delete local lyrics for ${record.title}?`)) return;
                await localLyricsStore.remove(trackId);
                if (spotifyPresenter.currentSong.songID === trackId) {
                    await lyricsPresenter.refreshLyrics(spotifyPresenter.currentSong);
                    await lyricsSyncPresenter.prepareForSong(
                        spotifyPresenter.currentSong,
                        lyricsPresenter.getPlainLyrics(),
                        lyricsPresenter.hasRemoteSyncedLyrics(),
                        true,
                    );
                }
            }
            this.renderLyricsSyncControls();
            await this.renderLocalLyricsLibrary();
        });

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

    forwardTrack() {
        if (lyricsSyncPresenter.isEditing()) return;
        spotifyPresenter.song_forward();
    }
    async playPauseTrack(): Promise<void> {
        if (lyricsSyncPresenter.isEditing()) {
            await lyricsSyncPresenter.togglePlayback();
            this.renderLyricsSyncControls();
            return;
        }
        spotifyPresenter.song_pauseplay();
    }
    backTrack() {
        if (lyricsSyncPresenter.isEditing()) return;
        spotifyPresenter.song_back();
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
        const list = document.getElementById('local-lyrics-list');
        if (!list) return;
        const records = await localLyricsStore.list();
        if (records.length === 0) {
            list.innerHTML = '<p class="local-lyrics-empty">No local lyrics yet.</p>';
            return;
        }
        list.innerHTML = records.map(record => {
            const completed = record.status === 'complete';
            const progress = `${record.lineTimestampsMs.length}/${parsePlainLyrics(record.plainLyrics).length} lines`;
            return `
                <article class="local-lyrics-card">
                    <p class="local-lyrics-card-title">${escapeHtml(record.title)}</p>
                    <p class="local-lyrics-card-meta">${escapeHtml(record.artist)} · ${record.status} · ${progress}</p>
                    <div class="local-lyrics-actions">
                        <button class="small-button" data-lyrics-action="sync" data-track-id="${escapeHtml(record.spotifyTrackId)}">${completed ? 'Re-time LRC' : 'Continue LRC'}</button>
                        ${completed ? `<button class="small-button accent" data-lyrics-action="export" data-track-id="${escapeHtml(record.spotifyTrackId)}">Export</button>` : ''}
                        ${completed ? `<button class="small-button" data-lyrics-action="copy" data-track-id="${escapeHtml(record.spotifyTrackId)}">Copy</button>` : ''}
                        <button class="small-button danger" data-lyrics-action="delete" data-track-id="${escapeHtml(record.spotifyTrackId)}">Delete</button>
                    </div>
                </article>`;
        }).join('');
    }

    private showLrcExport(record: LocalLyricsRecord) {
        const popup = document.getElementById('lrc-export-popup');
        const title = document.getElementById('lrc-export-title');
        const textArea = document.getElementById('lrc-export-text') as HTMLTextAreaElement | null;
        if (title) title.textContent = `Export ${record.title}`;
        if (textArea) textArea.value = record.syncedLyrics;
        if (popup) popup.style.display = 'flex';
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
