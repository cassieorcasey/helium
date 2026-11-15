# Helium

Helium is a local music player that runs in the browser and borrows its look from the iPod, click wheel included. It reads a folder of audio files from the device, indexes their tags and cover art, and plays them from there. Nothing is uploaded and there is no account.

The code is plain HTML, CSS, and JavaScript with no dependencies and no build step.

## Running it

Open `index.html` in a browser, or serve the folder:

```bash
python3 -m http.server 8000
```

Then load `http://localhost:8000` and pick a music folder. Dropping a folder onto the window works too.

Chrome and Edge use the File System Access API, so the folder is remembered and reconnects with one click after a restart. Firefox and Safari ask for the folder again each session, but the cached index and cover art carry over.

## Formats

Helium reads tags from MP3 (ID3v1 and ID3v2.2 to 2.4), FLAC, Ogg Vorbis, Opus, MP4/M4A (AAC and ALAC), and WAV, with its own parser in `js/metadata.js`. It also reads bit depth, sample rate, bitrate, and duration without decoding the audio, which is where labels like `FLAC 24-bit / 96kHz` come from.

Playback depends on the browser's decoders. ALAC only plays in Safari. When a file can't be decoded, the player names the codec in a message and moves on to the next track.

## How it works

Indexing reads only the bytes it needs: tag headers, stream info, and embedded pictures. Results are cached in IndexedDB, keyed by path, size, and modification time, so rescanning an unchanged library is quick. Each album's cover art is stored once. When a file has no embedded picture, a `cover.jpg` or `folder.jpg` in the same folder is used instead.

The library groups tracks by artist, album (with disc numbers), and folder. Any `.m3u` or `.m3u8` file inside the music folder shows up as a playlist. Recently Added, Heavy Rotation, and Never Played are built from play counts kept in localStorage. A play counts once 30 seconds or half the track has been heard, whichever is shorter.

Playback alternates between two `<audio>` elements. While one track plays, the next one loads into the other element and starts on a short timer at the end of the current track. FLAC, WAV, and ALAC join without a gap; MP3 and AAC can keep a few milliseconds of encoder padding.

Lyrics come from a `.lrc` file with the same name as the track, or from lyrics embedded in the file. They sit on the back of the album art in Now Playing. Synced lines highlight and scroll along with playback, and clicking a line seeks to it.

The click wheel seeks one second per 15° detent, further when spun quickly, or changes the volume in volume mode. Each detent can fire a short vibration and a synthesized click, and both can be switched off in Settings. Arrow keys and the mouse wheel drive it as well.

Panels move on a spring (stiffness 380, damping 32, mass 1). When the system asks for reduced motion, the spring is replaced by a 150 ms cross-fade. The Now Playing panel can be dragged down to close on small screens.

Track info and playback controls are exposed to the operating system through the Media Session API, and the last queue and position come back on the next visit.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `Space` | Play or pause |
| `←` / `→` | Back or forward 5 seconds |
| `Shift` + `←` / `→` | Previous or next track |
| `↑` / `↓` | Volume up or down 5% |
| `L` | Show or hide lyrics |
| `⌘/Ctrl` + `F` | Search the library |
| `Esc` | Close the open panel or go back |

## Icon

The app icon is an abstracted click wheel with a glass orb raised slightly above its center. `assets/icon/` holds the light and dark 1024 px masters, a simplified version for 16 to 32 px that follows the system theme, a monochrome version, and PNG exports for the web manifest, the iOS home screen, and favicons. Inside the app the logo is drawn from inline SVG symbols that read `--logo-*` CSS tokens, so it switches with the theme chosen in Settings.

## Layout

```
index.html            markup, SVG icons and logo, settings dialog
manifest.webmanifest  web app manifest
assets/icon/          icon sources and PNG exports
css/helium.css        light and dark tokens, glass bar, desktop and compact layouts
js/metadata.js        tag and stream parser
js/store.js           IndexedDB (folder handle, metadata cache, cover art) and localStorage
js/library.js         scanning, indexing, collections, smart playlists, play counts
js/engine.js          two-element playback engine
js/lrc.js             .lrc parser
js/motion.js          spring physics
js/wheel.js           click wheel input
js/app.js             navigation, views, queue, Now Playing, shortcuts
anti-slop/            UI and copy audit with open findings
```

`js/metadata.js` also works in Node: `require('./js/metadata.js').parse(file)` accepts a `File` or `Blob`.
