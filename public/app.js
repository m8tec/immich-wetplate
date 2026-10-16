// Wet-plate "developing photo" loading screen, after the RDR2 story-mode loading screens.
// One cycle per photo: black → blurry negative → positive develops from the edges inward
// through a smoky boundary → finished sepia plate holds → fades to black.
//
// URL params: ?duration=12.5  seconds per photo
//             ?t=5            freeze the cycle at this time (for tuning)
//             ?count=30       photos fetched per batch
//             ?img=<url>      show only this image (&caption=... for the note)
//             ?seed=0.42      fixed plate look (0..1)

const params = new URLSearchParams(location.search);
const DURATION = Number(params.get('duration')) || 12.5;
const FREEZE = params.has('t') ? Number(params.get('t')) : null;
const BATCH = Number(params.get('count')) || 30;
const FIXED_IMG = params.get('img'); // show only this image (for tuning)
const FIXED_SEED = params.has('seed') ? Number(params.get('seed')) : null; // reuse one plate look

const canvas = document.getElementById('plate');
const captionEl = document.getElementById('caption');
const statusEl = document.getElementById('status');
const gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: false });

if (!gl) {
  statusEl.textContent = 'WebGL2 wird von diesem Browser nicht unterstützt.';
  throw new Error('WebGL2 unavailable');
}

// ---------- shader ----------

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;

uniform sampler2D uTex;
uniform vec2 uRes;      // canvas pixels
uniform vec2 uImg;      // image pixels
uniform float uT;       // seconds into the cycle
uniform float uDur;     // cycle length
uniform float uSeed;    // per-photo randomness
uniform float uClock;   // wall clock, for grain
uniform float uHasTex;

// per-plate look, generated in JS (see plateStyle)
uniform vec4 uBorder;   // base border width per side L, R, T, B (screen-height units)
uniform vec4 uEdge;     // lobe amplitude, lobe frequency, tear amplitude, edge softness
uniform vec4 uFx1;      // silver rim, pour streaks, dripping top edge, mottle
uniform vec4 uFx2;      // spatter amount, spatter x, spatter y, hairlines
uniform vec4 uLeak;     // light leak x, y, radius, strength
uniform vec4 uBlobs[4]; // ink blobs eating into the plate: x, y (uv), radius, on/off

// --- noise ---
float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x),
             mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += a * vnoise(p);
    p = p * 2.03 + vec2(17.1, 9.7);
    a *= 0.5;
  }
  return v;
}
float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

// cover-fit + slow push-in
vec2 imageUv(vec2 uv, float zoom) {
  float ca = uRes.x / uRes.y, ia = uImg.x / uImg.y;
  vec2 s = ca > ia ? vec2(1.0, ia / ca) : vec2(ca / ia, 1.0);
  vec2 p = (uv - 0.5) * s / zoom + 0.5;
  return vec2(p.x, 1.0 - p.y);
}

// soft blur: a ring of mip-level taps
vec3 sampleBlur(vec2 uv, float px) {
  float lod = log2(max(px, 1.0));
  vec2 r = vec2(px) / uRes;
  vec3 c = textureLod(uTex, uv, lod).rgb * 2.0;
  for (int i = 0; i < 8; i++) {
    float a = float(i) * 0.785398 + uSeed;
    c += textureLod(uTex, uv + vec2(cos(a), sin(a)) * r, lod).rgb;
  }
  return c / 10.0;
}

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

vec3 sepia(float l) {
  vec3 dark  = vec3(0.045, 0.040, 0.034);
  vec3 mid   = vec3(0.40, 0.365, 0.30);
  vec3 light = vec3(0.86, 0.82, 0.70);
  return l < 0.5 ? mix(dark, mid, l * 2.0) : mix(mid, light, l * 2.0 - 1.0);
}

// how far a border pushes inward at position s along one side
float edgeWobble(float s, float side) {
  float k = uSeed * 31.0 + side * 17.3;
  float lobes = (fbm(vec2(s * uEdge.y, k)) - 0.5) * 2.0 * uEdge.x;
  float tear  = (vnoise(vec2(s * 22.0, k + 3.0)) - 0.5) * 2.0 * uEdge.z;
  float chip  = (vnoise(vec2(s * 110.0, k + 7.0)) - 0.5) * 0.005;
  return lobes + tear + chip;
}

// signed distance into the plate (positive inside), in screen-height units
float plateDist(vec2 uv, vec2 q, float aspect) {
  float top = 1.0 - uv.y;
  float drip = uFx1.z * 0.03 * smoothstep(0.35, 1.0, vnoise(vec2(q.x * 11.0, uSeed * 5.0)))
             + uFx1.z * 0.012 * vnoise(vec2(q.x * 40.0, uSeed * 2.0));
  float dl = q.x - uBorder.x - edgeWobble(uv.y, 0.0);
  float dr = aspect - q.x - uBorder.y - edgeWobble(uv.y, 1.0);
  float dt = top - uBorder.z - edgeWobble(q.x, 2.0) - drip;
  float db = uv.y - uBorder.w - edgeWobble(q.x, 3.0);
  float d = smin(smin(dl, dr, 0.04), smin(dt, db, 0.04), 0.05);
  // 2D noise near the edge breaks up the straight-side look into ragged, eaten shapes
  vec2 w = vec2(fbm(q * 3.0 + uSeed * 11.0), fbm(q * 3.0 - uSeed * 5.0));
  float ragged = (fbm(q * 6.0 + w * 2.5 + uSeed * 3.0) - 0.5) * 2.0 * uEdge.x * 1.3;
  d += ragged * (1.0 - smoothstep(0.0, 0.15, d));
  for (int i = 0; i < 4; i++) {
    vec4 b = uBlobs[i];
    if (b.w < 0.5) continue;
    vec2 c = b.xy * vec2(aspect, 1.0);
    float wob = 0.55 + 0.9 * fbm((q - c) * 7.0 + float(i) * 4.1 + uSeed);
    d = smin(d, length(q - c) - b.z * wob, 0.02);
  }
  return d;
}

void main() {
  vec2 uv = vUv;
  float aspect = uRes.x / uRes.y;
  vec2 q = uv * vec2(aspect, 1.0);
  float t = uT;
  vec2 sd = vec2(uSeed * 13.7, uSeed * 7.3);

  // --- timeline ---
  float fadeIn   = smoothstep(0.0, 1.4, t);
  float fadeOut  = 1.0 - smoothstep(uDur - 2.0, uDur - 0.7, t);
  float vis      = fadeIn * fadeOut;
  float sharpen  = smoothstep(0.4, 3.2, t);              // negative comes into focus
  float develop  = clamp((t - 2.8) / (uDur - 4.8), 0.0, 1.0); // positive takes over
  float blurOut  = smoothstep(uDur - 2.6, uDur - 0.8, t);

  // --- developing front ---
  // field is high in the middle and noisy; the positive wins wherever field < threshold.
  float r = length((uv - 0.5) * vec2(1.0, 1.25)) * 1.55;
  float drift = t * 0.035;
  float n  = fbm(q * 2.4 + sd + vec2(drift, -drift));
  float n2 = fbm(q * 7.0 - sd + vec2(0.0, drift * 2.0));
  float field = 1.0 - r * 0.8 + (n - 0.5) * 1.1 + (n2 - 0.5) * 0.25;
  float thresh = mix(-0.15, 1.65, develop);
  float front = thresh - field;
  float positive = smoothstep(-0.06, 0.10, front);
  float haze = exp(-pow(front / 0.16, 2.0)) * step(0.001, develop) * (1.0 - smoothstep(0.92, 1.0, develop));
  haze *= 0.55 + 0.45 * fbm(q * 11.0 + sd + drift * 3.0);

  // --- image ---
  float zoom = 1.0 + 0.045 * (t / uDur);
  vec2 iuv = imageUv(uv, zoom);
  float blurPx = mix(22.0, 1.5, sharpen) + blurOut * 18.0;
  vec3 srcNeg = uHasTex > 0.5 ? sampleBlur(iuv, blurPx + haze * 3.0) : vec3(0.0);
  vec3 srcPos = uHasTex > 0.5 ? sampleBlur(iuv, max(1.0, blurPx * 0.6 + haze * 5.0)) : vec3(0.0);

  // --- the plate itself ---
  // Everything here is density on the plate, so the negative shows it inverted too
  // (the black border reads as pale grey until the positive comes through).
  float mul = 1.0, add = 0.0;

  // uneven tone and mottled emulsion
  mul *= 0.84 + 0.3 * fbm(q * vec2(1.6, 3.2) + sd * 2.0);
  float mottle = smoothstep(0.5, 0.75, fbm(q * 2.5 + sd * 1.7)) * (hash(floor(q * uRes.y / 2.5) + sd) - 0.5);
  add += mottle * 0.35 * uFx1.w;

  // pour streaks: wavy vertical lines where the collodion ran
  float wx = q.x + (fbm(vec2(q.x * 4.0, uv.y * 2.2) + sd) - 0.5) * 0.07
                 + (vnoise(vec2(q.x * 30.0, uv.y * 9.0 + uSeed)) - 0.5) * 0.006;
  float laneId = floor(wx * 22.0);
  float lane = abs(fract(wx * 22.0) - 0.5);
  float lw = mix(0.02, 0.14, hash(vec2(laneId, uSeed + 3.0)));
  float streak = smoothstep(lw, lw * 0.3, lane) * step(0.4, hash(vec2(laneId, uSeed)));
  float streakSign = hash(vec2(laneId, uSeed + 9.0)) < 0.65 ? 1.0 : -1.4;
  float streakFade = smoothstep(0.0, 0.8, uv.y) * smoothstep(0.2, 0.7, vnoise(vec2(laneId * 1.7, uv.y * 3.0 + uSeed)));
  add += streak * streakFade * streakSign * 0.07 * uFx1.y;
  mul *= 1.0 + (vnoise(vec2(wx * 8.0, uSeed)) - 0.5) * 0.3 * uFx1.y;

  // vignette
  float v = length((uv - 0.5) * vec2(1.05, 1.25));
  mul *= 1.0 - smoothstep(0.32, 0.85, v) * 0.7;

  // ink spatter, clustered around one point
  vec2 spc = uFx2.yz * vec2(aspect, 1.0);
  float spd = length(q - spc);
  vec2 cellId = floor(q * 55.0);
  vec2 cellUv = fract(q * 55.0) - 0.5;
  float hs = hash(cellId + sd * 3.0);
  float dotR = 0.06 + 0.42 * pow(hash(cellId + 7.7), 3.0);
  vec2 dotUv = cellUv + (hash(cellId + 2.0) - 0.5) * 0.4 + (vec2(vnoise(q * 160.0), vnoise(q * 160.0 + 5.0)) - 0.5) * 0.35;
  float dotHit = step(1.0 - 0.2 * exp(-spd * spd / 0.025), hs) * smoothstep(dotR, dotR * 0.6, length(dotUv * vec2(1.0, 0.8)));
  float spatter = dotHit * uFx2.x;

  // dust: pale specks and darker crumbs
  vec2 dcell = floor(q * 90.0);
  float dd = length(fract(q * 90.0) - 0.5);
  float speckW = step(0.9965, hash(dcell + sd)) * smoothstep(0.45, 0.1, dd);
  float speckB = step(0.9975, hash(dcell - sd)) * smoothstep(0.4, 0.15, dd);
  add += speckW * 0.35 - speckB * 0.3;

  // scratches: vertical and horizontal hairlines
  float sx = step(0.997, hash(vec2(floor(uv.x * 420.0), uSeed)))
           * smoothstep(0.3, 0.8, vnoise(vec2(uv.x * 420.0, uv.y * 3.0 + uSeed * 9.0)));
  float sy = step(0.995, hash(vec2(floor(uv.y * 300.0), uSeed + 1.0)))
           * smoothstep(0.55, 0.85, vnoise(vec2(q.x * 2.5 + uSeed * 4.0, uv.y * 300.0)));
  add += sx * 0.18 + sy * 0.22 * uFx2.w;

  // border
  float d = plateDist(uv, q, aspect);
  float soft = uEdge.w + blurPx / uRes.y * 0.8;
  float inside = smoothstep(-soft, soft, d);
  float burnW = 0.03 + 0.12 * fbm(q * 2.2 + sd * 4.0);
  float burn = smoothstep(0.0, burnW, d);
  mul *= mix(0.12, 1.0, burn);
  // corners go darker, each by a different amount
  vec2 cq = abs(uv - 0.5) * 2.0;
  float corner = smoothstep(0.55, 1.0, cq.x) * smoothstep(0.45, 1.0, cq.y);
  mul *= 1.0 - corner * (0.35 + 0.5 * fbm(q * 1.5 + sd * 6.0));
  float rimN = fbm(q * 9.0 + sd);
  float rim = exp(-pow((d - 0.014) / (0.006 + 0.01 * rimN), 2.0)) * uFx1.x * smoothstep(0.3, 0.6, rimN);
  float peelN = vnoise(q * 20.0 + sd);
  float peel = exp(-pow((d - 0.032 - 0.02 * rimN) / 0.003, 2.0)) * uFx1.x * smoothstep(0.35, 0.65, peelN);
  add += rim * 0.3 - peel * 0.18;
  float outside = 0.025 + 0.05 * fbm(q * 18.0 + sd);

  // apply to both exposures
  float lp = luma(srcPos);
  lp = smoothstep(0.03, 0.97, lp);
  lp = pow(lp, 1.15);
  lp = clamp(lp * mul + add, 0.0, 1.0);
  lp = mix(lp, 0.02, spatter);
  lp = mix(outside, lp, inside);

  float lnBase = clamp(luma(srcNeg) * mul + add, 0.0, 1.0);
  lnBase = mix(lnBase, 0.02, spatter);
  lnBase = mix(outside, lnBase, inside);

  // negative: inverted, low contrast, cool grey, washed out at first
  float ln = 1.0 - lnBase;
  ln = mix(0.62, ln, mix(0.35, 0.95, sharpen));
  ln = mix(ln, smoothstep(0.1, 0.9, ln) * 1.08, sharpen * 0.6);
  vec3 negCol = vec3(ln) * vec3(0.93, 0.94, 0.96);

  // positive: sepia, with an optional warm light leak
  vec3 posCol = sepia(lp);
  float leak = exp(-pow(length(q - uLeak.xy * vec2(aspect, 1.0)) / max(uLeak.z, 0.01), 2.0)) * uLeak.w;
  posCol += vec3(0.22, 0.16, 0.04) * leak * inside;

  vec3 col = mix(negCol, posCol, positive);

  // smoky developer at the front: pale and milky
  vec3 smoke = vec3(0.78, 0.77, 0.74);
  col = mix(col, smoke, haze * 0.4 * inside);

  // film grain
  float g = hash(uv * uRes + fract(uClock * 7.13) * 100.0) - 0.5;
  col += g * 0.055;

  col *= vis;
  outColor = vec4(max(col, 0.0), 1.0);
}`;

function compile(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

const prog = gl.createProgram();
gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
gl.linkProgram(prog);
if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
gl.useProgram(prog);

const buf = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, buf);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
const aPos = gl.getAttribLocation(prog, 'aPos');
gl.enableVertexAttribArray(aPos);
gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

const U = Object.fromEntries(
  ['uTex', 'uRes', 'uImg', 'uT', 'uDur', 'uSeed', 'uClock', 'uHasTex', 'uBorder', 'uEdge', 'uFx1', 'uFx2', 'uLeak', 'uBlobs']
    .map((n) => [n, gl.getUniformLocation(prog, n)]),
);

// ---------- plate styles ----------
// Every photo gets its own plate: thin and clean, torn with a silvered rim, or heavy and blotchy.

function rng(seed) {
  let a = Math.floor(seed * 2 ** 32) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function plateStyle(seed) {
  const r = rng(seed);
  const between = (a, b) => a + (b - a) * r();
  const chance = (p) => r() < p;
  const k = r();
  const kind = k < 0.25 ? 'thin' : k < 0.6 ? 'torn' : 'heavy';
  const base = { thin: [0.006, 0.016], torn: [0.014, 0.04], heavy: [0.03, 0.07] }[kind];
  const border = [0, 0, 0, 0].map(() => between(...base) * between(0.6, 1.4));
  const edge = {
    thin: [between(0.003, 0.008), between(2, 5), 0.002, 0.002],
    torn: [between(0.015, 0.035), between(2, 7), between(0.005, 0.012), 0.0015],
    heavy: [between(0.025, 0.055), between(1.5, 4), between(0.003, 0.008), between(0.004, 0.012)],
  }[kind];
  const fx1 = [
    kind === 'torn' ? between(0.6, 1) : chance(0.25) ? between(0.2, 0.5) : 0, // silver rim
    chance(0.4) ? between(0.4, 1) : 0, // pour streaks
    chance(0.4) ? between(0.5, 1) : 0, // dripping top edge
    between(0.1, 1), // mottle
  ];
  const fx2 = [chance(0.35) ? 1 : 0, between(0.6, 0.95), between(0.2, 0.8), chance(0.5) ? between(0.5, 1) : 0];
  const leak = chance(0.25) ? [between(0.1, 0.5), between(0.3, 0.7), between(0.15, 0.35), between(0.5, 1)] : [0, 0, 0.1, 0];
  const blobs = [];
  const nBlobs = kind === 'thin' ? Math.floor(between(0, 2)) : Math.floor(between(1, 4.99));
  for (let i = 0; i < 4; i++) {
    if (i >= nBlobs) { blobs.push(0, 0, 0, 0); continue; }
    // sit on an edge, more often the bottom (dark lumps) or a top corner
    const side = Math.floor(r() * 4);
    const along = between(0.05, 0.95);
    const out = between(0.0, 0.03);
    const pos = [[-out, along], [1 + out, along], [along, 1 + out], [along, -out]][side];
    blobs.push(pos[0], pos[1], between(0.04, kind === 'heavy' ? 0.15 : 0.08), 1);
  }
  return { kind, border, edge, fx1, fx2, leak, blobs };
}

const tex = gl.createTexture();
gl.bindTexture(gl.TEXTURE_2D, tex);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

function upload(img) {
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
  gl.generateMipmap(gl.TEXTURE_2D);
}

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.round(innerWidth * dpr), h = Math.round(innerHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  gl.viewport(0, 0, w, h);
}
addEventListener('resize', resize);
resize();

// ---------- photo queue ----------

let queue = [];
let fetching = null;

async function refill() {
  if (FIXED_IMG) return queue.push({ url: FIXED_IMG, caption: params.get('caption') || '' });
  if (fetching) return fetching;
  fetching = (async () => {
    try {
      const r = await fetch(`/api/photos?count=${BATCH}`);
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || r.status);
      queue.push(...data.photos);
      statusEl.textContent = '';
    } catch (err) {
      console.error(err);
      statusEl.textContent = `Fotos konnten nicht geladen werden: ${err.message}`;
    } finally {
      fetching = null;
    }
  })();
  return fetching;
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`load failed: ${url}`));
    img.src = url;
  });
}

// Resolves to the next photo that actually loads, skipping broken ones.
async function nextPhoto() {
  for (let tries = 0; tries < 10; tries++) {
    if (queue.length < 5) refill();
    if (!queue.length) await refill();
    const item = queue.shift();
    if (!item) {
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    try {
      return { ...item, img: await loadImage(item.url) };
    } catch (err) {
      console.warn(err.message);
    }
  }
  return null;
}

// ---------- loop ----------

let current = null;
let pending = nextPhoto();
let cycleStart = 0;
let seed = FIXED_SEED ?? Math.random();
let style = plateStyle(seed);

async function advance(now) {
  const photo = await pending;
  pending = nextPhoto();
  if (!photo) return;
  current = photo;
  upload(photo.img);
  captionEl.textContent = photo.caption || '';
  seed = FIXED_SEED ?? Math.random();
  style = plateStyle(seed);
  // keep the note inside the plate border
  captionEl.style.left = `${(style.border[0] + 0.045) * innerHeight}px`;
  captionEl.style.top = `${(style.border[2] + 0.04) * innerHeight}px`;
  cycleStart = now;
}

let advancing = false;

function frame(nowMs) {
  const now = nowMs / 1000;
  let t = FREEZE ?? now - cycleStart;

  if (!current || (FREEZE === null && t >= DURATION)) {
    // hold on black until the next photo is ready
    if (!advancing) {
      advancing = true;
      advance(performance.now() / 1000).finally(() => (advancing = false));
    }
    t = current && FREEZE === null ? DURATION : t;
  }

  resize();
  gl.uniform1i(U.uTex, 0);
  gl.uniform2f(U.uRes, canvas.width, canvas.height);
  gl.uniform2f(U.uImg, current?.img.naturalWidth || 1, current?.img.naturalHeight || 1);
  gl.uniform1f(U.uT, current ? t : 0);
  gl.uniform1f(U.uDur, DURATION);
  gl.uniform1f(U.uSeed, seed);
  gl.uniform1f(U.uClock, now);
  gl.uniform1f(U.uHasTex, current ? 1 : 0);
  gl.uniform4fv(U.uBorder, style.border);
  gl.uniform4fv(U.uEdge, style.edge);
  gl.uniform4fv(U.uFx1, style.fx1);
  gl.uniform4fv(U.uFx2, style.fx2);
  gl.uniform4fv(U.uLeak, style.leak);
  gl.uniform4fv(U.uBlobs, style.blobs);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

  // caption is written onto the plate once the positive has mostly come through
  const capIn = smooth(DURATION * 0.45, DURATION * 0.62, t);
  const capOut = 1 - smooth(DURATION - 2.0, DURATION - 0.9, t);
  captionEl.style.opacity = current ? (capIn * capOut * 0.85).toFixed(3) : '0';

  requestAnimationFrame(frame);
}

function smooth(a, b, x) {
  const k = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return k * k * (3 - 2 * k);
}

requestAnimationFrame(frame);

// fullscreen on click or "f"
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.();
}
addEventListener('click', toggleFullscreen);
addEventListener('keydown', (e) => e.key.toLowerCase() === 'f' && toggleFullscreen());
