/* plane_models.js — aircraft catalogue + game/preview geometry
   Each aircraft has its own flight settings. Geometry is generated here so
   switching aircraft changes both the flight model and the visible 3D shape.
*/
(function (global) {
'use strict';

const PLANE_DEFS = {
  starter: {
    id: 'starter',
    name: 'SKY SCOUT',
    price: 0,
    description: 'Light, forgiving and easy to control.',
    settings: {
      maxSpeed: 135, minSpeed: 22, cruiseSpeed: 72,
      acceleration: 0.95, pitchRate: 1.65, rollRate: 3.10,
      yawRate: 0.95, response: 6.5, liftLoss: 30,
      stallSpeed: 38, bankTurn: 0.90
    },
    shape: {
      body: [0.88, 0.84, 4.05],
      nose: [0.52, 0.48, 0.50],
      wingSpan: 6.64,
      wingChord: 1.32,
      tailSpan: 2.44
    }
  },
  swift: {
    id: 'swift',
    name: 'SWIFT S-9',
    price: 850,
    description: 'Fast and responsive with a narrow racing profile.',
    settings: {
      maxSpeed: 175, minSpeed: 28, cruiseSpeed: 94,
      acceleration: 1.22, pitchRate: 1.85, rollRate: 3.65,
      yawRate: 1.08, response: 8.0, liftLoss: 27,
      stallSpeed: 44, bankTurn: 1.05
    },
    shape: {
      body: [0.80, 0.76, 5.30],
      nose: [0.30, 0.28, 1.10],
      wingSpan: 7.72,
      wingChord: 2.30,
      tailSpan: 1.90
    }
  },
  hauler: {
    id: 'hauler',
    name: 'CARGO HAWK',
    price: 1450,
    description: 'Stable and powerful, built for slower heavy flying.',
    settings: {
      maxSpeed: 118, minSpeed: 20, cruiseSpeed: 65,
      acceleration: 0.68, pitchRate: 1.35, rollRate: 2.45,
      yawRate: 0.82, response: 5.2, liftLoss: 34,
      stallSpeed: 34, bankTurn: 0.72
    },
    shape: {
      body: [1.36, 1.36, 4.80],
      nose: [1.00, 1.02, 0.60],
      wingSpan: 8.30,
      wingChord: 1.80,
      tailSpan: 2.90
    }
  }
};

/* ======================================================================
   MESH BUILDER
   ====================================================================== */

function Builder() {
  this.pos = [];
  this.col = [];
  this.tin = [];
  this.tri = [];
}

Builder.prototype.v = function (x, y, z, c, t) {
  this.pos.push(x, y, z);
  this.col.push(c[0], c[1], c[2]);
  this.tin.push(t);
  return (this.pos.length / 3) - 1;
};

Builder.prototype.tri3 = function (a, b, c) {
  this.tri.push(a, b, c);
};

/* Flat-shaded convex polygon — gets its own vertices so the facet normal
   stays crisp (used for boxes, caps, panels). */
Builder.prototype.poly = function (pts, c, t) {
  const n = pts.length;
  if (n < 3) return;
  const base = this.pos.length / 3;
  for (let i = 0; i < n; i++) this.v(pts[i][0], pts[i][1], pts[i][2], c, t);
  for (let i = 1; i < n - 1; i++) this.tri3(base, base + i, base + i + 1);
};

Builder.prototype.build = function () {
  const P = this.pos, T = this.tri;
  const nrm = new Float32Array(P.length);
  for (let i = 0; i < T.length; i += 3) {
    const a = T[i] * 3, b = T[i + 1] * 3, c = T[i + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    nrm[a] += nx; nrm[a + 1] += ny; nrm[a + 2] += nz;
    nrm[b] += nx; nrm[b + 1] += ny; nrm[b + 2] += nz;
    nrm[c] += nx; nrm[c + 1] += ny; nrm[c + 2] += nz;
  }
  for (let i = 0; i < nrm.length; i += 3) {
    const l = Math.hypot(nrm[i], nrm[i + 1], nrm[i + 2]) || 1;
    nrm[i] /= l; nrm[i + 1] /= l; nrm[i + 2] /= l;
  }
  const idx = new Uint16Array(T.length);
  for (let i = 0; i < T.length; i++) idx[i] = T[i];
  return {
    pos: new Float32Array(P),
    nrm: nrm,
    col: new Float32Array(this.col),
    tint: new Float32Array(this.tin),
    idx: idx
  };
};

/* ======================================================================
   GEOMETRY PRIMITIVES
   ====================================================================== */

/* A superellipse cross-section in the XY plane, extruded along +Z.
   Points are wound CCW as seen from +Z.  power=1 → circle, <1 → boxier. */
function superRing(z, hw, hh, yo, n, power) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const ca = Math.cos(a), sa = Math.sin(a);
    const x = (ca < 0 ? -1 : 1) * Math.pow(Math.abs(ca), power) * hw;
    const y = (sa < 0 ? -1 : 1) * Math.pow(Math.abs(sa), power) * hh + yo;
    pts.push([x, y, z]);
  }
  return pts;
}

/* Loft a stack of rings.  Ring points must be wound CCW when viewed from
   the direction the rings march toward, so faces point outward.
   Vertices are shared → smooth shading. */
function loftRings(b, rings, col, tint, opts) {
  opts = opts || {};
  const R = rings.length;
  if (R < 2) return null;
  const K = rings[0].length;
  const flip = !!opts.flip;
  const closed = opts.closed !== false;
  const base = b.pos.length / 3;

  for (let r = 0; r < R; r++) {
    const ring = rings[r];
    for (let k = 0; k < K; k++) {
      const p = ring[k];
      b.v(p[0], p[1], p[2], col, tint);
    }
  }
  const lim = closed ? K : K - 1;
  for (let r = 0; r < R - 1; r++) {
    for (let k = 0; k < lim; k++) {
      const k2 = (k + 1) % K;
      const a = base + r * K + k;
      const bb = base + r * K + k2;
      const cc = base + (r + 1) * K + k2;
      const d = base + (r + 1) * K + k;
      if (flip) {
        b.tri3(a, d, cc); b.tri3(a, cc, bb);
      } else {
        b.tri3(a, bb, cc); b.tri3(a, cc, d);
      }
    }
  }
  return { base: base, R: R, K: K, flip: flip };
}

/* Pointed cap (nose / tail cone tip) that shares the ring's vertices so the
   shading blends smoothly into the barrel. */
function capPoint(b, base, ring, K, pt, col, tint, flip, atEnd) {
  const tip = b.v(pt[0], pt[1], pt[2], col, tint);
  const off = base + ring * K;
  const rev = (atEnd === !!flip);
  for (let k = 0; k < K; k++) {
    const a = off + k, d = off + ((k + 1) % K);
    if (rev) b.tri3(tip, d, a); else b.tri3(tip, a, d);
  }
}

/* Flat fan cap across a ring (wing roots, wing tips, wheels). */
function capFlat(b, ring, col, tint, atEnd, flip) {
  const n = ring.length;
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < n; i++) { cx += ring[i][0]; cy += ring[i][1]; cz += ring[i][2]; }
  cx /= n; cy /= n; cz /= n;
  const c = b.v(cx, cy, cz, col, tint);
  const ids = [];
  for (let i = 0; i < n; i++) ids.push(b.v(ring[i][0], ring[i][1], ring[i][2], col, tint));
  const rev = (atEnd === !!flip);
  for (let i = 0; i < n; i++) {
    const a = ids[i], d = ids[(i + 1) % n];
    if (rev) b.tri3(c, d, a); else b.tri3(c, a, d);
  }
}

/* Convenience: loft + optional nose/tail cones. */
function tube(b, rings, col, tint, opts) {
  opts = opts || {};
  const info = loftRings(b, rings, col, tint, opts);
  if (!info) return null;
  if (opts.nose) capPoint(b, info.base, 0, info.K, opts.nose, col, tint, info.flip, false);
  if (opts.tail) capPoint(b, info.base, info.R - 1, info.K, opts.tail, col, tint, info.flip, true);
  return info;
}

/* Oriented box.  xf (optional) transforms every corner — used to place
   propeller blades and pitched surfaces. */
function addBox(b, cx, cy, cz, sx, sy, sz, col, tint, xf) {
  const hx = sx * 0.5, hy = sy * 0.5, hz = sz * 0.5;
  const P = function (x, y, z) {
    let px = cx + x, py = cy + y, pz = cz + z;
    if (xf) { const q = xf(px, py, pz); px = q[0]; py = q[1]; pz = q[2]; }
    return [px, py, pz];
  };
  const v0 = P(-hx, -hy, -hz), v1 = P(hx, -hy, -hz), v2 = P(hx, hy, -hz), v3 = P(-hx, hy, -hz);
  const v4 = P(-hx, -hy, hz), v5 = P(hx, -hy, hz), v6 = P(hx, hy, hz), v7 = P(-hx, hy, hz);
  b.poly([v0, v3, v2, v1], col, tint);
  b.poly([v4, v5, v6, v7], col, tint);
  b.poly([v0, v1, v5, v4], col, tint);
  b.poly([v3, v7, v6, v2], col, tint);
  b.poly([v0, v4, v7, v3], col, tint);
  b.poly([v1, v2, v6, v5], col, tint);
}

/* Wheel: cylinder whose axle runs along X, with slightly chamfered rims. */
function addWheel(b, cx, cy, cz, r, w, col, tint, seg) {
  seg = seg || 12;
  const xs = [-w * 0.5, -w * 0.36, w * 0.36, w * 0.5];
  const rs = [r * 0.80, r, r, r * 0.80];
  const rings = [];
  for (let i = 0; i < xs.length; i++) {
    const ring = [];
    for (let k = 0; k < seg; k++) {
      const a = (k / seg) * Math.PI * 2;
      ring.push([cx + xs[i], cy + Math.cos(a) * rs[i], cz + Math.sin(a) * rs[i]]);
    }
    rings.push(ring);
  }
  loftRings(b, rings, col, tint, {});
  capFlat(b, rings[0], col, tint, false, false);
  capFlat(b, rings[rings.length - 1], col, tint, true, false);
}

/* Propeller: `count` blades around a hub, each with pitch. */
function addProp(b, cx, cy, cz, radius, count, col, tint, pitch) {
  const chord = 0.20, thick = 0.055;
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    const xf = function (x, y, z) {
      /* pitch the blade about its own long axis (canonical +Y) */
      const cp = Math.cos(pitch), sp = Math.sin(pitch);
      const qx = x * cp + z * sp;
      const qz = -x * sp + z * cp;
      /* swing the blade around the hub */
      const ang = a - Math.PI / 2;
      const cr = Math.cos(ang), sr = Math.sin(ang);
      const rx = qx * cr - y * sr;
      const ry = qx * sr + y * cr;
      return [cx + rx, cy + ry, cz + qz];
    };
    addBox(b, 0, radius * 0.5, 0, chord, radius, thick, col, tint, xf);
  }
}

/* NACA-style symmetric airfoil section (chord along Z, thickness along Y).
   Ordered CCW as seen from +X, so it can be lofted straight out a wing. */
function airfoilProfile(chord, thick, n) {
  const pts = [];
  const half = chord * 0.5;
  const t = Math.max(0.04, thick);
  const yt = function (x) {
    return 5 * t * chord * (0.2969 * Math.sqrt(x) - 0.1260 * x
         - 0.3516 * x * x + 0.2843 * x * x * x - 0.1015 * x * x * x * x);
  };
  for (let i = 0; i <= n; i++) {            // upper surface, LE → TE
    const u = 0.5 * (1 - Math.cos(Math.PI * i / n));
    pts.push([-half + u * chord, yt(u)]);
  }
  for (let i = n - 1; i >= 1; i--) {        // lower surface, TE → LE
    const u = 0.5 * (1 - Math.cos(Math.PI * i / n));
    pts.push([-half + u * chord, -yt(u)]);
  }
  return pts;
}

/* Turn a list of spanwise stations into loftable rings. */
function wingRings(stations, n, mirror, xf) {
  const rings = [];
  for (let s = 0; s < stations.length; s++) {
    const st = stations[s];
    const prof = airfoilProfile(st.chord, st.thick, n);
    const ring = [];
    for (let p = 0; p < prof.length; p++) {
      let x = mirror ? -st.x : st.x;
      let y = st.y + prof[p][1];
      let z = st.z + prof[p][0];
      if (xf) { const q = xf(x, y, z); x = q[0]; y = q[1]; z = q[2]; }
      ring.push([x, y, z]);
    }
    rings.push(ring);
  }
  return rings;
}

function addWing(b, stations, col, tint, opts) {
  opts = opts || {};
  const n = opts.n || 7;
  const mirror = !!opts.mirror;
  const rings = wingRings(stations, n, mirror, opts.xf);
  loftRings(b, rings, col, tint, { flip: mirror });
  if (opts.caps !== false) {
    capFlat(b, rings[0], col, tint, false, mirror);
    capFlat(b, rings[rings.length - 1], col, tint, true, mirror);
  }
}

/* --------------------------------------------------------------------- */
/* rotation helpers                                                       */
function rotZ(a) {
  const c = Math.cos(a), s = Math.sin(a);
  return function (x, y, z) { return [x * c - y * s, x * s + y * c, z]; };
}
function rotY(a) {
  const c = Math.cos(a), s = Math.sin(a);
  return function (x, y, z) { return [x * c + z * s, y, -x * s + z * c]; };
}

/* ======================================================================
   AIRCRAFT 1 — SKY SCOUT (light low-wing sport plane, fixed gear, prop)
   ====================================================================== */
function buildStarter(b) {
  const PAINT  = [0.96, 0.96, 0.97];
  const TRIM   = [0.58, 0.64, 0.74];
  const GLASS  = [0.09, 0.18, 0.28];
  const DARK   = [0.14, 0.15, 0.17];
  const METAL  = [0.70, 0.73, 0.78];
  const RUBBER = [0.06, 0.06, 0.07];

  /* ---------- fuselage ---------- */
  const FS = [
    [-1.95, 0.25, 0.24, 0.00],
    [-1.72, 0.32, 0.30, 0.00],
    [-1.45, 0.37, 0.35, 0.01],
    [-1.00, 0.41, 0.39, 0.02],
    [-0.40, 0.44, 0.42, 0.04],
    [ 0.25, 0.43, 0.41, 0.05],
    [ 0.85, 0.36, 0.35, 0.06],
    [ 1.35, 0.26, 0.28, 0.07],
    [ 1.75, 0.15, 0.19, 0.08],
    [ 2.00, 0.08, 0.11, 0.08]
  ];
  const NB = 14;
  const body = FS.map(function (s) { return superRing(s[0], s[1], s[2], s[3], NB, 0.62); });
  tube(b, body.slice(0, 4), TRIM, 1, { nose: [0, 0, -2.06] });
  tube(b, body.slice(3), PAINT, 1, { tail: [0, 0.08, 2.08] });

  /* ---------- canopy ---------- */
  const CS = [
    [-1.22, 0.14, 0.11, 0.30],
    [-1.00, 0.24, 0.20, 0.31],
    [-0.55, 0.31, 0.26, 0.33],
    [-0.05, 0.31, 0.26, 0.34],
    [ 0.35, 0.22, 0.18, 0.33],
    [ 0.58, 0.10, 0.08, 0.31]
  ];
  const canopy = CS.map(function (s) { return superRing(s[0], s[1], s[2], s[3], 12, 0.75); });
  loftRings(b, canopy, GLASS, 0.12, {});
  capFlat(b, canopy[0], GLASS, 0.12, false, false);
  capFlat(b, canopy[canopy.length - 1], GLASS, 0.12, true, false);

  /* ---------- spinner + propeller ---------- */
  const SP = [
    [-2.32, 0.11, 0.11, 0.00],
    [-2.16, 0.22, 0.22, 0.00],
    [-2.00, 0.26, 0.26, 0.00]
  ];
  const spin = SP.map(function (s) { return superRing(s[0], s[1], s[2], s[3], 12, 0.85); });
  tube(b, spin, TRIM, 1, { nose: [0, 0, -2.44], tail: [0, 0, -1.98] });
  addProp(b, 0, 0, -2.18, 0.86, 2, DARK, 0, 0.42);

  /* ---------- wing (low, tapered, dihedral) ---------- */
  const WING = [
    { x: 0.16, y: -0.12, z: -0.10, chord: 1.32, thick: 0.15 },
    { x: 1.10, y: -0.08, z: -0.04, chord: 1.28, thick: 0.14 },
    { x: 2.20, y: -0.02, z:  0.06, chord: 1.10, thick: 0.12 },
    { x: 3.00, y:  0.02, z:  0.15, chord: 0.86, thick: 0.11 },
    { x: 3.32, y:  0.04, z:  0.21, chord: 0.64, thick: 0.11 }
  ];
  addWing(b, WING, PAINT, 1, { mirror: false, n: 7 });
  addWing(b, WING, PAINT, 1, { mirror: true,  n: 7 });

  /* ---------- tailplane ---------- */
  const HT = [
    { x: 0.10, y: 0.14, z: 1.70, chord: 0.86, thick: 0.13 },
    { x: 0.55, y: 0.16, z: 1.75, chord: 0.78, thick: 0.12 },
    { x: 1.00, y: 0.18, z: 1.81, chord: 0.62, thick: 0.12 },
    { x: 1.22, y: 0.19, z: 1.85, chord: 0.46, thick: 0.12 }
  ];
  addWing(b, HT, PAINT, 1, { mirror: false, n: 6 });
  addWing(b, HT, PAINT, 1, { mirror: true,  n: 6 });

  /* ---------- fin (built flat, then stood upright) ---------- */
  const FIN = [
    { x: 0.10, y: 0.00, z: 1.42, chord: 1.08, thick: 0.15 },
    { x: 0.52, y: 0.00, z: 1.50, chord: 0.90, thick: 0.14 },
    { x: 0.90, y: 0.00, z: 1.61, chord: 0.64, thick: 0.13 },
    { x: 1.08, y: 0.00, z: 1.68, chord: 0.44, thick: 0.13 }
  ];
  addWing(b, FIN, TRIM, 1, { n: 6, xf: rotZ(Math.PI / 2) });

  /* ---------- fixed tricycle gear ---------- */
  for (const s of [-1, 1]) {
    addBox(b, s * 0.98, -0.53, -0.05, 0.09, 0.78, 0.13, METAL, 0.05);
    addBox(b, s * 0.98, -0.24, -0.05, 0.16, 0.14, 0.30, METAL, 0.05);
    addWheel(b, s * 0.98, -0.92, -0.05, 0.21, 0.16, RUBBER, 0);
  }
  addBox(b, 0, -0.62, -1.42, 0.09, 0.60, 0.09, METAL, 0.05);
  addWheel(b, 0, -0.92, -1.42, 0.17, 0.12, RUBBER, 0);
}

/* ======================================================================
   AIRCRAFT 2 — SWIFT S-9 (swept delta jet, single fin, canards)
   ====================================================================== */
function buildSwift(b) {
  const PAINT  = [0.95, 0.96, 0.97];
  const TRIM   = [0.46, 0.52, 0.62];
  const GLASS  = [0.07, 0.15, 0.25];
  const DARK   = [0.12, 0.13, 0.15];

  /* ---------- fuselage (sharp nose → tapered tail) ---------- */
  const FS = [
    [-2.55, 0.06, 0.06, 0.00],
    [-2.30, 0.15, 0.14, 0.00],
    [-1.95, 0.24, 0.22, 0.01],
    [-1.45, 0.31, 0.28, 0.02],
    [-0.80, 0.37, 0.34, 0.03],
    [-0.05, 0.40, 0.38, 0.03],
    [ 0.70, 0.38, 0.37, 0.03],
    [ 1.40, 0.33, 0.33, 0.03],
    [ 2.00, 0.26, 0.27, 0.03]
  ];
  const NB = 14;
  const body = FS.map(function (s) { return superRing(s[0], s[1], s[2], s[3], NB, 0.72); });
  tube(b, body, PAINT, 1, { nose: [0, 0, -2.72] });

  /* ---------- exhaust nozzle ---------- */
  const EX = [
    [2.00, 0.26, 0.27, 0.03],
    [2.42, 0.22, 0.23, 0.03],
    [2.66, 0.18, 0.19, 0.03],
    [2.74, 0.15, 0.16, 0.03]
  ];
  const ex = EX.map(function (s) { return superRing(s[0], s[1], s[2], s[3], 12, 0.85); });
  loftRings(b, ex, DARK, 0.05, {});
  capFlat(b, ex[ex.length - 1], DARK, 0.05, true, false);

  /* ---------- canopy ---------- */
  const CS = [
    [-1.80, 0.09, 0.07, 0.26],
    [-1.55, 0.19, 0.14, 0.28],
    [-1.05, 0.28, 0.21, 0.30],
    [-0.50, 0.29, 0.22, 0.31],
    [-0.05, 0.22, 0.17, 0.30],
    [ 0.20, 0.11, 0.08, 0.28]
  ];
  const canopy = CS.map(function (s) { return superRing(s[0], s[1], s[2], s[3], 12, 0.8); });
  loftRings(b, canopy, GLASS, 0.10, {});
  capFlat(b, canopy[0], GLASS, 0.10, false, false);
  capFlat(b, canopy[canopy.length - 1], GLASS, 0.10, true, false);

  /* ---------- delta wing ---------- */
  const WING = [
    { x: 0.30, y: -0.10, z: 0.40, chord: 2.30, thick: 0.085 },
    { x: 1.30, y: -0.05, z: 0.66, chord: 1.80, thick: 0.080 },
    { x: 2.40, y:  0.01, z: 1.02, chord: 1.25, thick: 0.075 },
    { x: 3.35, y:  0.06, z: 1.38, chord: 0.76, thick: 0.072 },
    { x: 3.86, y:  0.09, z: 1.58, chord: 0.46, thick: 0.072 }
  ];
  addWing(b, WING, PAINT, 1, { mirror: false, n: 7 });
  addWing(b, WING, PAINT, 1, { mirror: true,  n: 7 });

  /* ---------- canards ---------- */
  const CAN = [
    { x: 0.18, y: 0.18, z: -1.55, chord: 0.66, thick: 0.09 },
    { x: 0.58, y: 0.21, z: -1.44, chord: 0.44, thick: 0.09 },
    { x: 0.76, y: 0.22, z: -1.38, chord: 0.32, thick: 0.09 }
  ];
  addWing(b, CAN, TRIM, 1, { mirror: false, n: 6 });
  addWing(b, CAN, TRIM, 1, { mirror: true,  n: 6 });

  /* ---------- tailplanes ---------- */
  const HT = [
    { x: 0.14, y: 0.08, z: 2.02, chord: 0.70, thick: 0.10 },
    { x: 0.52, y: 0.10, z: 2.08, chord: 0.58, thick: 0.10 },
    { x: 0.90, y: 0.12, z: 2.14, chord: 0.44, thick: 0.10 }
  ];
  addWing(b, HT, PAINT, 1, { mirror: false, n: 6 });
  addWing(b, HT, PAINT, 1, { mirror: true,  n: 6 });

  /* ---------- fin ---------- */
  const FIN = [
    { x: 0.14, y: 0.00, z: 1.10, chord: 1.75, thick: 0.11 },
    { x: 0.70, y: 0.00, z: 1.36, chord: 1.32, thick: 0.10 },
    { x: 1.22, y: 0.00, z: 1.62, chord: 0.86, thick: 0.10 },
    { x: 1.50, y: 0.00, z: 1.80, chord: 0.56, thick: 0.10 }
  ];
  addWing(b, FIN, TRIM, 1, { n: 6, xf: rotZ(Math.PI / 2) });

  /* ---------- side intakes ---------- */
  for (const s of [-1, 1]) {
    addBox(b, s * 0.40, 0.02, -0.35, 0.12, 0.32, 1.40, DARK, 0.05);
    addBox(b, s * 0.40, 0.02, -1.02, 0.14, 0.30, 0.10, TRIM, 1);
  }

  /* ---------- ventral strakes ---------- */
  for (const s of [-1, 1]) {
    addBox(b, s * 0.20, -0.36, 1.50, 0.06, 0.30, 1.10, TRIM, 1);
  }
}

/* ======================================================================
   AIRCRAFT 3 — CARGO HAWK (high wing, twin turboprops, T-tail)
   ====================================================================== */
function buildHauler(b) {
  const PAINT  = [0.94, 0.94, 0.95];
  const TRIM   = [0.55, 0.60, 0.68];
  const GLASS  = [0.09, 0.18, 0.27];
  const DARK   = [0.13, 0.14, 0.16];
  const METAL  = [0.68, 0.71, 0.76];
  const RUBBER = [0.06, 0.06, 0.07];

  /* ---------- fat, slightly upswept fuselage ---------- */
  const FS = [
    [-2.10, 0.30, 0.32, -0.04],
    [-1.85, 0.48, 0.50, -0.02],
    [-1.45, 0.60, 0.60,  0.00],
    [-0.80, 0.66, 0.66,  0.00],
    [ 0.00, 0.68, 0.68,  0.00],
    [ 0.80, 0.66, 0.66,  0.01],
    [ 1.50, 0.58, 0.59,  0.03],
    [ 2.00, 0.45, 0.49,  0.06],
    [ 2.35, 0.30, 0.35,  0.09]
  ];
  const NB = 16;
  const body = FS.map(function (s) { return superRing(s[0], s[1], s[2], s[3], NB, 0.55); });
  tube(b, body, PAINT, 1, { nose: [0, -0.04, -2.28], tail: [0, 0.12, 2.52] });

  /* ---------- cockpit glazing ---------- */
  const CK = [
    [-2.02, 0.20, 0.09, 0.40],
    [-1.78, 0.29, 0.12, 0.42],
    [-1.40, 0.32, 0.13, 0.44],
    [-1.05, 0.27, 0.11, 0.45]
  ];
  const ck = CK.map(function (s) { return superRing(s[0], s[1], s[2], s[3], 10, 0.75); });
  loftRings(b, ck, GLASS, 0.10, {});
  capFlat(b, ck[0], GLASS, 0.10, false, false);
  capFlat(b, ck[ck.length - 1], GLASS, 0.10, true, false);

  /* ---------- high wing ---------- */
  const WING = [
    { x: 0.35, y: 0.52, z: -0.25, chord: 1.80, thick: 0.150 },
    { x: 1.60, y: 0.55, z: -0.20, chord: 1.70, thick: 0.140 },
    { x: 2.90, y: 0.58, z: -0.12, chord: 1.50, thick: 0.130 },
    { x: 3.90, y: 0.60, z: -0.02, chord: 1.15, thick: 0.120 },
    { x: 4.15, y: 0.60, z:  0.04, chord: 0.95, thick: 0.120 }
  ];
  addWing(b, WING, PAINT, 1, { mirror: false, n: 8 });
  addWing(b, WING, PAINT, 1, { mirror: true,  n: 8 });

  /* ---------- engine nacelles, spinners and propellers ---------- */
  const NAC = [
    [-1.40, 0.20, 0.20, 0.30],
    [-1.15, 0.28, 0.28, 0.29],
    [-0.65, 0.32, 0.32, 0.28],
    [-0.10, 0.31, 0.31, 0.28],
    [ 0.30, 0.23, 0.23, 0.29]
  ];
  const SPR = [
    [-1.68, 0.18, 0.18, 0.30],
    [-1.52, 0.14, 0.14, 0.30],
    [-1.42, 0.07, 0.07, 0.30]
  ];
  for (const s of [-1, 1]) {
    const nx = s * 1.72;
    const nrings = NAC.map(function (st) {
      return superRing(st[0], st[1], st[2], st[3], 12, 0.8).map(function (p) {
        return [p[0] + nx, p[1], p[2]];
      });
    });
    tube(b, nrings, TRIM, 1, { nose: [nx, 0.30, -1.54], tail: [nx, 0.29, 0.40] });

    const springs = SPR.map(function (st) {
      return superRing(st[0], st[1], st[2], st[3], 10, 0.85).map(function (p) {
        return [p[0] + nx, p[1], p[2]];
      });
    });
    tube(b, springs, DARK, 0, { nose: [nx, 0.30, -1.78], tail: [nx, 0.30, -1.40] });

    addProp(b, nx, 0.30, -1.62, 0.78, 4, DARK, 0, 0.38);

    /* pylon joining nacelle to wing */
    addBox(b, nx, 0.47, -0.55, 0.20, 0.38, 0.95, TRIM, 1);
  }

  /* ---------- T-tail ---------- */
  const FIN = [
    { x: 0.45, y: 0.00, z: 1.55, chord: 1.60, thick: 0.16 },
    { x: 1.10, y: 0.00, z: 1.70, chord: 1.30, thick: 0.15 },
    { x: 1.70, y: 0.00, z: 1.88, chord: 0.95, thick: 0.14 },
    { x: 1.98, y: 0.00, z: 2.00, chord: 0.72, thick: 0.14 }
  ];
  addWing(b, FIN, PAINT, 1, { n: 7, xf: rotZ(Math.PI / 2) });

  const HT = [
    { x: 0.10, y: 1.92, z: 1.95, chord: 1.05, thick: 0.13 },
    { x: 0.65, y: 1.94, z: 2.00, chord: 0.92, thick: 0.13 },
    { x: 1.20, y: 1.96, z: 2.06, chord: 0.72, thick: 0.12 },
    { x: 1.45, y: 1.97, z: 2.10, chord: 0.55, thick: 0.12 }
  ];
  addWing(b, HT, PAINT, 1, { mirror: false, n: 7 });
  addWing(b, HT, PAINT, 1, { mirror: true,  n: 7 });

  /* ---------- undercarriage ---------- */
  for (const s of [-1, 1]) {
    addBox(b, s * 0.78, -0.62, 0.60, 0.30, 0.46, 1.10, TRIM, 1);
    addBox(b, s * 0.78, -1.06, 0.60, 0.14, 0.52, 0.14, METAL, 0.05);
    addWheel(b, s * 0.78, -1.38, 0.30, 0.30, 0.22, RUBBER, 0);
    addWheel(b, s * 0.78, -1.38, 0.90, 0.30, 0.22, RUBBER, 0);
  }
  addBox(b, 0, -0.84, -1.55, 0.14, 0.50, 0.14, METAL, 0.05);
  addWheel(b, 0, -1.36, -1.55, 0.28, 0.18, RUBBER, 0);
}

/* ======================================================================
   PUBLIC GEOMETRY ENTRY POINT
   ====================================================================== */
function buildGeometry(def) {
  const b = new Builder();
  if (def.id === 'swift') buildSwift(b);
  else if (def.id === 'hauler') buildHauler(b);
  else buildStarter(b);
  return b.build();
}

let gameMeshes = Object.create(null);
let preview = null;

function buildGameMesh(def) {
  const g = buildGeometry(def);
  return Terrain.createMesh(g.pos, g.nrm, g.col, g.idx);
}

function initGame() {
  gameMeshes = Object.create(null);
  for (const id of Object.keys(PLANE_DEFS)) {
    gameMeshes[id] = buildGameMesh(PLANE_DEFS[id]);
  }
}

function get(id) {
  return PLANE_DEFS[PLANE_DEFS[id] ? id : 'starter'];
}

function getGameMesh(id) {
  return gameMeshes[id] || gameMeshes.starter || null;
}

/* -------------------------------------------------------------------------
   Small independent WebGL preview renderer.
   It deliberately uses its own context so the main flight renderer can stay
   untouched while the shop is open. The shop canvas has a transparent clear
   colour, allowing the blurred terrain to remain visible behind it.
   ------------------------------------------------------------------------- */
function m4() { return new Float32Array(16); }
function m4Identity(o) {
  o.fill(0); o[0] = o[5] = o[10] = o[15] = 1; return o;
}
function m4Mul(out, a, b) {
  const t = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++)
    t[c * 4 + r] =
      a[0 * 4 + r] * b[c * 4 + 0] + a[1 * 4 + r] * b[c * 4 + 1] +
      a[2 * 4 + r] * b[c * 4 + 2] + a[3 * 4 + r] * b[c * 4 + 3];
  out.set(t); return out;
}
function m4Perspective(out, fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy * 0.5), nf = 1 / (near - far);
  out.fill(0);
  out[0] = f / aspect; out[5] = f;
  out[10] = (far + near) * nf; out[11] = -1;
  out[14] = (2 * far * near) * nf;
  return out;
}
function m4LookAt(out, eye, center, up) {
  let zx = eye[0] - center[0], zy = eye[1] - center[1], zz = eye[2] - center[2];
  let l = Math.hypot(zx, zy, zz) || 1; zx /= l; zy /= l; zz /= l;
  let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
  l = Math.hypot(xx, xy, xz) || 1; xx /= l; xy /= l; xz /= l;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  out.fill(0);
  out[0] = xx; out[1] = yx; out[2] = zx;
  out[4] = xy; out[5] = yy; out[6] = zy;
  out[8] = xz; out[9] = yz; out[10] = zz;
  out[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
  out[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
  out[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
  out[15] = 1;
  return out;
}
function compile(gl, type, source) {
  const s = gl.createShader(type);
  gl.shaderSource(s, source); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error('Plane preview shader: ' + gl.getShaderInfoLog(s));
  }
  return s;
}
function program(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS))
    throw new Error('Plane preview program: ' + gl.getProgramInfoLog(p));
  return p;
}
function previewMesh(gl, g) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  function attr(loc, data, size) {
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
  }
  attr(0, g.pos, 3); attr(1, g.nrm, 3); attr(2, g.col, 3); attr(3, g.tint, 1);
  const ib = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, g.idx, gl.STATIC_DRAW);
  gl.bindVertexArray(null);
  return { vao: vao, ib: ib, count: g.idx.length };
}
function hexRgb(hex) {
  const h = String(hex || '#e53b2f').replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(function (x) { return x + x; }).join('') : h, 16);
  return [
    ((n >> 16) & 255) / 255,
    ((n >> 8) & 255) / 255,
    (n & 255) / 255
  ];
}

function initPreview(canvas) {
  if (!canvas) return;
  let gl;
  try {
    gl = canvas.getContext('webgl2', { alpha: true, antialias: true, premultipliedAlpha: false });
  } catch (e) { gl = null; }
  if (!gl) return;

  const prog = program(gl, `#version 300 es
    precision highp float;
    layout(location=0) in vec3 aPos;
    layout(location=1) in vec3 aNrm;
    layout(location=2) in vec3 aCol;
    layout(location=3) in float aTint;
    uniform mat4 uVP,uModel;
    out vec3 vN,vC;
    out float vT;
    void main(){
      vN=mat3(uModel)*aNrm;
      vC=aCol;
      vT=aTint;
      gl_Position=uVP*uModel*vec4(aPos,1.0);
    }`,
    `#version 300 es
    precision highp float;
    in vec3 vN,vC;
    in float vT;
    uniform vec3 uTint;
    out vec4 fragColor;
    void main(){
      vec3 n=normalize(vN);
      vec3 light=normalize(vec3(-0.45,0.80,0.55));
      float ndl=max(dot(n,light),0.0);
      /* paintwork takes the shop colour, glass/metal/rubber stays as-is */
      vec3 albedo=mix(vC, vC*uTint, clamp(vT,0.0,1.0)*0.86);
      vec3 col=albedo*(vec3(0.34,0.38,0.48)+vec3(1.0,0.91,0.76)*ndl*1.15);
      vec3 view=normalize(vec3(0.35,0.35,1.0));
      col+=vec3(1.0)*pow(max(dot(reflect(-light,n),view),0.0),52.0)*0.28;
      float rim=pow(1.0-abs(n.z),4.0);
      col+=vec3(0.30,0.40,0.58)*rim*0.30;
      fragColor=vec4(col,1.0);
    }`);

  const meshes = Object.create(null);
  for (const id of Object.keys(PLANE_DEFS)) meshes[id] = previewMesh(gl, buildGeometry(PLANE_DEFS[id]));

  const vp = m4(), proj = m4(), view = m4(), model = m4();
  preview = {
    canvas: canvas, gl: gl, prog: prog, meshes: meshes,
    vp: vp, proj: proj, view: view, model: model,
    locs: {
      vp: gl.getUniformLocation(prog, 'uVP'),
      model: gl.getUniformLocation(prog, 'uModel'),
      tint: gl.getUniformLocation(prog, 'uTint')
    }
  };

  resizePreview();
}

function resizePreview() {
  if (!preview) return;
  const c = preview.canvas, d = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.floor(c.clientWidth * d)), h = Math.max(1, Math.floor(c.clientHeight * d));
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
}

function renderPreview(time, id, color) {
  if (!preview) return;
  resizePreview();
  const gl = preview.gl, canvas = preview.canvas;
  const mesh = preview.meshes[id] || preview.meshes.starter;
  if (!mesh) return;
  const aspect = canvas.width / Math.max(1, canvas.height);
  m4Perspective(preview.proj, 42 * Math.PI / 180, aspect, 0.1, 100);
  m4LookAt(preview.view, [0, 3.1, 14], [0, 0, 0], [0, 1, 0]);
  m4Mul(preview.vp, preview.proj, preview.view);

  const a = time * 0.00065;
  const ca = Math.cos(a), sa = Math.sin(a);
  const tilt = Math.sin(time * 0.00035) * 0.10;
  const rx = Math.cos(tilt), sx = Math.sin(tilt);
  // Model = Y rotation followed by a gentle X tilt.
  m4Identity(preview.model);
  preview.model[0] = ca;
  preview.model[1] = sx * sa;
  preview.model[2] = rx * sa;
  preview.model[4] = 0;
  preview.model[5] = rx;
  preview.model[6] = -sx;
  preview.model[8] = -sa;
  preview.model[9] = sx * ca;
  preview.model[10] = rx * ca;

  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.enable(gl.DEPTH_TEST); gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK);
  gl.useProgram(preview.prog);
  gl.uniformMatrix4fv(preview.locs.vp, false, preview.vp);
  gl.uniformMatrix4fv(preview.locs.model, false, preview.model);
  gl.uniform3fv(preview.locs.tint, hexRgb(color));
  gl.bindVertexArray(mesh.vao);
  gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_SHORT, 0);
  gl.bindVertexArray(null);
}

global.PlaneModels = {
  defs: PLANE_DEFS,
  initGame,
  get,
  getGameMesh,
  initPreview,
  renderPreview,
  resizePreview
};
})(window);
