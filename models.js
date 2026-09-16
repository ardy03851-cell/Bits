/* models.js — terrain generation system + shared mesh utilities
   Exposed as global `Terrain`.
   Call Terrain.init(gl) once before using anything that touches GL.
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
  const a = hash2(xi, yi),     b = hash2(xi + 1, yi);
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
   TERRAIN HEIGHT  (single source of truth for the world)
   ========================================================================= */
function terrainHeight(x, z) {
  let h = 0;
  h += fbm(x * 0.00058, z * 0.00058, 4) * 115;            // continents
  h += fbm(x * 0.0042 + 91.3, z * 0.0042 + 17.7, 4) * 24; // hills
  h += fbm(x * 0.019 + 5.1, z * 0.019 + 44.9, 2) * 3.5;   // detail
  return h - 20;
}

/* =========================================================================
   MESH UTILITIES
   ========================================================================= */
function createMesh(posArr, nrmArr, colArr, idxArr) {
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

  const ib = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idxArr, gl.STATIC_DRAW);
  bufs.push(ib);

  gl.bindVertexArray(null);
  return { vao, bufs, count: idxArr.length };
}

function deleteMesh(m) {
  if (!m || !gl) return;
  for (const b of m.bufs) gl.deleteBuffer(b);
  gl.deleteVertexArray(m.vao);
}

/* helper: append an axis-aligned box to pos/nrm/col/idx arrays */
function boxBuilder(pos, nrm, col, idx, cx, cy, cz, sx, sy, sz, color) {
  const x0 = cx - sx / 2, x1 = cx + sx / 2;
  const y0 = cy - sy / 2, y1 = cy + sy / 2;
  const z0 = cz - sz / 2, z1 = cz + sz / 2;

  function quad(a, b, c, d, n) {
    const base = pos.length / 3;
    pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], d[0], d[1], d[2]);
    for (let i = 0; i < 4; i++) {
      nrm.push(n[0], n[1], n[2]);
      col.push(color[0], color[1], color[2]);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  quad([x1,y0,z1],[x1,y0,z0],[x1,y1,z0],[x1,y1,z1], [ 1,0,0]);
  quad([x0,y0,z0],[x0,y0,z1],[x0,y1,z1],[x0,y1,z0], [-1,0,0]);
  quad([x0,y1,z1],[x1,y1,z1],[x1,y1,z0],[x0,y1,z0], [0, 1,0]);
  quad([x0,y0,z0],[x1,y0,z0],[x1,y0,z1],[x0,y0,z1], [0,-1,0]);
  quad([x1,y0,z0],[x0,y0,z0],[x0,y1,z0],[x1,y1,z0], [0,0,-1]);
  quad([x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1], [0,0, 1]);
}

/* =========================================================================
   CHUNKED TERRAIN STREAMING
   ========================================================================= */
const CHUNK_SIZE    = 140;   // world units per chunk
const CHUNK_SEG     = 12;    // quads per side
const VIEW_RADIUS   = 6;     // chunks in every direction
const CHUNK_BUDGET_MS = 5;   // generation time per frame
const chunks = new Map();

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
      pos[k] = x; pos[k + 1] = y; pos[k + 2] = z;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  // smooth normals used for silhouette outline expansion
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
      nrm[k] = nx / l; nrm[k + 1] = ny / l; nrm[k + 2] = nz / l;
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

  return {
    cx, cz, mesh,
    center: [ox + CHUNK_SIZE * 0.5, cy, oz + CHUNK_SIZE * 0.5],
    radius
  };
}

/* Called every frame. Streams chunks in/out around (px, pz).
   Bounded by CHUNK_BUDGET_MS so it never blocks the frame. */
function updateChunks(px, pz) {
  const t0 = performance.now();
  const pcx = Math.floor(px / CHUNK_SIZE);
  const pcz = Math.floor(pz / CHUNK_SIZE);
  const R = VIEW_RADIUS, R2 = R * R + R;

  // gather wanted chunks sorted by distance
  const wanted = [];
  for (let dz = -R; dz <= R; dz++) {
    for (let dx = -R; dx <= R; dx++) {
      const d2 = dx * dx + dz * dz;
      if (d2 > R2) continue;
      wanted.push([pcx + dx, pcz + dz, d2]);
    }
  }
  wanted.sort((a, b) => a[2] - b[2]);

  // generate until time budget is spent
  for (const [cx, cz] of wanted) {
    if (performance.now() - t0 > CHUNK_BUDGET_MS) break;
    const key = cx + ',' + cz;
    if (!chunks.has(key)) {
      chunks.set(key, buildChunk(cx, cz));
    }
  }

  // remove chunks that drifted too far away
  const killR = R + 2;
  for (const [key, ch] of chunks) {
    const dx = ch.cx - pcx, dz = ch.cz - pcz;
    if (dx * dx + dz * dz > killR * killR) {
      deleteMesh(ch.mesh);
      chunks.delete(key);
    }
  }
}

/* =========================================================================
   INIT / EXPORTS
   ========================================================================= */
function init(glContext) { gl = glContext; }

global.Terrain = {
  init,
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

})(window);
