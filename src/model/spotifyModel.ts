import { SpotifyApi, Track, Episode } from '@spotify/web-api-ts-sdk';
import Song, { song_placeholder } from '../model/songModel';
import { setPlaceholderLoginHint } from '../model/songModel';
import { downloadImageAsGrayscalePng, downloadImage } from './imageModel';
import { storage } from '../utils/storage';
import spotifyAuthModel from './spotifyAuthModel';
import playbackOffsetModel from './playbackOffsetModel';
import { EvenHubSpotifyDeserializer } from './evenHubSpotifyDeserializer';

const PLAYBACK_RESET_POSITION_MS = 0;
const PLAYBACK_RESET_CONFIRMATION_ATTEMPTS = 12;
const PLAYBACK_RESET_CONFIRMATION_INTERVAL_MS = 250;
const PLAYBACK_RESET_MAX_CONFIRMED_POSITION_MS = 3_000;
const PREVIOUS_RESTART_THRESHOLD_MS = 3_000;

function clampProgress(seconds: number, durationSeconds: number): number {
    const clamped = durationSeconds > 0 ? Math.min(seconds, durationSeconds) : seconds;
    return Math.max(0, clamped);
}

let spotifysdk!: SpotifyApi;

export async function initSpotify(): Promise<void> {
    const clientId = await storage.getItem('spotify_client_id');
    const clientSecret = await storage.getItem('spotify_client_secret');
    const codeData = await spotifyAuthModel.checkForAuthCode();

    let refreshToken: string | null = null;
    try {
        const stored = await storage.getItem('spotify_refresh_token');
        if (stored && stored.length > 20) refreshToken = stored;
    } catch (e) {
        console.error('Error reading refresh token:', e);
    }

    if (!clientId || !clientSecret) {
        console.error('Spotify credentials not set');
        setPlaceholderLoginHint(true);
        return;
    }

    document.getElementById('spotify-auth-popup')!.style.display = 'none';

    const exchangeRefreshToken = async (token: string) => {
        const response = await fetch('https://accounts.spotify.com/api/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': 'Basic ' + btoa(`${clientId}:${clientSecret}`),
            },
            body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token }),
        });
        const data = await response.json();
        if (!data.access_token) throw new Error('Auth failed: ' + JSON.stringify(data));
        return data;
    };

    try {
        let authData: any;

        if (codeData) {
            authData = codeData;
            if (authData.refresh_token) {
                refreshToken = authData.refresh_token;
                await storage.setItem('spotify_refresh_token', refreshToken!).catch(console.error);
                console.log('Initial refresh token saved.');
            }
        } else if (refreshToken) {
            authData = await exchangeRefreshToken(refreshToken);
        } else {
            console.error('No auth data available');
            setPlaceholderLoginHint(true);
            document.getElementById('spotify-auth-popup')!.style.display = 'flex';
            return;
        }

        setPlaceholderLoginHint(false);

        // Persist rotated refresh token if Spotify issued a new one
        if (authData.refresh_token && authData.refresh_token !== refreshToken) {
            refreshToken = authData.refresh_token;
            await storage.setItem('spotify_refresh_token', refreshToken!).catch(console.error);
        }

        spotifysdk = SpotifyApi.withAccessToken(
            clientId,
            {
                access_token: authData.access_token,
                token_type: authData.token_type ?? 'Bearer',
                expires_in: authData.expires_in,
                refresh_token: refreshToken ?? '',
                expires: Date.now() + authData.expires_in * 1000,
            },
            { deserializer: new EvenHubSpotifyDeserializer() },
        );

        console.log('Spotify SDK initialized.');
    } catch (e) {
        console.error('Spotify auth error:', e);
        setPlaceholderLoginHint(true);
        document.getElementById('spotify-auth-popup')!.style.display = 'flex';
    }
}

export class SpotifyModel {
    private lastSong = new Song();
    currentSong = new Song();
    deviceId = '';
    private playbackAvailable = false;

    constructor(
        private readonly getSdk: () => SpotifyApi = () => spotifysdk,
        private readonly wait: (milliseconds: number) => Promise<void> = milliseconds => (
            new Promise(resolve => setTimeout(resolve, milliseconds))
        ),
    ) {}

    isPlaybackAvailable(): boolean {
        return this.playbackAvailable;
    }

    async fetchCurrentTrack(): Promise<Song> {
        let result;
        try {
            result = await this.getSdk().player.getPlaybackState();
        } catch {
            this.playbackAvailable = false;
            return song_placeholder;
        }

        if (!result?.device?.id) {
            this.playbackAvailable = false;
            // Nothing playing — return last known song paused, or placeholder
            if (this.lastSong.songID !== '0') {
                this.lastSong.addisPlaying(false);
                return this.lastSong;
            }
            return song_placeholder;
        }

        if (this.deviceId !== result.device.id) {
            console.log(`Device ID: ${this.deviceId} → ${result.device.id}`);
            this.deviceId = result.device.id;
        }
        this.playbackAvailable = true;

        if (!result.item) return song_placeholder;

        if (result.item.type === 'track') {
            const track = result.item as Track;

            if (track.id !== this.lastSong.songID) {
                // New song — build it and return immediately; fetch art in background
                const song = new Song();
                song.addID(track.id);
                song.addTitle(track.name);
                song.addArtist(track.artists[0].name);
                song.addFeatures(track.artists.slice(1).map(a => a.name));
                song.addAlbum(track.album.name);
                song.addDurationSeconds(track.duration_ms / 1000);
                const rawProgress = result.progress_ms / 1000;
                song.addProgressSeconds(clampProgress(rawProgress + playbackOffsetModel.getOffsetSeconds(), song.durationSeconds));
                song.addisPlaying(result.is_playing);
                song.addChangedState(true);

                console.log(`Now playing: ${song.title} by ${song.artist}`);

                this.lastSong = song;
                this.currentSong = song;

                // Art fetch doesn't block — patches song object when ready
                this.fetchArtAsync(track, song);

                return song;
            }

            // Same song — update dynamic fields only
            if (this.lastSong.isPlaying !== result.is_playing) {
                console.log(result.is_playing
                    ? `Resumed: ${this.lastSong.title}`
                    : `Paused: ${this.lastSong.title}`
                );
            }
            this.lastSong.addisPlaying(result.is_playing);

            const serverProgress = result.progress_ms / 1000;
            const offsetSeconds = playbackOffsetModel.getOffsetSeconds();
            const estimatedRawProgress = this.lastSong.progressSeconds - offsetSeconds;
            const drift = Math.abs(serverProgress - estimatedRawProgress);
            if (drift > 0.5) {
                console.log(`[Spotify] Drift corrected: ${drift.toFixed(2)}s`);
                this.lastSong.addProgressSeconds(clampProgress(serverProgress + offsetSeconds, this.lastSong.durationSeconds));
            }

            this.lastSong.addChangedState(false);
            this.currentSong = this.lastSong;
            return this.lastSong;

        } else if (result.item.type === 'episode') {
            const episode = result.item as Episode;
            const song = new Song();
            song.type = 'Episode';
            song.addTitle(episode.name);
            song.addID(episode.id);
            console.log(`Now playing episode: ${episode.name}`);
            this.currentSong = song;
            return song;
        }

        return song_placeholder;
    }

    async fetchNextTrack(): Promise<Song | undefined> {
        try {
            const queue = await this.getSdk().player.getUsersQueue();
            const next = queue?.queue?.[0];
            if (next?.type === 'track') {
                const track = next as Track;
                const song = new Song();
                song.addID(track.id);
                song.addTitle(track.name);
                song.addArtist(track.artists[0].name);
                song.addFeatures(track.artists.slice(1).map(a => a.name));
                song.addAlbum(track.album.name);
                return song;
            }
        } catch {
            // Queue unavailable — not critical
        }
        return undefined;
    }

    private async fetchArtAsync(track: Track, song: Song): Promise<void> {
        try {
            const url = track.album.images[0].url;
            const [raw, color] = await Promise.all([
                downloadImageAsGrayscalePng(url, 144, 144),
                downloadImage(url, 120, 120),
            ]);
            // Only patch if this song is still current
            if (this.currentSong === song) {
                song.addArtRaw(raw);
                song.addArtColor(color);
                console.log(`[Spotify] Art ready for: ${song.title}`);
            }
        } catch (e) {
            console.error('[Spotify] Art fetch failed:', e);
        }
    }

    async song_Pause(): Promise<boolean> {
        const targetDeviceId = await this.resolvePlaybackDeviceId();
        if (!targetDeviceId) return false;
        try {
            await this.getSdk().player.pausePlayback(targetDeviceId);
            this.currentSong?.addisPlaying(false);
            this.playbackAvailable = true;
            return true;
        } catch (e) {
            console.error('Pause failed:', e);
            this.playbackAvailable = false;
            return false;
        }
    }

    async song_Play(): Promise<boolean> {
        const targetDeviceId = await this.resolvePlaybackDeviceId();
        if (!targetDeviceId) return false;
        try {
            await this.getSdk().player.startResumePlayback(targetDeviceId);
            this.currentSong?.addisPlaying(true);
            this.playbackAvailable = true;
            return true;
        } catch (e) {
            console.error('Play failed:', e);
            this.currentSong?.addisPlaying(false);
            this.playbackAvailable = false;
            return false;
        }
    }

    async pauseAndSeekToBeginning(): Promise<PlaybackResetResult> {
        let targetDeviceId = await this.resolvePlaybackDeviceId();
        if (!targetDeviceId) {
            return {
                ok: false,
                stage: 'device',
                message: 'Spotify device unavailable - open Spotify and tap Retry Reset',
            };
        }

        const sdk = this.getSdk();
        let lastFailure: PlaybackResetFailure = {
            ok: false,
            stage: 'seek',
            message: 'Could not seek Spotify to start - tap Retry Reset',
        };

        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                // Seek while the device is still active. Spotify does not guarantee
                // ordering between Player commands, so confirm this state before pausing.
                await this.seekToBeginning(sdk, targetDeviceId);
            } catch (error) {
                console.error('Seek to beginning failed:', error);
                lastFailure = {
                    ok: false,
                    stage: 'seek',
                    message: this.describeSeekFailure(error),
                };
                if (attempt === 0) await this.wait(250);
                continue;
            }

            const seekConfirmed = await this.waitForPlaybackState(playback => {
                const isAtStart = this.isPlaybackStateForReset(playback, targetDeviceId) &&
                    (playback.progress_ms ?? Number.POSITIVE_INFINITY) <= PLAYBACK_RESET_MAX_CONFIRMED_POSITION_MS;
                if (isAtStart && playback.device?.id) targetDeviceId = playback.device.id;
                return isAtStart;
            });
            if (!seekConfirmed) {
                lastFailure = {
                    ok: false,
                    stage: 'seek',
                    message: 'Spotify did not confirm the start position - tap Retry Reset',
                };
                continue;
            }

            try {
                await sdk.player.pausePlayback(targetDeviceId);
            } catch (error) {
                console.error('Pause after seek failed:', error);
                lastFailure = {
                    ok: false,
                    stage: 'pause',
                    message: 'Could not pause Spotify - tap Retry Reset',
                };
                if (attempt === 0) await this.wait(250);
                continue;
            }

            const pauseConfirmed = await this.waitForPlaybackState(playback => (
                this.isPlaybackStateForReset(playback, targetDeviceId) && playback.is_playing === false
            ));
            if (!pauseConfirmed) {
                lastFailure = {
                    ok: false,
                    stage: 'pause',
                    message: 'Spotify did not confirm pause - tap Retry Reset',
                };
                continue;
            }

            this.currentSong?.addisPlaying(false);
            this.currentSong?.addProgressSeconds(Math.max(0, playbackOffsetModel.getOffsetSeconds()));
            this.playbackAvailable = true;
            return { ok: true };
        }

        this.playbackAvailable = false;
        return lastFailure;
    }

    async song_Back(): Promise<PlaybackNavigationResult> {
        const sdk = this.getSdk();
        let playback: Awaited<ReturnType<SpotifyApi['player']['getPlaybackState']>> | null = null;
        try {
            playback = await sdk.player.getPlaybackState();
        } catch (error) {
            console.warn('Could not read Spotify playback state before Previous:', error);
        }

        const activeDeviceId = playback?.device?.id;
        const targetDeviceId = activeDeviceId && !playback?.device?.is_restricted
            ? activeDeviceId
            : await this.resolvePlaybackDeviceId();
        if (!targetDeviceId) {
            return { ok: false, changed: false, message: 'Spotify has no active player' };
        }

        this.deviceId = targetDeviceId;
        this.playbackAvailable = true;
        const currentTrackId = playback?.item?.id ?? this.currentSong?.songID;
        const currentProgressMs = playback?.progress_ms ?? (this.currentSong?.progressSeconds ?? 0) * 1000;

        // Match the familiar Spotify-player control: after the opening few
        // seconds, Previous restarts this song. Near its start, it moves to the
        // prior queue item. A fresh API playback state is used rather than the
        // rendered progress, which may be delayed by the display polling loop.
        if (currentProgressMs >= PREVIOUS_RESTART_THRESHOLD_MS) {
            try {
                await this.seekToBeginning(sdk, targetDeviceId);
                const restarted = await this.waitForPlaybackState(nextPlayback => (
                    this.isPlaybackStateForReset(nextPlayback, targetDeviceId) &&
                    (!currentTrackId || nextPlayback.item?.id === currentTrackId) &&
                    (nextPlayback.progress_ms ?? Number.POSITIVE_INFINITY) <= PLAYBACK_RESET_MAX_CONFIRMED_POSITION_MS
                ));
                if (restarted) {
                    this.currentSong?.addProgressSeconds(Math.max(0, playbackOffsetModel.getOffsetSeconds()));
                    return { ok: true, changed: true, message: 'Current track restarted' };
                }
                return { ok: true, changed: false, message: 'Spotify accepted restart, but playback did not reset' };
            } catch (error) {
                console.error('Restart current track failed:', error);
                return { ok: false, changed: false, message: 'Spotify rejected restart' };
            }
        }

        try {
            await sdk.player.skipToPrevious(targetDeviceId);
            const changed = await this.waitForPlaybackState(playback => {
                return Boolean(currentTrackId && playback.item?.id && playback.item.id !== currentTrackId);
            });
            return changed
                ? { ok: true, changed: true, message: 'Previous track started' }
                : {
                    ok: true,
                    changed: false,
                    message: 'Spotify accepted Previous, but playback did not change',
                };
        } catch (e) {
            console.error('Back failed:', e);
            return { ok: false, changed: false, message: 'Spotify rejected Previous' };
        }
    }

    async song_Forward(): Promise<boolean> {
        const targetDeviceId = await this.resolvePlaybackDeviceId();
        if (!targetDeviceId) return false;
        try {
            await this.getSdk().player.skipToNext(targetDeviceId);
            return true;
        } catch (e) {
            console.error('Forward failed:', e);
            return false;
        }
    }

    private async resolvePlaybackDeviceId(): Promise<string> {
        const sdk = this.getSdk();
        const cachedDeviceId = this.deviceId;

        try {
            const playback = await sdk.player.getPlaybackState();
            const activeDeviceId = playback?.device?.id;
            if (activeDeviceId && !playback.device.is_restricted) {
                this.deviceId = activeDeviceId;
                this.playbackAvailable = true;
                return activeDeviceId;
            }
        } catch (e) {
            console.warn('Could not refresh Spotify playback state:', e);
        }

        try {
            const response = await sdk.player.getAvailableDevices();
            const devices = response?.devices ?? [];
            const target = devices.find(device => device.is_active && device.id && !device.is_restricted)
                ?? devices.find(device => device.id === cachedDeviceId && !device.is_restricted)
                ?? devices.find(device => device.id && !device.is_restricted);
            if (target?.id) {
                this.deviceId = target.id;
                this.playbackAvailable = true;
                return target.id;
            }
        } catch (e) {
            console.warn('Could not refresh Spotify devices:', e);
        }

        if (cachedDeviceId) return cachedDeviceId;
        this.playbackAvailable = false;
        return '';
    }

    private async waitForPlaybackState(
        predicate: (playback: Awaited<ReturnType<SpotifyApi['player']['getPlaybackState']>>) => boolean,
    ): Promise<boolean> {
        for (let attempt = 0; attempt < PLAYBACK_RESET_CONFIRMATION_ATTEMPTS; attempt++) {
            try {
                const playback = await this.getSdk().player.getPlaybackState();
                if (playback && predicate(playback)) return true;
            } catch (error) {
                console.warn('Could not verify Spotify playback state:', error);
            }
            if (attempt < PLAYBACK_RESET_CONFIRMATION_ATTEMPTS - 1) {
                await this.wait(PLAYBACK_RESET_CONFIRMATION_INTERVAL_MS);
            }
        }
        return false;
    }

    private async seekToBeginning(sdk: SpotifyApi, targetDeviceId: string): Promise<void> {
        try {
            await sdk.player.seekToPosition(PLAYBACK_RESET_POSITION_MS, targetDeviceId);
        } catch (targetedError) {
            // A reported device ID can become stale while Spotify changes its
            // playback route. Retrying without it targets the active player.
            console.warn('Seek with the reported Spotify device failed; retrying active player:', targetedError);
            await sdk.player.seekToPosition(PLAYBACK_RESET_POSITION_MS);
        }
    }

    private describeSeekFailure(error: unknown): string {
        const detail = error instanceof Error ? error.message : String(error ?? '');
        if (/401|expired token|re-authenticate/i.test(detail)) {
            return 'Spotify authorisation expired - reconnect Spotify, then retry';
        }
        if (/403|premium|not allowed/i.test(detail)) {
            return 'Spotify rejected playback control - check Premium and reconnect Spotify';
        }
        if (/404|no active device|device not found/i.test(detail)) {
            return 'Spotify has no active player - open Spotify and play this song once, then retry';
        }
        if (/network|fetch|failed to fetch|timeout/i.test(detail)) {
            return 'Could not reach Spotify - check your network and tap Retry Reset';
        }
        const summary = this.safeErrorSummary(detail);
        return summary
            ? `Spotify seek failed (${summary}) - tap Retry Reset`
            : 'Could not seek Spotify to start - open Spotify, play this song once, then retry';
    }

    private safeErrorSummary(detail: string): string {
        return detail
            .replace(/bearer\s+[\w.-]+/gi, 'Bearer [redacted]')
            .replace(/(access[_-]?token|refresh[_-]?token|client[_-]?secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
            .replace(/[\r\n]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 96);
    }

    private isPlaybackStateForReset(
        playback: Awaited<ReturnType<SpotifyApi['player']['getPlaybackState']>>,
        targetDeviceId: string,
    ): boolean {
        // Spotify may rotate a device ID while a phone, car system, or desktop
        // changes its active playback route. The active playback state is the
        // state we need to time, even if its ID has changed since the command.
        return playback.device?.id === targetDeviceId || playback.device?.is_active === true;
    }
}

export type PlaybackResetStage = 'device' | 'seek' | 'pause';

export type PlaybackResetResult = { ok: true } | PlaybackResetFailure;

export interface PlaybackResetFailure {
    ok: false;
    stage: PlaybackResetStage;
    message: string;
}

export interface PlaybackNavigationResult {
    ok: boolean;
    changed: boolean;
    message: string;
}

const spotifyModel = new SpotifyModel();
export default spotifyModel;
