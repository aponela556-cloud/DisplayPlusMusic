import { beforeEach, describe, expect, it, vi } from 'vitest';
import { storage } from '../utils/storage';
import { SpotifyRateLimitBlockedError, SpotifyRateLimitModel } from './spotifyRateLimitModel';

function mockStorage(values = new Map<string, string>()) {
    vi.spyOn(storage, 'getItem').mockImplementation(async key => values.get(key) ?? null);
    vi.spyOn(storage, 'setItem').mockImplementation(async (key, value) => { values.set(key, value); });
    vi.spyOn(storage, 'removeItem').mockImplementation(async key => { values.delete(key); });
    return values;
}

describe('SpotifyRateLimitModel', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('locks Spotify requests after a 429 and honors Retry-After', async () => {
        const values = mockStorage();
        const model = new SpotifyRateLimitModel();
        const now = 1_700_000_000_000;
        vi.spyOn(Date, 'now').mockReturnValue(now);

        model.observeResponse(new Response(JSON.stringify({ error: { reason: 'QUOTA_EXCEEDED' } }), {
            status: 429,
            headers: { 'Retry-After': '30', 'Content-Type': 'application/json' },
        }));
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(model.isBlocked()).toBe(true);
        expect(model.canRetry(now + 29_999)).toBe(false);
        expect(model.canRetry(now + 30_000)).toBe(true);
        expect(model.getState().reason).toBe('quota');
        expect(() => model.beforeRequest()).toThrow(SpotifyRateLimitBlockedError);
        expect(values.get('spotify_rate_limit_state_v1')).toContain('quota');
    });

    it('allows exactly one manual probe and clears the lock after a successful response', async () => {
        mockStorage();
        const model = new SpotifyRateLimitModel();
        model.observeResponse(new Response('', { status: 429 }));

        expect(model.beginManualRetry()).toBe(true);
        expect(() => model.beforeRequest()).not.toThrow();
        expect(() => model.beforeRequest()).toThrow(SpotifyRateLimitBlockedError);

        model.observeResponse(new Response(null, { status: 204 }));

        expect(model.isBlocked()).toBe(false);
        expect(model.canRetry()).toBe(false);
    });

    it('restores a persisted lock without automatically permitting Spotify requests', async () => {
        const values = mockStorage(new Map([
            ['spotify_rate_limit_state_v1', JSON.stringify({
                blocked: true,
                blockedUntilMs: 1_700_000_020_000,
                reason: 'rate_limit',
                updatedAtMs: 1_700_000_000_000,
            })],
        ]));
        const model = new SpotifyRateLimitModel();

        await model.init();

        expect(model.isBlocked()).toBe(true);
        expect(() => model.beforeRequest()).toThrow(SpotifyRateLimitBlockedError);
        expect(values.get('spotify_rate_limit_state_v1')).toBeDefined();
    });
});
