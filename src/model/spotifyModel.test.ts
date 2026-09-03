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
            skipToPrevious: vi.fn().mockResolvedValue(undefined),
            skipToNext: vi.fn().mockResolvedValue(undefined),
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

    it('refreshes a stale device id before skipping to the previous track', async () => {
        const sdk = createSdk();
        const model = new SpotifyModel(() => sdk);
        model.deviceId = 'stale-device';

        await expect(model.song_Back()).resolves.toBe(true);

        expect(sdk.player.skipToPrevious).toHaveBeenCalledWith('phone-device');
        expect(model.deviceId).toBe('phone-device');
    });

    it('refreshes a stale device id before skipping to the next track', async () => {
        const sdk = createSdk();
        const model = new SpotifyModel(() => sdk);
        model.deviceId = 'stale-device';

        await expect(model.song_Forward()).resolves.toBe(true);

        expect(sdk.player.skipToNext).toHaveBeenCalledWith('phone-device');
        expect(model.deviceId).toBe('phone-device');
    });

    it('confirms seek before pausing when preparing lyric timing', async () => {
        const commandOrder: string[] = [];
        const sdk = createSdk({
            getPlaybackState: vi.fn()
                .mockResolvedValueOnce({
                    device: { id: 'phone-device', is_active: true, is_restricted: false },
                    is_playing: true,
                    progress_ms: 20_000,
                })
                .mockResolvedValueOnce({
                    device: { id: 'phone-device', is_active: true, is_restricted: false },
                    is_playing: true,
                    progress_ms: 500,
                })
                .mockResolvedValueOnce({
                    device: { id: 'phone-device', is_active: true, is_restricted: false },
                    is_playing: false,
                    progress_ms: 500,
                }),
            seekToPosition: vi.fn().mockImplementation(async () => { commandOrder.push('seek'); }),
            pausePlayback: vi.fn().mockImplementation(async () => { commandOrder.push('pause'); }),
        });
        const model = new SpotifyModel(() => sdk, async () => undefined);
        model.currentSong.addisPlaying(true);
        model.currentSong.addProgressSeconds(20);

        await expect(model.pauseAndSeekToBeginning()).resolves.toEqual({ ok: true });

        expect(commandOrder).toEqual(['seek', 'pause']);
        expect(sdk.player.seekToPosition).toHaveBeenCalledWith(0, 'phone-device');
        expect(sdk.player.pausePlayback).toHaveBeenCalledWith('phone-device');
        expect(model.currentSong.isPlaying).toBe(false);
        expect(model.currentSong.progressSeconds).toBe(0);
    });

    it('reports a seek failure without attempting pause', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const sdk = createSdk({
            seekToPosition: vi.fn().mockRejectedValue(new Error('seek rejected')),
        });
        const model = new SpotifyModel(() => sdk, async () => undefined);

        const result = await model.pauseAndSeekToBeginning();

        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.stage).toBe('seek');
        expect(sdk.player.seekToPosition).toHaveBeenCalledTimes(4);
        expect(sdk.player.pausePlayback).not.toHaveBeenCalled();
    });

    it('shows a redacted seek error summary when Spotify returns an unknown failure', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const sdk = createSdk({
            seekToPosition: vi.fn().mockRejectedValue(
                new Error('WebView transport denied; access_token=secret-value'),
            ),
        });
        const model = new SpotifyModel(() => sdk, async () => undefined);

        const result = await model.pauseAndSeekToBeginning();

        expect(result).toEqual({
            ok: false,
            stage: 'seek',
            message: 'Spotify seek failed (WebView transport denied; access_token=[redacted]) - tap Retry Reset',
        });
    });

    it('reports a pause failure after the start position is confirmed', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const sdk = createSdk({
            getPlaybackState: vi.fn().mockResolvedValue({
                device: { id: 'phone-device', is_active: true, is_restricted: false },
                is_playing: true,
                progress_ms: 0,
            }),
            pausePlayback: vi.fn().mockRejectedValue(new Error('pause rejected')),
        });
        const model = new SpotifyModel(() => sdk, async () => undefined);

        const result = await model.pauseAndSeekToBeginning();

        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.stage).toBe('pause');
        expect(sdk.player.seekToPosition).toHaveBeenCalledTimes(2);
        expect(sdk.player.pausePlayback).toHaveBeenCalledTimes(2);
    });

    it('allows Spotify extra time to report a reset on an active device', async () => {
        const stalePlayback = {
            device: { id: 'rotated-device', is_active: true, is_restricted: false },
            is_playing: true,
            progress_ms: 20_000,
        };
        const resetPlayback = {
            device: { id: 'rotated-device', is_active: true, is_restricted: false },
            is_playing: true,
            progress_ms: 1_500,
        };
        const pausedPlayback = {
            device: { id: 'rotated-device', is_active: true, is_restricted: false },
            is_playing: false,
            progress_ms: 1_500,
        };
        const sdk = createSdk({
            getPlaybackState: vi.fn()
                .mockResolvedValueOnce({
                    device: { id: 'phone-device', is_active: true, is_restricted: false },
                    is_playing: true,
                    progress_ms: 20_000,
                })
                .mockResolvedValueOnce(stalePlayback)
                .mockResolvedValueOnce(stalePlayback)
                .mockResolvedValueOnce(stalePlayback)
                .mockResolvedValueOnce(stalePlayback)
                .mockResolvedValueOnce(stalePlayback)
                .mockResolvedValueOnce(stalePlayback)
                .mockResolvedValueOnce(resetPlayback)
                .mockResolvedValueOnce(pausedPlayback),
        });
        const model = new SpotifyModel(() => sdk, async () => undefined);

        await expect(model.pauseAndSeekToBeginning()).resolves.toEqual({ ok: true });

        expect(sdk.player.seekToPosition).toHaveBeenCalledWith(0, 'phone-device');
        expect(sdk.player.pausePlayback).toHaveBeenCalledWith('rotated-device');
    });

    it('retries the active Spotify player when the reported device rejects seek', async () => {
        const sdk = createSdk({
            getPlaybackState: vi.fn()
                .mockResolvedValueOnce({
                    device: { id: 'stale-device', is_active: true, is_restricted: false },
                    is_playing: true,
                    progress_ms: 8_000,
                })
                .mockResolvedValueOnce({
                    device: { id: 'active-device', is_active: true, is_restricted: false },
                    is_playing: true,
                    progress_ms: 0,
                })
                .mockResolvedValueOnce({
                    device: { id: 'active-device', is_active: true, is_restricted: false },
                    is_playing: true,
                    progress_ms: 0,
                })
                .mockResolvedValueOnce({
                    device: { id: 'active-device', is_active: true, is_restricted: false },
                    is_playing: false,
                    progress_ms: 0,
                }),
            seekToPosition: vi.fn()
                .mockRejectedValueOnce(new Error('404 device not found'))
                .mockResolvedValueOnce(undefined),
        });
        const model = new SpotifyModel(() => sdk, async () => undefined);

        await expect(model.pauseAndSeekToBeginning()).resolves.toEqual({ ok: true });

        expect(sdk.player.seekToPosition).toHaveBeenNthCalledWith(1, 0, 'stale-device');
        expect(sdk.player.seekToPosition).toHaveBeenNthCalledWith(2, 0);
        expect(sdk.player.pausePlayback).toHaveBeenCalledWith('active-device');
    });
});
