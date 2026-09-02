# DisplayLyric Music

DisplayLyric Music is a private, independent music viewer for Even Hub. It shows the current track, album art, playback progress, lyrics, Spotify playback controls, and local LRC timing tools.

## Supported services

- Spotify (Premium required for playback controls)
- Navidrome (version 0.62 or later with a compatible PlaybackReport client)

## Local LRC timing

When LRCLIB provides only plain lyrics, the phone view offers **Create LRC** or **Continue LRC**. The editor pauses Spotify and seeks to the start, then provides Play/Pause, Mark, Undo, Save, and Cancel controls. Completed local LRC files are stored in Even Hub private storage and can be exported or copied for LRCGET.

For a credential-free test, start `Start-DisplayLyricMusic-SyncDemo.cmd` and scan its QR code. The demo URL is also available at:

```text
http://localhost:5173/?syncDemo=1
```

## Spotify setup

This project currently uses the existing OAuth callback:

```text
https://oliemanq.github.io/DisplayPlusMusic/
```

Keep that exact URI in your Spotify Developer Dashboard until DisplayLyric Music has its own deployed callback and the dashboard configuration is changed at the same time.

## Origin and licensing

DisplayLyric Music contains modified portions based on [DisplayPlus Music](https://github.com/Oliemanq/DisplayPlusMusic) by Oliemanq. The upstream package metadata declares the ISC License. See [NOTICE.md](NOTICE.md) for attribution and [LICENSE](LICENSE) for the ISC terms applying to original DisplayLyric Music contributions.

DisplayLyric Music is independent and is not affiliated with or endorsed by Oliemanq, Spotify, or Even Realities.

## Copyright and takedown requests

If you believe material in this project infringes your copyright or other rights, email [aponela556@gmail.com](mailto:aponela556@gmail.com). Include the relevant material, the rights claimed, and contact information. Reports will be reviewed promptly and material will be removed or disabled where appropriate. See [COPYRIGHT.md](COPYRIGHT.md).
