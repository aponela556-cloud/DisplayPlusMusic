import { OsEventTypeList, waitForEvenAppBridge } from '@evenrealities/even_hub_sdk';
import spotifyPresenter from './spotifyPresenter';
import lyricsSyncPresenter from './lyricsSyncPresenter';
import { normalizeEvenHubEvent } from '../model/evenHubEventModel';
import { showPlayerMessage } from './viewPresenter';

export async function eventHandler() {
    const bridge = await waitForEvenAppBridge();

    const unsubscribe = bridge.onEvenHubEvent(async event => {
        const normalizedEvent = normalizeEvenHubEvent(event);
        const eventType = normalizedEvent.textEvent?.eventType ??
            normalizedEvent.listEvent?.eventType ??
            normalizedEvent.sysEvent?.eventType;

        if (lyricsSyncPresenter.isEditing()) {
            // Lyrics timing is controlled from the phone. The glasses remain
            // display-only during editing so ring/touch events cannot add or
            // remove timestamps accidentally.
            return;
        }

        if (normalizedEvent.listEvent && (eventType === undefined || eventType === OsEventTypeList.CLICK_EVENT)) {
            if (spotifyPresenter.getActiveSource() === 'navidrome') return;
            const selectedIndex = normalizedEvent.listEvent.currentSelectItemIndex;
            const report = (message: string) => showPlayerMessage(message);
            const previous = async () => {
                report('PREVIOUS…');
                const result = await spotifyPresenter.song_back();
                report(result.changed ? 'PREVIOUS OK' : result.ok ? 'PREVIOUS: NO CHANGE' : 'PREVIOUS: REJECTED');
            };

            // The Even Hub list event uses 1 for the middle control and 2 for
            // the right control.  The left control can arrive with index 0 or
            // without an index/name at all on a physical device.  Preserve the
            // original DisplayPlus Music fallback: anything other than 1 or 2
            // is Previous.
            switch (selectedIndex) {
                case 1:
                    spotifyPresenter.song_pauseplay();
                    return;
                case 2:
                    await spotifyPresenter.song_forward();
                    return;
                default:
                    await previous();
                    return;
            }
        }

        if (eventType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
            console.log('double tap event, shutting down app');
            if (await bridge.shutDownPageContainer(1)) console.log('successful shutdown');
            else console.log('failed shutdown');
        }
    });

    return unsubscribe;
}
