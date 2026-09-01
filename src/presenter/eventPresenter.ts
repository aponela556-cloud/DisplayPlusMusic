import { OsEventTypeList, waitForEvenAppBridge } from '@evenrealities/even_hub_sdk';
import spotifyPresenter from './spotifyPresenter';
import lyricsSyncPresenter from './lyricsSyncPresenter';

export async function eventHandler() {
    const bridge = await waitForEvenAppBridge();

    const unsubscribe = bridge.onEvenHubEvent(async event => {
        const eventType = event.textEvent?.eventType ??
            event.listEvent?.eventType ??
            event.sysEvent?.eventType;

        if (lyricsSyncPresenter.isEditing()) {
            switch (eventType) {
                case OsEventTypeList.CLICK_EVENT:
                    await lyricsSyncPresenter.togglePlayback();
                    return;
                case OsEventTypeList.SCROLL_BOTTOM_EVENT:
                    await lyricsSyncPresenter.markCurrentLine();
                    return;
                case OsEventTypeList.SCROLL_TOP_EVENT:
                    await lyricsSyncPresenter.undoLine();
                    return;
                case OsEventTypeList.DOUBLE_CLICK_EVENT:
                    await lyricsSyncPresenter.saveAndExit();
                    return;
                default:
                    return;
            }
        }

        if (event.listEvent && (eventType === undefined || eventType === OsEventTypeList.CLICK_EVENT)) {
            if (spotifyPresenter.getActiveSource() === 'navidrome') return;
            const selectedName = event.listEvent.currentSelectItemName?.trim();
            if (selectedName === 'Start Sync' || selectedName === 'Resume Sync') {
                await lyricsSyncPresenter.startSync();
                return;
            }
            switch (event.listEvent.currentSelectItemIndex) {
                case 0:
                    spotifyPresenter.song_back();
                    break;
                case 1:
                    spotifyPresenter.song_pauseplay();
                    break;
                case 2:
                    spotifyPresenter.song_forward();
                    break;
                case 3:
                    await lyricsSyncPresenter.startSync();
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
