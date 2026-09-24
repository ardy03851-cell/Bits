/* vfx.js — GPU weather + aircraft atmosphere
   Optional renderer. It lives beside graphics.js and never owns the main
   canvas, so a VFX failure cannot take down the flight renderer.

   WebGL2 instancing is used for dense particles:
   - rain / storm streaks
   - fast wind streaks around the aircraft
   - suspended mist
   - aircraft wake / contrail particles
*/
(() => {
'use strict';

const mainCanvas = document.getElementById('glcanvas');
if (!mainCanvas) return;

const overlay = document.createElement('canvas');
overlay.id = 'vfxCanvas';
overlay.setAttribute('aria-hidden', 'true');
Object.assign(overlay.style, {
  position: 'fixed',
  inset: '0',
  width: '100%',
  height: '100%',
  pointerEvents: 'none',
  zIndex: '2'
});
document.body.appendChild(overlay);

const gl = overlay.getContext('webgl2', {
  alpha: true,
  antialias: false,
  depth: false,
  stencil: false,
  premultipliedAlpha: true,
  powerPreference: 'high-performance'
});
if (!gl) {
  overlay.style.display = 'none';
  return;
}

const weather = () => window.SkyCubeWeather || {
  rain: 0, storm: 0, wind: 0.2, cloud: 0.2, lightning: 0, mode: 'clear'
};
const flight = () => window.SkyCubeFlight || null;

const MAX_RAIN = 15000;
const MAX_WIND = 4200;
const MAX_MIST = 1800;
const MAX_WAKE = 900;

function shader(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const msg = gl.getShaderInfoLog(s) || 'unknown shader error';
    gl.deleteShader(s);
    throw new Error(msg);
  }
  return s;
}
function program(vs, fs) {
  const p = gl.createProgram();
  const a = shader(gl.VERTEX_SHADER, vs);
  const b = shader(gl.FRAGMENT_SHADER, fs);
  gl.attachShader(p, a); gl.attachShader(p, b);
  gl.linkProgram(p);
  gl.deleteShader(a); gl.deleteShader(b);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const msg = gl.getProgramInfoLog(p) || 'unknown link error';
    gl.deleteProgram(p);
    throw new Error(msg);
  }
  return p;
}

let prog;
try {
  prog = program(`#version 300 es
    precision highp float;

    layout(location=0) in vec2 aCorner;
    layout(location=1) in vec3 aPos;
    layout(location=2) in float aSize;
    layout(location=3) in float aLife;
    layout(location=4) in float aSeed;

    uniform vec2 uResolution;
    uniform float uAspect;
    uniform float uTime;
    uniform float uFov;
    uniform float uKind;

    out float vLife;
    out float vSeed;
    out vec2 vQuad;

    void main() {
      /* Camera-local particle volume. This gives real perspective falloff
         while keeping the VFX layer independent from the game's camera API. */
      float depth = max(3.0, aPos.z);
      float focal = 1.0 / tan(radians(uFov) * 0.5);
      vec2 ndc = vec2(aPos.x / depth * focal / uAspect,
                      aPos.y / depth * focal);

      float px = aSize / max(uResolution.y, 1.0) * 2.0;
      vec2 quad = aCorner * px;

      /* Rain and wind streaks are elongated in their local vertical axis. */
      if (uKind < 0.5) {
        quad.y *= 7.0 + aSize * 0.02;
        quad.x *= 0.42;
      } else if (uKind < 1.5) {
        quad.x *= 5.0;
        quad.y *= 0.24;
      } else {
        quad *= 1.4;
      }

      gl_Position = vec4(ndc + quad, 0.0, 1.0);
      vLife = aLife;
      vSeed = aSeed;
      vQuad = aCorner;
    }`,
    `#version 300 es
    precision highp float;

    in float vLife;
    in float vSeed;
    in vec2 vQuad;
    uniform float uKind;
    uniform float uRain;
    uniform float uStorm;
    uniform float uTime;
    out vec4 fragColor;

    float hash(float n) {
      return fract(sin(n * 91.731) * 43758.5453);
    }

    void main() {
      vec2 p = vQuad * 0.5;
      float d = dot(p, p);

      if (uKind < 0.5) {
        /* Rain: thin core + soft atmospheric halo. */
        float edge = smoothstep(0.30, 0.02, abs(p.x));
        float fade = smoothstep(0.0, 0.16, vLife) * smoothstep(1.0, 0.42, vLife);
        float sparkle = 0.82 + 0.18 * sin(uTime * 8.0 + vSeed * 31.0);
        vec3 col = mix(vec3(0.46,0.62,0.78), vec3(0.82,0.92,1.0), uStorm);
        fragColor = vec4(col * sparkle, edge * fade * (0.20 + uRain * 0.56));
      } else if (uKind < 1.5) {
        /* Wind: warm-white atmospheric streaks. */
        float soft = smoothstep(0.27, 0.0, d);
        float fade = smoothstep(0.0, 0.2, vLife) * smoothstep(1.0, 0.25, vLife);
        float flicker = 0.75 + 0.25 * hash(vSeed + floor(uTime * 5.0));
        fragColor = vec4(0.82, 0.91, 1.0, soft * fade * 0.17 * flicker);
      } else if (uKind < 2.5) {
        /* Mist: broad, low-contrast depth particles. */
        float soft = smoothstep(0.25, 0.0, d);
        float fade = smoothstep(0.0, 0.2, vLife) * smoothstep(1.0, 0.3, vLife);
        fragColor = vec4(0.72, 0.80, 0.86, soft * fade * (0.035 + uRain * 0.045));
      } else {
        /* Aircraft wake. */
        float soft = smoothstep(0.25, 0.0, d);
        float fade = smoothstep(0.0, 0.15, vLife) * smoothstep(1.0, 0.1, vLife);
        fragColor = vec4(0.88,0.93,0.96, soft * fade * 0.085);
      }
    }`);
} catch (e) {
  overlay.style.display = 'none';
  return;
}

const loc = {
  resolution: gl.getUniformLocation(prog, 'uResolution'),
  aspect: gl.getUniformLocation(prog, 'uAspect'),
  time: gl.getUniformLocation(prog, 'uTime'),
  fov: gl.getUniformLocation(prog, 'uFov'),
  kind: gl.getUniformLocation(prog, 'uKind'),
  rain: gl.getUniformLocation(prog, 'uRain'),
  storm: gl.getUniformLocation(prog, 'uStorm')
};

const quad = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, quad);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
  -1,-1, 1,-1, 1,1, -1,-1, 1,1, -1,1
]), gl.STATIC_DRAW);

function makeLayer(max) {
  const pos = new Float32Array(max * 3);
  const size = new Float32Array(max);
  const life = new Float32Array(max);
  const seed = new Float32Array(max);
  const posBuf = gl.createBuffer();
  const sizeBuf = gl.createBuffer();
  const lifeBuf = gl.createBuffer();
  const seedBuf = gl.createBuffer();

  for (let i=0;i<max;i++) {
    seed[i] = Math.random();
    life[i] = Math.random();
  }

  return { max, count: 0, pos, size, life, seed, posBuf, sizeBuf, lifeBuf, seedBuf };
}

const rain = makeLayer(MAX_RAIN);
const wind = makeLayer(MAX_WIND);
const mist = makeLayer(MAX_MIST);
const wake = makeLayer(MAX_WAKE);

function seedRain(layer) {
  for (let i=0;i<layer.max;i++) {
    const j=i*3;
    layer.pos[j] = (Math.random()-0.5) * 95;
    layer.pos[j+1] = (Math.random()-0.5) * 58;
    layer.pos[j+2] = 7 + Math.random() * 100;
    layer.size[i] = 2.0 + Math.random() * 4.0;
    layer.life[i] = Math.random();
  }
}
function seedWind(layer) {
  for (let i=0;i<layer.max;i++) {
    const j=i*3;
    layer.pos[j] = (Math.random()-0.5) * 115;
    layer.pos[j+1] = (Math.random()-0.5) * 62;
    layer.pos[j+2] = 8 + Math.random() * 120;
    layer.size[i] = 1.1 + Math.random() * 3.6;
    layer.life[i] = Math.random();
  }
}
function seedMist(layer) {
  for (let i=0;i<layer.max;i++) {
    const j=i*3;
    layer.pos[j] = (Math.random()-0.5) * 120;
    layer.pos[j+1] = (Math.random()-0.5) * 55;
    layer.pos[j+2] = 10 + Math.random() * 150;
    layer.size[i] = 8 + Math.random() * 18;
    layer.life[i] = Math.random();
  }
}
function seedWake(layer) {
  for (let i=0;i<layer.max;i++) {
    const j=i*3;
    layer.pos[j] = (Math.random()-0.5) * 26;
    layer.pos[j+1] = (Math.random()-0.5) * 10;
    layer.pos[j+2] = 8 + Math.random() * 65;
    layer.size[i] = 1 + Math.random() * 4;
    layer.life[i] = Math.random();
  }
}
seedRain(rain); seedWind(wind); seedMist(mist); seedWake(wake);

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 1.7);
  const w = Math.max(1, Math.floor(innerWidth * dpr));
  const h = Math.max(1, Math.floor(innerHeight * dpr));
  if (overlay.width !== w || overlay.height !== h) {
    overlay.width = w; overlay.height = h;
  }
}
window.addEventListener('resize', resize, { passive:true });
resize();

function updateLayer(layer, dt, speed, spreadX, spreadY, resetDepth) {
  for (let i=0;i<layer.max;i++) {
    const j=i*3;
    layer.life[i] -= dt * speed;
    if (layer.life[i] <= 0) {
      layer.life[i] = 1;
      layer.pos[j] = (Math.random()-0.5) * spreadX;
      layer.pos[j+1] = (Math.random()-0.5) * spreadY;
      layer.pos[j+2] = resetDepth();
    }
  }
}

let last=performance.now();
let raf=0;
function tick(now) {
  raf=requestAnimationFrame(tick);
  const dt=Math.min(0.033, Math.max(0.001,(now-last)/1000));
  last=now;

  resize();
  const wv=weather();
  const fl=flight();
  const windPower=Math.max(0.1, Number(wv.wind)||0.1);
  const rainPower=Math.max(0, Number(wv.rain)||0);
  const stormPower=Math.max(0, Number(wv.storm)||0);
  const planeSpeed=fl && fl.plane ? Math.max(20, Number(fl.plane.speed)||20) : 70;

  updateLayer(rain, dt, 0.16 + rainPower*0.58 + stormPower*0.22, 100, 64, () => 8+Math.random()*105);
  updateLayer(wind, dt, 0.12 + windPower*0.48 + planeSpeed/400, 125, 66, () => 8+Math.random()*125);
  updateLayer(mist, dt, 0.045 + rainPower*0.05, 130, 60, () => 12+Math.random()*160);
  updateLayer(wake, dt, 0.08 + planeSpeed/700, 34, 14, () => 10+Math.random()*75);

  const rainCount=Math.floor(MAX_RAIN*(rainPower*0.92 + stormPower*0.08));
  const windCount=Math.floor(MAX_WIND*(0.16 + windPower*0.62));
  const mistCount=Math.floor(MAX_MIST*(0.08 + rainPower*0.52 + stormPower*0.16));
  const wakeCount=Math.floor(MAX_WAKE*(0.10 + Math.min(1,planeSpeed/160)*0.48));

  gl.viewport(0,0,overlay.width,overlay.height);
  gl.disable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER,quad);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);
  gl.vertexAttribDivisor(0,0);

  gl.uniform2f(loc.resolution,overlay.width,overlay.height);
  gl.uniform1f(loc.aspect,overlay.width/overlay.height);
  gl.uniform1f(loc.time,now*0.001);
  gl.uniform1f(loc.fov,62);
  gl.uniform1f(loc.rain,rainPower);
  gl.uniform1f(loc.storm,stormPower);

  drawLayer(rain,rainCount,0);
  drawLayer(wind,windCount,1);
  drawLayer(mist,mistCount,2);
  drawLayer(wake,wakeCount,3);

  gl.disable(gl.BLEND);
}

function drawLayer(layer,count,kind) {
  if (count<=0) return;
  gl.uniform1f(loc.kind,kind);

  bindInstanced(1,layer.posBuf,layer.pos,3);
  bindInstanced(2,layer.sizeBuf,layer.size,1);
  bindInstanced(3,layer.lifeBuf,layer.life,1);
  bindInstanced(4,layer.seedBuf,layer.seed,1);

  gl.drawArraysInstanced(gl.TRIANGLES,0,6,count);
}
function bindInstanced(location,buffer,data,size) {
  gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
  gl.bufferData(gl.ARRAY_BUFFER,data,gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(location);
  gl.vertexAttribPointer(location,size,gl.FLOAT,false,0,0);
  gl.vertexAttribDivisor(location,1);
}

try {
  requestAnimationFrame(tick);
} catch (e) {
  overlay.style.display='none';
}

window.SkyCubeVFX = {
  canvas: overlay,
  setEnabled(v) { overlay.style.display = v ? '' : 'none'; },
  getEnabled() { return overlay.style.display !== 'none'; }
};
})();
