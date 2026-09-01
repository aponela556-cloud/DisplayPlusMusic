import spotifyModel, { initSpotify } from '../model/spotifyModel';
import navidromeModel from '../model/navidromeModel';
import Song, { song_placeholder } from '../model/songModel';
import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk';
import { storage } from '../utils/storage';
import type { MusicSource } from '../model/musicSource';
import { createSyncDemoSong } from '../model/syncDemoModel';
import playbackOffsetModel from '../model/playbackOffsetModel';

class SpotifyPresenter {
    currentSong: Song = song_placeholder;
    nextSong?: Song;
    private activeSource: MusicSource = 'spotify';
    private readonly syncDemoMode = import.meta.env.DEV && new URLSearchParams(window.location.search).get('syncDemo') === '1';

    async pollSingle() {
        try {
            if (this.syncDemoMode) return;
            if (this.activeSource === 'navidrome') {
                this.currentSong = await navidromeModel.fetchCurrentTrack();
                this.nextSong = await navidromeModel.fetchNextTrack();
                return;
            }

            this.currentSong = await spotifyModel.fetchCurrentTrack();
            this.nextSong = await spotifyModel.fetchNextTrack();
        } catch (e) {
            console.error('[SpotifyPresenter] pollSingle error:', e);
        }
    }

    async fetchCurrentSong(): Promise<Song> {
        if (this.syncDemoMode) return this.currentSong;
        return this.activeSource === 'navidrome'
            ? navidromeModel.fetchCurrentTrack()
            : spotifyModel.fetchCurrentTrack();
    }

    getActiveSource(): MusicSource {
        return this.activeSource;
    }

    isSyncDemoMode(): boolean {
        return this.syncDemoMode;
    }

    isPlaybackAvailable(): boolean {
        return this.syncDemoMode || (this.activeSource === 'spotify' && spotifyModel.isPlaybackAvailable());
    }

    async initActiveSource(): Promise<void> {
        if (this.syncDemoMode) {
            this.activeSource = 'spotify';
            this.currentSong = createSyncDemoSong();
            const popup = document.getElementById('spotify-auth-popup');
            if (popup) popup.style.display = 'none';
            return;
        }
        const storedSource = (await storage.getItem('music_source')) as MusicSource | null;
        this.activeSource = storedSource ?? 'spotify';

        if (this.activeSource === 'navidrome') {
            const configured = await navidromeModel.init();
            if (!configured) {
                return;
            }
            return;
        }

        await initSpotify();
    }

    async startAuth(token: string) {
        const bridge = await waitForEvenAppBridge();
        bridge.setLocalStorage('spotify_refresh_token', token);
        initSpotify();
    }

    song_pauseplay() {
        if (this.syncDemoMode) {
            this.currentSong.toggleisPlaying();
            return;
        }
        if (this.activeSource === 'navidrome') {
            navidromeModel.song_Pause();
            return;
        }

        this.currentSong?.isPlaying ? spotifyModel.song_Pause() : spotifyModel.song_Play();
    }
    song_back() {
        if (this.activeSource === 'navidrome') {
            navidromeModel.song_Back();
            return;
        }
        spotifyModel.song_Back();
    }
    song_forward() {
        if (this.activeSource === 'navidrome') {
            navidromeModel.song_Forward();
            return;
        }
        spotifyModel.song_Forward();
    }

    async setNavidromeClient(clientName: string) {
        if (this.activeSource !== 'navidrome') {
            return;
        }

        await navidromeModel.setSelectedPlaybackClient(clientName);
        this.currentSong = await navidromeModel.fetchCurrentTrack();
    }

    async pausePlayback(): Promise<void> {
        if (this.syncDemoMode) {
            this.currentSong.addisPlaying(false);
            return;
        }
        if (this.activeSource === 'spotify') await spotifyModel.song_Pause();
    }

    async togglePlayback(): Promise<void> {
        if (this.syncDemoMode) {
            this.currentSong.toggleisPlaying();
            return;
        }
        if (this.activeSource !== 'spotify') return;
        if (this.currentSong.isPlaying) await spotifyModel.song_Pause();
        else await spotifyModel.song_Play();
    }

    async pauseAndSeekToBeginning(): Promise<boolean> {
        if (this.syncDemoMode) {
            this.currentSong.addisPlaying(false);
            this.currentSong.addProgressSeconds(Math.max(0, playbackOffsetModel.getOffsetSeconds()));
            return true;
        }
        if (this.activeSource !== 'spotify') return false;
        return spotifyModel.pauseAndSeekToBeginning();
    }

}

const spotifyPresenter = new SpotifyPresenter();
export default spotifyPresenter;
