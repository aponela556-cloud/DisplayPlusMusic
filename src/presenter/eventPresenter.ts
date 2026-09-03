import { OsEventTypeList, waitForEvenAppBridge } from '@evenrealities/even_hub_sdk';
import spotifyPresenter from './spotifyPresenter';
import lyricsSyncPresenter from './lyricsSyncPresenter';
import { normalizeEvenHubEvent } from '../model/evenHubEventModel';
import { showPlaybackCommandStatus } from '../view/GlassesView';

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
            const selectedName = normalizedEvent.listEvent.currentSelectItemName?.trim();
            const previous = async () => {
                showPlaybackCommandStatus(spotifyPresenter.currentSong, 'PREVIOUS…');
                const result = await spotifyPresenter.song_back();
                showPlaybackCommandStatus(
                    spotifyPresenter.currentSong,
                    result.changed ? 'PREVIOUS OK' : result.ok ? 'PREVIOUS: NO CHANGE' : 'PREVIOUS: REJECTED',
                );
            };

            // The glasses can return a display-normalized item name. The index
            // is the stable identifier for this fixed three-button list.
            switch (selectedIndex) {
                case 0:
                    await previous();
                    return;
                case 1:
                    spotifyPresenter.song_pauseplay();
                    return;
                case 2:
                    await spotifyPresenter.song_forward();
                    return;
            }

            if (selectedName === '◁◁') await previous();
            else if (selectedName === '▷ll' || selectedName === '▷Ⅱ') spotifyPresenter.song_pauseplay();
            else if (selectedName === '▷▷') await spotifyPresenter.song_forward();
            else {
                const indexText = selectedIndex === undefined || selectedIndex === null
                    ? '-'
                    : String(selectedIndex);
                const nameText = selectedName ? selectedName.slice(0, 16) : '-';
                showPlaybackCommandStatus(
                    spotifyPresenter.currentSong,
                    `BUTTON i:${indexText} n:${nameText}`,
                    5000,
                );
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
