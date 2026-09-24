/* models.js — terrain generation + every world model
   Terrain is the single source of truth for height, chunks and spawned props.
   Models owns the aircraft, propeller and tree meshes.

   Optional textures are looked up under ./assets/. Missing files automatically
   keep the procedural/vertex-color fallback, so the game works immediately.

   TEXTURES
   --------
   plane.png     -> wrapped over the whole aircraft   (assets/plane.png)
   propeller.png -> wrapped over the propeller        (assets/propeller.png)
   tree.png      -> optional, off by default          (assets/tree.png)

   Meshes now carry UVs on vertex attribute 3 and expose `mesh.texture`.
   The renderer must bind mesh.texture on unit 0 and multiply it with the
   vertex colour when mesh.texture is not null.
*/
(function (global) {
'use strict';

let gl = null;

/* =========================================================================
   NOISE
   ========================================================================= */
function hash2(ix, iy) {
  let h = Math.imul(ix | 0, 374761393) + Math.imul(iy | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function noise2(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}
function fbm(x, y, oct) {
  let amp = 1, freq = 1, sum = 0, n = 0;
  for (let i = 0; i < oct; i++) {
    sum += (noise2(x * freq, y * freq) * 2 - 1) * amp;
    n += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / n;
}

/* =========================================================================
   TERRAIN HEIGHT
   ========================================================================= */
function terrainHeight(x, z) {
  let h = 0;
  h += fbm(x * 0.00058, z * 0.00058, 4) * 115;
  h += fbm(x * 0.0042 + 91.3, z * 0.0042 + 17.7, 4) * 24;
  h += fbm(x * 0.019 + 5.1, z * 0.019 + 44.9, 2) * 3.5;
  return h - 20;
}

/* =========================================================================
   MESH UTILITIES
   ========================================================================= */
function createMesh(posArr, nrmArr, colArr, idxArr, uvArr, texture) {
  if (!gl) throw new Error('Terrain.init(gl) must be called before createMesh');
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const bufs = [];

  function attr(location, data, size) {
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
    bufs.push(b);
  }

  attr(0, posArr, 3);
  attr(1, nrmArr, 3);
  if (colArr) attr(2, colArr, 3);
  if (uvArr && uvArr.length) attr(3, uvArr, 2);

  const ib = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idxArr, gl.STATIC_DRAW);
  bufs.push(ib);

  gl.bindVertexArray(null);
  return {
    vao, bufs,
    count: idxArr.length,
    texture: texture || null,
    textured: !!texture
  };
}

function deleteMesh(m) {
  if (!m || !gl) return;
  for (const b of m.bufs) gl.deleteBuffer(b);
  gl.deleteVertexArray(m.vao);
}

/*  Box with UVs.
    Signature:  boxBuilder(pos,nrm,col,idx,uv, cx,cy,cz, sx,sy,sz, color,
                           uvScale, uvMode)

    uvMode 'fit'   -> every face gets the whole texture (0..uvScale per face)
    uvMode 'world' -> UVs come from the model-space coordinate along the face,
                      so a texture wraps continuously across the whole model.
                      uvScale = texture tiles per world unit.

    The legacy signature (no uv array) still works.                        */
function boxBuilder(pos, nrm, col, idx, uv, cx, cy, cz, sx, sy, sz, color,
                    uvScale, uvMode) {
  if (typeof uv === 'number') {
    const a = Array.prototype.slice.call(arguments, 4);
    uv = null;
    cx = a[0]; cy = a[1]; cz = a[2];
    sx = a[3]; sy = a[4]; sz = a[5];
    color = a[6];
    uvScale = 1; uvMode = 'fit';
  }
  if (!uvScale) uvScale = 1;
  if (!uvMode) uvMode = 'fit';

  const x0 = cx - sx / 2, x1 = cx + sx / 2;
  const y0 = cy - sy / 2, y1 = cy + sy / 2;
  const z0 = cz - sz / 2, z1 = cz + sz / 2;

  function quad(a, b, c, d, n, au, av) {
    const base = pos.length / 3;
    pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], d[0], d[1], d[2]);
    for (let i = 0; i < 4; i++) {
      nrm.push(n[0], n[1], n[2]);
      col.push(color[0], color[1], color[2]);
    }
    if (uv) {
      const cs = [a, b, c, d];
      for (let i = 0; i < 4; i++) {
        if (uvMode === 'world') {
          uv.push(cs[i][au] * uvScale, cs[i][av] * uvScale);
        } else {
          uv.push((i === 1 || i === 2) ? uvScale : 0,
                  (i >= 2) ? uvScale : 0);
        }
      }
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  quad([x1,y0,z1],[x1,y0,z0],[x1,y1,z0],[x1,y1,z1], [ 1,0,0], 2, 1);
  quad([x0,y0,z0],[x0,y0,z1],[x0,y1,z1],[x0,y1,z0], [-1,0,0], 2, 1);
  quad([x0,y1,z1],[x1,y1,z1],[x1,y1,z0],[x0,y1,z0], [0, 1,0], 0, 2);
  quad([x0,y0,z0],[x1,y0,z0],[x1,y0,z1],[x0,y0,z1], [0,-1,0], 0, 2);
  quad([x1,y0,z0],[x0,y0,z0],[x0,y1,z0],[x1,y1,z0], [0,0,-1], 0, 1);
  quad([x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1], [0,0, 1], 0, 1);
}

function finishMesh(pos, nrm, col, idx, uv, texture) {
  return createMesh(
    new Float32Array(pos),
    new Float32Array(nrm),
    new Float32Array(col),
    new Uint16Array(idx),
    (uv && uv.length) ? new Float32Array(uv) : null,
    texture || null
  );
}

/* =========================================================================
   TEXTURE TUNING
   ========================================================================= */
/* 'world' UV mode: how many texture tiles fit into one world unit.
   Smaller value = bigger picture stretched over the model.               */
const PLANE_UV_SCALE = 1 / 3.0;   // one plane.png tile ≈ 3 units
const PROP_UV_SCALE  = 1 / 2.0;   // one propeller.png tile ≈ 2 units

/* Set to true to also slap tree.png on every tree (multiplied by the
   vertex colours if the shader supports it).                            */
const USE_TREE_TEXTURE = false;

/* =========================================================================
   WORLD MODELS — AIRCRAFT
   ========================================================================= */
function buildPlaneMesh(texture) {
  const pos = [], nrm = [], col = [], idx = [], uv = [];
  const BODY   = [0.88, 0.24, 0.16];
  const WING   = [0.96, 0.97, 0.98];
  const GLASS  = [0.22, 0.44, 0.62];
  const ACCENT = [1.00, 0.80, 0.24];

  /* uvMode 'world' = the texture wraps continuously around the airframe
     instead of restarting on every box face.                           */
  const W = PLANE_UV_SCALE, M = 'world';

  boxBuilder(pos, nrm, col, idx, uv, 0, 0, 0,        1.10, 0.95, 2.40, BODY,   W, M);
  boxBuilder(pos, nrm, col, idx, uv, 0, 0, -1.55,    0.75, 0.65, 0.60, BODY,   W, M);
  boxBuilder(pos, nrm, col, idx, uv, 0, 0.55, -0.20, 0.72, 0.30, 0.95, GLASS,  W, M);
  boxBuilder(pos, nrm, col, idx, uv, 0, 0.05, 0,     6.60, 0.18, 1.20, WING,   W, M);
  boxBuilder(pos, nrm, col, idx, uv, -3.00, 0.05, 0, 0.60, 0.28, 0.95, ACCENT, W, M);
  boxBuilder(pos, nrm, col, idx, uv,  3.00, 0.05, 0, 0.60, 0.28, 0.95, ACCENT, W, M);
  boxBuilder(pos, nrm, col, idx, uv, 0, 0.70, 1.05,  0.14, 0.95, 0.75, BODY,   W, M);
  boxBuilder(pos, nrm, col, idx, uv, 0, 0.20, 1.10,  2.30, 0.14, 0.65, WING,   W, M);

  return finishMesh(pos, nrm, col, idx, uv, texture);
}

function buildPropMesh(texture) {
  const pos = [], nrm = [], col = [], idx = [], uv = [];
  const BLADE = [0.22, 0.23, 0.27];
  const HUB   = [0.36, 0.36, 0.40];
  const W = PROP_UV_SCALE, M = 'world';

  boxBuilder(pos, nrm, col, idx, uv, 0, 0, 0,    3.4, 0.28, 0.07, BLADE, W, M);
  boxBuilder(pos, nrm, col, idx, uv, 0, 0, 0,    0.28, 3.4, 0.07, BLADE, W, M);
  boxBuilder(pos, nrm, col, idx, uv, 0, 0, 0.10, 0.42, 0.42, 0.34, HUB,   W, M);

  return finishMesh(pos, nrm, col, idx, uv, texture);
}

/* =========================================================================
   WORLD MODELS — TREES
   Every builder is origin-at-the-ground, +Y up, roughly 1 unit = 1 metre.
   ========================================================================= */
function buildOakMesh(texture) {
  const pos = [], nrm = [], col = [], idx = [], uv = [];
  const TRUNK = [0.28, 0.14, 0.055];
  const LEAF1 = [0.10, 0.34, 0.10];
  const LEAF2 = [0.15, 0.46, 0.13];
  const LEAF3 = [0.22, 0.55, 0.16];

  boxBuilder(pos, nrm, col, idx, uv, 0, 1.60, 0, 0.55, 3.20, 0.55, TRUNK);
  boxBuilder(pos, nrm, col, idx, uv, 0, 3.20, 0, 3.80, 2.40, 3.80, LEAF1);
  boxBuilder(pos, nrm, col, idx, uv, 0, 4.90, 0, 3.00, 2.10, 3.00, LEAF2);
  boxBuilder(pos, nrm, col, idx, uv, 0, 6.35, 0, 2.00, 1.70, 2.00, LEAF3);

  return finishMesh(pos, nrm, col, idx, uv, texture);
}

function buildPineMesh(texture) {
  const pos = [], nrm = [], col = [], idx = [], uv = [];
  const TRUNK = [0.30, 0.17, 0.08];
  const P1 = [0.07, 0.26, 0.12];
  const P2 = [0.10, 0.34, 0.15];
  const P3 = [0.14, 0.44, 0.19];

  boxBuilder(pos, nrm, col, idx, uv, 0, 1.50, 0, 0.45, 3.00, 0.45, TRUNK);
  boxBuilder(pos, nrm, col, idx, uv, 0, 2.60, 0, 3.60, 1.90, 3.60, P1);
  boxBuilder(pos, nrm, col, idx, uv, 0, 4.00, 0, 2.90, 1.80, 2.90, P2);
  boxBuilder(pos, nrm, col, idx, uv, 0, 5.30, 0, 2.10, 1.70, 2.10, P2);
  boxBuilder(pos, nrm, col, idx, uv, 0, 6.50, 0, 1.20, 1.60, 1.20, P3);

  return finishMesh(pos, nrm, col, idx, uv, texture);
}

function buildBirchMesh(texture) {
  const pos = [], nrm = [], col = [], idx = [], uv = [];
  const BARK  = [0.88, 0.87, 0.82];
  const LEAF1 = [0.34, 0.60, 0.20];
  const LEAF2 = [0.45, 0.72, 0.26];

  boxBuilder(pos, nrm, col, idx, uv, 0, 2.30, 0, 0.30, 4.60, 0.30, BARK);
  boxBuilder(pos, nrm, col, idx, uv, 0, 5.20, 0, 2.60, 1.80, 2.60, LEAF1);
  boxBuilder(pos, nrm, col, idx, uv, 0, 6.35, 0, 1.90, 1.50, 1.90, LEAF2);
  boxBuilder(pos, nrm, col, idx, uv, 0, 7.25, 0, 1.10, 1.20, 1.10, LEAF2);

  return finishMesh(pos, nrm, col, idx, uv, texture);
}

function buildBushMesh(texture) {
  const pos = [], nrm = [], col = [], idx = [], uv = [];
  const LEAF1 = [0.16, 0.42, 0.14];
  const LEAF2 = [0.23, 0.53, 0.19];

  boxBuilder(pos, nrm, col, idx, uv, 0, 0.25, 0, 0.30, 0.50, 0.30, [0.30, 0.20, 0.10]);
  boxBuilder(pos, nrm, col, idx, uv, 0, 0.60, 0, 1.80, 1.10, 1.80, LEAF1);
  boxBuilder(pos, nrm, col, idx, uv, 0, 1.30, 0, 1.30, 0.90, 1.30, LEAF2);

  return finishMesh(pos, nrm, col, idx, uv, texture);
}

function buildDeadTreeMesh(texture) {
  const pos = [], nrm = [], col = [], idx = [], uv = [];
  const BARK  = [0.30, 0.25, 0.19];
  const BARK2 = [0.40, 0.33, 0.25];

  boxBuilder(pos, nrm, col, idx, uv, 0, 2.20, 0, 0.50, 4.40, 0.50, BARK);
  boxBuilder(pos, nrm, col, idx, uv, 0.90, 3.60, 0, 1.80, 0.26, 0.26, BARK2);
  boxBuilder(pos, nrm, col, idx, uv, -0.85, 3.00, 0, 1.60, 0.24, 0.24, BARK2);
  boxBuilder(pos, nrm, col, idx, uv, 0, 4.55, 0.35, 0.24, 0.24, 1.40, BARK2);

  return finishMesh(pos, nrm, col, idx, uv, texture);
}

/* =========================================================================
   OPTIONAL ASSETS
   ========================================================================= */
const ASSET_ROOT = 'assets/';
const assetPaths = {
  plane: ASSET_ROOT + 'plane.png',
  propeller: ASSET_ROOT + 'propeller.png',
  tree: ASSET_ROOT + 'tree.png'
};
const assets = Object.create(null);

function nextPOT(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/* WebGL1 + WebGL2 both like power-of-two textures when we want REPEAT and
   mipmaps, so any odd-sized PNG gets resampled onto a POT canvas first. */
function toPowerOfTwo(img) {
  const w = img.width || img.naturalWidth || 0;
  const h = img.height || img.naturalHeight || 0;
  if (!w || !h) return img;
  const pw = nextPOT(w), ph = nextPOT(h);
  if (pw === w && ph === h) return img;

  const c = document.createElement('canvas');
  c.width = pw;
  c.height = ph;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, pw, ph);
  return c;
}

function makeFallbackTexture(r, g, b, a = 255) {
  if (!gl) return null;
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA,
                gl.UNSIGNED_BYTE, new Uint8Array([r, g, b, a]));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return tex;
}

function loadAssetTexture(name, fallback) {
  if (!gl) return null;

  const tex = makeFallbackTexture(fallback[0], fallback[1], fallback[2], 255);
  const entry = { texture: tex, loaded: false, failed: false, path: assetPaths[name] };
  assets[name] = entry;

  const img = new Image();
  img.onload = () => {
    const src = toPowerOfTwo(img);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA,
                  gl.UNSIGNED_BYTE, src);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.bindTexture(gl.TEXTURE_2D, null);
    entry.loaded = true;
    entry.width = src.width;
    entry.height = src.height;
  };
  img.onerror = () => {
    /* Missing assets are expected until the user adds them.
       The 1x1 fallback colour stays bound, so nothing breaks. */
    entry.failed = true;
  };
  img.src = assetPaths[name];
  return tex;
}

function loadAssets() {
  loadAssetTexture('plane',     [224, 61, 41]);
  loadAssetTexture('propeller', [58, 59, 69]);
  loadAssetTexture('tree',      [38, 115, 38]);
}

/* =========================================================================
   MODEL REGISTRY
   ========================================================================= */
const TREE_KINDS = ['oak', 'pine', 'birch', 'bush', 'dead'];

/* Per-variant [minScale, maxScale]. */
const TREE_SCALE = {
  oak:   [0.80, 1.30],
  pine:  [0.85, 1.35],
  birch: [0.75, 1.15],
  bush:  [0.80, 1.45],
  dead:  [0.85, 1.25]
};

const models = {
  planeMesh: null,
  propMesh: null,
  treeMesh: null,                     // default tree (oak) — legacy alias
  treeMeshes: Object.create(null),    // { oak, pine, birch, bush, dead }
  treeVariants: TREE_KINDS.slice(),
  TREE_SCALE,
  assets,
  assetPaths,
  uv: { plane: PLANE_UV_SCALE, prop: PROP_UV_SCALE },

  /* Renderer helper: resolves the mesh for a spawned tree object. */
  getTreeMesh(obj) {
    if (!obj) return models.treeMesh;
    if (obj.mesh) return obj.mesh;
    const k = obj.variant || obj.kind || obj.type;
    return (k && models.treeMeshes[k]) || models.treeMesh;
  }
};

function init(glContext) {
  gl = glContext;

  /* Textures first: the fallback 1x1 is created synchronously and the real
     PNG swaps itself in later, so mesh.texture stays valid forever. */
  loadAssets();

  const planeTex = assets.plane ? assets.plane.texture : null;
  const propTex  = assets.propeller ? assets.propeller.texture : null;
  const treeTex  = USE_TREE_TEXTURE && assets.tree ? assets.tree.texture : null;

  models.planeMesh = buildPlaneMesh(planeTex);
  models.propMesh  = buildPropMesh(propTex);

  models.treeMeshes.oak   = buildOakMesh(treeTex);
  models.treeMeshes.pine  = buildPineMesh(treeTex);
  models.treeMeshes.birch = buildBirchMesh(treeTex);
  models.treeMeshes.bush  = buildBushMesh(treeTex);
  models.treeMeshes.dead  = buildDeadTreeMesh(treeTex);
  models.treeMesh = models.treeMeshes.oak;
}

/* =========================================================================
   CHUNKED TERRAIN STREAMING + TREE SPAWNING
   ========================================================================= */
const CHUNK_SIZE = 140;
const CHUNK_SEG = 12;
const VIEW_RADIUS = 6;
const CHUNK_BUDGET_MS = 5;
const chunks = new Map();

function pickTreeKind(y, r) {
  if (y > 46) return r < 0.65 ? 'pine' : 'dead';                 // high ground
  if (y > 28) {                                                  // hillside
    if (r < 0.42) return 'pine';
    if (r < 0.78) return 'oak';
    if (r < 0.92) return 'birch';
    return 'dead';
  }
  if (r < 0.34) return 'oak';                                    // lowlands
  if (r < 0.62) return 'birch';
  if (r < 0.84) return 'bush';
  return 'pine';
}

function buildChunk(cx, cz) {
  const N = CHUNK_SEG + 1;
  const step = CHUNK_SIZE / CHUNK_SEG;
  const ox = cx * CHUNK_SIZE;
  const oz = cz * CHUNK_SIZE;

  const heights = new Float32Array(N * N);
  const pos = new Float32Array(N * N * 3);
  const nrm = new Float32Array(N * N * 3);

  let minY = Infinity, maxY = -Infinity;

  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const x = ox + i * step;
      const z = oz + j * step;
      const y = terrainHeight(x, z);
      heights[j * N + i] = y;

      const k = (j * N + i) * 3;
      pos[k] = x;
      pos[k + 1] = y;
      pos[k + 2] = z;

      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const iL = Math.max(0, i - 1), iR = Math.min(N - 1, i + 1);
      const jD = Math.max(0, j - 1), jU = Math.min(N - 1, j + 1);
      const hl = heights[j * N + iL], hr = heights[j * N + iR];
      const hd = heights[jD * N + i], hu = heights[jU * N + i];

      const nx = hl - hr;
      const ny = 2 * step;
      const nz = hd - hu;
      const l = Math.hypot(nx, ny, nz) || 1;
      const k = (j * N + i) * 3;

      nrm[k] = nx / l;
      nrm[k + 1] = ny / l;
      nrm[k + 2] = nz / l;
    }
  }

  const idx = new Uint16Array(CHUNK_SEG * CHUNK_SEG * 6);
  let t = 0;
  for (let j = 0; j < CHUNK_SEG; j++) {
    for (let i = 0; i < CHUNK_SEG; i++) {
      const a = j * N + i, b = a + 1, c = a + N, d = c + 1;
      idx[t++] = a; idx[t++] = c; idx[t++] = b;
      idx[t++] = b; idx[t++] = c; idx[t++] = d;
    }
  }

  const mesh = createMesh(pos, nrm, null, idx);
  const cy = (minY + maxY) * 0.5;
  const radius = Math.hypot(CHUNK_SIZE * 0.71, (maxY - minY) * 0.5) + 2;

  /* Deterministic forest: the same chunk always gets the same layout. */
  const objects = [];
  const seed = (cx * 73856093) ^ (cz * 19349663);
  const count = 3 + ((Math.abs(seed) >>> 0) % 4);

  for (let i = 0; i < count; i++) {
    const r1 = hash2(cx * 31 + i * 17, cz * 47 + i * 13);
    const r2 = hash2(cx * 53 + i * 29 + 7, cz * 71 + i * 11 + 3);
    const r3 = hash2(cx * 89 + i * 7 + 19, cz * 97 + i * 23 + 5);
    const r4 = hash2(cx * 131 + i * 41 + 11, cz * 157 + i * 19 + 23);
    const r5 = hash2(cx * 173 + i * 59 + 29, cz * 199 + i * 31 + 17);

    const x = ox + 18 + r1 * (CHUNK_SIZE - 36);
    const z = oz + 18 + r2 * (CHUNK_SIZE - 36);
    const y = terrainHeight(x, z);

    /* Keep the original spawn area clear so the start still feels identical. */
    if (Math.hypot(x, z) < 90) continue;

    /* Trees stay on reasonable ground and avoid deep water. */
    if (y < 2 || y > 72) continue;

    const kind = pickTreeKind(y, r4);
    const range = TREE_SCALE[kind] || [1, 1];
    const scale = range[0] + r5 * (range[1] - range[0]);

    objects.push({
      type: 'tree',
      variant: kind,
      mesh: models.treeMeshes[kind] || models.treeMesh,
      position: [x, y, z],
      rotation: r3 * Math.PI * 2,
      scale: scale
    });
  }

  return {
    cx, cz, mesh,
    objects,
    center: [ox + CHUNK_SIZE * 0.5, cy, oz + CHUNK_SIZE * 0.5],
    radius
  };
}

function updateChunks(px, pz) {
  const t0 = performance.now();
  const pcx = Math.floor(px / CHUNK_SIZE);
  const pcz = Math.floor(pz / CHUNK_SIZE);
  const R = VIEW_RADIUS, R2 = R * R + R;

  const wanted = [];
  for (let dz = -R; dz <= R; dz++) {
    for (let dx = -R; dx <= R; dx++) {
      const d2 = dx * dx + dz * dz;
      if (d2 > R2) continue;
      wanted.push([pcx + dx, pcz + dz, d2]);
    }
  }
  wanted.sort((a, b) => a[2] - b[2]);

  for (const [cx, cz] of wanted) {
    if (performance.now() - t0 > CHUNK_BUDGET_MS) break;
    const key = cx + ',' + cz;
    if (!chunks.has(key)) chunks.set(key, buildChunk(cx, cz));
  }

  const killR = R + 2;
  for (const [key, ch] of chunks) {
    const dx = ch.cx - pcx, dz = ch.cz - pcz;
    if (dx * dx + dz * dz > killR * killR) {
      deleteMesh(ch.mesh);
      chunks.delete(key);
    }
  }
}

function initTerrain(glContext) {
  gl = glContext;
}

global.Terrain = {
  init: initTerrain,
  terrainHeight,
  createMesh,
  deleteMesh,
  boxBuilder,
  updateChunks,
  chunks,
  CHUNK_SIZE,
  CHUNK_SEG,
  VIEW_RADIUS
};

models.init = init;
global.Models = models;

})(window);
