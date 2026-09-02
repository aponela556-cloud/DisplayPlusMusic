import { OsEventTypeList, waitForEvenAppBridge } from '@evenrealities/even_hub_sdk';
import spotifyPresenter from './spotifyPresenter';
import lyricsSyncPresenter from './lyricsSyncPresenter';
import { normalizeEvenHubEvent } from '../model/evenHubEventModel';

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
            const selectedName = normalizedEvent.listEvent.currentSelectItemName?.trim();
            if (selectedName === '◁◁') spotifyPresenter.song_back();
            else if (selectedName === '▷ll' || selectedName === '▷Ⅱ') spotifyPresenter.song_pauseplay();
            else if (selectedName === '▷▷') spotifyPresenter.song_forward();
            if (selectedName) return;
            switch (normalizedEvent.listEvent.currentSelectItemIndex) {
                case 0:
                    spotifyPresenter.song_back();
                    break;
                case 1:
                    spotifyPresenter.song_pauseplay();
                    break;
                case 2:
                    spotifyPresenter.song_forward();
                    break;
            }
            return;
        }

        if (eventType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
            console.log('double tap event, shutting down app');
            if (await bridge.shutDownPageContainer(1)) console.log('successful shutdown');
            else console.log('failed shutdown');
        }
    });

    return unsubscribe;
}
