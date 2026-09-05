import { storage } from '../utils/storage';

const STORAGE_KEY = 'spotify_rate_limit_state_v1';

export type SpotifyRateLimitReason = 'rate_limit' | 'quota' | 'unknown';

export interface SpotifyRateLimitState {
    blocked: boolean;
    blockedUntilMs?: number;
    reason?: SpotifyRateLimitReason;
    updatedAtMs?: number;
}

function parseRetryAfterMs(value: string | null, now: number): number | undefined {
    if (!value) return undefined;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return now + seconds * 1000;
    const date = Date.parse(value);
    return Number.isNaN(date) ? undefined : date;
}

function parseReason(body: unknown): SpotifyRateLimitReason {
    const payload = typeof body === 'object' && body !== null ? body as {
        reason?: unknown;
        error?: { reason?: unknown };
    } : undefined;
    const reason = String(payload?.reason ?? payload?.error?.reason ?? '').toUpperCase();
    return reason.includes('QUOTA') ? 'quota' : 'rate_limit';
}

export class SpotifyRateLimitModel {
    private state: SpotifyRateLimitState = { blocked: false };
    private manualRetryPermit = false;
    private listeners = new Set<() => void>();

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    async init(): Promise<void> {
        const raw = await storage.getItem(STORAGE_KEY);
        if (!raw) return;
        try {
            const parsed = JSON.parse(raw) as Partial<SpotifyRateLimitState>;
            if (parsed.blocked === true) {
                this.state = {
                    blocked: true,
                    blockedUntilMs: typeof parsed.blockedUntilMs === 'number' ? parsed.blockedUntilMs : undefined,
                    reason: parsed.reason === 'quota' || parsed.reason === 'rate_limit' ? parsed.reason : 'unknown',
                    updatedAtMs: typeof parsed.updatedAtMs === 'number' ? parsed.updatedAtMs : undefined,
                };
                this.notify();
            }
        } catch {
            await storage.removeItem(STORAGE_KEY);
        }
    }

    getState(): SpotifyRateLimitState {
        return { ...this.state };
    }

    isBlocked(): boolean {
        return this.state.blocked;
    }

    canRetry(now = Date.now()): boolean {
        return this.state.blocked && (!this.state.blockedUntilMs || now >= this.state.blockedUntilMs);
    }

    beginManualRetry(now = Date.now()): boolean {
        if (!this.canRetry(now)) return false;
        this.manualRetryPermit = true;
        return true;
    }

    beforeRequest(): void {
        if (!this.state.blocked) return;
        if (this.manualRetryPermit) {
            this.manualRetryPermit = false;
            return;
        }
        throw new SpotifyRateLimitBlockedError(this.getStatusMessage());
    }

    observeResponse(response: Response): void {
        if (response.status >= 200 && response.status < 300) {
            if (this.state.blocked) this.clear();
            return;
        }
        if (response.status !== 429) return;

        const now = Date.now();
        this.state = {
            blocked: true,
            blockedUntilMs: parseRetryAfterMs(response.headers.get('Retry-After'), now),
            reason: 'unknown',
            updatedAtMs: now,
        };
        this.manualRetryPermit = false;
        void this.persist();
        this.notify();

        void response.clone().json()
            .then(body => {
                if (!this.state.blocked) return;
                this.state = { ...this.state, reason: parseReason(body) };
                void this.persist();
                this.notify();
            })
            .catch(() => undefined);
    }

    getStatusMessage(now = Date.now()): string {
        if (!this.state.blocked) return 'Spotify ready';
        if (this.state.blockedUntilMs && now < this.state.blockedUntilMs) {
            return `Spotify limited. Retry after ${new Date(this.state.blockedUntilMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`;
        }
        if (this.state.reason === 'quota') {
            return 'Spotify development quota reached. Retry manually later.';
        }
        return 'Spotify temporarily limited. Retry manually.';
    }

    private clear(): void {
        this.state = { blocked: false };
        this.manualRetryPermit = false;
        void storage.removeItem(STORAGE_KEY);
        this.notify();
    }

    private async persist(): Promise<void> {
        await storage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    }

    private notify(): void {
        this.listeners.forEach(listener => listener());
    }
}

export class SpotifyRateLimitBlockedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SpotifyRateLimitBlockedError';
    }
}

const spotifyRateLimitModel = new SpotifyRateLimitModel();
export default spotifyRateLimitModel;
