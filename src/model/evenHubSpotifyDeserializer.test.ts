import { describe, expect, it, vi } from 'vitest';
import { EvenHubSpotifyDeserializer } from './evenHubSpotifyDeserializer';

describe('EvenHubSpotifyDeserializer', () => {
    it('accepts a non-JSON body from a successful control response', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const response = new Response('xSAOiWfWEJ', {
            status: 200,
            headers: { 'content-type': 'text/plain' },
        });

        await expect(new EvenHubSpotifyDeserializer().deserialize(response)).resolves.toBeNull();
    });

    it('still parses normal Spotify JSON responses', async () => {
        const response = new Response('{"progress_ms":0}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });

        await expect(new EvenHubSpotifyDeserializer().deserialize(response)).resolves.toEqual({ progress_ms: 0 });
    });

    it('rejects malformed JSON returned with a JSON content type', async () => {
        const response = new Response('not-json', {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });

        await expect(new EvenHubSpotifyDeserializer().deserialize(response)).rejects.toThrow('Spotify returned invalid JSON');
    });
});
