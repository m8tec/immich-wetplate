// Small zero-dependency server: serves the page and hands it a list of photos.
// Photo source, in order of preference:
//   1. Immich (IMMICH_URL + IMMICH_API_KEY set) — random assets, optionally from one album
//   2. Local files in ./photos
//   3. Demo images from picsum.photos

import { createServer } from 'node:http';
import { readdir, stat } from 'node:fs/promises';
import { existsSync, readFileSync, createReadStream } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');
loadDotEnv(join(ROOT, '.env'));

const PHOTOS_DIR = resolve(process.env.PHOTOS_DIR || join(ROOT, 'photos'));
const MUSIC_DIR = resolve(process.env.MUSIC_DIR || join(ROOT, 'music'));

const PORT = Number(process.env.PORT || 8787);
const IMMICH_URL = (process.env.IMMICH_URL || '').replace(/\/+$/, '');
const IMMICH_API_KEY = process.env.IMMICH_API_KEY || '';
const IMMICH_ALBUM_ID = process.env.IMMICH_ALBUM_ID || '';
const IMMICH_ENABLED = Boolean(IMMICH_URL && IMMICH_API_KEY);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
};
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif']);
const AUDIO_EXT = new Set(['.mp3', '.m4a', '.ogg', '.wav']);

function loadDotEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (!m || line.trim().startsWith('#')) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (!(m[1] in process.env)) process.env[m[1]] = value;
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

// Contained path join: refuses anything that escapes `base`.
function safeJoin(base, rel) {
  const full = resolve(base, '.' + sep + decodeURIComponent(rel));
  return full === base || full.startsWith(base + sep) ? full : null;
}

async function serveFile(req, res, file) {
  try {
    const s = await stat(file);
    if (!s.isFile()) throw new Error('not a file');
    const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream';
    // byte ranges, so audio can seek and loop
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m && (m[1] || m[2])) {
      const start = m[1] ? Number(m[1]) : Math.max(0, s.size - Number(m[2]));
      const end = m[1] && m[2] ? Math.min(Number(m[2]), s.size - 1) : s.size - 1;
      if (start > end || start >= s.size) {
        return res.writeHead(416, { 'content-range': `bytes */${s.size}` }).end();
      }
      res.writeHead(206, {
        'content-type': type,
        'content-length': end - start + 1,
        'content-range': `bytes ${start}-${end}/${s.size}`,
        'accept-ranges': 'bytes',
      });
      return createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { 'content-type': type, 'content-length': s.size, 'accept-ranges': 'bytes' });
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404).end('not found');
  }
}

// ---------- photo sources ----------

function immichCaption(asset) {
  const exif = asset.exifInfo || {};
  const place = exif.city || exif.state || exif.country || '';
  const when = exif.dateTimeOriginal || asset.localDateTime || asset.fileCreatedAt;
  const date = when
    ? new Date(when).toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' })
    : '';
  return [place, date].filter(Boolean).join(', ');
}

async function immichPhotos(count) {
  // timeline only: never archived, hidden or locked-folder photos
  const body = { size: count, type: 'IMAGE', visibility: 'timeline', withExif: true };
  if (IMMICH_ALBUM_ID) body.albumIds = [IMMICH_ALBUM_ID];
  const r = await fetch(`${IMMICH_URL}/api/search/random`, {
    method: 'POST',
    headers: { 'x-api-key': IMMICH_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Immich responded ${r.status}: ${await r.text()}`);
  const assets = await r.json();
  return assets.map((a) => ({ url: `/immich/thumb/${encodeURIComponent(a.id)}`, caption: immichCaption(a) }));
}

async function localPhotos(count) {
  if (!existsSync(PHOTOS_DIR)) return [];
  const files = (await readdir(PHOTOS_DIR)).filter((f) => IMAGE_EXT.has(extname(f).toLowerCase()));
  shuffle(files);
  return files.slice(0, count).map((f) => ({
    url: `/photos/${encodeURIComponent(f)}`,
    caption: f.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' '),
  }));
}

function demoPhotos(count) {
  return Array.from({ length: count }, () => {
    const seed = Math.random().toString(36).slice(2, 10);
    return { url: `https://picsum.photos/seed/${seed}/1920/1080`, caption: '' };
  });
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function getPhotos(count) {
  if (IMMICH_ENABLED) return { source: 'immich', photos: await immichPhotos(count) };
  const local = await localPhotos(count);
  if (local.length) return { source: 'local', photos: local };
  return { source: 'demo', photos: demoPhotos(count) };
}

async function proxyImmichThumb(res, id) {
  const r = await fetch(`${IMMICH_URL}/api/assets/${encodeURIComponent(id)}/thumbnail?size=preview`, {
    headers: { 'x-api-key': IMMICH_API_KEY },
  });
  if (!r.ok) return res.writeHead(r.status).end();
  res.writeHead(200, {
    'content-type': r.headers.get('content-type') || 'image/jpeg',
    'cache-control': 'private, max-age=86400',
  });
  res.end(Buffer.from(await r.arrayBuffer()));
}

// ---------- routes ----------

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  try {
    if (path === '/health') {
      return sendJson(res, 200, { ok: true, source: IMMICH_ENABLED ? 'immich' : 'local' });
    }
    if (path === '/api/photos') {
      const count = Math.min(100, Math.max(1, Number(url.searchParams.get('count')) || 20));
      return sendJson(res, 200, await getPhotos(count));
    }
    if (path.startsWith('/immich/thumb/') && IMMICH_ENABLED) {
      return await proxyImmichThumb(res, path.slice('/immich/thumb/'.length));
    }
    if (path === '/api/music') {
      // background music: every audio file in ./music, played in order and looped
      const files = existsSync(MUSIC_DIR)
        ? (await readdir(MUSIC_DIR)).filter((f) => AUDIO_EXT.has(extname(f).toLowerCase())).sort()
        : [];
      return sendJson(res, 200, { tracks: files.map((f) => `/music/${encodeURIComponent(f)}`) });
    }
    if (path.startsWith('/music/')) {
      const file = safeJoin(MUSIC_DIR, path.slice('/music/'.length));
      return file ? serveFile(req, res, file) : res.writeHead(403).end();
    }
    if (path.startsWith('/photos/')) {
      const file = safeJoin(PHOTOS_DIR, path.slice('/photos/'.length));
      return file ? serveFile(req, res, file) : res.writeHead(403).end();
    }
    const file = safeJoin(PUBLIC_DIR, path === '/' ? 'index.html' : path.slice(1));
    return file ? serveFile(req, res, file) : res.writeHead(403).end();
  } catch (err) {
    console.error(err);
    sendJson(res, 502, { error: String(err.message || err) });
  }
});

server.listen(PORT, () => {
  const source = IMMICH_ENABLED ? `Immich (${IMMICH_URL}${IMMICH_ALBUM_ID ? ', album ' + IMMICH_ALBUM_ID : ''})` : 'local ./photos or demo images';
  console.log(`Wetplate on http://localhost:${PORT}  —  source: ${source}`);
});
