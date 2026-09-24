/* models.js — terrain generation + every world model
   Terrain is the single source of truth for height, chunks and spawned props.

   ------------------------------------------------------------------
   TEXTURES  (drop PNGs into ./assets/ — all optional)
   ------------------------------------------------------------------
     plane.png          airplane body
     propeller.png      propeller
     tree_oak.png       tree atlas / per-type textures
     tree_pine.png
     tree_birch.png
     tree_maple.png
     tree_spruce.png
     tree_redwood.png
     tree_willow.png
     tree_palm.png
     tree_cactus.png
     tree_bush.png
     tree_dead.png

   If a file is missing, the mesh keeps its procedural vertex colours.
   Plane / propeller use world-wrapped UVs so the texture flows around the
   whole airframe.  Trees use world-wrapped UVs at a smaller scale.
   ------------------------------------------------------------------
   RENDERER REQUIREMENTS
   ------------------------------------------------------------------
     attribute 0 : vec3 position
     attribute 1 : vec3 normal
     attribute 2 : vec3 colour     (multiply with texture)
     attribute 3 : vec2 uv         (needed for textures)
     uniform sampler2D uTexture    (bind mesh.texture here, unit 0)
   ------------------------------------------------------------------

   CHANGES IN THIS VERSION
   ------------------------------------------------------------------
   • Biome noise frequencies raised ~4x so biomes are encountered locally
     instead of once per ~7,000 units.
   • Three new biomes added: savanna, badlands, highlands.
   • Terrain now stacks three overlapping mountain scales (large ranges,
     medium connector ridges, small foothills) with a much taller peak
     contribution, so massive mountains actually appear in view.
   • Tree tables extended for the new biomes.
   • Oasis palm trigger window widened so palms ring the water tongues.
   ------------------------------------------------------------------
*/
(function (global) {
'use strict';

let gl = null;

/* =========================================================================
   MATH HELPERS
   ========================================================================= */
function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}
function lerp(a, b, t) { return a + (b - a) * t; }

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
function ridgedFbm(x, y, oct) {
  let amp = 1, freq = 1, sum = 0, n = 0;
  for (let i = 0; i < oct; i++) {
    let v = 1 - Math.abs(noise2(x * freq, y * freq) * 2 - 1);
    v *= v;
    sum += v * amp;
    n += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / n; // 0..1
}

/* =========================================================================
   BIOME FIELDS
   ========================================================================= */
const SEA_LEVEL = 0;

/* Wavelengths tuned so biomes are visible during a single flight:
     tempNoise  : wavelength ≈ 2,200 units
     moistNoise : wavelength ≈ 1,400 units
   (previous values were ~7,700 / ~4,760, i.e. effectively invisible) */
function tempNoise(x, z) {
  return fbm(x * 0.00045 + 512.3, z * 0.00045 + 941.7, 3);
}
function moistNoise(x, z) {
  return fbm(x * 0.00072 + 187.4, z * 0.00072 + 623.1, 3);
}

function getBiome(x, z, y) {
  const t = tempNoise(x, z);
  const m = moistNoise(x, z);

  /* altitude layers first */
  if (y < SEA_LEVEL - 1.5) return 'ocean';
  if (y < SEA_LEVEL + 2.5) return 'beach';
  if (y > 92) return 'snow';
  if (y > 62) return (t < 0.10) ? 'snow' : 'highlands';

  /* latitude (temperature) */
  if (t < -0.42) return 'snow';
  if (t < -0.28) return 'tundra';

  /* hot / dry quadrant */
  if (t > 0.15 && m < -0.12) {
    return (y > 32) ? 'badlands' : 'desert';
  }
  /* hot / semi-dry */
  if (t > 0.18 && m < 0.10) return 'savanna';

  /* hot / wet */
  if (t > 0.10 && m > 0.30) return 'jungle';

  /* wet & low */
  if (m > 0.42 && y < 12) return 'swamp';

  /* upland */
  if (y > 48) return 'mountain';

  /* temperate default */
  if (m > 0.05) return 'forest';
  return 'plains';
}

/* =========================================================================
   TERRAIN HEIGHT
   ========================================================================= */
function terrainHeight(x, z) {
  /* Continental base — broad shaping */
  const continent = fbm(x * 0.00016, z * 0.00016, 4);
  let h = continent * 50;

  /* Rolling hills */
  h += fbm(x * 0.0034, z * 0.0034, 3) * 12;

  /* ---------------------------------------------------------------
     MOUNTAINS — three overlapping scales.
     mask  : where mountains are allowed to form
     ridge : the actual sharp, elongated mountain shape
     Higher frequency + more permissive mask = ranges you can
     actually find and fly through.
     --------------------------------------------------------------- */

  /* LARGE ranges — towering peaks up to ~230 m */
  const maskLarge = smoothstep(-0.05, 0.40,
      fbm(x * 0.00060 + 71.2, z * 0.00060 + 33.8, 3));
  if (maskLarge > 0.001) {
    const ridgeLarge = ridgedFbm(x * 0.0011 + 12.3, z * 0.0011 + 45.7, 5);
    h += Math.pow(ridgeLarge, 1.35) * maskLarge * 230;
  }

  /* MEDIUM ridges — connector peaks between ranges, ~95 m */
  const maskMed = smoothstep(0.00, 0.45,
      fbm(x * 0.0014 + 88.1, z * 0.0014 + 22.9, 3));
  if (maskMed > 0.001) {
    const ridgeMed = ridgedFbm(x * 0.0025 + 33.7, z * 0.0025 + 91.1, 4);
    h += Math.pow(ridgeMed, 1.5) * maskMed * 95;
  }

  /* SMALL foothills — short bumps, ~30 m */
  const maskSmall = smoothstep(0.10, 0.55,
      fbm(x * 0.0032 + 99.1, z * 0.0032 + 77.4, 2));
  if (maskSmall > 0.001) {
    const ridgeSmall = ridgedFbm(x * 0.0052 + 55.5, z * 0.0052 + 11.7, 3);
    h += Math.pow(ridgeSmall, 1.6) * maskSmall * 30;
  }

  /* Cliff bands — terraced walls (unchanged idea, tighter mask) */
  const cliffMask = smoothstep(0.55, 0.72,
      fbm(x * 0.0008 + 555, z * 0.0008 + 555, 2));
  if (cliffMask > 0.001) {
    const stepH = 11;
    const t = h / stepH;
    const f = t - Math.floor(t);
    const sharp = Math.pow(f, 3.5);
    const hTerr = (Math.floor(t) + sharp) * stepH;
    h = h * (1 - cliffMask) + hTerr * cliffMask;
  }

  h -= 8;

  /* Desert oases: rare, winding water tongues in low-lying hot/dry areas */
  if (h < 25) {
    const t = tempNoise(x, z);
    const m = moistNoise(x, z);
    if (t > 0.10 && m < 0.05) {
      const o = Math.abs(fbm(x * 0.004 + 800, z * 0.004 + 800, 3));
      const oasis = 1 - smoothstep(0.02, 0.10, o);
      if (oasis > 0.001) {
        const floorY = -14;
        const target = Math.min(h, 4);
        h = target * (1 - oasis) + floorY * oasis;
      }
    }
  }

  return h;
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

/* Box with UVs.
   Signature:
     boxBuilder(pos, nrm, col, idx, uv, cx, cy, cz, sx, sy, sz, color,
                uvScale, uvMode)
   uvMode 'fit'   : whole texture per face
   uvMode 'world' : UVs from model-space, wrapping continuously            */
function boxBuilder(pos, nrm, col, idx, uv, cx, cy, cz, sx, sy, sz, color,
                    uvScale, uvMode) {
  /* Backward-compatible with old signature (no uv array) */
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
   UV SCALES  (world units per texture tile)
   ========================================================================= */
const PLANE_UV_SCALE = 0.40;
const PROP_UV_SCALE  = 0.60;
const TREE_UV_SCALE  = 0.50;

/* =========================================================================
   WORLD MODELS — AIRCRAFT
   ========================================================================= */
function buildPlaneMesh(texture) {
  const pos = [], nrm = [], col = [], idx = [], uv = [];
  const BODY   = [0.88, 0.24, 0.16];
  const WING   = [0.96, 0.97, 0.98];
  const GLASS  = [0.22, 0.44, 0.62];
  const ACCENT = [1.00, 0.80, 0.24];
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
   All builders: origin at ground, +Y up, roughly 1 unit = 1 metre.
   ========================================================================= */
function treePart(pos, nrm, col, idx, uv, cx, cy, cz, sx, sy, sz, color) {
  boxBuilder(pos, nrm, col, idx, uv, cx, cy, cz, sx, sy, sz,
             color, TREE_UV_SCALE, 'world');
}

/* ---- OAK : medium broad canopy ---------------------------------------- */
function buildOakMesh(texture) {
  const pos=[],nrm=[],col=[],idx=[],uv=[];
  const TRUNK=[0.28,0.14,0.055];
  const L1=[0.10,0.34,0.10], L2=[0.15,0.46,0.13], L3=[0.22,0.55,0.16];

  treePart(pos,nrm,col,idx,uv, 0, 1.60, 0, 0.55,3.20,0.55, TRUNK);
  treePart(pos,nrm,col,idx,uv, 0, 3.20, 0, 3.80,2.40,3.80, L1);
  treePart(pos,nrm,col,idx,uv, 0, 4.90, 0, 3.00,2.10,3.00, L2);
  treePart(pos,nrm,col,idx,uv, 0, 6.35, 0, 2.00,1.70,2.00, L3);
  return finishMesh(pos,nrm,col,idx,uv,texture);
}

/* ---- PINE : medium conical -------------------------------------------- */
function buildPineMesh(texture) {
  const pos=[],nrm=[],col=[],idx=[],uv=[];
  const TRUNK=[0.30,0.17,0.08];
  const P1=[0.07,0.26,0.12], P2=[0.10,0.34,0.15], P3=[0.14,0.44,0.19];

  treePart(pos,nrm,col,idx,uv, 0, 1.50, 0, 0.45,3.00,0.45, TRUNK);
  treePart(pos,nrm,col,idx,uv, 0, 2.60, 0, 3.60,1.90,3.60, P1);
  treePart(pos,nrm,col,idx,uv, 0, 4.00, 0, 2.90,1.80,2.90, P2);
  treePart(pos,nrm,col,idx,uv, 0, 5.30, 0, 2.10,1.70,2.10, P2);
  treePart(pos,nrm,col,idx,uv, 0, 6.50, 0, 1.20,1.60,1.20, P3);
  return finishMesh(pos,nrm,col,idx,uv,texture);
}

/* ---- BIRCH : tall thin, white bark ------------------------------------ */
function buildBirchMesh(texture) {
  const pos=[],nrm=[],col=[],idx=[],uv=[];
  const BARK=[0.88,0.87,0.82];
  const L1=[0.34,0.60,0.20], L2=[0.45,0.72,0.26];

  treePart(pos,nrm,col,idx,uv, 0, 2.30, 0, 0.30,4.60,0.30, BARK);
  treePart(pos,nrm,col,idx,uv, 0, 5.20, 0, 2.60,1.80,2.60, L1);
  treePart(pos,nrm,col,idx,uv, 0, 6.35, 0, 1.90,1.50,1.90, L2);
  treePart(pos,nrm,col,idx,uv, 0, 7.25, 0, 1.10,1.20,1.10, L2);
  return finishMesh(pos,nrm,col,idx,uv,texture);
}

/* ---- BUSH : small, low ------------------------------------------------ */
function buildBushMesh(texture) {
  const pos=[],nrm=[],col=[],idx=[],uv=[];
  const L1=[0.16,0.42,0.14], L2=[0.23,0.53,0.19];

  treePart(pos,nrm,col,idx,uv, 0, 0.25, 0, 0.30,0.50,0.30, [0.30,0.20,0.10]);
  treePart(pos,nrm,col,idx,uv, 0, 0.60, 0, 1.80,1.10,1.80, L1);
  treePart(pos,nrm,col,idx,uv, 0, 1.30, 0, 1.30,0.90,1.30, L2);
  return finishMesh(pos,nrm,col,idx,uv,texture);
}

/* ---- DEAD : bare, twisted branches ------------------------------------ */
function buildDeadTreeMesh(texture) {
  const pos=[],nrm=[],col=[],idx=[],uv=[];
  const BARK=[0.30,0.25,0.19], BARK2=[0.40,0.33,0.25];

  treePart(pos,nrm,col,idx,uv, 0, 2.20, 0, 0.50,4.40,0.50, BARK);
  treePart(pos,nrm,col,idx,uv, 0.90, 3.60, 0, 1.80,0.26,0.26, BARK2);
  treePart(pos,nrm,col,idx,uv, -0.85, 3.00, 0, 1.60,0.24,0.24, BARK2);
  treePart(pos,nrm,col,idx,uv, 0, 4.55, 0.35, 0.24,0.24,1.40, BARK2);
  treePart(pos,nrm,col,idx,uv, 0.5, 4.1, -0.6, 1.2,0.20,0.20, BARK2);
  return finishMesh(pos,nrm,col,idx,uv,texture);
}

/* ---- PALM : tall, curved, fronds at top ------------------------------- */
function buildPalmMesh(texture) {
  const pos=[],nrm=[],col=[],idx=[],uv=[];
  const TRUNK=[0.45,0.30,0.16], TRUNK_LT=[0.55,0.38,0.22];
  const FROND=[0.20,0.55,0.18], FROND_LT=[0.32,0.68,0.24];
  const COCO=[0.30,0.20,0.10];

  /* Segmented, slightly leaning trunk */
  const segs = 10, segH = 0.9;
  let topX = 0, topZ = 0;
  for (let i = 0; i < segs; i++) {
    const t = i / segs;
    const nx = Math.sin(i * 0.35) * 0.35 * t;
    const nz = Math.cos(i * 0.28) * 0.22 * t;
    const y = 0.5 + i * segH;
    const w = 0.55 - t * 0.20;
    treePart(pos,nrm,col,idx,uv, nx, y, nz, w, segH, w,
             (i % 2) ? TRUNK : TRUNK_LT);
    topX = nx; topZ = nz;
  }
  const topY = 0.5 + segs * segH - 0.2;

  /* Coconut cluster */
  treePart(pos,nrm,col,idx,uv, topX, topY - 0.10, topZ, 0.65,0.45,0.65, COCO);

  /* Fronds (thin boxes radiating from top) */
  const FROND_COUNT = 7;
  for (let i = 0; i < FROND_COUNT; i++) {
    const a = (i / FROND_COUNT) * Math.PI * 2 + 0.37;
    const dx = Math.cos(a), dz = Math.sin(a);
    /* Inner segment */
    treePart(pos,nrm,col,idx,uv,
             topX + dx * 0.9, topY + 0.20, topZ + dz * 0.9,
             Math.abs(dx) * 2.0 + 0.35,
             0.14,
             Math.abs(dz) * 2.0 + 0.35,
             FROND);
    /* Outer, drooping tip */
    treePart(pos,nrm,col,idx,uv,
             topX + dx * 1.9, topY - 0.35, topZ + dz * 1.9,
             Math.abs(dx) * 1.5 + 0.25,
             0.12,
             Math.abs(dz) * 1.5 + 0.25,
             FROND_LT);
  }
  return finishMesh(pos,nrm,col,idx,uv,texture);
}

/* ---- CACTUS : saguaro ------------------------------------------------ */
function buildCactusMesh(texture) {
  const pos=[],nrm=[],col=[],idx=[],uv=[];
  const BODY=[0.20,0.50,0.24], BODY_LT=[0.28,0.60,0.30];

  /* Trunk */
  treePart(pos,nrm,col,idx,uv, 0, 2.30, 0, 0.75,4.60,0.75, BODY);
  treePart(pos,nrm,col,idx,uv, 0, 4.55, 0, 0.55,0.35,0.55, BODY_LT);

  /* Left arm */
  treePart(pos,nrm,col,idx,uv, -0.85, 2.60, 0, 1.10,0.50,0.50, BODY);
  treePart(pos,nrm,col,idx,uv, -1.35, 3.45, 0, 0.50,1.90,0.50, BODY);
  treePart(pos,nrm,col,idx,uv, -1.35, 4.35, 0, 0.38,0.28,0.38, BODY_LT);

  /* Right arm */
  treePart(pos,nrm,col,idx,uv,  0.85, 3.10, 0, 1.10,0.50,0.50, BODY);
  treePart(pos,nrm,col,idx,uv,  1.35, 4.00, 0, 0.50,2.10,0.50, BODY);
  treePart(pos,nrm,col,idx,uv,  1.35, 5.00, 0, 0.38,0.28,0.38, BODY_LT);

  return finishMesh(pos,nrm,col,idx,uv,texture);
}

/* ---- REDWOOD : very tall, massive ------------------------------------ */
function buildRedwoodMesh(texture) {
  const pos=[],nrm=[],col=[],idx=[],uv=[];
  const BARK=[0.42,0.20,0.12];
  const L1=[0.09,0.32,0.10], L2=[0.13,0.42,0.13], L3=[0.18,0.50,0.16];

  treePart(pos,nrm,col,idx,uv, 0, 6.00, 0, 1.60,12.00,1.60, BARK);
  treePart(pos,nrm,col,idx,uv, 0,11.50, 0, 6.20,3.40,6.20, L1);
  treePart(pos,nrm,col,idx,uv, 0,14.00, 0, 5.00,3.00,5.00, L2);
  treePart(pos,nrm,col,idx,uv, 0,16.20, 0, 3.60,2.60,3.60, L2);
  treePart(pos,nrm,col,idx,uv, 0,17.80, 0, 2.00,2.20,2.00, L3);
  return finishMesh(pos,nrm,col,idx,uv,texture);
}

/* ---- WILLOW : wide, drooping canopy ---------------------------------- */
function buildWillowMesh(texture) {
  const pos=[],nrm=[],col=[],idx=[],uv=[];
  const BARK=[0.32,0.22,0.12];
  const L1=[0.20,0.44,0.18], L2=[0.30,0.55,0.22], L3=[0.38,0.62,0.26];

  treePart(pos,nrm,col,idx,uv, 0, 2.00, 0, 0.65,4.00,0.65, BARK);
  treePart(pos,nrm,col,idx,uv, 0, 3.60, 0, 5.20,1.20,5.20, L1);
  treePart(pos,nrm,col,idx,uv, 0, 4.40, 0, 4.60,1.10,4.60, L2);
  /* Droopy lower lobes */
  treePart(pos,nrm,col,idx,uv,  2.10, 2.90, 0, 1.60,2.60,1.60, L1);
  treePart(pos,nrm,col,idx,uv, -2.10, 2.90, 0, 1.60,2.60,1.60, L1);
  treePart(pos,nrm,col,idx,uv, 0, 2.90,  2.10, 1.60,2.60,1.60, L1);
  treePart(pos,nrm,col,idx,uv, 0, 2.90, -2.10, 1.60,2.60,1.60, L1);
  treePart(pos,nrm,col,idx,uv, 0, 5.20, 0, 3.20,1.00,3.20, L3);
  return finishMesh(pos,nrm,col,idx,uv,texture);
}

/* ---- SPRUCE : tall, narrow, layered ---------------------------------- */
function buildSpruceMesh(texture) {
  const pos=[],nrm=[],col=[],idx=[],uv=[];
  const BARK=[0.28,0.18,0.10];
  const C1=[0.08,0.28,0.12], C2=[0.11,0.36,0.15], C3=[0.16,0.46,0.20];

  treePart(pos,nrm,col,idx,uv, 0, 1.80, 0, 0.42,3.60,0.42, BARK);
  treePart(pos,nrm,col,idx,uv, 0, 2.60, 0, 3.40,1.60,3.40, C1);
  treePart(pos,nrm,col,idx,uv, 0, 3.80, 0, 3.00,1.55,3.00, C2);
  treePart(pos,nrm,col,idx,uv, 0, 5.00, 0, 2.55,1.50,2.55, C1);
  treePart(pos,nrm,col,idx,uv, 0, 6.15, 0, 2.10,1.45,2.10, C2);
  treePart(pos,nrm,col,idx,uv, 0, 7.25, 0, 1.65,1.40,1.65, C3);
  treePart(pos,nrm,col,idx,uv, 0, 8.30, 0, 1.20,1.30,1.20, C2);
  treePart(pos,nrm,col,idx,uv, 0, 9.25, 0, 0.75,1.20,0.75, C3);
  return finishMesh(pos,nrm,col,idx,uv,texture);
}

/* ---- MAPLE : medium, warm canopy ------------------------------------- */
function buildMapleMesh(texture) {
  const pos=[],nrm=[],col=[],idx=[],uv=[];
  const BARK=[0.34,0.22,0.14];
  const L1=[0.55,0.22,0.12], L2=[0.68,0.32,0.14], L3=[0.78,0.44,0.20];

  treePart(pos,nrm,col,idx,uv, 0, 1.70, 0, 0.55,3.40,0.55, BARK);
  treePart(pos,nrm,col,idx,uv, 0, 3.30, 0, 4.00,2.10,4.00, L1);
  treePart(pos,nrm,col,idx,uv, 0, 4.70, 0, 3.10,1.90,3.10, L2);
  treePart(pos,nrm,col,idx,uv, 0, 5.90, 0, 2.10,1.60,2.10, L3);
  return finishMesh(pos,nrm,col,idx,uv,texture);
}

/* =========================================================================
   TREE REGISTRY
   ========================================================================= */
const TREE_DEFS = {
  oak:     { build: buildOakMesh,     scale: [0.85, 1.30], biome: 'forest' },
  pine:    { build: buildPineMesh,    scale: [0.90, 1.40], biome: 'forest' },
  birch:   { build: buildBirchMesh,   scale: [0.75, 1.15], biome: 'forest' },
  bush:    { build: buildBushMesh,    scale: [0.80, 1.50], biome: 'any'    },
  dead:    { build: buildDeadTreeMesh,scale: [0.80, 1.25], biome: 'any'    },
  palm:    { build: buildPalmMesh,    scale: [0.85, 1.30], biome: 'desert' },
  cactus:  { build: buildCactusMesh,  scale: [0.75, 1.30], biome: 'desert' },
  redwood: { build: buildRedwoodMesh, scale: [0.75, 1.15], biome: 'forest' },
  willow:  { build: buildWillowMesh,  scale: [0.80, 1.20], biome: 'swamp'  },
  spruce:  { build: buildSpruceMesh,  scale: [0.85, 1.35], biome: 'cold'   },
  maple:   { build: buildMapleMesh,   scale: [0.80, 1.20], biome: 'forest' }
};

/* =========================================================================
   BIOME -> TREE VARIANT TABLE
   Each entry: [variant, cumulativeWeight]
   ========================================================================= */
const BIOME_TREES = {
  forest:   [['oak',0.22],['pine',0.42],['birch',0.58],['maple',0.72],
             ['spruce',0.82],['willow',0.89],['redwood',0.95],['bush',1.00]],
  plains:   [['oak',0.35],['bush',0.62],['birch',0.82],['maple',1.00]],
  jungle:   [['palm',0.35],['willow',0.58],['bush',0.80],['redwood',1.00]],
  desert:   [['cactus',0.55],['dead',1.00]],
  savanna:  [['oak',0.35],['bush',0.60],['dead',0.85],['palm',1.00]],
  badlands: [['dead',0.50],['cactus',0.80],['bush',1.00]],
  tundra:   [['spruce',0.40],['pine',0.70],['dead',1.00]],
  snow:     [['spruce',0.65],['dead',1.00]],
  mountain: [['pine',0.50],['spruce',0.82],['dead',1.00]],
  highlands:[['pine',0.40],['spruce',0.70],['dead',0.90],['bush',1.00]],
  swamp:    [['willow',0.55],['dead',1.00]],
  beach:    [['palm',0.75],['bush',1.00]],
  ocean:    []
};

function pickFromTable(table, r) {
  for (let i = 0; i < table.length; i++) {
    if (r <= table[i][1]) return table[i][0];
  }
  return table.length ? table[table.length - 1][0] : null;
}

function pickTreeForBiome(biome, y, r) {
  /* Desert / oasis special case: near water, force palms.
     Widened trigger window (y < 8.0) so palms ring the water tongues. */
  if (biome === 'desert' || biome === 'badlands') {
    if (y > SEA_LEVEL - 0.5 && y < 8.0) return 'palm';
    if (y < SEA_LEVEL - 0.5) return null;      // underwater -> skip
    return pickFromTable(BIOME_TREES[biome], r);
  }
  const table = BIOME_TREES[biome];
  if (!table || !table.length) return null;
  return pickFromTable(table, r);
}

/* =========================================================================
   OPTIONAL ASSETS  (textures)
   ========================================================================= */
const ASSET_ROOT = 'assets/';
const TEXTURE_DEFS = [
  /* key           path                        fallback RGB            */
  ['plane',       'plane.png',                [224,  61,  41]],
  ['propeller',   'propeller.png',            [ 58,  59,  69]],
  ['tree_oak',    'tree_oak.png',             [ 26,  87,  26]],
  ['tree_pine',   'tree_pine.png',            [ 18,  66,  30]],
  ['tree_birch',  'tree_birch.png',           [ 87, 140,  50]],
  ['tree_maple',  'tree_maple.png',           [140,  56,  30]],
  ['tree_spruce', 'tree_spruce.png',          [ 20,  72,  38]],
  ['tree_redwood','tree_redwood.png',         [ 23,  82,  26]],
  ['tree_willow', 'tree_willow.png',          [ 51, 112,  45]],
  ['tree_palm',   'tree_palm.png',            [ 51, 140,  46]],
  ['tree_cactus', 'tree_cactus.png',          [ 51, 128,  61]],
  ['tree_bush',   'tree_bush.png',            [ 41, 107,  36]],
  ['tree_dead',   'tree_dead.png',            [ 76,  63,  48]]
];

const assets = Object.create(null);
const assetPaths = Object.create(null);

/* Fan-out per tree variant, so meshes can look up their texture by name. */
const TREE_TEXTURE_KEY = {
  oak:     'tree_oak',
  pine:    'tree_pine',
  birch:   'tree_birch',
  maple:   'tree_maple',
  spruce:  'tree_spruce',
  redwood: 'tree_redwood',
  willow:  'tree_willow',
  palm:    'tree_palm',
  cactus:  'tree_cactus',
  bush:    'tree_bush',
  dead:    'tree_dead'
};

function nextPOT(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

function toPowerOfTwo(img) {
  const w = img.width || img.naturalWidth || 0;
  const h = img.height || img.naturalHeight || 0;
  if (!w || !h) return img;
  const pw = nextPOT(w), ph = nextPOT(h);
  if (pw === w && ph === h) return img;

  const c = document.createElement('canvas');
  c.width = pw; c.height = ph;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, pw, ph);
  return c;
}

function makeFallbackTexture(r, g, b, a) {
  if (!gl) return null;
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA,
                gl.UNSIGNED_BYTE, new Uint8Array([r, g, b, a == null ? 255 : a]));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return tex;
}

const _loadListeners = [];

function loadAssetTexture(name, filename, fallback) {
  if (!gl) return null;
  const path = ASSET_ROOT + filename;
  assetPaths[name] = path;

  const tex = makeFallbackTexture(fallback[0], fallback[1], fallback[2]);
  const entry = {
    texture: tex,
    loaded: false,
    failed: false,
    path: path,
    name: name
  };
  assets[name] = entry;

  const img = new Image();
  /* Do NOT set crossOrigin — breaks file:// usage in some browsers. */
  img.onload = () => {
    try {
      const src = toPowerOfTwo(img);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA,
                    gl.UNSIGNED_BYTE, src);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER,
                       gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.bindTexture(gl.TEXTURE_2D, null);
      entry.loaded = true;
      entry.width  = src.width || src.naturalWidth;
      entry.height = src.height || src.naturalHeight;
      for (const cb of _loadListeners) { try { cb(entry); } catch (e) {} }
    } catch (err) {
      entry.failed = true;
      console.warn('[Models] texture upload failed for', path, err);
    }
  };
  img.onerror = () => {
    entry.failed = true;
    /* Missing assets are expected — silent, keep fallback colour. */
    for (const cb of _loadListeners) { try { cb(entry); } catch (e) {} }
  };
  img.src = path;
  return tex;
}

function loadAssets() {
  for (const [name, file, fb] of TEXTURE_DEFS) {
    loadAssetTexture(name, file, fb);
  }
}

function onAssetsLoaded(cb) {
  _loadListeners.push(cb);
  /* Fire immediately for any already-resolved entries. */
  for (const k in assets) {
    const e = assets[k];
    if (e.loaded || e.failed) { try { cb(e); } catch (_) {} }
  }
}

function registerTexture(name, filename, fallbackRGB) {
  const fb = fallbackRGB || [200, 200, 200];
  return loadAssetTexture(name, filename, fb);
}

/* =========================================================================
   MODEL REGISTRY
   ========================================================================= */
const TREE_KINDS = Object.keys(TREE_DEFS);

const models = {
  planeMesh: null,
  propMesh:  null,
  treeMesh:  null,                     // default tree (oak) — legacy alias
  treeMeshes: Object.create(null),     // { oak, pine, ... }
  treeVariants: TREE_KINDS,
  TREE_DEFS: TREE_DEFS,
  BIOME_TREES: BIOME_TREES,
  assets,
  assetPaths,
  onAssetsLoaded,
  registerTexture,
  getBiome,
  SEA_LEVEL,
  uv: {
    plane: PLANE_UV_SCALE,
    prop:  PROP_UV_SCALE,
    tree:  TREE_UV_SCALE
  },

  /* Renderer helper: resolves the mesh for a spawned tree object. */
  getTreeMesh(obj) {
    if (!obj) return models.treeMesh;
    if (obj.mesh) return obj.mesh;
    const k = obj.variant || obj.kind;
    return (k && models.treeMeshes[k]) || models.treeMesh;
  }
};

function init(glContext) {
  gl = glContext;

  /* Textures first: 1x1 fallbacks are created synchronously; the real PNGs
     swap in asynchronously.  Meshes hold a stable WebGLTexture reference, so
     they automatically pick up the real image when it arrives. */
  loadAssets();

  const planeTex = assets.plane ? assets.plane.texture : null;
  const propTex  = assets.propeller ? assets.propeller.texture : null;

  models.planeMesh = buildPlaneMesh(planeTex);
  models.propMesh  = buildPropMesh(propTex);

  for (const kind of TREE_KINDS) {
    const def = TREE_DEFS[kind];
    const texKey = TREE_TEXTURE_KEY[kind];
    const tex = (texKey && assets[texKey]) ? assets[texKey].texture : null;
    models.treeMeshes[kind] = def.build(tex);
  }
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
  const count = 4 + ((Math.abs(seed) >>> 0) % 5);   // 4..8 attempts

  for (let i = 0; i < count; i++) {
    const r1 = hash2(cx * 31 + i * 17, cz * 47 + i * 13);
    const r2 = hash2(cx * 53 + i * 29 + 7, cz * 71 + i * 11 + 3);
    const r3 = hash2(cx * 89 + i * 7 + 19, cz * 97 + i * 23 + 5);
    const r4 = hash2(cx * 131 + i * 41 + 11, cz * 157 + i * 19 + 23);
    const r5 = hash2(cx * 173 + i * 59 + 29, cz * 199 + i * 31 + 17);

    const x = ox + 12 + r1 * (CHUNK_SIZE - 24);
    const z = oz + 12 + r2 * (CHUNK_SIZE - 24);
    const y = terrainHeight(x, z);

    /* Keep the original spawn area clear. */
    if (Math.hypot(x, z) < 90) continue;

    const biome = getBiome(x, z, y);

    /* Never spawn trees under water. */
    if (y < SEA_LEVEL - 0.5) continue;

    /* Reject extreme slopes (trees don't grow on vertical cliff faces). */
    const s = 1.5;
    const dx = terrainHeight(x + s, z) - terrainHeight(x - s, z);
    const dz = terrainHeight(x, z + s) - terrainHeight(x, z - s);
    const slope = Math.hypot(dx, dz) / (2 * s);
    if (slope > 1.1) continue;

    const kind = pickTreeForBiome(biome, y, r4);
    if (!kind) continue;

    const range = TREE_DEFS[kind].scale;
    const scale = range[0] + r5 * (range[1] - range[0]);

    objects.push({
      type: 'tree',
      variant: kind,
      biome: biome,
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

/* =========================================================================
   EXPORTS
   ========================================================================= */
global.Terrain = {
  init: initTerrain,
  terrainHeight,
  getBiome,
  SEA_LEVEL,
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
