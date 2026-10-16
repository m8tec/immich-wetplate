// Wet-plate "developing photo" loading screen, after the RDR2 story-mode loading screens.
// One cycle per photo: black → blurry negative → positive develops from the edges inward
// through a smoky boundary → finished sepia plate holds → fades to black.
//
// URL params: ?duration=12.5  seconds per photo
//             ?t=5            freeze the cycle at this time (for tuning)
//             ?dev=7          fixed development end in seconds (for tuning)
//             ?count=30       photos fetched per batch
//             ?img=<url>      show only this image (&caption=... for the note)
//             ?seed=0.42      fixed plate look (0..1)

const params = new URLSearchParams(location.search);
const DURATION = Number(params.get('duration')) || 12;
const FREEZE = params.has('t') ? Number(params.get('t')) : null;
const BATCH = Number(params.get('count')) || 30;
const FIXED_IMG = params.get('img'); // show only this image (for tuning)
const FIXED_DEV = params.has('dev') ? Number(params.get('dev')) : null;
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

// Shared noise helpers.
const NOISE = `
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
}`;

// Pass 1, once per photo: bakes everything about the plate that does not change over time
// into two textures, so the per-frame pass stays cheap.
//   plate0 = (tone multiplier / 2, tone offset + 0.5, (edge distance + 0.1) / 0.4, ink spatter)
//   plate1 = ((developing field + 1) / 3, haze noise, light leak, border texture)
const PLATE_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
layout(location = 0) out vec4 plate0;
layout(location = 1) out vec4 plate1;

uniform vec2 uRes;
uniform float uSeed;
uniform vec4 uBorder;   // base border width per side L, R, T, B (screen-height units)
uniform vec4 uEdge;     // lobe amplitude, lobe frequency, tear amplitude, edge softness
uniform vec4 uFx1;      // silver rim, pour streaks, dripping top edge, mottle
uniform vec4 uFx2;      // spatter amount, spatter x, spatter y, hairlines
uniform vec4 uLeak;     // light leak x, y, radius, strength
uniform vec4 uBlobs[4]; // ink blobs eating into the plate: x, y (uv), radius, on/off
${NOISE}
float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
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
  vec2 sd = vec2(uSeed * 13.7, uSeed * 7.3);

  // developing front: high in the middle and noisy; the positive wins wherever field < threshold
  float r = length((uv - 0.5) * vec2(1.0, 1.25)) * 1.55;
  float field = 1.0 - r * 0.8 + (fbm(q * 2.4 + sd) - 0.5) * 1.1 + (fbm(q * 7.0 - sd) - 0.5) * 0.25;
  float hazeN = fbm(q * 11.0 + sd);

  // Plate density. The negative shows it inverted too, so the black border
  // reads as pale grey until the positive comes through.
  float mul = 1.0, add = 0.0;

  // uneven tone and mottled emulsion
  mul *= 0.84 + 0.3 * fbm(q * vec2(1.6, 3.2) + sd * 2.0);
  float mottle = smoothstep(0.5, 0.75, fbm(q * 2.5 + sd * 1.7)) * (hash(floor(q * 1080.0 / 2.5) + sd) - 0.5);
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

  // border: burnt falloff, darker corners, silvered rim and a peeled emulsion line
  float d = plateDist(uv, q, aspect);
  float burnW = 0.03 + 0.12 * fbm(q * 2.2 + sd * 4.0);
  mul *= mix(0.08, 1.0, smoothstep(0.0, burnW, d));
  vec2 cq = abs(uv - 0.5) * 2.0;
  float corner = smoothstep(0.55, 1.0, cq.x) * smoothstep(0.45, 1.0, cq.y);
  mul *= 1.0 - corner * (0.35 + 0.5 * fbm(q * 1.5 + sd * 6.0));
  float rimN = fbm(q * 9.0 + sd);
  float rim = exp(-pow((d - 0.014) / (0.006 + 0.01 * rimN), 2.0)) * uFx1.x * smoothstep(0.3, 0.6, rimN);
  float peel = exp(-pow((d - 0.032 - 0.02 * rimN) / 0.003, 2.0)) * uFx1.x * smoothstep(0.35, 0.65, vnoise(q * 20.0 + sd));
  add += rim * 0.3 - peel * 0.18;

  float leak = exp(-pow(length(q - uLeak.xy * vec2(aspect, 1.0)) / max(uLeak.z, 0.01), 2.0)) * uLeak.w;

  plate0 = vec4(mul * 0.5, add + 0.5, (d + 0.1) / 0.4, spatter);
  plate1 = vec4((field + 1.0) / 3.0, hazeN, leak, fbm(q * 18.0 + sd));
}`;

// Pass 2, every frame: the photo, the developing front and grain.
const FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;

uniform sampler2D uTex;
uniform sampler2D uPlate0;
uniform sampler2D uPlate1;
uniform vec2 uRes;      // canvas pixels
uniform vec2 uImg;      // image pixels
uniform float uT;       // seconds into the cycle
uniform float uDur;     // cycle length
uniform float uSeed;
uniform float uClock;   // wall clock, for grain
uniform float uHasTex;
uniform float uSoft;    // edge softness of this plate
uniform float uDevelop; // 0..1 progress of the positive (computed in JS)
uniform float uThresh;  // field value the developing front has reached

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
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
  vec3 dark  = vec3(0.026, 0.024, 0.021);
  vec3 mid   = vec3(0.40, 0.365, 0.30);
  vec3 light = vec3(0.86, 0.82, 0.70);
  return l < 0.5 ? mix(dark, mid, l * 2.0) : mix(mid, light, l * 2.0 - 1.0);
}

void main() {
  vec2 uv = vUv;
  // Timeline measured from the game footage (12 s per photo), scaled to uDur.
  float t = uT * 12.0 / uDur;
  vec4 p0 = texture(uPlate0, uv);
  vec4 p1 = texture(uPlate1, uv);
  float mul = p0.r * 2.0, add = p0.g - 0.5, d = p0.b * 0.4 - 0.1, spatter = p0.a;
  float field = p1.r * 3.0 - 1.0, hazeN = p1.g, leak = p1.b, borderN = p1.a;

  // --- timeline ---
  float fadeIn   = smoothstep(0.2, 2.4, t);                  // up from black, negative peaks ~2 s
  float fadeOut  = 1.0 - smoothstep(9.2, 11.35, t);          // black from 11.35 s to 12 s
  float vis      = fadeIn * fadeOut;
  float sharpen  = smoothstep(1.0, 2.6, t);                  // negative comes into focus
  float develop  = uDevelop;                                  // positive takes over
  float blurOut  = smoothstep(9.2, 10.0, t);                 // fixed, even if still developing

  // --- developing front ---
  float front = uThresh - field;
  float positive = smoothstep(-0.06, 0.10, front);
  float haze = exp(-pow(front / 0.16, 2.0)) * step(0.001, develop) * (1.0 - smoothstep(0.92, 1.0, develop));
  haze *= 0.55 + 0.45 * hazeN;

  // --- image ---
  float zoom = 1.0 + 0.045 * (t / 12.0);
  vec2 iuv = imageUv(uv, zoom);
  float blurPx = mix(22.0, 1.5, sharpen) + blurOut * 18.0;
  vec3 srcNeg = uHasTex > 0.5 ? sampleBlur(iuv, blurPx + haze * 3.0) : vec3(0.0);
  vec3 srcPos = uHasTex > 0.5 ? sampleBlur(iuv, max(1.0, blurPx * 0.6 + haze * 5.0)) : vec3(0.0);

  float soft = uSoft + blurPx / uRes.y * 0.8;
  float inside = smoothstep(-soft, soft, d);

  // negative: inverted, low contrast, cool grey, washed out at first
  float lnBase = clamp(luma(srcNeg) * mul + add, 0.0, 1.0);
  lnBase = mix(lnBase, 0.02, spatter);
  lnBase = mix(0.03, lnBase, inside);
  float ln = 1.0 - lnBase;
  ln = mix(0.62, ln, mix(0.35, 0.95, sharpen));
  ln = mix(ln, smoothstep(0.1, 0.9, ln) * 1.08, sharpen * 0.6);
  vec3 negCol = vec3(ln) * vec3(0.93, 0.94, 0.96);

  // positive: sepia, warm light leak, border near black (~#0a0a0a at most)
  float lp = luma(srcPos);
  lp = smoothstep(0.03, 0.97, lp);
  lp = pow(lp, 1.15);
  lp = clamp(lp * mul + add, 0.0, 1.0);
  lp = mix(lp, 0.0, spatter);
  vec3 posCol = sepia(lp) + vec3(0.22, 0.16, 0.04) * leak;
  vec3 borderCol = vec3(0.016, 0.015, 0.014) * (0.6 + 0.8 * borderN);
  posCol = mix(borderCol, posCol, inside);

  vec3 col = mix(negCol, posCol, positive);

  // smoky developer at the front: pale and milky
  col = mix(col, vec3(0.78, 0.77, 0.74), haze * 0.4 * inside);

  // film grain, faint in the blacks so the border stays dark
  float g = hash(uv * uRes + fract(uClock * 7.13) * 100.0) - 0.5;
  col += g * 0.055 * mix(0.15, 1.0, smoothstep(0.02, 0.25, luma(col)));

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

function program(fragSrc, uniforms) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl.VERTEX_SHADER, VERT));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fragSrc));
  gl.bindAttribLocation(p, 0, 'aPos');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  return { p, u: Object.fromEntries(uniforms.map((n) => [n, gl.getUniformLocation(p, n)])) };
}

const main = program(FRAG, ['uTex', 'uPlate0', 'uPlate1', 'uRes', 'uImg', 'uT', 'uDur', 'uSeed', 'uClock', 'uHasTex', 'uSoft', 'uDevelop', 'uThresh']);
const bake = program(PLATE_FRAG, ['uRes', 'uSeed', 'uBorder', 'uEdge', 'uFx1', 'uFx2', 'uLeak', 'uBlobs']);

const buf = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, buf);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

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
  // How long the plate takes to develop varies a lot in the game (measured 4.6 s to over 10 s).
  // The blur-out starts at 9.3 s regardless, so slow plates fade with some negative left.
  const d = r();
  const devEnd = FIXED_DEV ?? (d < 0.65 ? between(5.2, 6.6) : d < 0.9 ? between(6.6, 9.0) : between(9.0, 11.5));
  return { kind, border, edge, fx1, fx2, leak, blobs, devEnd };
}

function makeTexture(mip) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

const tex = makeTexture(true);
const plateTex = [makeTexture(false), makeTexture(false)];
const plateFbo = gl.createFramebuffer();
let plateSize = [0, 0];

function upload(bitmap) {
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
  gl.generateMipmap(gl.TEXTURE_2D);
}

// Renders the static plate layers. Capped at 1920 px wide: the details are soft enough.
function bakePlate() {
  const scale = Math.min(1, 1920 / canvas.width);
  const w = Math.round(canvas.width * scale), h = Math.round(canvas.height * scale);
  if (w !== plateSize[0] || h !== plateSize[1]) {
    for (const t of plateTex) {
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    plateSize = [w, h];
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, plateFbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, plateTex[0], 0);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, plateTex[1], 0);
  gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
  gl.viewport(0, 0, w, h);
  gl.useProgram(bake.p);
  gl.uniform2f(bake.u.uRes, w, h);
  gl.uniform1f(bake.u.uSeed, seed);
  gl.uniform4fv(bake.u.uBorder, style.border);
  gl.uniform4fv(bake.u.uEdge, style.edge);
  gl.uniform4fv(bake.u.uFx1, style.fx1);
  gl.uniform4fv(bake.u.uFx2, style.fx2);
  gl.uniform4fv(bake.u.uLeak, style.leak);
  gl.uniform4fv(bake.u.uBlobs, style.blobs);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  measureField(w, h);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  plateDirty = false;
}

// The front advances through the field's values. The field is noise, so its values are not
// spread evenly: moving the threshold at a constant speed makes the front stall for seconds
// and then jump. Instead, read the field back once per plate and advance by developed area.
const SMALL = [192, 108];
const smallTex = makeTexture(false);
gl.bindTexture(gl.TEXTURE_2D, smallTex);
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, SMALL[0], SMALL[1], 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
const smallFbo = gl.createFramebuffer();
gl.bindFramebuffer(gl.FRAMEBUFFER, smallFbo);
gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, smallTex, 0);
gl.bindFramebuffer(gl.FRAMEBUFFER, null);
const smallPixels = new Uint8Array(SMALL[0] * SMALL[1] * 4);
let fieldSorted = new Float32Array([-0.15, 1.2]);

function measureField(w, h) {
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, plateFbo);
  gl.readBuffer(gl.COLOR_ATTACHMENT1);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, smallFbo);
  gl.blitFramebuffer(0, 0, w, h, 0, 0, SMALL[0], SMALL[1], gl.COLOR_BUFFER_BIT, gl.LINEAR);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, smallFbo);
  gl.readPixels(0, 0, SMALL[0], SMALL[1], gl.RGBA, gl.UNSIGNED_BYTE, smallPixels);
  // Weight the middle of the frame more: that is where the bright negative is seen,
  // the dark edges barely register. Store values and cumulative weights.
  const [W, H] = SMALL;
  const items = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = (x / (W - 1) - 0.5) * 2, dy = (y / (H - 1) - 0.5) * 2;
      const r = Math.hypot(dx, dy * 0.9);
      const w = 0.15 + 0.85 * (1 - Math.min(1, Math.max(0, (r - 0.55) / 0.5)));
      items.push([(smallPixels[(y * W + x) * 4] / 255) * 3 - 1, w]);
    }
  }
  items.sort((a, b) => a[0] - b[0]);
  const total = items.reduce((sum, it) => sum + it[1], 0);
  // resample to 256 evenly weighted quantiles
  const q = new Float32Array(256);
  let acc = 0, j = 0;
  for (let k = 0; k < q.length; k++) {
    const target = (k / (q.length - 1)) * total;
    while (j < items.length - 1 && acc + items[j][1] < target) acc += items[j++][1];
    q[k] = items[j][0];
  }
  fieldSorted = q;
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
}

// Threshold at which `area` (0..1) of the plate has turned positive.
function frontAt(area) {
  const n = fieldSorted.length;
  const lo = fieldSorted[0] - 0.12, hi = fieldSorted[n - 1] + 0.1;
  if (area <= 0) return lo;
  if (area >= 1) return hi;
  const x = area * (n - 1), i = Math.floor(x);
  const v = fieldSorted[i] + (fieldSorted[Math.min(i + 1, n - 1)] - fieldSorted[i]) * (x - i);
  // the smoothstep in the shader needs a little lead to fully flip a pixel
  return v + 0.02 + (hi - fieldSorted[n - 1]) * area;
}

function clamp01(x) {
  return Math.min(1, Math.max(0, x));
}

let plateDirty = true;

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.round(innerWidth * dpr), h = Math.round(innerHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    plateDirty = true;
  }
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
    img.onload = () => createImageBitmap(img).then(resolve, reject);
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
  plateDirty = true;
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

  if (plateDirty) bakePlate();
  const ts = (t * 12) / DURATION; // position on the 12 s reference timeline
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.useProgram(main.p);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, plateTex[0]);
  gl.activeTexture(gl.TEXTURE2);
  gl.bindTexture(gl.TEXTURE_2D, plateTex[1]);
  gl.uniform1i(main.u.uTex, 0);
  gl.uniform1i(main.u.uPlate0, 1);
  gl.uniform1i(main.u.uPlate1, 2);
  gl.uniform2f(main.u.uRes, canvas.width, canvas.height);
  gl.uniform2f(main.u.uImg, current?.img.width || 1, current?.img.height || 1);
  gl.uniform1f(main.u.uT, current ? t : 0);
  gl.uniform1f(main.u.uDur, DURATION);
  gl.uniform1f(main.u.uSeed, seed);
  gl.uniform1f(main.u.uClock, now);
  gl.uniform1f(main.u.uHasTex, current ? 1 : 0);
  gl.uniform1f(main.u.uSoft, style.edge[3]);
  const develop = clamp01((ts - 2.1) / (style.devEnd - 2.1));
  gl.uniform1f(main.u.uDevelop, develop);
  gl.uniform1f(main.u.uThresh, frontAt(develop));
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

  // caption is written onto the plate once the positive has mostly come through
  const capAt = Math.min(style.devEnd, 8.4);
  const capIn = smooth(capAt - 1.2, capAt, ts);
  const capOut = 1 - smooth(9.2, 10.4, ts);
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
