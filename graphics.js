"use strict";
/* =========================================================================
   SkyCube — main game logic
   Terrain generation lives in models.js (Terrain.*)

   CHANGES IN THIS VERSION
   -------------------------------------------------------------------------
   • Terrain shader now evaluates the SAME temperature / moisture fields as
     models.js, so each biome renders with its own palette:
        ocean · beach · desert · savanna · jungle · swamp · plains ·
        forest · tundra · snow · badlands · highlands · mountain
   • Snow line and rock line moved up to match the taller mountains.
   • HUD shows the current biome by name (Terrain.getBiome).
   • Water, lighting, texture pipeline and models kept from the previous
     pass — only terrain colouring and the HUD changed.
   ========================================================================= */

const canvas = document.getElementById('glcanvas');
const gl = canvas.getContext('webgl2', {
  antialias: true, alpha: false, powerPreference: 'high-performance',
  preserveDrawingBuffer: false
});
if (!gl) {
  document.body.innerHTML =
    '<div style="color:#fff;padding:40px;font-family:sans-serif">WebGL2 is required.</div>';
  throw new Error('no webgl2');
}
const hudStats = document.getElementById('stats');
const msgEl = document.getElementById('msg');
const resetBtn = document.getElementById('resetBtn');
const touchUI = document.getElementById('touchUI');

const IS_TOUCH = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
if (IS_TOUCH) {
  touchUI.style.display = 'block';
  resetBtn.style.display = 'block';
  document.getElementById('hudKeys').style.display = 'none';
  document.getElementById('hudKeys2').style.display = 'none';
}

/* ---- init terrain system with our gl context ---- */
Terrain.init(gl);

/* =========================================================================
   MATH
   ========================================================================= */
const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);
const lerp  = (a, b, t) => a + (b - a) * t;
const norm3 = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0]/l, v[1]/l, v[2]/l]; };

function m4() { return new Float32Array(16); }
function m4identity(o) { o.fill(0); o[0] = o[5] = o[10] = o[15] = 1; return o; }

function m4perspective(o, fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  o.fill(0);
  o[0] = f / aspect; o[5] = f;
  o[10] = (far + near) / (near - far);
  o[11] = -1;
  o[14] = 2 * far * near / (near - far);
  return o;
}
function m4lookAt(o, eye, center, up) {
  let zx = eye[0]-center[0], zy = eye[1]-center[1], zz = eye[2]-center[2];
  let len = Math.hypot(zx, zy, zz) || 1; zx/=len; zy/=len; zz/=len;
  let xx = up[1]*zz - up[2]*zy, xy = up[2]*zx - up[0]*zz, xz = up[0]*zy - up[1]*zx;
  len = Math.hypot(xx, xy, xz);
  if (len < 1e-6) { xx = 1; xy = 0; xz = 0; } else { xx/=len; xy/=len; xz/=len; }
  const yx = zy*xz - zz*xy, yy = zz*xx - zx*xz, yz = zx*xy - zy*xx;
  o[0]=xx; o[1]=yx; o[2]=zx; o[3]=0;
  o[4]=xy; o[5]=yy; o[6]=zy; o[7]=0;
  o[8]=xz; o[9]=yz; o[10]=zz; o[11]=0;
  o[12]=-(xx*eye[0]+xy*eye[1]+xz*eye[2]);
  o[13]=-(yx*eye[0]+yy*eye[1]+yz*eye[2]);
  o[14]=-(zx*eye[0]+zy*eye[1]+zz*eye[2]);
  o[15]=1;
  return o;
}
const _m4tmp = m4();
function m4mul(o, a, b) {
  const t = (o === a || o === b) ? _m4tmp : o;
  for (let c = 0; c < 4; c++) {
    const b0=b[c*4], b1=b[c*4+1], b2=b[c*4+2], b3=b[c*4+3];
    t[c*4+0] = a[0]*b0 + a[4]*b1 + a[8]*b2  + a[12]*b3;
    t[c*4+1] = a[1]*b0 + a[5]*b1 + a[9]*b2  + a[13]*b3;
    t[c*4+2] = a[2]*b0 + a[6]*b1 + a[10]*b2 + a[14]*b3;
    t[c*4+3] = a[3]*b0 + a[7]*b1 + a[11]*b2 + a[15]*b3;
  }
  if (t !== o) o.set(t);
  return o;
}
function m4invert(o, m) {
  const a00=m[0],a01=m[1],a02=m[2],a03=m[3];
  const a10=m[4],a11=m[5],a12=m[6],a13=m[7];
  const a20=m[8],a21=m[9],a22=m[10],a23=m[11];
  const a30=m[12],a31=m[13],a32=m[14],a33=m[15];
  const b00=a00*a11-a01*a10, b01=a00*a12-a02*a10, b02=a00*a13-a03*a10;
  const b03=a01*a12-a02*a11, b04=a01*a13-a03*a11, b05=a02*a13-a03*a12;
  const b06=a20*a31-a21*a30, b07=a20*a32-a22*a30, b08=a20*a33-a23*a30;
  const b09=a21*a32-a22*a31, b10=a21*a33-a23*a31, b11=a22*a33-a23*a32;
  let det = b00*b11 - b01*b10 + b02*b09 + b03*b08 - b04*b07 + b05*b06;
  if (!det) return m4identity(o);
  det = 1 / det;
  o[0]=(a11*b11-a12*b10+a13*b09)*det;  o[1]=(a02*b10-a01*b11-a03*b09)*det;
  o[2]=(a31*b05-a32*b04+a33*b03)*det;  o[3]=(a22*b04-a21*b05-a23*b03)*det;
  o[4]=(a12*b08-a10*b11-a13*b07)*det;  o[5]=(a00*b11-a02*b08+a03*b07)*det;
  o[6]=(a32*b02-a30*b05-a33*b01)*det;  o[7]=(a20*b05-a22*b02+a23*b01)*det;
  o[8]=(a10*b10-a11*b08+a13*b06)*det;  o[9]=(a01*b08-a00*b10-a03*b06)*det;
  o[10]=(a30*b04-a31*b02+a33*b00)*det; o[11]=(a21*b02-a20*b04-a23*b00)*det;
  o[12]=(a11*b07-a10*b09-a12*b06)*det; o[13]=(a00*b09-a01*b07+a02*b06)*det;
  o[14]=(a31*b01-a30*b03-a32*b00)*det; o[15]=(a20*b03-a21*b01+a22*b00)*det;
  return o;
}

/* --- quaternion --- */
function qIdentity() { return [0,0,0,1]; }
function qMul(a, b) {
  return [
    a[3]*b[0] + a[0]*b[3] + a[1]*b[2] - a[2]*b[1],
    a[3]*b[1] - a[0]*b[2] + a[1]*b[3] + a[2]*b[0],
    a[3]*b[2] + a[0]*b[1] - a[1]*b[0] + a[2]*b[3],
    a[3]*b[3] - a[0]*b[0] - a[1]*b[1] - a[2]*b[2]
  ];
}
function qNorm(q) {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0]/l, q[1]/l, q[2]/l, q[3]/l];
}
function qAxisAngle(x, y, z, ang) {
  const h = ang * 0.5, s = Math.sin(h);
  return [x*s, y*s, z*s, Math.cos(h)];
}
function qRot(q, v) {
  const x=q[0], y=q[1], z=q[2], w=q[3];
  const x2=x+x, y2=y+y, z2=z+z;
  const xx=x*x2, xy=x*y2, xz=x*z2;
  const yy=y*y2, yz=y*z2, zz=z*z2;
  const wx=w*x2, wy=w*y2, wz=w*z2;
  return [
    (1-(yy+zz))*v[0] + (xy-wz)*v[1]   + (xz+wy)*v[2],
    (xy+wz)*v[0]     + (1-(xx+zz))*v[1] + (yz-wx)*v[2],
    (xz-wy)*v[0]     + (yz+wx)*v[1]   + (1-(xx+yy))*v[2]
  ];
}
function m4fromQuatPos(o, q, p) {
  const x=q[0], y=q[1], z=q[2], w=q[3];
  const x2=x+x, y2=y+y, z2=z+z;
  const xx=x*x2, xy=x*y2, xz=x*z2;
  const yy=y*y2, yz=y*z2, zz=z*z2;
  const wx=w*x2, wy=w*y2, wz=w*z2;
  o[0]=1-(yy+zz); o[1]=xy+wz;     o[2]=xz-wy;     o[3]=0;
  o[4]=xy-wz;     o[5]=1-(xx+zz); o[6]=yz+wx;     o[7]=0;
  o[8]=xz+wy;     o[9]=yz-wx;     o[10]=1-(xx+yy);o[11]=0;
  o[12]=p[0];     o[13]=p[1];     o[14]=p[2];     o[15]=1;
  return o;
}

function m4fromTRS(o, p, rotY, scale) {
  const c = Math.cos(rotY), s = Math.sin(rotY);
  o[0] = c * scale;  o[1] = 0;          o[2] = -s * scale; o[3] = 0;
  o[4] = 0;          o[5] = scale;      o[6] = 0;          o[7] = 0;
  o[8] = s * scale;  o[9] = 0;          o[10] = c * scale; o[11] = 0;
  o[12] = p[0];      o[13] = p[1];      o[14] = p[2];      o[15] = 1;
  return o;
}

/* =========================================================================
   SHADERS
   ========================================================================= */
function compile(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
    console.error(gl.getShaderInfoLog(s), src);
  return s;
}
function makeProgram(vsSrc, fsSrc) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl.VERTEX_SHADER, vsSrc));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fsSrc));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS))
    console.error(gl.getProgramInfoLog(p));
  return p;
}
function locs(p, names) {
  const o = {};
  for (const n of names) o[n] = gl.getUniformLocation(p, n);
  return o;
}

/* ---- sky ---- */
const skyProg = makeProgram(`#version 300 es
precision highp float;
layout(location=0) in vec2 aPos;
uniform mat4 uInvViewProj;
uniform vec3 uCamPos;
out vec3 vDir;
void main(){
  vec4 p = uInvViewProj * vec4(aPos, 1.0, 1.0);
  vDir = p.xyz / p.w - uCamPos;
  gl_Position = vec4(aPos, 1.0, 1.0);
}`, `#version 300 es
precision highp float;
in vec3 vDir;
uniform vec3 uSunDir, uSunColor, uSkyTop, uSkyHorizon, uGroundColor;
out vec4 fragColor;
void main(){
  vec3 d = normalize(vDir);
  float up = d.y;
  float t = pow(clamp(up, 0.0, 1.0), 0.55);
  vec3 col = mix(uSkyHorizon, uSkyTop, t);
  col = mix(col, uGroundColor, smoothstep(0.0, -0.22, up));

  float sd = max(dot(d, uSunDir), 0.0);
  col += uSunColor * pow(sd, 1200.0) * 18.0;
  col += uSunColor * pow(sd, 40.0)   * 0.55;
  col += uSunColor * pow(sd, 6.0)    * 0.14;
  col += uSunColor * pow(sd, 2.0)    * 0.05;

  fragColor = vec4(col, 1.0);
}`);
const skyU = locs(skyProg, ['uInvViewProj','uCamPos','uSunDir','uSunColor','uSkyTop','uSkyHorizon','uGroundColor']);

/* --------------------------------------------------------------------------
   TERRAIN
   The fragment shader now reconstructs the biome fields (temperature and
   moisture) using the same frequencies as models.js, then blends a
   per-biome palette.  Altitude and slope override the lowland biome so
   mountains, snow and badlands read correctly.
   ------------------------------------------------------------------------ */
const terrainProg = makeProgram(`#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
uniform mat4 uViewProj;
out vec3 vWorld;
void main(){
  vWorld = aPos;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}`, `#version 300 es
precision highp float;
in vec3 vWorld;
uniform vec3 uCamPos, uSunDir, uSunColor, uFogColor;
uniform float uFogNear, uFogFar;
out vec4 fragColor;

/* ------- value noise + fbm, matching models.js closely enough -------- */
float hash1(vec2 p){
  return fract(sin(dot(floor(p), vec2(12.9898, 78.233))) * 43758.5453);
}
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash1(i);
  float b = hash1(i + vec2(1.0, 0.0));
  float c = hash1(i + vec2(0.0, 1.0));
  float d = hash1(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
/* Signed fbm, output roughly -1..1 (same as CPU version) */
float fbm2(vec2 p){
  float sum = 0.0, amp = 1.0, n = 0.0, f = 1.0;
  for (int i = 0; i < 3; i++){
    sum += (vnoise(p * f) * 2.0 - 1.0) * amp;
    n   += amp;
    amp *= 0.5;
    f   *= 2.03;
  }
  return sum / n;
}

/* ------- biome palettes -------------------------------------------- */
const vec3 C_BEACH     = vec3(0.88, 0.82, 0.62);
const vec3 C_PLAINS    = vec3(0.44, 0.56, 0.26);
const vec3 C_FOREST    = vec3(0.22, 0.42, 0.16);
const vec3 C_JUNGLE    = vec3(0.12, 0.36, 0.14);
const vec3 C_SWAMP     = vec3(0.28, 0.34, 0.18);
const vec3 C_DESERT    = vec3(0.86, 0.74, 0.44);
const vec3 C_SAVANNA   = vec3(0.70, 0.64, 0.30);
const vec3 C_BADLANDS  = vec3(0.66, 0.36, 0.24);
const vec3 C_TUNDRA    = vec3(0.58, 0.60, 0.52);
const vec3 C_SNOW      = vec3(0.95, 0.97, 1.00);
const vec3 C_MOUNTAIN  = vec3(0.44, 0.42, 0.40);
const vec3 C_HIGHLAND  = vec3(0.46, 0.44, 0.36);

void main(){
  vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
  vec3 toCam = uCamPos - vWorld;
  float dist = length(toCam);
  vec3 viewDir = toCam / max(dist, 1e-4);
  if (dot(n, viewDir) < 0.0) n = -n;

  float slope = 1.0 - clamp(n.y, 0.0, 1.0);
  float h = vWorld.y;

  /* ---- biome fields (same frequencies as models.js) ---- */
  vec2 xz = vWorld.xz;
  float t = fbm2(xz * 0.00045 + vec2(512.3, 941.7));
  float m = fbm2(xz * 0.00072 + vec2(187.4, 623.1));

  /* small per-fragment jitter so the ground isn't a flat colour */
  float v = hash1(xz * 0.35);

  /* ---- lowland biome pick ------------------------------------ */
  vec3 base;
  if (t > 0.15 && m < -0.12) {
    base = C_DESERT;
  } else if (t > 0.18 && m < 0.10) {
    base = C_SAVANNA;
  } else if (t > 0.10 && m > 0.30) {
    base = C_JUNGLE;
  } else if (m > 0.42 && h < 12.0) {
    base = C_SWAMP;
  } else if (m > 0.05) {
    base = C_FOREST;
  } else {
    base = C_PLAINS;
  }
  if (t < -0.42) base = C_SNOW;
  else if (t < -0.28) base = C_TUNDRA;

  /* Slight colour variation between neighbouring pixels */
  base *= (0.92 + v * 0.16);

  /* ---- altitude overrides ------------------------------------- */
  if (h > 32.0 && t > 0.15 && m < -0.12) {
    base = mix(base, C_BADLANDS, smoothstep(32.0, 46.0, h));
  }
  base = mix(base, C_MOUNTAIN, smoothstep(48.0, 62.0, h));
  base = mix(base, C_HIGHLAND, smoothstep(62.0, 78.0, h));
  base = mix(base, C_SNOW,     smoothstep(82.0, 100.0, h));
  /* Cold high ground also gets snow */
  base = mix(base, C_SNOW, smoothstep(60.0, 80.0, h) * smoothstep(-0.05, -0.30, t));

  /* ---- beach fade near sea level ----------------------------- */
  base = mix(C_BEACH, base, smoothstep(0.5, 3.0, h));

  /* ---- rock on steep faces ----------------------------------- */
  base = mix(base, C_MOUNTAIN, smoothstep(0.55, 0.80, slope) * 0.85);
  /* Snow dusting doesn't stick to vertical cliffs */
  base = mix(base, C_SNOW,
    smoothstep(82.0, 100.0, h) * (1.0 - smoothstep(0.55, 0.80, slope)) * 0.55);

  /* ---- shading ------------------------------------------------ */
  float ndl = max(dot(n, uSunDir), 0.0);

  /* Sky/ground hemisphere ambient */
  vec3 skyAmb = vec3(0.42, 0.46, 0.55);
  vec3 gndAmb = vec3(0.22, 0.20, 0.18);
  vec3 ambient = mix(gndAmb, skyAmb, n.y * 0.5 + 0.5);

  vec3 col = base * (ambient + uSunColor * ndl * 1.12);

  /* Soft sky rim */
  float rim = pow(1.0 - max(dot(n, viewDir), 0.0), 4.0) * 0.14;
  col += uSunColor * rim;

  /* Warm glow toward the sun */
  float sunAmount = pow(max(dot(viewDir, uSunDir), 0.0), 5.0);
  col += uSunColor * sunAmount * 0.12;

  /* Fog */
  float fog = smoothstep(uFogNear, uFogFar, dist);
  col = mix(col, uFogColor, fog);

  fragColor = vec4(col, 1.0);
}`);
const terrU = locs(terrainProg, ['uViewProj','uCamPos','uSunDir','uSunColor','uFogColor','uFogNear','uFogFar']);

/* ---- models (plane, propeller, trees) — textured ---- */
const modelProg = makeProgram(`#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNrm;
layout(location=2) in vec3 aCol;
layout(location=3) in vec2 aUv;
uniform mat4 uViewProj;
uniform mat4 uModel;
out vec3 vWorld;
out vec3 vNrm;
out vec3 vCol;
out vec2 vUv;
void main(){
  vec4 wp = uModel * vec4(aPos, 1.0);
  vWorld = wp.xyz;
  vNrm = mat3(uModel) * aNrm;
  vCol = aCol;
  vUv  = aUv;
  gl_Position = uViewProj * wp;
}`, `#version 300 es
precision highp float;
in vec3 vWorld;
in vec3 vNrm;
in vec3 vCol;
in vec2 vUv;
uniform sampler2D uTexture;
uniform float uHasTexture;
uniform vec3 uCamPos, uSunDir, uSunColor, uFogColor;
uniform float uFogNear, uFogFar;
out vec4 fragColor;
void main(){
  vec3 n = normalize(vNrm);
  vec3 toCam = uCamPos - vWorld;
  float dist = length(toCam);
  vec3 viewDir = toCam / max(dist, 1e-4);
  if (dot(n, viewDir) < 0.0) n = -n;

  vec4 texSample = texture(uTexture, vUv);
  vec3 texCol = texSample.rgb * 1.15;
  vec3 albedo = mix(vCol, texCol, uHasTexture);

  float ndl = max(dot(n, uSunDir), 0.0);

  vec3 skyAmb = vec3(0.34, 0.40, 0.50);
  vec3 gndAmb = vec3(0.20, 0.18, 0.16);
  vec3 amb = mix(gndAmb, skyAmb, n.y * 0.5 + 0.5);

  vec3 col = albedo * (amb + uSunColor * ndl * 1.22);

  vec3 hv = normalize(uSunDir + viewDir);
  col += uSunColor * pow(max(dot(n, hv), 0.0), 48.0) * 0.42;

  col = mix(col, uFogColor, smoothstep(uFogNear, uFogFar, dist));
  fragColor = vec4(col, 1.0);
}`);
const modelU = locs(modelProg, [
  'uViewProj','uModel','uCamPos','uSunDir','uSunColor','uFogColor',
  'uFogNear','uFogFar','uTexture','uHasTexture'
]);

/* ---- outlines ---- */
const outlineProg = makeProgram(`#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNrm;
uniform mat4 uViewProj;
uniform mat4 uModel;
uniform float uThickness;
uniform vec2 uResolution;
void main(){
  vec4 wp = uModel * vec4(aPos, 1.0);
  vec4 cp = uViewProj * wp;
  vec4 wn = uModel * vec4(aNrm, 0.0);
  vec4 cn = uViewProj * (wp + wn);
  vec2 s0 = cp.xy / cp.w;
  vec2 s1 = cn.xy / cn.w;
  vec2 d  = s1 - s0;
  float len = length(d);
  vec2 off = len > 1e-6 ? (d / len) * (uThickness * 2.0 / uResolution) : vec2(0.0);
  cp.xy += off * cp.w;
  gl_Position = cp;
}`, `#version 300 es
precision highp float;
out vec4 fragColor;
void main(){ fragColor = vec4(0.045, 0.050, 0.065, 1.0); }`);
const outU = locs(outlineProg, ['uViewProj','uModel','uThickness','uResolution']);

/* ---- water ----
   Layered directional sines + value noise, no repeating grid.
------------------------------------------------------------------- */
const waterProg = makeProgram(`#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
uniform mat4 uViewProj;
uniform mat4 uModel;
out vec3 vWorld;
void main(){
  vec4 wp = uModel * vec4(aPos, 1.0);
  vWorld = wp.xyz;
  gl_Position = uViewProj * wp;
}`, `#version 300 es
precision highp float;
in vec3 vWorld;
uniform vec3 uCamPos, uSunDir, uSunColor, uFogColor, uSkyHorizon;
uniform float uFogNear, uFogFar, uTime;
out vec4 fragColor;

float hash21(vec2 p){
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float waveHeight(vec2 p, float t){
  float h = 0.0;
  h += sin(dot(p, vec2( 0.0413,  0.0271)) + t * 0.91) * 0.36;
  h += sin(dot(p, vec2(-0.0239,  0.0371)) + t * 1.27) * 0.28;
  h += sin(dot(p, vec2( 0.0671, -0.0513)) + t * 1.83) * 0.18;
  h += sin(dot(p, vec2( 0.0131,  0.0831)) + t * 2.51) * 0.11;
  h += sin(dot(p, vec2( 0.1523,  0.1177)) + t * 3.31) * 0.06;
  h += (vnoise(p * 0.14 + t * 0.07) - 0.5) * 0.55;
  h += (vnoise(p * 0.42 - t * 0.11) - 0.5) * 0.28;
  h += (vnoise(p * 1.13 + t * 0.19) - 0.5) * 0.12;
  return h;
}

void main(){
  vec3 toCam = uCamPos - vWorld;
  float dist = length(toCam);
  vec3 viewDir = toCam / max(dist, 1e-4);

  vec2 p = vWorld.xz;
  float e = 0.55;
  float hC = waveHeight(p, uTime);
  float hL = waveHeight(p - vec2(e, 0.0), uTime);
  float hR = waveHeight(p + vec2(e, 0.0), uTime);
  float hD = waveHeight(p - vec2(0.0, e), uTime);
  float hU = waveHeight(p + vec2(0.0, e), uTime);

  float amp = 0.85;
  vec3 n = normalize(vec3((hL - hR) * amp, 2.0 * e, (hD - hU) * amp));

  float crest = clamp(hC * 0.5 + 0.5, 0.0, 1.0);

  float fres = pow(1.0 - max(dot(viewDir, n), 0.0), 3.0);
  vec3 deep = mix(vec3(0.045, 0.130, 0.210), vec3(0.075, 0.205, 0.260), crest);
  vec3 col = mix(deep, uSkyHorizon, clamp(fres, 0.0, 1.0) * 0.85);

  vec3 hv = normalize(uSunDir + viewDir);
  col += uSunColor * pow(max(dot(n, hv), 0.0), 380.0) * 2.2;
  col += uSunColor * pow(max(dot(n, hv), 0.0), 22.0)  * 0.13;

  col = mix(col, uFogColor, smoothstep(uFogNear, uFogFar, dist));
  fragColor = vec4(col, 1.0);
}`);
const waterU = locs(waterProg, [
  'uViewProj','uModel','uCamPos','uSunDir','uSunColor','uFogColor',
  'uSkyHorizon','uFogNear','uFogFar','uTime'
]);

/* =========================================================================
   WORLD MODELS
   ========================================================================= */
Models.init(gl);

/* Optional: log which textures arrived, helpful when debugging. */
if (Models.onAssetsLoaded) {
  Models.onAssetsLoaded((entry) => {
    if (entry.loaded) console.log('[SkyCube] texture loaded:', entry.path);
    else if (entry.failed) console.warn('[SkyCube] texture missing:', entry.path);
  });
}

/* =========================================================================
   WATER + SKY GEOMETRY
   ========================================================================= */
const waterMesh = (() => {
  const s = 3000;
  const pos = new Float32Array([-s,0,-s, -s,0,s, s,0,s, s,0,-s]);
  const nrm = new Float32Array([0,1,0, 0,1,0, 0,1,0, 0,1,0]);
  const idx = new Uint16Array([0,1,2, 0,2,3]);
  return Terrain.createMesh(pos, nrm, null, idx);
})();

const skyMesh = (() => {
  const pos = new Float32Array([-1,-1, 3,-1, -1,3]);
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const b = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, b);
  gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  return { vao, bufs: [b], count: 3 };
})();

/* =========================================================================
   ATMOSPHERE
   ========================================================================= */
const SUN_DIR     = norm3([0.42, 0.50, -0.76]);
const SUN_COLOR   = [1.00, 0.94, 0.80];
const SKY_TOP     = [0.24, 0.47, 0.80];
const SKY_HORIZON = [0.86, 0.89, 0.93];
const SKY_GROUND  = [0.56, 0.62, 0.66];
const FOG_COLOR   = [0.82, 0.87, 0.92];
/* Fog pushed out a little because the new mountain ranges are visible
   much further than the old low rolling terrain. */
const FOG_NEAR    = 600;
const FOG_FAR     = 1300;

/* =========================================================================
   GAME STATE
   ========================================================================= */
const plane = {
  pos: [0, 0, 0],
  q: qIdentity(),
  speed: 60,
  throttle: 0.7,
};
plane.pos[1] = Math.max(Terrain.terrainHeight(0, 0), 0) + 190;

const camPos = [plane.pos[0], plane.pos[1] + 5, plane.pos[2] + 16];
const camUp  = [0, 1, 0];

let throttleSmooth = plane.throttle;
let ratePitch = 0, rateYaw = 0, rateRoll = 0;

const MAX_PITCH_RATE = 1.65;
const MAX_ROLL_RATE  = 3.10;
const MAX_YAW_RATE   = 0.95;
const RESPONSE       = 6.5;

let propAngle  = 0;
let crashTimer = 0;
let showOutlines = true;
let gameTime   = 0;

const keys = Object.create(null);
window.addEventListener('keydown', e => {
  keys[e.code] = true;
  if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(e.code)) e.preventDefault();
  if (e.code === 'KeyO') showOutlines = !showOutlines;
  if (e.code === 'KeyR') respawn();
});
window.addEventListener('keyup', e => { keys[e.code] = false; });
window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; });

/* =========================================================================
   TOUCH
   ========================================================================= */
function makeStick(el, knob) {
  return {
    el, knob, id: null, x: 0, y: 0,
    start(t) { this.id = t.identifier; this.update(t); },
    update(t) {
      const r = this.el.getBoundingClientRect();
      const cx = r.left + r.width * 0.5;
      const cy = r.top + r.height * 0.5;
      let dx = t.clientX - cx, dy = t.clientY - cy;
      const max = r.width * 0.5 - 20;
      const len = Math.hypot(dx, dy);
      if (len > max) { dx = dx / len * max; dy = dy / len * max; }
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
      this.x = dx / max; this.y = dy / max;
    },
    end() {
      this.id = null; this.x = 0; this.y = 0;
      knob.style.transform = 'translate(0px, 0px)';
    }
  };
}
const leftStick  = makeStick(document.getElementById('leftStick'),  document.getElementById('leftKnob'));
const rightStick = makeStick(document.getElementById('rightStick'), document.getElementById('rightKnob'));

function pickStick(clientX, id) {
  if (clientX < window.innerWidth * 0.5) {
    if (leftStick.id === null) return leftStick;
    if (rightStick.id === null) return rightStick;
  } else {
    if (rightStick.id === null) return rightStick;
    if (leftStick.id === null) return leftStick;
  }
  return null;
}
function onTouchStart(e) {
  if (e.target && e.target.tagName === 'BUTTON') return;
  for (const t of e.changedTouches) {
    const s = pickStick(t.clientX, t.identifier);
    if (s) s.start(t);
  }
  e.preventDefault();
}
function onTouchMove(e) {
  for (const t of e.changedTouches) {
    if (leftStick.id  === t.identifier) { leftStick.update(t);  continue; }
    if (rightStick.id === t.identifier) { rightStick.update(t); continue; }
  }
  e.preventDefault();
}
function onTouchEnd(e) {
  for (const t of e.changedTouches) {
    if (leftStick.id  === t.identifier) leftStick.end();
    if (rightStick.id === t.identifier) rightStick.end();
  }
  e.preventDefault();
}
window.addEventListener('touchstart',  onTouchStart, { passive: false });
window.addEventListener('touchmove',   onTouchMove,  { passive: false });
window.addEventListener('touchend',    onTouchEnd,   { passive: false });
window.addEventListener('touchcancel', onTouchEnd,   { passive: false });
resetBtn.addEventListener('click', (e) => { e.preventDefault(); respawn(); });

/* =========================================================================
   MESSAGES / RESPAWN
   ========================================================================= */
function showMessage(text, ms) {
  msgEl.textContent = text;
  msgEl.style.opacity = '1';
  clearTimeout(showMessage._t);
  showMessage._t = setTimeout(() => { msgEl.style.opacity = '0'; }, ms || 1400);
}
function respawn() {
  const x = plane.pos[0], z = plane.pos[2];
  plane.pos[1] = Math.max(Terrain.terrainHeight(x, z), 0) + 190;
  plane.q = qIdentity();
  plane.speed = 65;
  plane.throttle = 0.7;
  throttleSmooth = 0.7;
  ratePitch = rateYaw = rateRoll = 0;
  crashTimer = 0;
}
function crash() {
  crashTimer = 1.5;
  showMessage('CRASHED', 1300);
}

/* =========================================================================
   UPDATE
   ========================================================================= */
function update(dt) {
  gameTime += dt;

  if (crashTimer > 0) {
    crashTimer -= dt;
    if (crashTimer <= 0) respawn();
    return;
  }

  let pitchIn = 0, rollIn = 0, yawIn = 0;
  if (keys['KeyW'] || keys['ArrowUp'])    pitchIn += 1;
  if (keys['KeyS'] || keys['ArrowDown'])  pitchIn -= 1;
  if (keys['KeyA'] || keys['ArrowLeft'])  rollIn  += 1;
  if (keys['KeyD'] || keys['ArrowRight']) rollIn  -= 1;
  if (keys['KeyQ']) yawIn += 1;
  if (keys['KeyE']) yawIn -= 1;

  pitchIn += -leftStick.y;
  rollIn  += -leftStick.x;
  yawIn   += -rightStick.x;
  plane.throttle += -rightStick.y * dt * 1.1;

  if (keys['ShiftLeft'] || keys['ShiftRight'])     plane.throttle += dt * 0.75;
  if (keys['ControlLeft'] || keys['ControlRight']) plane.throttle -= dt * 0.75;
  plane.throttle = clamp(plane.throttle, 0, 1);

  pitchIn = clamp(pitchIn, -1, 1);
  rollIn  = clamp(rollIn,  -1, 1);
  yawIn   = clamp(yawIn,   -1, 1);

  throttleSmooth += (plane.throttle - throttleSmooth) * Math.min(1, dt * 3.0);

  const authority = clamp(plane.speed / 80, 0.40, 1.35);

  const targetPitch = pitchIn * MAX_PITCH_RATE * authority;
  const targetRoll  = rollIn  * MAX_ROLL_RATE  * authority;
  const targetYaw   = yawIn   * MAX_YAW_RATE   * authority;

  const rp = 1 - Math.exp(-RESPONSE * dt);
  ratePitch = lerp(ratePitch, targetPitch, rp);
  rateRoll  = lerp(rateRoll,  targetRoll,  rp);
  rateYaw   = lerp(rateYaw,   targetYaw,   rp);

  let rot = qIdentity();
  rot = qMul(rot, qAxisAngle(1, 0, 0, ratePitch * dt));
  rot = qMul(rot, qAxisAngle(0, 0, 1, rateRoll  * dt));
  rot = qMul(rot, qAxisAngle(0, 1, 0, rateYaw   * dt));
  plane.q = qNorm(qMul(plane.q, rot));

  const rightAxis = qRot(plane.q, [1, 0, 0]);
  const bankTurn = rightAxis[1] * 0.90 * clamp(plane.speed / 70, 0.4, 1.4);
  plane.q = qNorm(qMul(qAxisAngle(0, 1, 0, bankTurn * dt), plane.q));

  const fwd = qRot(plane.q, [0, 0, -1]);
  const targetSpeed = 30 + throttleSmooth * 100;

  plane.speed += (targetSpeed - plane.speed) * Math.min(1, dt * 0.9);
  plane.speed -= fwd[1] * 30 * dt;
  plane.speed = clamp(plane.speed, 20, 175);

  plane.pos[0] += fwd[0] * plane.speed * dt;
  plane.pos[1] += fwd[1] * plane.speed * dt;
  plane.pos[2] += fwd[2] * plane.speed * dt;

  propAngle += (2.0 + throttleSmooth * 30.0) * dt;

  const gh = Terrain.terrainHeight(plane.pos[0], plane.pos[2]);
  if (plane.pos[1] < gh + 2.0) {
    plane.pos[1] = gh + 2.0;
    crash();
    return;
  }

  const off = qRot(plane.q, [0, 3.0, 12.5]);
  const desiredX = plane.pos[0] + off[0];
  const desiredY = plane.pos[1] + off[1];
  const desiredZ = plane.pos[2] + off[2];
  const cs = 1 - Math.exp(-8.0 * dt);
  camPos[0] = lerp(camPos[0], desiredX, cs);
  camPos[1] = lerp(camPos[1], desiredY, cs);
  camPos[2] = lerp(camPos[2], desiredZ, cs);

  const camGround = Terrain.terrainHeight(camPos[0], camPos[2]);
  if (camPos[1] < camGround + 3.5) camPos[1] = camGround + 3.5;

  const pUp = qRot(plane.q, [0, 1, 0]);
  let bu = [lerp(0, pUp[0], 0.80), lerp(1, pUp[1], 0.80), lerp(0, pUp[2], 0.80)];
  const bl = Math.hypot(bu[0], bu[1], bu[2]);
  if (bl < 0.25) bu = [0, 1, 0];
  else bu = [bu[0]/bl, bu[1]/bl, bu[2]/bl];
  camUp[0] = lerp(camUp[0], bu[0], cs);
  camUp[1] = lerp(camUp[1], bu[1], cs);
  camUp[2] = lerp(camUp[2], bu[2], cs);
}

/* =========================================================================
   RENDER
   ========================================================================= */
const matProj = m4();
const matView = m4();
const matViewProj = m4();
const matInvViewProj = m4();
const matModel = m4();
const matPlane = m4();
const matTmpA = m4();
const matTmpB = m4();
const matTmpC = m4();

const frustum = new Float32Array(24);
function updateFrustum(m) {
  const r0 = [m[0], m[4], m[8],  m[12]];
  const r1 = [m[1], m[5], m[9],  m[13]];
  const r2 = [m[2], m[6], m[10], m[14]];
  const r3 = [m[3], m[7], m[11], m[15]];
  function set(i, row, sign) {
    for (let k = 0; k < 4; k++) frustum[i*4+k] = r3[k] + sign * row[k];
    const n = Math.hypot(frustum[i*4], frustum[i*4+1], frustum[i*4+2]) || 1;
    for (let k = 0; k < 4; k++) frustum[i*4+k] /= n;
  }
  set(0, r0, +1); set(1, r0, -1);
  set(2, r1, +1); set(3, r1, -1);
  set(4, r2, +1); set(5, r2, -1);
}
function sphereVisible(x, y, z, r) {
  for (let i = 0; i < 6; i++) {
    const a = frustum[i*4], b = frustum[i*4+1], c = frustum[i*4+2], d = frustum[i*4+3];
    if (a*x + b*y + c*z + d < -r) return false;
  }
  return true;
}

let screenW = 1, screenH = 1;
function resize() {
  const dprCap = IS_TOUCH ? 1.6 : 2.0;
  const dpr = Math.min(window.devicePixelRatio || 1, dprCap);
  const w = Math.max(1, Math.floor(canvas.clientWidth  * dpr));
  const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w; canvas.height = h;
  }
  screenW = canvas.width; screenH = canvas.height;
}
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', resize);
  window.visualViewport.addEventListener('scroll', resize);
}
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => setTimeout(resize, 200));

/* --- helper: draw a textured model mesh with the standard model program --- */
function drawTexturedModel(mesh) {
  if (!mesh) return;
  if (mesh.texture) {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, mesh.texture);
    gl.uniform1i(modelU.uTexture, 0);
    gl.uniform1f(modelU.uHasTexture, 1.0);
  } else {
    gl.uniform1f(modelU.uHasTexture, 0.0);
  }
  gl.bindVertexArray(mesh.vao);
  gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_SHORT, 0);
}

function render() {
  resize();
  gl.viewport(0, 0, screenW, screenH);

  const aspect = screenW / screenH;
  m4perspective(matProj, 62 * Math.PI / 180, aspect, 0.6, 2800);

  const la = qRot(plane.q, [0, 1.6, -14]);
  const lookTarget = [
    plane.pos[0] + la[0],
    plane.pos[1] + la[1],
    plane.pos[2] + la[2]
  ];
  m4lookAt(matView, camPos, lookTarget, camUp);
  m4mul(matViewProj, matProj, matView);
  m4invert(matInvViewProj, matViewProj);
  updateFrustum(matViewProj);

  gl.clearColor(FOG_COLOR[0], FOG_COLOR[1], FOG_COLOR[2], 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  /* -------- SKY -------- */
  gl.disable(gl.DEPTH_TEST);
  gl.depthMask(false);
  gl.disable(gl.CULL_FACE);
  gl.useProgram(skyProg);
  gl.uniformMatrix4fv(skyU.uInvViewProj, false, matInvViewProj);
  gl.uniform3fv(skyU.uCamPos, camPos);
  gl.uniform3fv(skyU.uSunDir, SUN_DIR);
  gl.uniform3fv(skyU.uSunColor, SUN_COLOR);
  gl.uniform3fv(skyU.uSkyTop, SKY_TOP);
  gl.uniform3fv(skyU.uSkyHorizon, SKY_HORIZON);
  gl.uniform3fv(skyU.uGroundColor, SKY_GROUND);
  gl.bindVertexArray(skyMesh.vao);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.enable(gl.DEPTH_TEST);
  gl.depthMask(true);
  gl.enable(gl.CULL_FACE);
  gl.cullFace(gl.BACK);

  /* -------- visible chunks -------- */
  const visible = [];
  for (const ch of Terrain.chunks.values()) {
    if (sphereVisible(ch.center[0], ch.center[1], ch.center[2], ch.radius))
      visible.push(ch);
  }

  /* -------- TERRAIN -------- */
  gl.useProgram(terrainProg);
  gl.uniformMatrix4fv(terrU.uViewProj, false, matViewProj);
  gl.uniform3fv(terrU.uCamPos, camPos);
  gl.uniform3fv(terrU.uSunDir, SUN_DIR);
  gl.uniform3fv(terrU.uSunColor, SUN_COLOR);
  gl.uniform3fv(terrU.uFogColor, FOG_COLOR);
  gl.uniform1f(terrU.uFogNear, FOG_NEAR);
  gl.uniform1f(terrU.uFogFar, FOG_FAR);
  for (const ch of visible) {
    gl.bindVertexArray(ch.mesh.vao);
    gl.drawElements(gl.TRIANGLES, ch.mesh.count, gl.UNSIGNED_SHORT, 0);
  }

  /* -------- TERRAIN OUTLINES -------- */
  if (showOutlines) {
    gl.useProgram(outlineProg);
    gl.uniformMatrix4fv(outU.uViewProj, false, matViewProj);
    gl.uniformMatrix4fv(outU.uModel, false, m4identity(matModel));
    gl.uniform2f(outU.uResolution, screenW, screenH);
    gl.uniform1f(outU.uThickness, 1.2);
    gl.cullFace(gl.FRONT);
    for (const ch of visible) {
      gl.bindVertexArray(ch.mesh.vao);
      gl.drawElements(gl.TRIANGLES, ch.mesh.count, gl.UNSIGNED_SHORT, 0);
    }
    gl.cullFace(gl.BACK);
  }

  /* -------- AIRCRAFT -------- */
  m4fromQuatPos(matPlane, plane.q, plane.pos);

  gl.useProgram(modelProg);
  gl.uniformMatrix4fv(modelU.uViewProj, false, matViewProj);
  gl.uniform3fv(modelU.uCamPos, camPos);
  gl.uniform3fv(modelU.uSunDir, SUN_DIR);
  gl.uniform3fv(modelU.uSunColor, SUN_COLOR);
  gl.uniform3fv(modelU.uFogColor, FOG_COLOR);
  gl.uniform1f(modelU.uFogNear, FOG_NEAR);
  gl.uniform1f(modelU.uFogFar, FOG_FAR);

  gl.uniformMatrix4fv(modelU.uModel, false, matPlane);
  drawTexturedModel(Models.planeMesh);

  /* propeller (spinning around local Z) */
  {
    m4identity(matTmpA); matTmpA[14] = -2.05;
    const ca = Math.cos(propAngle), sa = Math.sin(propAngle);
    m4identity(matTmpB);
    matTmpB[0] = ca; matTmpB[1] = sa;
    matTmpB[4] = -sa; matTmpB[5] = ca;
    m4mul(matTmpC, matTmpA, matTmpB);
    m4mul(matModel, matPlane, matTmpC);
    gl.uniformMatrix4fv(modelU.uModel, false, matModel);
    drawTexturedModel(Models.propMesh);
  }

  /* -------- AIRCRAFT OUTLINES -------- */
  if (showOutlines) {
    gl.useProgram(outlineProg);
    gl.uniformMatrix4fv(outU.uViewProj, false, matViewProj);
    gl.uniform2f(outU.uResolution, screenW, screenH);
    gl.uniform1f(outU.uThickness, 2.6);
    gl.cullFace(gl.FRONT);

    gl.uniformMatrix4fv(outU.uModel, false, matPlane);
    gl.bindVertexArray(Models.planeMesh.vao);
    gl.drawElements(gl.TRIANGLES, Models.planeMesh.count, gl.UNSIGNED_SHORT, 0);

    m4identity(matTmpA); matTmpA[14] = -2.05;
    const ca = Math.cos(propAngle), sa = Math.sin(propAngle);
    m4identity(matTmpB);
    matTmpB[0] = ca; matTmpB[1] = sa; matTmpB[4] = -sa; matTmpB[5] = ca;
    m4mul(matTmpC, matTmpA, matTmpB);
    m4mul(matModel, matPlane, matTmpC);
    gl.uniformMatrix4fv(outU.uModel, false, matModel);
    gl.bindVertexArray(Models.propMesh.vao);
    gl.drawElements(gl.TRIANGLES, Models.propMesh.count, gl.UNSIGNED_SHORT, 0);

    gl.cullFace(gl.BACK);
  }

  /* -------- WORLD MODELS: TREES (per-variant meshes + textures) -------- */
  gl.useProgram(modelProg);
  gl.uniformMatrix4fv(modelU.uViewProj, false, matViewProj);
  gl.uniform3fv(modelU.uCamPos, camPos);
  gl.uniform3fv(modelU.uSunDir, SUN_DIR);
  gl.uniform3fv(modelU.uSunColor, SUN_COLOR);
  gl.uniform3fv(modelU.uFogColor, FOG_COLOR);
  gl.uniform1f(modelU.uFogNear, FOG_NEAR);
  gl.uniform1f(modelU.uFogFar, FOG_FAR);

  for (const ch of visible) {
    for (const obj of ch.objects) {
      if (obj.type !== 'tree') continue;
      const mesh = obj.mesh || Models.getTreeMesh(obj);
      m4fromTRS(matModel, obj.position, obj.rotation, obj.scale);
      gl.uniformMatrix4fv(modelU.uModel, false, matModel);
      drawTexturedModel(mesh);
    }
  }

  /* -------- TREE OUTLINES -------- */
  if (showOutlines) {
    gl.useProgram(outlineProg);
    gl.uniformMatrix4fv(outU.uViewProj, false, matViewProj);
    gl.uniform2f(outU.uResolution, screenW, screenH);
    gl.uniform1f(outU.uThickness, 1.8);
    gl.cullFace(gl.FRONT);

    for (const ch of visible) {
      for (const obj of ch.objects) {
        if (obj.type !== 'tree') continue;
        const mesh = obj.mesh || Models.getTreeMesh(obj);
        m4fromTRS(matModel, obj.position, obj.rotation, obj.scale);
        gl.uniformMatrix4fv(outU.uModel, false, matModel);
        gl.bindVertexArray(mesh.vao);
        gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_SHORT, 0);
      }
    }
    gl.cullFace(gl.BACK);
  }

  /* -------- WATER -------- */
  {
    gl.useProgram(waterProg);
    gl.uniformMatrix4fv(waterU.uViewProj, false, matViewProj);
    m4identity(matModel);
    matModel[12] = camPos[0];
    matModel[13] = 0;
    matModel[14] = camPos[2];
    gl.uniformMatrix4fv(waterU.uModel, false, matModel);
    gl.uniform3fv(waterU.uCamPos, camPos);
    gl.uniform3fv(waterU.uSunDir, SUN_DIR);
    gl.uniform3fv(waterU.uSunColor, SUN_COLOR);
    gl.uniform3fv(waterU.uFogColor, FOG_COLOR);
    gl.uniform3fv(waterU.uSkyHorizon, SKY_HORIZON);
    gl.uniform1f(waterU.uFogNear, FOG_NEAR);
    gl.uniform1f(waterU.uFogFar, FOG_FAR);
    gl.uniform1f(waterU.uTime, gameTime);
    gl.bindVertexArray(waterMesh.vao);
    gl.drawElements(gl.TRIANGLES, waterMesh.count, gl.UNSIGNED_SHORT, 0);
  }

  gl.bindVertexArray(null);
}

/* =========================================================================
   HUD + LOOP
   ========================================================================= */
let hudTimer = 0;
function updateHud(dt) {
  hudTimer -= dt;
  if (hudTimer > 0) return;
  hudTimer = 0.15;
  const alt = plane.pos[1];
  const spd = plane.speed * 3.6 * 0.6;
  const f = qRot(plane.q, [0, 0, -1]);
  let hdg = Math.atan2(f[0], -f[2]) * 180 / Math.PI;
  if (hdg < 0) hdg += 360;

  /* Current biome under the aircraft */
  const biome = Terrain.getBiome(plane.pos[0], plane.pos[2], plane.pos[1]);

  hudStats.innerHTML =
    `ALT ${alt.toFixed(0)} m<br>` +
    `SPD ${spd.toFixed(0)} km/h<br>` +
    `THR ${(throttleSmooth * 100).toFixed(0)}%<br>` +
    `HDG ${hdg.toFixed(0)}°<br>` +
    `CHUNKS ${Terrain.chunks.size}<br>` +
    `BIOME ${biome.toUpperCase()}`;
}

/* pre-generate the initial view */
(function preload() {
  const start = performance.now();
  while (performance.now() - start < 200) {
    const before = Terrain.chunks.size;
    Terrain.updateChunks(plane.pos[0], plane.pos[2]);
    if (Terrain.chunks.size === before) break;
  }
})();

let lastTime = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  let dt = (now - lastTime) / 1000;
  lastTime = now;
  dt = Math.min(dt, 0.05);

  update(dt);
  Terrain.updateChunks(plane.pos[0], plane.pos[2]);
  render();
  updateHud(dt);
}
requestAnimationFrame(frame);

canvas.addEventListener('webglcontextlost', e => {
  e.preventDefault();
  showMessage('CONTEXT LOST', 4000);
});
