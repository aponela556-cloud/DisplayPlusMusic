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
            if (eventType === undefined && normalizedEvent.textEvent) {
                // Simulator 0.6.2 omits CLICK_EVENT for text containers.
                await lyricsSyncPresenter.togglePlayback();
                return;
            }
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

        if (normalizedEvent.listEvent && (eventType === undefined || eventType === OsEventTypeList.CLICK_EVENT)) {
            if (spotifyPresenter.getActiveSource() === 'navidrome') return;
            const selectedName = normalizedEvent.listEvent.currentSelectItemName?.trim();
            if (selectedName === 'Start Sync' || selectedName === 'Resume Sync') {
                await lyricsSyncPresenter.startSync();
                return;
            }
            const syncActionVisible = Boolean(lyricsSyncPresenter.getActionLabel());
            if (
                syncActionVisible &&
                normalizedEvent.listEvent.currentSelectItemName === undefined &&
                normalizedEvent.listEvent.currentSelectItemIndex === undefined
            ) {
                // Simulator 0.6.2 emits only the list container identity on Click.
                // In sync demo mode Start/Resume Sync is deliberately the first item.
                await lyricsSyncPresenter.startSync();
                return;
            }
            switch (normalizedEvent.listEvent.currentSelectItemIndex) {
                case 0:
                    if (syncActionVisible) await lyricsSyncPresenter.startSync();
                    else spotifyPresenter.song_back();
                    break;
                case 1:
                    if (syncActionVisible) spotifyPresenter.song_back();
                    else spotifyPresenter.song_pauseplay();
                    break;
                case 2:
                    if (syncActionVisible) spotifyPresenter.song_pauseplay();
                    else spotifyPresenter.song_forward();
                    break;
                case 3:
                    if (syncActionVisible) spotifyPresenter.song_forward();
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
