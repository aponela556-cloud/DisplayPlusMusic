# DisplayPlus Music
DisplayPlus Music is a media viewer for the Even Hub, displaying the current playing media on any device!

## Supported services
 - Spotify (premium subscription required)
 - Navidrome (popular self hosted media service)
     - Your server must be on at least **version 0.62**, along with a compatible client that implements the new PlaybackReport extension, such as the Web UI, Feishin on MacOS/Windows/Linux, Arpeggi on iOS, and Symphoniom on Android. Unsupported clients will cause weird playback state issues

## The app includes:
 - Song info (title, artist, etc.)
 - Album art
 - Playback progress
 - Realtime synced lyrics
 - Resilient LRCLIB fallback matching for alternate releases, remasters, live versions, and Traditional/Simplified Chinese titles
 - Clear status when only non-timestamped lyrics are available
 - Playback controls (Spotify only)

## Local lyrics sync (development feature)

When LRCLIB only has plain lyrics for the current Spotify track, DisplayPlus Music shows **Start Sync** (or **Resume Sync** for a saved draft). The editor pauses Spotify and seeks to the beginning. Click to play/pause, swipe down to timestamp the current line, swipe up to redo the previous line, and double click to save and exit.

Completed lyrics are stored in the Even Hub app's private local storage and take priority over remote plain lyrics. Remote synced lyrics always remain the first choice. The phone view can resume or restart a draft, save or cancel an editing session, and download or copy a completed UTF-8 LRC file for LRCGET.

To test without Spotify credentials, start the development server and open:

```text
http://localhost:5173/?syncDemo=1
```

The demo supports the simulator's Up, Down, Click, and Double Click events. A physical R1 is still required to validate real gesture timing and event de-duplication.


## Even hub testing QR code
<img src="src/Assets/githubpagesQR.png" alt="QR Code" width="300" />
