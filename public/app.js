// Wet-plate "developing photo" loading screen, after the RDR2 story-mode loading screens.
// One cycle per photo: black → blurry negative → positive develops from the edges inward
// through a smoky boundary → finished sepia plate holds → fades to black.
//
// URL params: ?duration=12.5  seconds per photo
//             ?t=5            freeze the cycle at this time (for tuning)
//             ?count=30       photos fetched per batch
//             ?img=<url>      show only this image (&caption=... for the note)

const params = new URLSearchParams(location.search);
const DURATION = Number(params.get('duration')) || 12.5;
const FREEZE = params.has('t') ? Number(params.get('t')) : null;
const BATCH = Number(params.get('count')) || 30;
const FIXED_IMG = params.get('img'); // show only this image (for tuning)

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

  // negative: inverted, low contrast, cool grey, washed out at first
  float ln = 1.0 - luma(srcNeg);
  ln = mix(0.62, ln, mix(0.35, 0.95, sharpen));
  ln = mix(ln, smoothstep(0.1, 0.9, ln) * 1.08, sharpen * 0.6);
  vec3 negCol = vec3(ln) * vec3(0.93, 0.94, 0.96);

  // positive: contrasty sepia
  float lp = luma(srcPos);
  lp = smoothstep(0.03, 0.97, lp);
  lp = pow(lp, 1.15);
  vec3 posCol = sepia(lp);

  // plate stains: mottled lighter/darker patches, strongest in bright areas
  float stain = fbm(q * vec2(1.6, 3.2) + sd * 2.0);
  posCol *= 0.86 + 0.28 * stain;
  posCol += vec3(0.05, 0.045, 0.035) * smoothstep(0.55, 0.85, fbm(q * 4.0 - sd)) * lp;

  vec3 col = mix(negCol, posCol, positive);

  // smoky developer at the front: pale and milky
  vec3 smoke = vec3(0.78, 0.77, 0.74);
  col = mix(col, smoke, haze * 0.4);

  // vignette
  float v = length((uv - 0.5) * vec2(1.05, 1.25));
  col *= 1.0 - smoothstep(0.35, 0.85, v) * 0.75;

  // burnt, torn plate edge
  float e = min(min(uv.x, 1.0 - uv.x) * aspect, min(uv.y, 1.0 - uv.y));
  float en = fbm(q * 9.0 + sd * 3.0) * 0.05 + fbm(q * 40.0 + sd) * 0.012;
  float edge = e - en;
  col *= smoothstep(-0.005, 0.012, edge);
  col *= mix(0.45, 1.0, smoothstep(0.0, 0.07, edge));

  // dust specks and hair-thin scratches, fixed per plate
  vec2 cell = floor(q * 90.0);
  float speck = step(0.9965, hash(cell + sd)) * smoothstep(0.5, 0.1, length(fract(q * 90.0) - 0.5));
  col = mix(col, vec3(0.9, 0.88, 0.82), speck * 0.5 * positive);
  float sx = hash(vec2(floor(uv.x * 420.0), uSeed));
  float scratch = step(0.997, sx) * smoothstep(0.3, 0.8, vnoise(vec2(uv.x * 420.0, uv.y * 3.0 + uSeed * 9.0)));
  col = mix(col, vec3(0.82, 0.8, 0.74), scratch * 0.25 * positive);

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
  ['uTex', 'uRes', 'uImg', 'uT', 'uDur', 'uSeed', 'uClock', 'uHasTex'].map((n) => [n, gl.getUniformLocation(prog, n)]),
);

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
let seed = Math.random();

async function advance(now) {
  const photo = await pending;
  pending = nextPhoto();
  if (!photo) return;
  current = photo;
  upload(photo.img);
  captionEl.textContent = photo.caption || '';
  seed = Math.random();
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
