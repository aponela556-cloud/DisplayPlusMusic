import { describe, expect, it } from 'vitest';
import { OsEventTypeList } from '@evenrealities/even_hub_sdk';
import { normalizeEvenHubEvent } from './evenHubEventModel';

describe('Even Hub event normalization', () => {
    it('keeps native parsed list events unchanged', () => {
        const event = {
            listEvent: {
                containerID: 2,
                containerName: 'buttons',
                currentSelectItemName: 'Start Sync',
                currentSelectItemIndex: 0,
                eventType: OsEventTypeList.CLICK_EVENT,
            },
        };
        expect(normalizeEvenHubEvent(event).listEvent).toMatchObject(event.listEvent);
    });

    it('parses the simulator jsonData event envelope', () => {
        const event = normalizeEvenHubEvent({
            listEvent: true,
            jsonData: {
                containerID: 2,
                containerName: 'buttons',
                currentSelectItemName: 'Start Sync',
                currentSelectItemIndex: 0,
                eventType: OsEventTypeList.CLICK_EVENT,
            },
        });
        expect(event.listEvent).toMatchObject({
            containerID: 2,
            containerName: 'buttons',
            currentSelectItemName: 'Start Sync',
            currentSelectItemIndex: 0,
            eventType: OsEventTypeList.CLICK_EVENT,
        });
    });
});
