# immich-plate-loader

A loading-screen style slideshow for your [Immich](https://immich.app) library, modelled on the Red Dead Redemption 2 story-mode loading screens: each photo appears as a blurry negative, then develops into a sepia wet-plate photograph from the edges inward through a smoky front, holds for a moment, and fades to black.

Everything runs in the browser as a WebGL2 shader. A small Node server with no dependencies serves the page and talks to Immich, so the browser needs no CORS setup and never sees your API key.

## Start

```bash
cp .env.example .env   # optional, see below
npm start
```

Then open http://localhost:8787. Click or press `F` for fullscreen.

## Photo sources

The server picks the first source that is available:

1. **Immich**: set `IMMICH_URL` and `IMMICH_API_KEY` in `.env`. The server fetches random images through `POST /api/search/random` and proxies their preview thumbnails. Set `IMMICH_ALBUM_ID` to limit the photos to one album. The note in the corner shows the city and date from the EXIF data.
2. **Local folder**: image files in `./photos`. The note shows the file name.
3. **Demo**: random images from picsum.photos.

Create the API key in Immich under *Account Settings → API Keys*. It needs the permissions `asset.read` and `asset.view`, plus `album.read` if you use an album. Only photos from the timeline are shown: archived, hidden and locked-folder photos are left out. Tested against Immich 3.2.

## Background music

Put audio files (mp3, m4a, ogg, wav) into `./music`. They play in name order and loop. Browsers only allow sound after an interaction, so if autoplay is blocked the music starts on the first click or key press. Press `M` to mute. The folder is git-ignored.

## URL parameters

| Parameter | Effect |
| --- | --- |
| `duration=12` | Seconds per photo |
| `count=30` | Photos fetched per batch |
| `t=5` | Freeze the cycle at this second, for tuning the look |
| `img=<url>&caption=...` | Show a single image only |
| `dev=7` | Fixed development end in seconds |
| `artifacts=1` | Keep the plate artifacts on the finished positive, for tuning |
| `music=0` | No background music |
| `seed=0.42` | Use one fixed plate look (0–1) instead of a random one per photo |

## Timeline per photo (default 12 s)

Measured frame by frame from the game footage; `duration` scales all of it.

| Time | Phase |
| --- | --- |
| 0.2–2.4 s | Up from black as a blurry negative, sharp from about 2.6 s |
| 2.1 s – varies | Positive develops from the edges inward. The end varies per photo: mostly 5–6.5 s, sometimes up to 9 s, rarely 11.5 s |
| 9.2–10 s | Blur, always at the same time, even if the plate is still developing |
| 9.2–11.35 s | Fade to black |
| 11.35–12 s | Black |

## Plate looks

Each photo gets its own plate, generated from a random seed in `plateStyle()`:

- **Thin**: a narrow, slightly chipped edge.
- **Torn**: ragged lobes with a silvered rim and a peeled emulsion line.
- **Heavy**: thick, blotchy, burnt borders with ink blobs eating into the image.

On top of that, randomly: pour streaks, a dripping top edge, ink spatter, horizontal hairlines and a warm light leak. The wet, undeveloped plate carries pour lines (thin wavy contours with chains of small bubbles), patches of fine pitting, dust dots, lint, ink drops and hairline scratches. Like dirt on the plate they keep their polarity in the negative (dark dots stay dark) and fade out wherever the positive comes through. The border is part of the plate's density, so during the negative phase it shows up pale grey, as in the game.

All timing and look parameters are in the fragment shader in `public/app.js`.
