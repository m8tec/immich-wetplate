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

Create the API key in Immich under *Account Settings → API Keys*. It only needs read access to assets, plus albums if you use an album.

## URL parameters

| Parameter | Effect |
| --- | --- |
| `duration=12.5` | Seconds per photo |
| `count=30` | Photos fetched per batch |
| `t=5` | Freeze the cycle at this second, for tuning the look |
| `img=<url>&caption=...` | Show a single image only |
| `seed=0.42` | Use one fixed plate look (0–1) instead of a random one per photo |

## Timeline per photo (default 12.5 s)

| Time | Phase |
| --- | --- |
| 0–1.4 s | Fade in from black, very blurry |
| 0.4–3.2 s | Negative comes into focus |
| 2.8–~9 s | Positive develops from the edges inward, the negative lingers in the middle |
| ~5.6–7.7 s | Handwritten note appears |
| 9.9–11.8 s | Blur and fade to black |

## Plate looks

Each photo gets its own plate, generated from a random seed in `plateStyle()`:

- **Thin**: a narrow, slightly chipped edge.
- **Torn**: ragged lobes with a silvered rim and a peeled emulsion line.
- **Heavy**: thick, blotchy, burnt borders with ink blobs eating into the image.

On top of that, randomly: pour streaks, a dripping top edge, ink spatter, horizontal hairlines and a warm light leak. The border is part of the plate's density, so during the negative phase it shows up pale grey, as in the game.

All timing and look parameters are in the fragment shader in `public/app.js`.
