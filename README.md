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

When LRCLIB only has plain lyrics for the current Spotify track, the phone view shows **Create LRC** (or **Continue LRC** for a saved draft). Starting the editor pauses Spotify and seeks to the beginning. The phone provides Mark, Undo, Play/Pause, Save, and Cancel controls. Each Mark records the current line and advances the glasses display to the next line.

The glasses keep their original three playback controls during normal playback. While timing lyrics, they become a display-only editor showing the previous, current, and next lines; ring and temple events do not modify timestamps. Completed lyrics are stored in the Even Hub app's private local storage and take priority over remote plain lyrics. Remote synced lyrics always remain the first choice. The phone view can continue or restart a draft, save or cancel an editing session, and download or copy a completed UTF-8 LRC file for LRCGET.

To test without Spotify credentials, start the development server and open:

```text
http://localhost:5173/?syncDemo=1
```

The demo can exercise the full phone-controlled timing flow without Spotify credentials. The Even Hub simulator verifies the automatic switch between the original playback layout and the display-only editor; a physical G2 is still required to validate the final screen rebuild behavior.

On Windows, `Start-DisplayPlusMusic-SyncDemo.cmd` starts a LAN development server and displays a QR code for loading the same credential-free demo on a test phone. Keep the command window open during testing.


## Even hub testing QR code
<img src="src/Assets/githubpagesQR.png" alt="QR Code" width="300" />
