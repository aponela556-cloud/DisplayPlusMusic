import type { IResponseDeserializer } from '@spotify/web-api-ts-sdk';

/**
 * Even Hub's Android network bridge can turn Spotify's empty control response
 * into a successful response with a short non-JSON body. Spotify's SDK tries
 * to parse that body and throws even though the command reached Spotify.
 */
export class EvenHubSpotifyDeserializer implements IResponseDeserializer {
    async deserialize<TReturnType>(response: Response): Promise<TReturnType> {
        const text = await response.text();
        if (!text.trim()) return null as TReturnType;

        try {
            return JSON.parse(text) as TReturnType;
        } catch {
            const contentType = response.headers.get('content-type') ?? '';
            if (contentType.includes('application/json')) throw new Error('Spotify returned invalid JSON');
            console.warn('Ignoring non-JSON body from successful Spotify control request.');
            return null as TReturnType;
        }
    }
}
