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
const PHOTOS_DIR = join(ROOT, 'photos');

loadDotEnv(join(ROOT, '.env'));

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
};
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif']);

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

async function serveFile(res, file) {
  try {
    const s = await stat(file);
    if (!s.isFile()) throw new Error('not a file');
    res.writeHead(200, {
      'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      'content-length': s.size,
    });
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
  const body = { size: count, type: 'IMAGE', withExif: true };
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
    if (path === '/api/photos') {
      const count = Math.min(100, Math.max(1, Number(url.searchParams.get('count')) || 20));
      return sendJson(res, 200, await getPhotos(count));
    }
    if (path.startsWith('/immich/thumb/') && IMMICH_ENABLED) {
      return await proxyImmichThumb(res, path.slice('/immich/thumb/'.length));
    }
    if (path.startsWith('/photos/')) {
      const file = safeJoin(PHOTOS_DIR, path.slice('/photos/'.length));
      return file ? serveFile(res, file) : res.writeHead(403).end();
    }
    const file = safeJoin(PUBLIC_DIR, path === '/' ? 'index.html' : path.slice(1));
    return file ? serveFile(res, file) : res.writeHead(403).end();
  } catch (err) {
    console.error(err);
    sendJson(res, 502, { error: String(err.message || err) });
  }
});

server.listen(PORT, () => {
  const source = IMMICH_ENABLED ? `Immich (${IMMICH_URL}${IMMICH_ALBUM_ID ? ', album ' + IMMICH_ALBUM_ID : ''})` : 'local ./photos or demo images';
  console.log(`Plate loader on http://localhost:${PORT}  —  source: ${source}`);
});
