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
      body: [1.10, 0.95, 2.40],
      nose: [0.76, 0.65, 0.72],
      wingSpan: 6.60,
      wingChord: 1.20,
      tailSpan: 2.30
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
      body: [0.86, 0.76, 2.95],
      nose: [0.56, 0.50, 0.92],
      wingSpan: 7.90,
      wingChord: 0.82,
      tailSpan: 1.85
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
      body: [1.55, 1.22, 2.20],
      nose: [1.12, 0.88, 0.68],
      wingSpan: 8.30,
      wingChord: 1.45,
      tailSpan: 2.90
    }
  }
};

let gameMeshes = Object.create(null);
let preview = null;

function clamp(v, a, b) {
  return v < a ? a : (v > b ? b : v);
}

function pushBox(pos, nrm, col, idx, cx, cy, cz, sx, sy, sz, color) {
  const x0 = cx - sx * 0.5, x1 = cx + sx * 0.5;
  const y0 = cy - sy * 0.5, y1 = cy + sy * 0.5;
  const z0 = cz - sz * 0.5, z1 = cz + sz * 0.5;

  function quad(a, b, c, d, n) {
    const base = pos.length / 3;
    pos.push(
      a[0],a[1],a[2], b[0],b[1],b[2],
      c[0],c[1],c[2], d[0],d[1],d[2]
    );
    for (let i = 0; i < 4; i++) nrm.push(n[0], n[1], n[2]);
    for (let i = 0; i < 4; i++) col.push(color[0], color[1], color[2]);
    idx.push(base,base+1,base+2, base,base+2,base+3);
  }

  quad([x1,y0,z1],[x1,y0,z0],[x1,y1,z0],[x1,y1,z1], [ 1,0,0]);
  quad([x0,y0,z0],[x0,y0,z1],[x0,y1,z1],[x0,y1,z0], [-1,0,0]);
  quad([x0,y1,z1],[x1,y1,z1],[x1,y1,z0],[x0,y1,z0], [0,1,0]);
  quad([x0,y0,z0],[x1,y0,z0],[x1,y0,z1],[x0,y0,z1], [0,-1,0]);
  quad([x1,y0,z0],[x0,y0,z0],[x0,y1,z0],[x1,y1,z0], [0,0,-1]);
  quad([x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1], [0,0,1]);
}

function buildGeometry(def) {
  const p = [], n = [], c = [], i = [];
  const s = def.shape;

  // White/light paint areas are deliberately neutral so the shop colour
  // tint can recolour the aircraft without destroying the glass/highlights.
  const BODY = [0.96,0.96,0.96];
  const WING = [0.82,0.85,0.89];
  const GLASS = [0.18,0.38,0.56];
  const DARK = [0.16,0.18,0.21];
  const ACCENT = [0.94,0.94,0.94];

  pushBox(p,n,c,i, 0,0,0, s.body[0],s.body[1],s.body[2], BODY);
  pushBox(p,n,c,i, 0,0,-1.55, s.nose[0],s.nose[1],s.nose[2], BODY);

  const canopyZ = def.id === 'swift' ? -0.20 : 0.05;
  pushBox(p,n,c,i, 0,s.body[1]*0.62,canopyZ,
          s.body[0]*0.62, s.body[1]*0.30, s.body[2]*0.36, GLASS);

  pushBox(p,n,c,i, 0,0.04,0, s.wingSpan,0.18,s.wingChord, WING);

  const tip = s.wingSpan * 0.5 - 0.32;
  pushBox(p,n,c,i, -tip,0.04,0, 0.62,0.28,s.wingChord*0.80, ACCENT);
  pushBox(p,n,c,i,  tip,0.04,0, 0.62,0.28,s.wingChord*0.80, ACCENT);

  pushBox(p,n,c,i, 0,s.body[1]*0.74,1.02, 0.16,s.body[1]*0.95,0.72, BODY);
  pushBox(p,n,c,i, 0,0.20,1.12, s.tailSpan,0.14,0.62, WING);

  // Underside strakes give the larger aircraft a visibly different silhouette.
  if (def.id === 'hauler') {
    pushBox(p,n,c,i, -0.62,-0.34,0.10, 0.32,0.26,1.20, DARK);
    pushBox(p,n,c,i,  0.62,-0.34,0.10, 0.32,0.26,1.20, DARK);
  }

  if (def.id === 'swift') {
    pushBox(p,n,c,i, 0,0.10,-1.15, 0.48,0.34,0.70, DARK);
  }

  return {
    pos: new Float32Array(p),
    nrm: new Float32Array(n),
    col: new Float32Array(c),
    idx: new Uint16Array(i)
  };
}

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
  o.fill(0); o[0]=o[5]=o[10]=o[15]=1; return o;
}
function m4Mul(out,a,b) {
  const t = new Float32Array(16);
  for (let c=0;c<4;c++) for (let r=0;r<4;r++)
    t[c*4+r] =
      a[0*4+r]*b[c*4+0] + a[1*4+r]*b[c*4+1] +
      a[2*4+r]*b[c*4+2] + a[3*4+r]*b[c*4+3];
  out.set(t); return out;
}
function m4Perspective(out,fovy,aspect,near,far) {
  const f=1/Math.tan(fovy*0.5), nf=1/(near-far);
  out.fill(0);
  out[0]=f/aspect; out[5]=f;
  out[10]=(far+near)*nf; out[11]=-1;
  out[14]=(2*far*near)*nf;
  return out;
}
function m4LookAt(out,eye,center,up) {
  let zx=eye[0]-center[0], zy=eye[1]-center[1], zz=eye[2]-center[2];
  let l=Math.hypot(zx,zy,zz)||1; zx/=l;zy/=l;zz/=l;
  let xx=up[1]*zz-up[2]*zy, xy=up[2]*zx-up[0]*zz, xz=up[0]*zy-up[1]*zx;
  l=Math.hypot(xx,xy,xz)||1; xx/=l;xy/=l;xz/=l;
  const yx=zy*xz-zz*xy, yy=zz*xx-zx*xz, yz=zx*xy-zy*xx;
  out.fill(0);
  out[0]=xx;out[1]=yx;out[2]=zx;
  out[4]=xy;out[5]=yy;out[6]=zy;
  out[8]=xz;out[9]=yz;out[10]=zz;
  out[12]=-(xx*eye[0]+xy*eye[1]+xz*eye[2]);
  out[13]=-(yx*eye[0]+yy*eye[1]+yz*eye[2]);
  out[14]=-(zx*eye[0]+zy*eye[1]+zz*eye[2]);
  out[15]=1;
  return out;
}
function compile(gl, type, source) {
  const s=gl.createShader(type);
  gl.shaderSource(s,source); gl.compileShader(s);
  if (!gl.getShaderParameter(s,gl.COMPILE_STATUS)) {
    throw new Error('Plane preview shader: '+gl.getShaderInfoLog(s));
  }
  return s;
}
function program(gl, vs, fs) {
  const p=gl.createProgram();
  gl.attachShader(p,compile(gl,gl.VERTEX_SHADER,vs));
  gl.attachShader(p,compile(gl,gl.FRAGMENT_SHADER,fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p,gl.LINK_STATUS))
    throw new Error('Plane preview program: '+gl.getProgramInfoLog(p));
  return p;
}
function previewMesh(gl, g) {
  const vao=gl.createVertexArray();
  gl.bindVertexArray(vao);
  function attr(loc,data,size) {
    const b=gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER,b);
    gl.bufferData(gl.ARRAY_BUFFER,data,gl.STATIC_DRAW);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc,size,gl.FLOAT,false,0,0);
  }
  attr(0,g.pos,3); attr(1,g.nrm,3); attr(2,g.col,3);
  const ib=gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,ib);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,g.idx,gl.STATIC_DRAW);
  gl.bindVertexArray(null);
  return {vao,ib,count:g.idx.length};
}
function hexRgb(hex) {
  const h=String(hex||'#e53b2f').replace('#','');
  const n=parseInt(h.length===3?h.split('').map(x=>x+x).join(''):h,16);
  return [
    ((n>>16)&255)/255,
    ((n>>8)&255)/255,
    (n&255)/255
  ];
}

function initPreview(canvas) {
  if (!canvas) return;
  let gl;
  try {
    gl=canvas.getContext('webgl2',{alpha:true,antialias:true,premultipliedAlpha:false});
  } catch (e) { gl=null; }
  if (!gl) return;

  const prog=program(gl,`#version 300 es
    precision highp float;
    layout(location=0) in vec3 aPos;
    layout(location=1) in vec3 aNrm;
    layout(location=2) in vec3 aCol;
    uniform mat4 uVP,uModel;
    out vec3 vN,vC;
    void main(){
      vN=mat3(uModel)*aNrm;
      vC=aCol;
      gl_Position=uVP*uModel*vec4(aPos,1.0);
    }`,
    `#version 300 es
    precision highp float;
    in vec3 vN,vC;
    uniform vec3 uTint;
    out vec4 fragColor;
    void main(){
      vec3 n=normalize(vN);
      vec3 light=normalize(vec3(-0.45,0.80,0.55));
      float ndl=max(dot(n,light),0.0);
      vec3 albedo=mix(vC,vC*uTint,0.84);
      vec3 col=albedo*(vec3(0.34,0.38,0.48)+vec3(1.0,0.91,0.76)*ndl*1.15);
      vec3 view=normalize(vec3(0.35,0.35,1.0));
      col+=vec3(1.0)*pow(max(dot(reflect(-light,n),view),0.0),52.0)*0.28;
      fragColor=vec4(col,1.0);
    }`);

  const meshes=Object.create(null);
  for (const id of Object.keys(PLANE_DEFS)) meshes[id]=previewMesh(gl,buildGeometry(PLANE_DEFS[id]));

  const vp=m4(), proj=m4(), view=m4(), model=m4();
  preview={canvas,gl,prog,meshes,vp,proj,view,model,locs:{
    vp:gl.getUniformLocation(prog,'uVP'),
    model:gl.getUniformLocation(prog,'uModel'),
    tint:gl.getUniformLocation(prog,'uTint')
  }};

  resizePreview();
}

function resizePreview() {
  if (!preview) return;
  const c=preview.canvas, d=Math.min(window.devicePixelRatio||1,2);
  const w=Math.max(1,Math.floor(c.clientWidth*d)), h=Math.max(1,Math.floor(c.clientHeight*d));
  if(c.width!==w||c.height!==h){c.width=w;c.height=h;}
}

function renderPreview(time,id,color) {
  if(!preview) return;
  resizePreview();
  const {gl,canvas}=preview;
  const mesh=preview.meshes[id]||preview.meshes.starter;
  if(!mesh) return;
  const aspect=canvas.width/Math.max(1,canvas.height);
  m4Perspective(preview.proj,42*Math.PI/180,aspect,0.1,100);
  m4LookAt(preview.view,[0,3.1,14],[0,0,0],[0,1,0]);
  m4Mul(preview.vp,preview.proj,preview.view);

  const a=time*0.00065;
  const ca=Math.cos(a),sa=Math.sin(a);
  const tilt=Math.sin(time*0.00035)*0.10;
  const rx=Math.cos(tilt),sx=Math.sin(tilt);
  // Model = Y rotation followed by a gentle X tilt.
  m4Identity(preview.model);
  preview.model[0]=ca;
  preview.model[1]=sx*sa;
  preview.model[2]=rx*sa;
  preview.model[4]=0;
  preview.model[5]=rx;
  preview.model[6]=-sx;
  preview.model[8]=-sa;
  preview.model[9]=sx*ca;
  preview.model[10]=rx*ca;

  gl.viewport(0,0,canvas.width,canvas.height);
  gl.clearColor(0,0,0,0);
  gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
  gl.enable(gl.DEPTH_TEST); gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK);
  gl.useProgram(preview.prog);
  gl.uniformMatrix4fv(preview.locs.vp,false,preview.vp);
  gl.uniformMatrix4fv(preview.locs.model,false,preview.model);
  gl.uniform3fv(preview.locs.tint,hexRgb(color));
  gl.bindVertexArray(mesh.vao);
  gl.drawElements(gl.TRIANGLES,mesh.count,gl.UNSIGNED_SHORT,0);
  gl.bindVertexArray(null);
}

global.PlaneModels={
  defs: PLANE_DEFS,
  initGame,
  get,
  getGameMesh,
  initPreview,
  renderPreview,
  resizePreview
};
})(window);
