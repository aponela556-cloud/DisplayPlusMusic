import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpotifyApi } from '@spotify/web-api-ts-sdk';
import { SpotifyModel } from './spotifyModel';

function createSdk(overrides: Record<string, unknown> = {}) {
    return {
        player: {
            getPlaybackState: vi.fn().mockResolvedValue({
                device: { id: 'phone-device', is_active: true, is_restricted: false },
            }),
            getAvailableDevices: vi.fn().mockResolvedValue({ devices: [] }),
            startResumePlayback: vi.fn().mockResolvedValue(undefined),
            pausePlayback: vi.fn().mockResolvedValue(undefined),
            seekToPosition: vi.fn().mockResolvedValue(undefined),
            ...overrides,
        },
    } as unknown as SpotifyApi;
}

describe('SpotifyModel playback controls', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('refreshes a stale device id before resuming playback', async () => {
        const sdk = createSdk();
        const model = new SpotifyModel(() => sdk);
        model.deviceId = 'stale-device';
        model.currentSong.addisPlaying(false);

        await expect(model.song_Play()).resolves.toBe(true);

        expect(sdk.player.startResumePlayback).toHaveBeenCalledWith('phone-device');
        expect(model.deviceId).toBe('phone-device');
        expect(model.currentSong.isPlaying).toBe(true);
    });

    it('falls back to an available unrestricted device', async () => {
        const sdk = createSdk({
            getPlaybackState: vi.fn().mockResolvedValue(null),
            getAvailableDevices: vi.fn().mockResolvedValue({
                devices: [
                    { id: 'restricted', is_active: true, is_restricted: true },
                    { id: 'desktop-device', is_active: false, is_restricted: false },
                ],
            }),
        });
        const model = new SpotifyModel(() => sdk);

        await expect(model.song_Play()).resolves.toBe(true);

        expect(sdk.player.startResumePlayback).toHaveBeenCalledWith('desktop-device');
        expect(model.currentSong.isPlaying).toBe(true);
    });

    it('does not report playing when Spotify rejects the command', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const sdk = createSdk({
            startResumePlayback: vi.fn().mockRejectedValue(new Error('403 Forbidden')),
        });
        const model = new SpotifyModel(() => sdk);
        model.currentSong.addisPlaying(false);

        await expect(model.song_Play()).resolves.toBe(false);

        expect(model.currentSong.isPlaying).toBe(false);
        expect(model.isPlaybackAvailable()).toBe(false);
    });
});
