import { evenHubEventFromJson, type EvenHubEvent } from '@evenrealities/even_hub_sdk';

export function normalizeEvenHubEvent(event: EvenHubEvent | unknown): EvenHubEvent {
    if (event && typeof event === 'object') {
        const raw = event as EvenHubEvent & Record<string, unknown>;
        if (raw.jsonData && typeof raw.jsonData === 'object') {
            for (const type of ['listEvent', 'textEvent', 'sysEvent', 'audioEvent'] as const) {
                if (type in raw) return evenHubEventFromJson({ type, jsonData: raw.jsonData });
            }
        }
        if (
            (raw.listEvent && typeof raw.listEvent === 'object') ||
            (raw.textEvent && typeof raw.textEvent === 'object') ||
            (raw.sysEvent && typeof raw.sysEvent === 'object') ||
            (raw.audioEvent && typeof raw.audioEvent === 'object')
        ) return raw;
    }
    return evenHubEventFromJson(event);
}
