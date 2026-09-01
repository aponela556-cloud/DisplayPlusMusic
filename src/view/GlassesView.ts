import {
    waitForEvenAppBridge,
    EvenAppBridge,
    CreateStartUpPageContainer,
    TextContainerProperty,
    ImageContainerProperty,
    ImageRawDataUpdate,
    ImageRawDataUpdateResult,
    StartUpPageCreateResult,
    RebuildPageContainer,
    TextContainerUpgrade,
    ListContainerProperty,
    ListItemContainerProperty,
} from '@evenrealities/even_hub_sdk';
import { formatTime } from '../Scripts/formatTime';
import Song from '../model/songModel';
import lyricsPresenter from '../presenter/lyricsPresenter';
import lyricsSyncPresenter from '../presenter/lyricsSyncPresenter';
import spotifyPresenter from '../presenter/spotifyPresenter';

const MAX_HEIGHT = 288;
const MAX_WIDTH = 576;
const IMAGE_RETRY_DELAY_MS = 3000;

let bridge: EvenAppBridge | null = null;
let isPageCreated = false;
let isUpdating = false;
let isSendingImage = false;
let lastSongID = '';
let lastRenderedMode = '';
let imageRetryAt = 0;
let lastSentSongInfoText = '';
let lastSentPlaybackBarText = '';
let lastSentSyncText = '';
let pendingSong: Song | null = null;

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
    return Promise.race([
        promise.catch(() => fallback),
        new Promise<T>(resolve => setTimeout(() => resolve(fallback), ms)),
    ]);
}

function buildNormalConfig(
    songInfoText: string,
    playbackBarText: string,
    showPlaybackButtons: boolean,
    syncActionLabel: string,
) {
    const playbackItems = ['◁◁', ' ▷ll', '▷▷'];
    const itemNames = syncActionLabel ? [syncActionLabel, ...playbackItems] : playbackItems;
    const listWidth = syncActionLabel ? 90 : 80;
    const songInfoX = showPlaybackButtons ? 155 + listWidth : 155;
    return {
        containerTotalNum: showPlaybackButtons ? 4 : 3,
        imageObject: [new ImageContainerProperty({
            xPosition: 2,
            yPosition: 2,
            width: 144,
            height: 144,
            containerID: 0,
            containerName: 'album-art',
        })],
        listObject: showPlaybackButtons ? [new ListContainerProperty({
            xPosition: 155,
            yPosition: 8,
            width: listWidth,
            height: 132,
            borderWidth: 0,
            borderRadius: 0,
            containerID: 2,
            containerName: 'buttons',
            isEventCapture: 1,
            itemContainer: new ListItemContainerProperty({
                itemCount: itemNames.length,
                itemName: itemNames,
                isItemSelectBorderEn: 1,
            }),
        })] : [],
        textObject: [
            new TextContainerProperty({
                xPosition: songInfoX,
                yPosition: 12,
                width: MAX_WIDTH - songInfoX + 2,
                height: 132,
                borderRadius: 12,
                borderWidth: 1,
                paddingLength: 16,
                containerID: 3,
                containerName: 'songInfo',
                content: songInfoText,
                isEventCapture: 0,
            }),
            new TextContainerProperty({
                xPosition: 0,
                yPosition: 150,
                width: MAX_WIDTH,
                height: MAX_HEIGHT - 150,
                borderRadius: 6,
                borderWidth: 0,
                containerID: 4,
                containerName: 'playbackBar',
                content: playbackBarText,
                isEventCapture: showPlaybackButtons ? 0 : 1,
            }),
        ],
    };
}

function buildSyncConfig(content: string) {
    return {
        containerTotalNum: 1,
        imageObject: [],
        listObject: [],
        textObject: [new TextContainerProperty({
            xPosition: 0,
            yPosition: 0,
            width: MAX_WIDTH,
            height: MAX_HEIGHT,
            borderRadius: 0,
            borderWidth: 0,
            paddingLength: 8,
            containerID: 10,
            containerName: 'syncEditor',
            content,
            isEventCapture: 1,
        })],
    };
}

async function sendImageAsync(song: Song): Promise<void> {
    if (isSendingImage || Date.now() < imageRetryAt) return;
    if (!song.albumArtRaw?.length || song.songID === lastSongID || lyricsSyncPresenter.isEditing()) return;
    isSendingImage = true;
    try {
        const result = await withTimeout(
            bridge!.updateImageRawData(new ImageRawDataUpdate({
                containerID: 0,
                containerName: 'album-art',
                imageData: song.albumArtRaw,
            })),
            8000,
            ImageRawDataUpdateResult.sendFailed,
        );
        if (result === ImageRawDataUpdateResult.success) {
            lastSongID = song.songID;
            imageRetryAt = 0;
        } else {
            imageRetryAt = Date.now() + IMAGE_RETRY_DELAY_MS;
        }
    } finally {
        isSendingImage = false;
    }
}

export async function createView(song: Song): Promise<void> {
    if (isUpdating) {
        pendingSong = song;
        return;
    }
    isUpdating = true;
    try {
        if (!bridge) {
            bridge = await withTimeout(waitForEvenAppBridge(), 3000, null);
            if (!bridge) return;
        }

        const editing = lyricsSyncPresenter.isEditing();
        const syncActionLabel = lyricsSyncPresenter.getActionLabel();
        const activeSource = spotifyPresenter.getActiveSource();
        const showPlaybackButtons = activeSource !== 'navidrome';
        const modeKey = editing ? 'sync-editor' : `${activeSource}:${syncActionLabel}`;
        const songInfoText = `${song.title}\n${song.artist}\n${song.album}`;
        const playbackBarText = `${formatTime(song.progressSeconds)}               -${formatTime(Math.max(0, song.durationSeconds - song.progressSeconds))}\n` +
            `${song.createPlaybackBar(MAX_WIDTH)}\n${lyricsPresenter.currentLineFormatted}\n           ${lyricsPresenter.nextLine}`;
        const syncText = lyricsSyncPresenter.getGlassesContent();
        const buildConfig = () => editing
            ? buildSyncConfig(syncText)
            : buildNormalConfig(songInfoText, playbackBarText, showPlaybackButtons, syncActionLabel);

        if (isPageCreated && lastRenderedMode !== modeKey) {
            let rebuilt = false;
            for (let attempt = 0; attempt < 3 && !rebuilt; attempt++) {
                rebuilt = await withTimeout(
                    bridge.rebuildPageContainer(new RebuildPageContainer(buildConfig())),
                    5000,
                    false,
                );
                if (!rebuilt && attempt < 2) await new Promise(resolve => setTimeout(resolve, 500));
            }
            if (rebuilt) {
                await new Promise(resolve => setTimeout(resolve, 800));
                lastRenderedMode = modeKey;
                lastSongID = '';
                imageRetryAt = 0;
                lastSentSongInfoText = songInfoText;
                lastSentPlaybackBarText = playbackBarText;
                lastSentSyncText = syncText;
            }
            return;
        }

        if (!isPageCreated) {
            const result = await withTimeout(
                bridge.createStartUpPageContainer(new CreateStartUpPageContainer(buildConfig())),
                5000,
                StartUpPageCreateResult.invalid,
            );
            if (result !== StartUpPageCreateResult.success && result !== StartUpPageCreateResult.invalid) return;
            isPageCreated = true;
            lastRenderedMode = modeKey;
            lastSentSongInfoText = songInfoText;
            lastSentPlaybackBarText = playbackBarText;
            lastSentSyncText = syncText;
        }

        if (editing) {
            if (syncText !== lastSentSyncText) {
                const ok = await withTimeout(
                    bridge.textContainerUpgrade(new TextContainerUpgrade({
                        containerID: 10,
                        containerName: 'syncEditor',
                        content: syncText,
                    })),
                    2000,
                    false,
                );
                if (ok) lastSentSyncText = syncText;
            }
            return;
        }

        if (songInfoText !== lastSentSongInfoText) {
            const ok = await withTimeout(
                bridge.textContainerUpgrade(new TextContainerUpgrade({
                    containerID: 3,
                    containerName: 'songInfo',
                    content: songInfoText,
                })),
                2000,
                false,
            );
            if (!ok) {
                await bridge.rebuildPageContainer(new RebuildPageContainer(buildConfig()));
                lastSongID = '';
                return;
            }
            lastSentSongInfoText = songInfoText;
        }

        if (playbackBarText !== lastSentPlaybackBarText) {
            const ok = await withTimeout(
                bridge.textContainerUpgrade(new TextContainerUpgrade({
                    containerID: 4,
                    containerName: 'playbackBar',
                    content: playbackBarText,
                })),
                2000,
                false,
            );
            if (ok) lastSentPlaybackBarText = playbackBarText;
        }

        if (song.albumArtRaw?.length && song.songID !== lastSongID) sendImageAsync(song);
    } catch (error) {
        console.error('[GlassesView] createView error:', error);
    } finally {
        isUpdating = false;
        const queuedSong = pendingSong;
        pendingSong = null;
        if (queuedSong) queueMicrotask(() => { void createView(queuedSong); });
    }
}

export function requestImmediateViewRefresh(song: Song): void {
    void createView(song);
}
