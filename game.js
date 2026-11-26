(function(){
'use strict';
const $ = id => document.getElementById(id);
const RULES = window.RCRULES;                 // shared with the server: prices, missions, run limits
const ON = window.RCOnline;                   // online layer (online.js); works offline when not configured

// ---------- constants ----------
const LANE_W = 3.2, LANES = [-LANE_W, 0, LANE_W];
const G = 24;                 // gravity m/s²
const SPAWN_Z = -135;
const START_SPEED = 14, MAX_SPEED = 31;
const TRUCK_HW = 0.44, TRUCK_HL = 0.56;
const STEP = 0.32;            // how much higher a surface may be and still be climbed / landed on
const ROAD_LEN = 420, TILE = 12;

const rand = (a,b) => a + Math.random()*(b-a);
const pick = arr => arr[(Math.random()*arr.length)|0];
const shuffle = a => { for(let i=a.length-1;i>0;i--){const j=(Math.random()*(i+1))|0;[a[i],a[j]]=[a[j],a[i]];} return a; };
const clamp = (v,a,b) => Math.max(a, Math.min(b, v));

// ---------- renderer / scene ----------
const stage = $('stage');
const renderer = new THREE.WebGLRenderer({antialias:true, alpha:true, powerPreference:'high-performance'});
renderer.setPixelRatio(Math.min(window.devicePixelRatio||1, 2));
renderer.setClearColor(0x000000, 0);

renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
stage.appendChild(renderer.domElement);
renderer.domElement.tabIndex = 0;

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xf3c39a, 45, 150);
const camera = new THREE.PerspectiveCamera(62, 1, 0.1, 400);
let baseFov = 62, portrait = false;

const hemi = new THREE.HemisphereLight(0xe6eeff, 0x7a6650, 1.25); scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffe0b5, 1.6);
sun.castShadow = true;
sun.shadow.mapSize.set(1024,1024);
Object.assign(sun.shadow.camera, {left:-13,right:13,top:16,bottom:-16,near:1,far:60});
sun.shadow.bias = -0.0008;
scene.add(sun); scene.add(sun.target);

const maxAniso = renderer.capabilities.getMaxAnisotropy();
function canvasTex(w,h,draw,rx=1,ry=1){
  const c = document.createElement('canvas'); c.width=w; c.height=h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);

  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(rx,ry); t.anisotropy = maxAniso;
  return t;
}
function noise(g,w,h,n,base,spread,alpha){
  for(let i=0;i<n;i++){ const v=(base+Math.random()*spread)|0; g.fillStyle=`rgba(${v},${v},${v},${alpha})`; g.fillRect(Math.random()*w, Math.random()*h, 2, 2); }
}

// ---------- materials ----------
const matCache = {};
function mat(color, o={}){
  const k = color + JSON.stringify(o);
  return matCache[k] || (matCache[k] = new THREE.MeshStandardMaterial(Object.assign({color, roughness:0.6, metalness:0.1}, o)));
}
const stripeTex = (a,b,rot) => canvasTex(64,64,(g,w,h)=>{
  g.fillStyle=b; g.fillRect(0,0,w,h); g.fillStyle=a;
  g.save(); g.translate(w/2,h/2); g.rotate(rot); g.translate(-w,-h);
  for(let x=0;x<w*2;x+=32) g.fillRect(x,0,16,h*2);
  g.restore();
});
const rampMat = new THREE.MeshStandardMaterial({map:stripeTex('#ffc21a','#151515',Math.PI/4), roughness:0.7});
rampMat.map.repeat.set(3,2);
const bumpMat = new THREE.MeshStandardMaterial({map:stripeTex('#ffc21a','#151515',0), roughness:0.8});
bumpMat.map.repeat.set(4,1);
const barrierMat = new THREE.MeshStandardMaterial({map:stripeTex('#e43b2c','#f4f1ea',Math.PI/4), roughness:0.6});
barrierMat.map.repeat.set(4,1);
const tireMat = mat('#1a1a1c',{roughness:0.95});
const tailMat = mat('#ff2a1a',{emissive:'#ff1a0a', emissiveIntensity:0.9});
const glassMat = mat('#1e2833',{roughness:0.15, metalness:0.5});
const darkMat = mat('#2a2c31',{roughness:0.8});
const chromeMat = mat('#c9ccd2',{roughness:0.25, metalness:0.9});

// ---------- road & sidewalks ----------
const roadTex = canvasTex(256,256,(g,w,h)=>{
  g.fillStyle='#3b3d43'; g.fillRect(0,0,w,h);
  noise(g,w,h,1600,40,40,0.55);
  g.fillStyle='#e9e6dc'; g.fillRect(5,0,6,h); g.fillRect(w-11,0,6,h);
  g.fillStyle='#f1efe6'; [w/3, 2*w/3].forEach(x=>g.fillRect(x-3,30,6,110));
}, 1, ROAD_LEN/TILE);
const road = new THREE.Mesh(new THREE.PlaneGeometry(LANE_W*3, ROAD_LEN), new THREE.MeshStandardMaterial({map:roadTex, roughness:0.95}));
road.rotation.x = -Math.PI/2; road.position.set(0,0,20-ROAD_LEN/2); road.receiveShadow = true; scene.add(road);

for(const s of [-1,1]){
  const curb = new THREE.Mesh(new THREE.BoxGeometry(0.25,0.18,ROAD_LEN), mat('#d2ccc0',{roughness:0.85}));
  curb.position.set(s*4.925, 0.09, 20-ROAD_LEN/2); curb.receiveShadow=true; scene.add(curb);
}
const ground = new THREE.Mesh(new THREE.PlaneGeometry(320, ROAD_LEN), mat('#7d776d',{roughness:1}));
ground.rotation.x = -Math.PI/2; ground.position.set(0,-0.03,20-ROAD_LEN/2); scene.add(ground);

// ---------- the RC monster truck ----------
const hazardMat = mat('#ffc21a',{roughness:0.4});
// Four models. All share the same size and hitbox, so the choice is about style, not stats.
const TRUCKS = [
  {id:'blaze',   name:'Blaze',        tag:'Classic pickup',  shell:'#ff5a1f', accent:'#ffc21a', desc:'Bright orange street brawler with a yellow race stripe and a roll bar.'},
  {id:'bulldog', name:'Bulldog',      tag:'Off-road 4×4',     shell:'#5d6b3a', accent:'#c9ccd2', desc:'Boxy army-green SUV with a chrome bull bar, roof lights and a spare wheel.'},
  {id:'shark',   name:'Shark',        tag:'Fin-topped racer', shell:'#1e78d6', accent:'#f4f1ea', desc:'Ocean-blue body, white belly, a dorsal fin and a mouth full of teeth.'},
  {id:'howler',  name:'Night Howler', tag:'Neon stunt rig',   shell:'#1b1c22', accent:'#a64dff', desc:'Matte black with purple underglow, chrome exhaust stacks and a rear wing.'},
];
const tTireGeo = new THREE.CylinderGeometry(0.24,0.24,0.2,18); tTireGeo.rotateZ(Math.PI/2);
const tHubGeo = new THREE.CylinderGeometry(0.11,0.11,0.21,10); tHubGeo.rotateZ(Math.PI/2);
const treadGeo = new THREE.BoxGeometry(0.21,0.05,0.07);
const headMat = mat('#fffbe8',{emissive:'#fff1b0',emissiveIntensity:1});
const teethTex = canvasTex(128,32,(g,w,h)=>{
  g.fillStyle='#14161b'; g.fillRect(0,0,w,h); g.fillStyle='#f4f1ea';
  for(let x=0;x<w;x+=16){ g.beginPath(); g.moveTo(x,0); g.lineTo(x+16,0); g.lineTo(x+8,h*0.55); g.fill(); g.beginPath(); g.moveTo(x+8,h); g.lineTo(x+24,h); g.lineTo(x+16,h*0.45); g.fill(); }
});
function buildTruck(id, lite=false){
  const def = TRUCKS.find(t=>t.id===id) || TRUCKS[0];
  const rig = new THREE.Group(), body = new THREE.Group(); rig.add(body);
  const shellM = id==='howler' ? mat(def.shell,{roughness:0.85, metalness:0.05}) : mat(def.shell,{roughness:0.35, metalness:0.25});
  const accM = id==='howler' ? mat(def.accent,{emissive:def.accent, emissiveIntensity:1.2})
             : id==='bulldog' ? chromeMat : mat(def.accent,{roughness:0.4});
  const b = (w,h,d,m,x,y,z,p=body)=>{ const o=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),m); o.position.set(x,y,z); o.castShadow=true; p.add(o); return o; };
  b(0.52,0.07,0.95,darkMat,0,0.3,0,rig);                 // chassis
  let antY = 0.6, antZ = 0.46;
  if(id==='bulldog'){
    b(0.88,0.2,1.12,shellM,0,0.53,0);
    b(0.8,0.2,0.86,glassMat,0,0.73,0.08);
    b(0.84,0.05,0.9,shellM,0,0.855,0.08);
    b(0.72,0.05,0.05,accM,0,0.47,-0.61); b(0.72,0.05,0.05,accM,0,0.6,-0.61);
    b(0.05,0.18,0.05,accM,-0.3,0.53,-0.61); b(0.05,0.18,0.05,accM,0.3,0.53,-0.61);
    b(0.62,0.06,0.08,darkMat,0,0.91,-0.22);
    for(const x of [-0.22,-0.075,0.075,0.22]) b(0.1,0.06,0.03,headMat,x,0.91,-0.27);
    const spare = new THREE.Mesh(new THREE.CylinderGeometry(0.17,0.17,0.08,14), tireMat); spare.rotation.x=Math.PI/2; spare.position.set(0,0.62,0.6); spare.castShadow=true; body.add(spare);
    antY = 0.88; antZ = 0.4;
  } else if(id==='shark'){
    b(0.86,0.17,1.12,shellM,0,0.52,0);
    b(0.88,0.06,1.04,accM,0,0.445,0);
    b(0.66,0.16,0.5,glassMat,0,0.68,0.02);
    b(0.7,0.04,0.52,shellM,0,0.78,0.02);
    const fs = new THREE.Shape(); fs.moveTo(0,0); fs.lineTo(0.36,0); fs.quadraticCurveTo(0.12,0.08,-0.02,0.3); fs.lineTo(0,0);
    const fin = new THREE.Mesh(new THREE.ExtrudeGeometry(fs,{depth:0.04, bevelEnabled:false}), shellM);
    fin.rotation.y = Math.PI/2; fin.position.set(-0.02,0.8,0.24); fin.castShadow=true; body.add(fin);
    const mouth = new THREE.Mesh(new THREE.PlaneGeometry(0.62,0.12), new THREE.MeshStandardMaterial({map:teethTex, roughness:0.5}));
    mouth.position.set(0,0.5,-0.562); mouth.rotation.y = Math.PI; body.add(mouth);
    for(const x of [-0.3,0.3]){ b(0.07,0.07,0.02,mat('#f4f1ea'),x,0.62,-0.552); b(0.035,0.035,0.02,darkMat,x,0.62,-0.562); }
  } else if(id==='howler'){
    b(0.86,0.16,1.1,shellM,0,0.52,0);
    b(0.9,0.025,1.0,accM,0,0.42,0);                     // underglow
    b(0.68,0.16,0.42,glassMat,0,0.68,-0.02);
    b(0.72,0.04,0.46,shellM,0,0.78,-0.02);
    for(const x of [-0.2,0.2]){ const st=new THREE.Mesh(new THREE.CylinderGeometry(0.035,0.04,0.34,10), chromeMat); st.position.set(x,0.76,0.28); st.castShadow=true; body.add(st); }
    b(0.04,0.14,0.04,darkMat,-0.3,0.67,0.52); b(0.04,0.14,0.04,darkMat,0.3,0.67,0.52);
    b(0.86,0.03,0.18,shellM,0,0.75,0.54);
    b(0.86,0.012,0.03,accM,0,0.768,0.62);
    antZ = 0.4;
  } else {
    b(0.86,0.17,1.1,shellM,0,0.52,0);
    b(0.88,0.035,1.02,accM,0,0.46,0);
    b(0.7,0.17,0.46,glassMat,0,0.69,0.04);
    b(0.74,0.04,0.5,shellM,0,0.79,0.04);
    b(0.06,0.18,0.06,darkMat,-0.32,0.69,0.42); b(0.06,0.18,0.06,darkMat,0.32,0.69,0.42); b(0.7,0.05,0.06,darkMat,0,0.78,0.42);
  }
  b(0.18,0.07,0.03,headMat,-0.24,0.55,-0.565); b(0.18,0.07,0.03,headMat,0.24,0.55,-0.565);
  b(0.16,0.06,0.03,tailMat,-0.28,0.55,0.565); b(0.16,0.06,0.03,tailMat,0.28,0.55,0.565);
  // antenna: the RC tell
  const antenna = new THREE.Group(); antenna.position.set(0.3,antY,antZ); body.add(antenna);
  { const a=new THREE.Mesh(new THREE.CylinderGeometry(0.008,0.012,0.62,5), darkMat); a.position.y=0.31; antenna.add(a);
    const tip=new THREE.Mesh(new THREE.SphereGeometry(0.03,8,6), mat('#ff2a1a')); tip.position.y=0.63; antenna.add(tip); antenna.rotation.x=0.35; }
  const hubM = id==='howler' ? accM : id==='bulldog' ? chromeMat : id==='shark' ? mat('#f4f1ea') : hazardMat;
  const wheels = [];
  for(const x of [-0.43,0.43]) for(const z of [-0.37,0.37]){
    const w = new THREE.Group(); w.position.set(x,0.24,z);
    const t = new THREE.Mesh(tTireGeo,tireMat); t.castShadow=true; w.add(t);
    w.add(new THREE.Mesh(tHubGeo,hubM));
    if(!lite) for(let k=0;k<8;k++){ const tr=new THREE.Mesh(treadGeo,tireMat); const a=k/8*Math.PI*2; tr.position.set(0,Math.cos(a)*0.235,Math.sin(a)*0.235); tr.rotation.x=-a; w.add(tr); }
    rig.add(w); wheels.push(w);
    const sh = new THREE.Mesh(new THREE.CylinderGeometry(0.025,0.025,0.3,6), id==='blaze'?hazardMat:accM); sh.position.set(x*0.7,0.42,z); sh.rotation.z = -Math.sign(x)*0.5; rig.add(sh);
  }
  return {rig, body, wheels, antenna, def};
}
const truck = new THREE.Group(); scene.add(truck);
let tBody, tWheels, antenna, rigNow = null;
let truckId = null;
try{ truckId = localStorage.getItem('rc-rampage-truck'); }catch(e){}
if(!TRUCKS.some(t=>t.id===truckId)) truckId = null;
const rigCache = {};
function setTruckModel(id){
  if(rigNow) truck.remove(rigNow.rig);
  rigNow = rigCache[id] || (rigCache[id] = buildTruck(id));
  truck.add(rigNow.rig);
  tBody = rigNow.body; tWheels = rigNow.wheels; antenna = rigNow.antenna;
}
setTruckModel(truckId || 'blaze');

// ---------- roadside themes, streamed in 20 m chunks ----------
// Each chunk is built for the theme that is active when it appears at the horizon,
// so a theme change rolls in from the distance. Every geometry here is shared.
const CHUNK = 20, SCN_FAR = -300, SCN_NEAR = 35;
const THEMES = {
  city:   'ENTERING DOWNTOWN',
  farm:   'ENTERING FARMLAND',
  suburb: 'ENTERING THE SUBURBS',
  show:   'MONSTER TRUCK SHOW',
};
const unitBox = new THREE.BoxGeometry(1,1,1);
const unitPlane = new THREE.PlaneGeometry(1,1);
const prismGeo = (()=>{ const s=new THREE.Shape(); s.moveTo(-0.5,0); s.lineTo(0.5,0); s.lineTo(0,1); s.lineTo(-0.5,0);
  const g=new THREE.ExtrudeGeometry(s,{depth:1,bevelEnabled:false}); g.translate(0,0,-0.5); return g; })();
function box(g,m,sx,sy,sz,x,y,z,shadow=true){ const o=new THREE.Mesh(unitBox,m); o.scale.set(sx,sy,sz); o.position.set(x,y,z); o.castShadow=shadow; o.receiveShadow=true; g.add(o); return o; }
function flat(g,m,x0,x1,y){ const o=new THREE.Mesh(unitPlane,m); o.rotation.x=-Math.PI/2; o.scale.set(Math.abs(x1-x0),CHUNK,1); o.position.set((x0+x1)/2,y,0); o.receiveShadow=true; g.add(o); return o; }
const std = (o)=>new THREE.MeshStandardMaterial(Object.assign({roughness:0.95},o));

// textures
const walkMat = std({map:canvasTex(128,128,(g,w,h)=>{ g.fillStyle='#bdb6aa'; g.fillRect(0,0,w,h); noise(g,w,h,500,150,60,0.4);
  g.fillStyle='#9a9387'; g.fillRect(0,0,w,3); g.fillRect(0,0,3,h); g.fillRect(w/2,0,2,h); }, 1.2, CHUNK/3)});
const grassTexFn = (rx,ry,base='#6c9a45') => canvasTex(64,64,(g,w,h)=>{ g.fillStyle=base; g.fillRect(0,0,w,h);
  for(let i=0;i<260;i++){ g.fillStyle=Math.random()<0.5?'rgba(40,80,20,.35)':'rgba(170,210,110,.3)'; g.fillRect(Math.random()*w,Math.random()*h,2,3); } }, rx, ry);
const grassShoulder = std({map:grassTexFn(1.5,8)});
const grassGround = std({map:grassTexFn(12,4)});
const lawnGround = std({map:grassTexFn(12,4,'#79ab4c')});
const soilGround = std({map:canvasTex(64,64,(g,w,h)=>{ g.fillStyle='#7a5a3a'; g.fillRect(0,0,w,h); noise(g,w,h,300,60,60,0.35);
  g.fillStyle='rgba(50,32,18,.45)'; for(let x=0;x<w;x+=8) g.fillRect(x,0,3,h); }, 12, 4)});
const dirtTexFn = (rx,ry) => canvasTex(64,64,(g,w,h)=>{ g.fillStyle='#8f6a44'; g.fillRect(0,0,w,h); noise(g,w,h,400,70,70,0.4);
  for(let i=0;i<6;i++){ g.fillStyle='rgba(60,40,22,.25)'; g.fillRect(0,Math.random()*h,w,3); } }, rx, ry);
const dirtShoulder = std({map:dirtTexFn(1.5,8)});
const dirtGround = std({map:dirtTexFn(12,4)});
const cityGround = mat('#77716a',{roughness:1});
const cornMat = std({map:canvasTex(64,64,(g,w,h)=>{ g.fillStyle='#365f24'; g.fillRect(0,0,w,h);
  for(let x=2;x<w;x+=6){ g.fillStyle='#6fa043'; g.fillRect(x,8,2,h-8); g.fillStyle='#8cbd52'; g.fillRect(x-2,20+((x*7)%20),5,2); }
  g.fillStyle='#d9c25a'; for(let x=0;x<w;x+=6) g.fillRect(x,0,3,9); }, 12, 1)});
const fenceTexMat = (draw, rx) => { const m = std({map:canvasTex(128,32,draw,rx,1), transparent:true, alphaTest:0.5, side:THREE.DoubleSide}); return m; };
const woodFence = fenceTexMat((g,w,h)=>{ g.clearRect(0,0,w,h); g.fillStyle='#7b5a3c'; g.fillRect(0,6,w,4); g.fillRect(0,18,w,4); g.fillRect(2,2,6,h-2); g.fillRect(66,2,6,h-2); }, 8);
const picketFence = fenceTexMat((g,w,h)=>{ g.clearRect(0,0,w,h); g.fillStyle='#f6f3ec'; g.fillRect(0,12,w,3); g.fillRect(0,24,w,3);
  for(let x=2;x<w;x+=12){ g.beginPath(); g.moveTo(x,6); g.lineTo(x+3,1); g.lineTo(x+6,6); g.lineTo(x+6,h); g.lineTo(x,h); g.fill(); } }, 10);
function fence(g,m,x,h){ const o=new THREE.Mesh(unitPlane,m); o.rotation.y=Math.PI/2; o.scale.set(CHUNK,h,1); o.position.set(x,h/2+0.18,0); g.add(o); return o; }

// --- city ---
const BCOLORS = ['#c9b79c','#9fa8b5','#b98a6e','#d7cbb6','#7f8fa3','#a7765c','#cfd2d6','#8e9a86'];
const buildingProtos = [];
for(let i=0;i<14;i++){
  const w=rand(6,11), h=rand(7,30), d=10, base=pick(BCOLORS);
  const floors=Math.max(2,Math.round(h/3.2)), cols=Math.max(2,Math.round(w/2.3));
  const tex = canvasTex(cols*16, floors*16, (g,cw,ch)=>{ g.fillStyle=base; g.fillRect(0,0,cw,ch);
    for(let f=0;f<floors;f++) for(let c=0;c<cols;c++){ g.fillStyle = Math.random()<0.22 ? '#ffd98a' : (Math.random()<0.5?'#2c3442':'#3a4658'); g.fillRect(c*16+4, f*16+4, 8, 9); }
    g.fillStyle='rgba(0,0,0,.18)'; g.fillRect(0,ch-12,cw,12); });
  buildingProtos.push({w,h,d, geo:new THREE.BoxGeometry(d,h,w), mat:new THREE.MeshStandardMaterial({map:tex, roughness:0.9})});
}
const postMat = mat('#4a4f5a',{metalness:0.5,roughness:0.5});
const lampHeadMat = mat('#fff4d6',{emissive:'#ffdc8a',emissiveIntensity:0.8});
const leafMats = [mat('#5f8a3e',{roughness:0.9,flatShading:true}), mat('#6f9a45',{roughness:0.9,flatShading:true}), mat('#4f7a34',{roughness:0.9,flatShading:true})];
const trunkMat = mat('#6b4a32',{roughness:1});
const crownGeo = new THREE.IcosahedronGeometry(1.25,0);
const trunkGeo = new THREE.CylinderGeometry(0.12,0.16,1.8,6);
const lampPostGeo = new THREE.CylinderGeometry(0.07,0.09,5.2,8);
function tree(g,x,z,s=1){ const t=new THREE.Group(); const tr=new THREE.Mesh(trunkGeo,trunkMat); tr.position.y=0.9; t.add(tr);
  const c=new THREE.Mesh(crownGeo,pick(leafMats)); c.position.y=2.5; c.scale.set(1,1.15,1); c.castShadow=true; t.add(c);
  t.scale.setScalar(s); t.position.set(x,0.18,z); t.rotation.y=rand(0,6); g.add(t); }
function lamp(g,s,z){ const l=new THREE.Group(); const p=new THREE.Mesh(lampPostGeo,postMat); p.position.y=2.6; l.add(p);
  box(l,postMat,1.4,0.08,0.08,-s*0.7,5.15,0,false); box(l,lampHeadMat,0.5,0.12,0.25,-s*1.35,5.08,0,false);
  l.position.set(s*5.4,0.18,z); g.add(l); }
function buildCity(g,s){
  flat(g,walkMat,s*4.8,s*8.6,0.18); flat(g,cityGround,s*8.6,s*60,0.02);
  let z = CHUNK/2;
  while(z > -CHUNK/2){
    const p = pick(buildingProtos);
    const m = new THREE.Mesh(p.geo,p.mat); m.position.set(s*(9.2+p.d/2+rand(0,1.2)), p.h/2, z-p.w/2); m.receiveShadow=true; g.add(m);
    z -= p.w + rand(0.3,1.8);
  }
  lamp(g,s,s>0?-5:5); tree(g,s*7.4,s>0?5:-5);
}

// --- farm ---
const cowMat = std({map:canvasTex(64,32,(g,w,h)=>{ g.fillStyle='#f3f0e8'; g.fillRect(0,0,w,h); g.fillStyle='#1d1d1f';
  for(let i=0;i<7;i++){ g.beginPath(); g.ellipse(Math.random()*w,Math.random()*h,rand(4,9),rand(3,6),rand(0,3),0,Math.PI*2); g.fill(); } }), roughness:0.85});
const pinkMat = mat('#e8a5a0',{roughness:0.8});
const hoofMat = mat('#2a2522',{roughness:0.9});
function makeCow(){ const a=new THREE.Group();
  box(a,cowMat,1.6,0.75,0.72,0,0.95,0); box(a,cowMat,0.45,0.42,0.4,0.98,1.18,0); box(a,pinkMat,0.14,0.22,0.32,1.24,1.08,0);
  box(a,mat('#d8cfb8'),0.06,0.12,0.06,0.9,1.43,0.16,false); box(a,mat('#d8cfb8'),0.06,0.12,0.06,0.9,1.43,-0.16,false);
  for(const x of [-0.6,0.6]) for(const z of [-0.24,0.24]){ box(a,cowMat,0.15,0.6,0.15,x,0.3,z); box(a,hoofMat,0.16,0.1,0.16,x,0.05,z,false); }
  box(a,pinkMat,0.3,0.12,0.3,-0.25,0.55,0,false); box(a,cowMat,0.05,0.6,0.05,-0.82,0.75,0,false);
  return a; }
function makeHorse(color, mane){ const a=new THREE.Group(); const c=mat(color,{roughness:0.7}), m=mat(mane,{roughness:0.9});
  box(a,c,1.7,0.66,0.55,0,1.3,0);
  const neck=box(a,c,0.34,0.9,0.3,0.86,1.75,0); neck.rotation.z=-0.55;
  const head=box(a,c,0.62,0.26,0.26,1.28,2.06,0); head.rotation.z=-0.45;
  const mn=box(a,m,0.1,0.85,0.12,0.72,1.85,0,false); mn.rotation.z=-0.55;
  for(const x of [-0.65,0.65]) for(const z of [-0.18,0.18]){ box(a,c,0.13,1.0,0.13,x,0.5,z); box(a,hoofMat,0.15,0.08,0.15,x,0.04,z,false); }
  const tail=box(a,m,0.1,0.75,0.12,-0.92,1.05,0,false); tail.rotation.z=0.35;
  return a; }
const animalProtos = { cow:makeCow(), horseBrown:makeHorse('#7a4a26','#2a1a10'), horseBlack:makeHorse('#262321','#111'), horseWhite:makeHorse('#e9e4da','#bdb5a6') };
const hayGeo = new THREE.CylinderGeometry(0.6,0.6,1.2,14); const hayMat = mat('#d9b860',{roughness:1});
const barnRed = mat('#a8322a',{roughness:0.85}), barnTrim = mat('#f4f1ea',{roughness:0.7}), roofGrey = mat('#4a4f5a',{roughness:0.8});
const siloGeo = new THREE.CylinderGeometry(1.6,1.6,9,16), domeGeo = new THREE.SphereGeometry(1.6,16,8,0,Math.PI*2,0,Math.PI/2);
function buildFarm(g,s){
  flat(g,grassShoulder,s*4.8,s*8.6,0.18);
  fence(g,woodFence,s*8.8,1.0);
  const r = Math.random();
  if(r < 0.55){                                   // corn field
    flat(g,soilGround,s*8.6,s*60,0.02);
    for(let i=0;i<9;i++){ const m=box(g,cornMat,1.0,rand(2.1,2.5),CHUNK-0.4,s*(10.6+i*1.8),1.15,0,i<3); }
  } else if(r < 0.88){                            // pasture with animals
    flat(g,grassGround,s*8.6,s*60,0.02);
    const n = 2 + (Math.random()*3|0);
    for(let i=0;i<n;i++){
      const kind = pick(['cow','cow','horseBrown','horseBlack','horseWhite']);
      const a = animalProtos[kind].clone(); a.position.set(s*rand(11,26), 0.02, rand(-8,8)); a.rotation.y = rand(0,Math.PI*2); g.add(a);
    }
    if(Math.random()<0.5){ const h=new THREE.Mesh(hayGeo,hayMat); h.rotation.z=Math.PI/2; h.position.set(s*rand(14,22),0.62,rand(-7,7)); h.castShadow=true; g.add(h); }
    if(Math.random()<0.4) tree(g,s*rand(18,30),rand(-8,8),1.4);
  } else {                                        // barn and silo
    flat(g,grassGround,s*8.6,s*60,0.02);
    const bx = s*17;
    box(g,barnRed,9,6,11,bx,3,0);
    const roof=new THREE.Mesh(prismGeo,roofGrey); roof.scale.set(10,3.4,11.6); roof.position.set(bx,6,0); roof.castShadow=true; g.add(roof);
    box(g,barnTrim,0.1,3.6,3.2,bx-s*4.52,1.8,0,false);
    const x1=box(g,barnTrim,0.12,4.3,0.22,bx-s*4.55,1.8,0,false); x1.rotation.x=0.72;
    const x2=box(g,barnTrim,0.12,4.3,0.22,bx-s*4.55,1.8,0,false); x2.rotation.x=-0.72;
    const silo=new THREE.Mesh(siloGeo,mat('#b9bcc2',{metalness:0.5,roughness:0.5})); silo.position.set(bx+s*7,4.5,-3); silo.castShadow=true; g.add(silo);
    const dome=new THREE.Mesh(domeGeo,roofGrey); dome.position.set(bx+s*7,9,-3); g.add(dome);
  }
}

// --- suburb ---
const HOUSE_COLORS = ['#f2d7c4','#cfe3e8','#f5e6a8','#d9e8c9','#e8cfe0','#f4f1ea'];
const ROOF_COLORS = ['#8a3b2e','#4a4f5a','#5d4636','#3e5a6e'];
const houseTex = canvasTex(128,64,(g,w,h)=>{ g.fillStyle='#fff'; g.fillRect(0,0,w,h);
  for(const x of [14,82]){ g.fillStyle='#f4f1ea'; g.fillRect(x-3,15,38,28); g.fillStyle='#41556b'; g.fillRect(x,18,32,22); g.fillStyle='#f4f1ea'; g.fillRect(x+15,18,2,22); g.fillRect(x,28,32,2); }
  g.fillStyle='rgba(0,0,0,.12)'; g.fillRect(0,h-5,w,5); });
const houseMats = HOUSE_COLORS.map(c=>new THREE.MeshStandardMaterial({map:houseTex, color:c, roughness:0.85}));
const roofMats = ROOF_COLORS.map(c=>mat(c,{roughness:0.85}));
const doorMats = ['#7a2e2a','#2f5d7a','#3a6b45','#4a3a2e'].map(c=>mat(c,{roughness:0.6}));
const drivewayMat = mat('#9a958c',{roughness:1});
const mailMat = mat('#2a5fa8',{roughness:0.5});
function buildSuburb(g,s){
  flat(g,walkMat,s*4.8,s*7.2,0.18); flat(g,lawnGround,s*7.2,s*60,0.16);
  fence(g,picketFence,s*9.0,0.8);
  for(const zc of [5,-5]){
    const hx = s*rand(14.5,16), w = rand(6.5,8), dpt = 6, hh = rand(3,3.6);
    box(g,pick(houseMats),dpt,hh,w,hx,0.18+hh/2,zc);
    const roof=new THREE.Mesh(prismGeo,pick(roofMats)); roof.scale.set(dpt+0.8,rand(1.6,2.3),w+0.6); roof.position.set(hx,0.18+hh,zc); roof.castShadow=true; g.add(roof);
    box(g,pick(doorMats),0.08,1.9,1.0,hx-s*(dpt/2+0.02),0.18+0.95,zc,false);
    const dw = new THREE.Mesh(unitPlane,drivewayMat); dw.rotation.x=-Math.PI/2; dw.scale.set(Math.abs(hx)-dpt/2-7.2, 2.6, 1); dw.position.set(s*(7.2+(Math.abs(hx)-dpt/2-7.2)/2), 0.19, zc+w/2-1.6); g.add(dw);
    const mb=new THREE.Group(); box(mb,postMat,0.08,1.0,0.08,0,0.5,0,false); box(mb,mailMat,0.45,0.3,0.3,0,1.1,0); mb.position.set(s*8.6,0.16,zc-w/2+1); g.add(mb);
    if(Math.random()<0.7) tree(g,s*rand(10.5,12),zc+rand(-3,3),rand(0.8,1.1));
  }
}

// --- monster truck show ---
const showTruckProtos = TRUCKS.map(t=>buildTruck(t.id, true).rig);
const flagPoleGeo = new THREE.CylinderGeometry(0.05,0.05,6,6);
const flagMats = ['#ff5a1f','#ffc21a','#3d95f0','#b06bff','#3ddc84','#f4f1ea'].map(c=>new THREE.MeshStandardMaterial({color:c, side:THREE.DoubleSide, roughness:0.7}));
const flagGeo = (()=>{ const sh=new THREE.Shape(); sh.moveTo(0,0); sh.lineTo(1.4,-0.45); sh.lineTo(0,-0.9); sh.lineTo(0,0); return new THREE.ShapeGeometry(sh); })();
const moundGeo = new THREE.ConeGeometry(4,1.6,12);
const tireStackGeo = new THREE.TorusGeometry(0.42,0.2,8,16);
const bleacherMat = mat('#8f96a3',{metalness:0.4,roughness:0.6});
const seatMats = ['#c7372f','#2f6fdb','#f2b705'].map(c=>mat(c,{roughness:0.6}));
const bannerMat = std({map:canvasTex(512,96,(g,w,h)=>{ g.fillStyle='#16181d'; g.fillRect(0,0,w,h);
  g.fillStyle='#ffc21a'; for(let x=0;x<w;x+=40){ g.fillRect(x,0,20,8); g.fillRect(x+20,h-8,20,8); }
  g.fillStyle='#ff5a1f'; g.font='bold 54px Impact, Arial Black, sans-serif'; g.textAlign='center'; g.textBaseline='middle'; g.fillText('RC RAMPAGE SHOW', w/2, h/2+2); }), roughness:0.7});
function buildShow(g,s){
  flat(g,dirtShoulder,s*4.8,s*8.6,0.18); flat(g,dirtGround,s*8.6,s*60,0.02);
  // parked monster truck, scaled up, sometimes on a mound or on crushed cars
  if(Math.random() < 0.6){
  const t = pick(showTruckProtos).clone(); const sc = rand(3.2,3.8);
  t.scale.setScalar(sc); let base = 0.02;
  const r = Math.random(), tx = s*rand(12,14), tz = rand(-4,4);
  if(r < 0.35){ const m=new THREE.Mesh(moundGeo,dirtGround); m.position.set(tx,0.8,tz); m.scale.set(1,1,0.8); m.receiveShadow=true; g.add(m); base = 1.35; }
  else if(r < 0.7){ for(let i=0;i<3;i++){ box(g,mat(pick(CAR_COLORS),{roughness:0.6}),2.0,0.5,4.2,tx+rand(-0.3,0.3),0.27+i*0.52,tz+(i-1)*0.6+rand(-0.4,0.4)).rotation.y=rand(-0.2,0.2); } base = 1.58; }
  t.position.set(tx, base, tz); t.rotation.y = s*rand(0.5,1.1) + (Math.random()<0.5?Math.PI:0); g.add(t);
  }
  // flags, tire stacks, banner, bleachers
  for(const fz of [-8,8]){ const p=new THREE.Mesh(flagPoleGeo,postMat); p.position.set(s*9.4,3.0,fz); g.add(p); const f=new THREE.Mesh(flagGeo,pick(flagMats)); f.position.set(s*9.4,5.9,fz); f.rotation.y=rand(0,6); g.add(f); }
  for(let i=0;i<2;i++){ const tz2=rand(-9,9), tx2=s*rand(9.5,11); for(let k=0;k<3;k++){ const tr=new THREE.Mesh(tireStackGeo,tireMat); tr.rotation.x=Math.PI/2; tr.position.set(tx2,0.22+k*0.36,tz2); tr.castShadow=true; g.add(tr); } }
  if(Math.random()<0.5){ const b=new THREE.Mesh(unitPlane,bannerMat); b.scale.set(9,1.7,1); b.rotation.y=-s*Math.PI/2; b.position.set(s*17.5,2.2,0); g.add(b);
    box(g,postMat,0.12,3.1,0.12,s*17.55,1.55,-4.4,false); box(g,postMat,0.12,3.1,0.12,s*17.55,1.55,4.4,false); }
  for(let k=0;k<3;k++){ const hgt=0.9+k*1.1; box(g,bleacherMat,2.2,hgt,CHUNK-1,s*(21+k*2.2),hgt/2,0,false); box(g,pick(seatMats),1.4,0.3,CHUNK-1.4,s*(21.3+k*2.2),hgt+0.15,0,false); }
}

const BUILDERS = {city:buildCity, farm:buildFarm, suburb:buildSuburb, show:buildShow};
const chunks = [], zoneMarks = [];
let theme = 'city', themeLeft = 0, farZ = SCN_NEAR, playerTheme = 'city';
const themeLen = () => rand(380, 600);
function spawnChunk(zFar){
  const g = new THREE.Group(); g.position.z = zFar + CHUNK/2;
  BUILDERS[theme](g,-1); BUILDERS[theme](g,1);
  scene.add(g); chunks.push(g);
  themeLeft -= CHUNK;
  if(themeLeft <= 0){
    theme = pick(Object.keys(BUILDERS).filter(k=>k!==theme));
    themeLeft = themeLen();
    zoneMarks.push({z:zFar, theme});
  }
}
function resetScenery(){
  chunks.forEach(c=>scene.remove(c)); chunks.length = 0; zoneMarks.length = 0;
  theme = 'city'; playerTheme = 'city'; themeLeft = 1e9; farZ = SCN_NEAR;
  while(farZ > SCN_FAR){ spawnChunk(farZ - CHUNK); farZ -= CHUNK; }
  themeLeft = themeLen();
}
function updateScenery(d){
  for(let i=chunks.length-1;i>=0;i--){ const c=chunks[i]; c.position.z += d; if(c.position.z - CHUNK/2 > SCN_NEAR){ scene.remove(c); chunks.splice(i,1); } }
  farZ += d;
  while(farZ > SCN_FAR){ spawnChunk(farZ - CHUNK); farZ -= CHUNK; }
  for(let i=zoneMarks.length-1;i>=0;i--){
    const m = zoneMarks[i]; m.z += d;
    if(m.z > -2){ zoneMarks.splice(i,1); playerTheme = m.theme; if(run && state==='playing') run.themes.add(m.theme); if(state==='playing') pop(THEMES[m.theme], 'power', '#ffc21a'); }
  }
}
resetScenery();

// ---------- obstacles ----------
const obstacles = [];
const coins = [];
const wheelGeo = new THREE.CylinderGeometry(0.33,0.33,0.24,14); wheelGeo.rotateZ(Math.PI/2); wheelGeo.userData.shared = true;
function ob(g,w,h,d,m,x,y,z){ const o=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),m); o.position.set(x,y,z); o.castShadow=true; o.receiveShadow=true; g.add(o); return o; }
function addWheel(g,x,z,list){ const w=new THREE.Mesh(wheelGeo,tireMat); w.position.set(x,0.33,z); w.castShadow=true; g.add(w); list.push(w); }
const CAR_COLORS = ['#2f6fdb','#e8e4da','#2b2d33','#c7372f','#3a8c5c','#8a95a5','#7a4fb8','#1f8a9a'];

function makeCar(kind){
  const g = new THREE.Group(), wheels=[];
  const body = kind==='taxi' ? mat('#f2b705',{roughness:0.4}) : kind==='police' ? mat('#16181d',{roughness:0.35,metalness:0.3}) : mat(pick(CAR_COLORS),{roughness:0.35,metalness:0.3});
  let L,W,H;
  if(kind==='van'){
    L=5; W=1.95; H=2.1;
    ob(g,W,1.75,L,body,0,1.225,0);
    ob(g,W+0.02,0.5,0.9,glassMat,0,1.6,-L/2+0.44);
    ob(g,W-0.5,0.5,0.04,glassMat,0,1.6,L/2+0.01);
    ob(g,W+0.03,0.42,2.8,glassMat,0,1.6,0.2);
  } else {
    L=4.4; W=1.8; H=1.45;
    ob(g,W,0.62,L,body,0,0.64,0);
    ob(g,W-0.16,0.45,2.2,glassMat,0,1.175,0.25);
    ob(g,W-0.12,0.05,2.0,body,0,1.425,0.25);
    if(kind==='taxi') ob(g,0.6,0.16,0.26,mat('#fff8e0',{emissive:'#ffcc55',emissiveIntensity:0.5}),0,1.53,0.25);
    if(kind==='police'){ ob(g,W+0.02,0.32,2.3,mat('#f4f1ea',{roughness:0.4}),0,0.72,0.1); ob(g,W-0.1,0.05,2.0,mat('#f4f1ea',{roughness:0.4}),0,1.43,0.25); }
  }
  let siren = null;
  if(kind==='police'){ ob(g,1.1,0.1,0.3,darkMat,0,1.5,0.25); siren = [ob(g,0.5,0.14,0.28,sirenRed,-0.28,1.6,0.25), ob(g,0.5,0.14,0.28,sirenBlue,0.28,1.6,0.25)]; }
  const ty = kind==='van' ? 1.0 : 0.82;
  ob(g,0.32,0.14,0.05,tailMat,-(W/2-0.25),ty,L/2+0.01);
  ob(g,0.32,0.14,0.05,tailMat,(W/2-0.25),ty,L/2+0.01);
  ob(g,W+0.04,0.16,0.12,darkMat,0,0.4,L/2);
  ob(g,0.5,0.14,0.02,mat('#f4f1ea'),0,0.6,L/2+0.02);
  for(const x of [-(W/2-0.06),(W/2-0.06)]) for(const z of [-(L/2-0.85),(L/2-0.85)]) addWheel(g,x,z,wheels);
  const blink = {l:[], r:[]};
  for(const zz of [L/2+0.015, -L/2-0.015]){ blink.l.push(ob(g,0.16,0.1,0.04,blinkMat,-(W/2-0.06),ty+0.14,zz)); blink.r.push(ob(g,0.16,0.1,0.04,blinkMat,(W/2-0.06),ty+0.14,zz)); }
  blink.l.concat(blink.r).forEach(m=>{ m.visible=false; m.castShadow=false; });
  return {g, wheels, blink, siren, vehicle:true, zones:[{x:0,hw:W/2,z0:L/2,z1:-L/2,h:H,kind:'solid'}], L, H};
}

function makeRampTrailer(){
  const g = new THREE.Group(), wheels=[];
  const steel = mat('#5d6470',{metalness:0.6,roughness:0.45});
  ob(g,2.3,0.18,6.6,steel,0,0.81,-0.3);                 // bed z 3.0 .. -3.6, top 0.9
  ob(g,0.08,0.2,6.6,hazardMat,-1.11,0.99,-0.3); ob(g,0.08,0.2,6.6,hazardMat,1.11,0.99,-0.3);
  for(const z of [1.9,0.9]) for(const x of [-0.95,0.95]) addWheel(g,x,z,wheels);
  const rl = Math.hypot(2.2,0.9);
  const ramp = new THREE.Mesh(new THREE.BoxGeometry(2.1,0.08,rl), rampMat);
  ramp.position.set(0,0.42,4.1); ramp.rotation.x = Math.atan2(0.9,2.2); ramp.castShadow=true; ramp.receiveShadow=true; g.add(ramp);
  ob(g,0.08,0.9,0.08,steel,-1.0,0.45,3.0); ob(g,0.08,0.9,0.08,steel,1.0,0.45,3.0);
  // tow pickup with camper shell
  const pc = mat(pick(['#2a5fa8','#3d3f45','#b3332a','#e8e4da']),{roughness:0.35,metalness:0.3});
  ob(g,2.0,0.7,5.4,pc,0,0.75,-6.3);
  ob(g,1.92,0.5,5.0,pc,0,1.35,-6.45);
  ob(g,1.94,0.38,1.0,glassMat,0,1.36,-8.4);
  ob(g,1.94,0.3,2.6,glassMat,0,1.38,-5.0);
  ob(g,0.3,0.12,0.5,darkMat,0,0.55,-3.4);
  ob(g,0.32,0.14,0.05,tailMat,-0.75,0.92,-3.59); ob(g,0.32,0.14,0.05,tailMat,0.75,0.92,-3.59);
  for(const z of [-4.6,-8.0]) for(const x of [-0.95,0.95]) addWheel(g,x,z,wheels);
  return {g, wheels, vehicle:true, zones:[
    {x:0,hw:1.1,z0:5.2,z1:3.0,h:0.9,kind:'ramp'},
    {x:0,hw:1.15,z0:3.0,z1:-3.6,h:0.9,kind:'solid'},
    {x:0,hw:1.0,z0:-3.6,z1:-9.0,h:1.6,kind:'solid'},
  ]};
}

const bumpGeo = new THREE.CylinderGeometry(0.45,0.45,2.8,20); bumpGeo.rotateZ(Math.PI/2); bumpGeo.scale(1,0.55,1); bumpGeo.userData.shared=true;
const coneGeo = new THREE.ConeGeometry(0.2,0.6,10); coneGeo.userData.shared=true;
const coneMat = mat('#ff6a1a',{roughness:0.5});
function makeRoadworks(){
  const g = new THREE.Group();
  const bump = new THREE.Mesh(bumpGeo,bumpMat); bump.position.set(0,0,3); bump.receiveShadow=true; bump.castShadow=true; g.add(bump);
  ob(g,2.7,0.32,0.12,barrierMat,0,0.42,-1.5);
  ob(g,0.08,0.58,0.5,darkMat,-1.2,0.29,-1.5); ob(g,0.08,0.58,0.5,darkMat,1.2,0.29,-1.5);
  ob(g,0.14,0.14,0.14,mat('#ffb21a',{emissive:'#ff9a00',emissiveIntensity:1}),-1.2,0.66,-1.5);
  const pile = new THREE.Mesh(new THREE.ConeGeometry(0.9,0.42,9), mat('#8a6b4a',{roughness:1,flatShading:true}));
  pile.position.set(0.2,0.21,-2.7); pile.scale.z=0.55; pile.castShadow=true; g.add(pile);
  for(const [x,z] of [[-1.35,0.6],[1.35,0.6],[-1.35,-0.6],[1.35,-0.6]]){ const c=new THREE.Mesh(coneGeo,coneMat); c.position.set(x,0.3,z); c.castShadow=true; g.add(c); }
  return {g, wheels:[], zones:[
    {x:0,hw:1.4,z0:3.45,z1:2.55,h:0.25,kind:'bump'},
    {x:0,hw:1.4,z0:-1.3,z1:-1.7,h:0.58,kind:'solid'},
    {x:0.2,hw:0.9,z0:-2.3,z1:-3.1,h:0.42,kind:'solid'},
  ]};
}

function addObstacle(o, lane, z){
  o.g.position.set(LANES[lane],0,z); scene.add(o.g);
  o.lane=lane; o.x=LANES[lane]; o.z=z;
  o.back = Math.min(...o.zones.map(zn=>zn.z1));
  o.front = Math.max(...o.zones.map(zn=>zn.z0));
  o.top = Math.max(...o.zones.map(zn=>zn.h));
  obstacles.push(o); return o;
}
function disposeGroup(g){
  g.traverse(m=>{ if(m.isMesh && m.geometry && !m.geometry.userData.shared) m.geometry.dispose(); });
  scene.remove(g);
}

// ---------- scenario-specific obstacles, moving traffic and events ----------
[unitBox, unitPlane, prismGeo, hayGeo].forEach(g=>{ g.userData.shared = true; });
const blinkMat = new THREE.MeshBasicMaterial({color:'#ffae1a'});
const sirenRed = new THREE.MeshBasicMaterial({color:'#ff2a2a'});
const sirenBlue = new THREE.MeshBasicMaterial({color:'#2a6bff'});
// which scenery a given spot on the road belongs to (scenery changes roll in from the horizon)
function themeAt(z){ let t = playerTheme; for(const m of zoneMarks){ if(m.z >= z) t = m.theme; } return t; }

const bigWheelGeo = new THREE.CylinderGeometry(0.85,0.85,0.5,16); bigWheelGeo.rotateZ(Math.PI/2); bigWheelGeo.userData.shared = true;
const smallWheelGeo = new THREE.CylinderGeometry(0.45,0.45,0.32,12); smallWheelGeo.rotateZ(Math.PI/2); smallWheelGeo.userData.shared = true;
const pipeGeo = new THREE.CylinderGeometry(0.06,0.06,0.9,8); pipeGeo.userData.shared = true;
function makeTractor(){
  const g = new THREE.Group(), wheels = [];
  const green = mat('#3f8f3a',{roughness:0.5}), yel = mat('#f2c21a',{roughness:0.5});
  // hay wagon, closest to the player: a flat roof of bales you can ride on
  ob(g,2.3,0.25,6.0,mat('#7a5a3c',{roughness:0.9}),0,0.78,3.5);
  for(const x of [-0.58,0.58]) for(let i=0;i<4;i++) box(g,hayMat,1.1,1.0,1.4,x,1.4,5.8-i*1.5);
  for(const z of [5.4,1.6]) for(const x of [-1.0,1.0]) addWheel(g,x,z,wheels);
  ob(g,0.15,0.12,1.0,darkMat,0,0.6,0.1);
  // the tractor itself
  ob(g,1.4,1.0,2.8,green,0,1.05,-3.4);
  ob(g,1.9,0.5,1.8,green,0,1.3,-1.2);
  ob(g,1.8,1.0,1.6,glassMat,0,2.05,-1.2);
  ob(g,2.0,0.1,1.9,yel,0,2.6,-1.2);
  for(const x of [-1.05,1.05]){ const w=new THREE.Mesh(bigWheelGeo,tireMat); w.position.set(x,0.85,-1.1); w.castShadow=true; g.add(w); wheels.push(w);
    const h=new THREE.Mesh(smallWheelGeo,yel); h.scale.set(1.62,0.95,0.95); h.position.set(x*1.02,0.85,-1.1); g.add(h); }
  for(const x of [-0.8,0.8]){ const w=new THREE.Mesh(smallWheelGeo,tireMat); w.position.set(x,0.45,-4.2); w.castShadow=true; g.add(w); wheels.push(w); }
  const p = new THREE.Mesh(pipeGeo,darkMat); p.position.set(0.45,1.95,-3.9); g.add(p);
  return {g, wheels, H:1.9, vehicle:true, long:true, zones:[
    {x:0,hw:1.15,z0:6.5,z1:0.4,h:1.9,kind:'solid'},
    {x:0,hw:1.3,z0:0.4,z1:-4.9,h:2.6,kind:'solid'},
  ]};
}
function makeBus(){
  const g = new THREE.Group(), wheels = [];
  const L = 10.5, W = 2.3, H = 2.8, yel = mat('#f2b705',{roughness:0.45});
  ob(g,W,2.3,L,yel,0,1.6,0);
  ob(g,W-0.1,0.08,L-0.2,mat('#e8a800',{roughness:0.5}),0,2.79,0);
  ob(g,W+0.02,0.1,L,darkMat,0,1.35,0);
  ob(g,W+0.03,0.62,L-2.6,glassMat,0,2.08,-0.3);
  ob(g,W-0.7,0.65,0.04,glassMat,0,2.05,L/2+0.01);
  ob(g,W-0.2,0.7,0.06,glassMat,0,2.0,-L/2-0.02);
  ob(g,0.3,0.16,0.05,tailMat,-(W/2-0.25),1.0,L/2+0.01); ob(g,0.3,0.16,0.05,tailMat,(W/2-0.25),1.0,L/2+0.01);
  const stop = new THREE.Mesh(new THREE.CylinderGeometry(0.28,0.28,0.04,8), mat('#d8321f')); stop.rotation.z = Math.PI/2; stop.position.set(-W/2-0.06,1.9,-L/2+2); g.add(stop);
  for(const x of [-(W/2-0.12),(W/2-0.12)]) for(const z of [-(L/2-1.8),(L/2-1.9)]) addWheel(g,x,z,wheels);
  return {g, wheels, H, vehicle:true, long:true, zones:[{x:0,hw:W/2,z0:L/2,z1:-L/2,h:H,kind:'solid'}]};
}
function makeCowObstacle(dir){
  const g = new THREE.Group();
  const cow = animalProtos.cow.clone(); cow.rotation.y = dir > 0 ? 0 : Math.PI; g.add(cow);
  return {g, wheels:[], cow, zones:[{x:0,hw:0.85,z0:0.42,z1:-0.42,h:1.5,kind:'solid'}]};
}
function cowMove(o, dt){
  if(o.z < -Math.max(40, speed*3.5)) return;        // starts crossing as you get close
  o.x += o.dir*1.6*dt; o.g.position.x = o.x;
  o.lane = clamp(Math.round(o.x/LANE_W)+1, 0, 2);
  o.cow.position.y = Math.abs(Math.sin(o.x*3))*0.06;
}
function addCow(z, dir){
  const o = makeCowObstacle(dir); addObstacle(o, 1, z);
  o.dir = dir; o.x = -dir*rand(3,6.5); o.g.position.x = o.x; o.move = cowMove;
  o.lane = clamp(Math.round(o.x/LANE_W)+1, 0, 2);
  return o;
}
const binGeo = new THREE.CylinderGeometry(0.32,0.28,0.95,12); binGeo.userData.shared = true;
function placeBins(l, z){
  const n = 2 + (Math.random()*2|0);
  for(let i=0;i<n;i++){
    const g = new THREE.Group();
    const m = new THREE.Mesh(binGeo, mat(pick(['#2f6b3a','#3a4a5c','#2f5fa8','#5a5d66']),{roughness:0.6})); m.position.y = 0.48; m.castShadow = true; g.add(m);
    box(g,darkMat,0.7,0.08,0.7,0,0.98,0);
    const o = {g, wheels:[], zones:[{x:0,hw:0.38,z0:0.36,z1:-0.36,h:1.0,kind:'prop'}]};
    addObstacle(o, l, z - i*1.7);
    o.x = LANES[l] + rand(-0.9,0.9); o.g.position.x = o.x;
  }
}
function makeJunkCar(){
  const g = new THREE.Group();
  const c = mat(pick(['#7a4a2a','#6b6f76','#8a3b2e','#4f6b45','#9a8a5a']),{roughness:0.95});
  ob(g,1.9,0.5,4.2,c,0,0.3,0); ob(g,1.6,0.25,2.0,c,0,0.65,0.2); ob(g,1.62,0.14,0.9,glassMat,0,0.62,-0.6);
  g.rotation.y = rand(-0.12,0.12);
  return {g, wheels:[], zones:[{x:0,hw:0.95,z0:2.1,z1:-2.1,h:0.78,kind:'crush'}]};
}
const dirtRampGeo = (()=>{ const s=new THREE.Shape(); s.moveTo(3.4,0); s.lineTo(0,1.2); s.lineTo(-1.2,1.2); s.lineTo(-2.6,0); s.lineTo(3.4,0);
  const g=new THREE.ExtrudeGeometry(s,{depth:2.4,bevelEnabled:false}); g.translate(0,0,-1.2); g.rotateY(-Math.PI/2); g.userData.shared = true; return g; })();
function makeDirtRamp(){
  const g = new THREE.Group();
  const m = new THREE.Mesh(dirtRampGeo, dirtGround); m.castShadow = true; m.receiveShadow = true; g.add(m);
  for(const x of [-1.25,1.25]){ const t=new THREE.Mesh(tireStackGeo,tireMat); t.rotation.y=Math.PI/2; t.position.set(x,0.42,2.6); g.add(t); }
  return {g, wheels:[], zones:[
    {x:0,hw:1.2,z0:3.4,z1:0,h:1.2,kind:'ramp'},
    {x:0,hw:1.2,z0:0,z1:-1.2,h:1.2,kind:'solid'},
  ]};
}
function makeTrainCrossing(){
  const g = new THREE.Group(), lights = [];
  const steel = mat('#8d939c',{metalness:0.7,roughness:0.35}), tie = mat('#5a4636',{roughness:1});
  for(const rz of [-0.72,0.72]) box(g,steel,26,0.12,0.1,0,0.06,rz,false);
  for(let x=-12;x<=12;x+=1.2) box(g,tie,0.25,0.06,2.4,x,0.03,0,false);
  for(const s of [-1,1]){
    box(g,postMat,0.12,3.2,0.12,s*5.8,1.6,2.2);
    const a=box(g,mat('#f4f1ea'),1.4,0.18,0.06,s*5.8,2.95,2.25,false); a.rotation.z=0.6;
    const b=box(g,mat('#f4f1ea'),1.4,0.18,0.06,s*5.8,2.95,2.25,false); b.rotation.z=-0.6;
    for(const dx of [-0.25,0.25]) lights.push(box(g,basic('#ff2a1a'),0.22,0.22,0.08,s*5.8+dx,2.3,2.28,false));
  }
  const zones = [{x:0,hw:6.5,z0:1.5,z1:-1.5,h:2.8,kind:'solid'}];
  for(const l of [0,1,2]){
    const r = new THREE.Mesh(new THREE.BoxGeometry(2.4,0.1,Math.hypot(3,1)), rampMat);
    r.position.set(LANES[l],0.5,10.5); r.rotation.x = Math.atan2(1,3); r.castShadow = true; r.receiveShadow = true; g.add(r);
    zones.push({x:LANES[l],hw:1.25,z0:12,z1:9,h:1.0,kind:'ramp',boost:11.5});
  }
  const train = new THREE.Group(); g.add(train);
  const cols = ['#2f6fdb','#c7372f','#3a8c5c','#8a95a5','#7a4fb8'];
  for(let i=0;i<6;i++){
    const car = new THREE.Group();
    const loco = i===5, c = loco ? mat('#ffc21a',{roughness:0.5}) : mat(pick(cols),{roughness:0.6});
    box(car,c,12,2.3,2.6,0,1.55,0); box(car,darkMat,12.2,0.3,2.3,0,0.3,0);
    box(car,mat('#2a2c31'),11,0.12,2.7,0,2.76,0,false);
    if(loco){ box(car,glassMat,0.1,0.7,2.2,6.04,2.2,0,false); box(car,mat('#16181d'),1.6,0.6,2.0,4.6,3.1,0); }
    car.position.x = -40 + i*13; train.add(car);
  }
  const o = {g, wheels:[], zones, train, lights, t:0};
  o.move = (o, dt)=>{
    for(const c of o.train.children){ c.position.x += 15*dt; if(c.position.x > 45) c.position.x -= 78; }
    o.t += dt; const a = Math.floor(o.t*3)%2; o.lights.forEach((l,i)=>{ l.visible = (i%2)===a; });
  };
  return o;
}
function setLaneChange(o, target){ o.lc = {target, state:'wait', t:0, from:o.x}; o.move = laneChangeMove; }
function laneChangeMove(o, dt){
  const lc = o.lc;
  if(lc.state==='done') return;
  const side = LANES[lc.target] > o.x ? 'r' : 'l';
  if(lc.state==='wait'){ if(o.z > -Math.max(35, speed*3.2)){ lc.state='blink'; lc.t=0; } return; }
  lc.t += dt;
  const on = Math.floor(lc.t*4)%2===0;
  o.blink[side].forEach(m=>{ m.visible = on; });
  if(lc.state==='blink' && lc.t > 1.0){ lc.state='move'; lc.t=0; lc.from=o.x; }
  if(lc.state==='move'){
    const k = Math.min(1, lc.t/1.2), e = k*k*(3-2*k), delta = LANES[lc.target]-lc.from;
    o.x = lc.from + delta*e; o.g.position.x = o.x;
    o.g.rotation.y = -Math.sign(delta)*0.16*Math.sin(k*Math.PI);
    if(k > 0.5) o.lane = lc.target;
    if(k >= 1){ lc.state='done'; o.g.rotation.y=0; o.blink.l.concat(o.blink.r).forEach(m=>{ m.visible=false; }); }
  }
}
function sirenMove(o, dt){ o.st = (o.st||0)+dt; const a = Math.floor(o.st*6)%2===0; o.siren[0].visible = a; o.siren[1].visible = !a; }
function placeVehicle(l, z, th, roofCoins, kind){
  if(!kind){
    if(th==='farm' && Math.random()<0.45) kind = 'tractor';
    else if(th==='suburb' && Math.random()<0.35) kind = 'bus';
  }
  if(kind==='tractor' || kind==='bus'){
    const o = kind==='tractor' ? makeTractor() : makeBus(); addObstacle(o, l, z);
    if(roofCoins) for(let i=-1;i<=1;i++) addCoin(LANES[l], o.H+0.45, z+(kind==='tractor'?3.5:0)+i*1.6);
    return o;
  }
  return placeCar(l, z, roofCoins, kind);
}
function bashProp(o){
  if(o.fling) return;
  o.zones = [];
  o.fling = {vy:rand(5,8), vx:rand(-4,4), rx:rand(-8,8), rz:rand(-8,8)};
  award(10, 'BIN BASH'); if(run) run.bins++; play('land', 0.6, 1.5);
  burst(o.x, 0.6, o.z, '#9aa3ad', 6, 2, 3, 0.5);
}
function crushCar(o){
  if(o.squash !== undefined) return;
  o.zones = []; o.squash = 0;
  award(30, 'CRUSH'); if(run) run.crushed++;
  play('smash', 0.45, 0.8); burst(o.x, 0.7, o.z, '#9a8a5a', 8, 2.5, 3, 0.5);
}
function spawnTrainCrossing(z){
  const o = makeTrainCrossing(); addObstacle(o, 1, z);
  const vy = 11.5;
  for(let k=1;k<=9;k++){ const t=k*0.1; addCoin(0, 1.0+vy*t-0.5*G*t*t+0.4, z+9-speed*t); }
  pop('TRAIN CROSSING! USE THE RAMPS', 'power', '#ffc21a');
  return 62 + speed*1.0;
}
function spawnRoadblock(z){
  const lanes = shuffle([0,1,2]), gap = lanes[0];
  lanes.slice(1).forEach(l=>{
    const c = placeCar(l, z+rand(-1,1), false, 'police');
    c.g.rotation.y = (l < gap ? 1 : -1)*0.3; c.zones[0].hw = 1.2; c.zones[0].z0 = 2.5; c.zones[0].z1 = -2.5;
    c.move = sirenMove;
    for(const dx of [-1.1,1.1]){ const cn=new THREE.Mesh(coneGeo,coneMat); cn.position.set(dx,0.3,3.2); c.g.add(cn); }
  });
  coinLine(gap, z+6, 6);
  pop('ROADBLOCK AHEAD!', 'power', '#3d95f0');
  return 30 + speed*0.85;
}

// ---------- combos: stunts in quick succession raise a score multiplier ----------
const combo = {n:0, t:0};
const COMBO_WINDOW = 4;
const comboMult = () => Math.min(5, 1 + Math.floor(combo.n/2));
function award(points, label, quiet){
  combo.n++; combo.t = COMBO_WINDOW;
  const m = comboMult(), pts = points*m;
  bonus += pts;
  if(run) run.maxMult = Math.max(run.maxMult, m);
  if(!quiet) pop(`${label} +${pts}`, m > 1 ? 'power' : '', m > 1 ? '#ffc21a' : '');
}

// ---------- air tricks ----------
const TRICKS = {roll:{name:'BARREL ROLL', dur:0.45, pts:75}, flip:{name:'BACKFLIP', dur:0.55, pts:100}};
function startTrick(type){
  if(state!=='playing' || T.grounded || T.trick || T.onRamp) return false;
  T.trick = {type, t:0, dur:TRICKS[type].dur};
  play('hop', 0.45, 1.7);
  return true;
}
function trickPose(){
  // rotate around the truck's middle, not its wheels
  if(!T.trick) return;
  const a = Math.min(1, T.trick.t/T.trick.dur)*Math.PI*2, c = 0.45;
  if(T.trick.type==='roll'){ truck.rotation.z = a; truck.position.x += c*Math.sin(a); truck.position.y += c*(1-Math.cos(a)); }
  else { truck.rotation.x += a; truck.position.y += c*(1-Math.cos(a)); truck.position.z -= c*Math.sin(a); }
}

// ---------- day / night cycle and weather ----------
const SKIES = {
  day:    {top:'#3f6fc4', mid:'#86b4e8', low:'#e9dcc0', glow:[255,250,230,0.55], gsize:14, fog:'#dcd4c2', hemi:1.35, sun:1.7, sunCol:'#fff3df', night:0},
  sunset: {top:'#2e4687', mid:'#d48d86', low:'#f3c39a', glow:[255,236,190,0.95], gsize:16, fog:'#f3c39a', hemi:1.25, sun:1.6, sunCol:'#ffe0b5', night:0},
  night:  {top:'#04061a', mid:'#10173a', low:'#262c58', glow:[225,232,255,0.7],  gsize:5,  fog:'#1c2244', hemi:0.42, sun:0.3, sunCol:'#9fb4ff', night:1},
};
const CYCLE = [[0,'day'],[0.30,'day'],[0.40,'sunset'],[0.50,'night'],[0.80,'night'],[0.90,'sunset'],[1,'day']];
const CYCLE_SECONDS = 210;
let dayT = 0.36, skyCssAt = 0;
const _c1 = new THREE.Color(), _c2 = new THREE.Color();
const lerpHex = (a,b,k) => '#'+_c1.set(a).lerp(_c2.set(b),k).getHexString();
function skyAt(t){
  let i = 0; while(i < CYCLE.length-2 && t > CYCLE[i+1][0]) i++;
  const [t0,a] = CYCLE[i], [t1,b] = CYCLE[i+1];
  const k = t1 > t0 ? clamp((t-t0)/(t1-t0),0,1) : 0, A = SKIES[a], B = SKIES[b], L = (x,y)=>x+(y-x)*k;
  return {top:lerpHex(A.top,B.top,k), mid:lerpHex(A.mid,B.mid,k), low:lerpHex(A.low,B.low,k),
    glow:A.glow.map((v,j)=>L(v,B.glow[j])), gsize:L(A.gsize,B.gsize), fog:lerpHex(A.fog,B.fog,k),
    hemi:L(A.hemi,B.hemi), sun:L(A.sun,B.sun), sunCol:lerpHex(A.sunCol,B.sunCol,k), night:L(A.night,B.night)};
}
const headlight = new THREE.SpotLight(0xfff2d0, 0, 34, 0.5, 0.6, 1.2);
headlight.position.set(0,0.6,-0.4); headlight.target.position.set(0,0,-12);
truck.add(headlight); truck.add(headlight.target);
const weather = {rain:0, target:0, until:0};
const RAIN_N = 1100, rainPos = new Float32Array(RAIN_N*6);
const rainGeo = new THREE.BufferGeometry(); rainGeo.setAttribute('position', new THREE.BufferAttribute(rainPos,3));
const rainMat = new THREE.LineBasicMaterial({color:'#e4eefb', transparent:true, opacity:0});
const rainLines = new THREE.LineSegments(rainGeo, rainMat); rainLines.frustumCulled = false; rainLines.visible = false; scene.add(rainLines);
function resetDrop(i, top){
  const x = rand(-16,16), y = top ? rand(10,16) : rand(0,16), z = rand(-45,8);
  rainPos.set([x,y,z, x+0.05,y+0.9,z-0.3], i*6);
}
for(let i=0;i<RAIN_N;i++) resetDrop(i, false);
function startRain(){ weather.target = 1; weather.until = gameTime + rand(30,45); pop("IT'S STARTING TO RAIN", 'power', '#8fb8ff'); }
function updateSkyAndWeather(dt, d){
  dayT = (dayT + dt/CYCLE_SECONDS) % 1;
  if(weather.target && gameTime > weather.until) weather.target = 0;
  weather.rain += (weather.target - weather.rain)*Math.min(1, dt*0.4);
  const s = skyAt(dayT), wet = weather.rain;
  scene.fog.color.set(lerpHex(s.fog, '#6d7686', wet*0.6));
  scene.fog.near = 45 - wet*25; scene.fog.far = 150 - wet*55;
  hemi.intensity = s.hemi*(1 - wet*0.3); sun.intensity = s.sun*(1 - wet*0.5); sun.color.set(s.sunCol);
  headlight.intensity = Math.max(s.night, wet*0.5)*2.2;
  lampHeadMat.emissiveIntensity = 0.8 + s.night*2.2;
  tailMat.emissiveIntensity = 0.9 + s.night*1.5;
  const now = performance.now();
  if(now - skyCssAt > 200){
    skyCssAt = now;
    const g = s.glow, top = lerpHex(s.top,'#454c58',wet*0.9), mid = lerpHex(s.mid,'#646b78',wet*0.9), low = lerpHex(s.low,'#868c96',wet*0.85);
    stage.style.background = `radial-gradient(circle at 50% 36%, rgba(${g[0]|0},${g[1]|0},${g[2]|0},${(g[3]*(1-wet)).toFixed(2)}) 0, rgba(${g[0]|0},${g[1]|0},${g[2]|0},${(g[3]*0.5*(1-wet)).toFixed(2)}) ${(s.gsize*0.32).toFixed(1)}%, rgba(${g[0]|0},${g[1]|0},${g[2]|0},0) ${s.gsize.toFixed(1)}%), linear-gradient(to bottom, ${top} 0%, ${mid} 22%, ${low} 37%, ${low} 100%)`;
  }
  rainLines.visible = wet > 0.02;
  if(rainLines.visible){
    rainMat.opacity = 0.85*wet;
    for(let i=0;i<RAIN_N;i++){
      const o = i*6; const dy = 24*dt, dz = d*0.9 + 2*dt;
      rainPos[o+1] -= dy; rainPos[o+4] -= dy; rainPos[o+2] += dz; rainPos[o+5] += dz;
      if(rainPos[o+1] < 0 || rainPos[o+2] > 8) resetDrop(i, true);
    }
    rainGeo.attributes.position.needsUpdate = true;
    rainLines.position.x = T.x*0.7;
  }
  setRainSound(wet);
}

const coinGeo = new THREE.CylinderGeometry(0.32,0.32,0.08,22); coinGeo.rotateX(Math.PI/2);
const coinMat = new THREE.MeshStandardMaterial({color:'#ffcc33', metalness:0.7, roughness:0.25, emissive:'#8a5200', emissiveIntensity:0.55});
function addCoin(x,y,z){ const m=new THREE.Mesh(coinGeo,coinMat); m.position.set(x,y,z); m.rotation.y=z*0.3; m.castShadow=true; scene.add(m); coins.push(m); }
function coinLine(lane,z,n){ for(let i=0;i<n;i++) addCoin(LANES[lane],0.5,z-i*2.6); }

// ---------- particles ----------
const parts = [];
const pGeo = new THREE.BoxGeometry(0.1,0.1,0.1);
const pMats = {};
const pMat = c => pMats[c] || (pMats[c] = new THREE.MeshBasicMaterial({color:c}));
for(let i=0;i<90;i++){ const m=new THREE.Mesh(pGeo,pMat('#fff')); m.visible=false; scene.add(m); parts.push({m,v:new THREE.Vector3(),life:0,max:1}); }
let pIdx=0;
function burst(x,y,z,color,n,spread,up,life=0.6){
  for(let i=0;i<n;i++){
    const p = parts[pIdx++ % parts.length];
    p.m.material = pMat(color); p.m.visible=true; p.m.position.set(x+rand(-.2,.2),y+rand(0,.2),z+rand(-.2,.2));
    p.v.set(rand(-spread,spread), rand(up*0.4,up), rand(-spread,spread*0.6));
    p.life = p.max = life*rand(0.6,1.2);
  }
}

// ---------- audio (CC0 samples: see audio/CREDITS.md) ----------
const SOUND_FILES = {
  engine:'audio/engine.wav',
  coin:'audio/sfx/coin.mp3', 'ramp-jump':'audio/sfx/ramp-jump.mp3', hop:'audio/sfx/hop.mp3', 'super-jump':'audio/sfx/super-jump.mp3',
  land:'audio/sfx/land.mp3', crash:'audio/sfx/crash.mp3', smash:'audio/sfx/smash.mp3', unlock:'audio/sfx/unlock.mp3',
  'power-end':'audio/sfx/power-end.mp3', 'power-jump':'audio/sfx/power-jump.mp3', 'power-magnet':'audio/sfx/power-magnet.mp3',
  'power-shield':'audio/sfx/power-shield.mp3', 'shield-hit':'audio/sfx/shield-hit.mp3', 'power-nitro':'audio/sfx/power-nitro.mp3',
  select:'audio/sfx/select.mp3', confirm:'audio/sfx/confirm.mp3',
  'music-city':'audio/music/city.mp3', 'music-farm':'audio/music/farm.mp3', 'music-suburb':'audio/music/suburb.mp3', 'music-show':'audio/music/show.mp3',
};
// start downloading right away; decoding waits for the first click (browsers need a gesture to start audio)
const soundData = {};
for(const k in SOUND_FILES){ soundData[k] = fetch(SOUND_FILES[k]).then(r=>r.ok ? r.arrayBuffer() : null).catch(()=>null); }
const buffers = {};
let actx=null, master=null, sfxBus=null, musicBus=null, musicOut=null, fxOut=null, engineGain=null, engineFilter=null, engineSrc=null;
let musicOff=false, sfxOff=false, rainGain=null;
function setRainSound(w){ if(rainGain) rainGain.gain.setTargetAtTime(0.09*w, actx.currentTime, 0.3); }
let musicNow = null, musicWanted = 'city', nitroSrc = null;
try{
  const old = localStorage.getItem('rc-rampage-muted')==='1';      // the single mute button from earlier versions
  musicOff = (localStorage.getItem('rc-rampage-music-off') ?? (old?'1':'0'))==='1';
  sfxOff   = (localStorage.getItem('rc-rampage-sfx-off')   ?? (old?'1':'0'))==='1';
}catch(e){}
function decode(ab){ return new Promise((res)=>{ try{ const p = actx.decodeAudioData(ab, res, ()=>res(null)); if(p && p.then) p.then(res, ()=>res(null)); }catch(e){ res(null); } }); }
function initAudio(){
  if(actx){ if(actx.state==='suspended' && state!=='paused') actx.resume(); return; }
  try{
    actx = new (window.AudioContext||window.webkitAudioContext)();
    master = actx.createGain(); master.gain.value = 1; master.connect(actx.destination);
    // two independent switches: musicOut (background music) and fxOut (effects + engine)
    musicOut = actx.createGain(); musicOut.gain.value = musicOff?0:1; musicOut.connect(master);
    fxOut = actx.createGain(); fxOut.gain.value = sfxOff?0:1; fxOut.connect(master);
    sfxBus = actx.createGain(); sfxBus.gain.value = 0.7; sfxBus.connect(fxOut);
    musicBus = actx.createGain(); musicBus.gain.value = 0.32; musicBus.connect(musicOut);
    engineFilter = actx.createBiquadFilter(); engineFilter.type='lowpass'; engineFilter.frequency.value=1500; engineFilter.Q.value=0.5;
    engineGain = actx.createGain(); engineGain.gain.value = 0; engineFilter.connect(engineGain); engineGain.connect(fxOut);
    // rain: filtered noise, only heard while it rains
    const nb = actx.createBuffer(1, actx.sampleRate*2, actx.sampleRate), nd = nb.getChannelData(0);
    for(let i=0;i<nd.length;i++) nd[i] = Math.random()*2-1;
    const ns = actx.createBufferSource(); ns.buffer = nb; ns.loop = true;
    const bp = actx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1800; bp.Q.value = 0.6;
    rainGain = actx.createGain(); rainGain.gain.value = 0;
    ns.connect(bp); bp.connect(rainGain); rainGain.connect(fxOut); ns.start();
  }catch(e){ actx=null; return; }
  for(const k in soundData){
    soundData[k].then(ab=>ab && decode(ab.slice(0))).then(b=>{
      if(!b) return; buffers[k]=b;
      if(k==='engine') startEngine();
      if(k==='music-'+musicWanted) setMusic(musicWanted, true);
    });
  }
}
function play(name, vol=1, rate=1){
  if(!actx || sfxOff || !buffers[name]) return null;
  const s = actx.createBufferSource(); s.buffer = buffers[name]; s.playbackRate.value = rate;
  const g = actx.createGain(); g.gain.value = vol; s.connect(g); g.connect(sfxBus); s.start();
  return s;
}
function startEngine(){
  if(engineSrc || !buffers.engine) return;
  engineSrc = actx.createBufferSource(); engineSrc.buffer = buffers.engine; engineSrc.loop = true;
  engineSrc.connect(engineFilter); engineSrc.start();
}
// engine: pitch follows speed (and revs when the wheels leave the ground), kept quiet and soft
function setEngine(level, vol){
  if(!engineSrc) return; const t = actx.currentTime;
  engineSrc.playbackRate.setTargetAtTime(0.7 + level*0.75, t, 0.15);
  engineFilter.frequency.setTargetAtTime(900 + level*1400, t, 0.2);
  engineGain.gain.setTargetAtTime(vol, t, 0.25);
}
// background music: one track per scenario, crossfaded
function setMusic(theme, force=false){
  musicWanted = theme;
  if(!actx || (!force && musicNow && musicNow.theme===theme)) return;
  const buf = buffers['music-'+theme]; if(!buf) return;
  const t = actx.currentTime;
  if(musicNow){ const old = musicNow; old.gain.gain.cancelScheduledValues(t); old.gain.gain.setValueAtTime(old.gain.gain.value, t); old.gain.gain.linearRampToValueAtTime(0, t+1.5); old.src.stop(t+1.6); }
  const src = actx.createBufferSource(); src.buffer = buf; src.loop = true;
  const g = actx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(1, t+1.5);
  src.connect(g); g.connect(musicBus); src.start(t);
  musicNow = {theme, src, gain:g};
}
function duckMusic(level){ if(musicBus) musicBus.gain.setTargetAtTime(0.32*level, actx.currentTime, 0.3); }
const sfx = {
  coin(){ play('coin', 0.55, 0.95 + Math.random()*0.12); },
  jump(){ play('ramp-jump', 0.8); },
  hop(){ play('hop', 0.7); },
  land(){ play('land', 0.45, 0.9); },
  crash(){ play('crash', 0.9); if(nitroSrc){ try{ nitroSrc.stop(); }catch(e){} nitroSrc=null; } },
  power(id){
    if(id==='turbo'){ if(nitroSrc){ try{ nitroSrc.stop(); }catch(e){} } nitroSrc = play('power-nitro', 0.7); }
    else play('power-'+id, 0.8);
  },
  shieldHit(){ play('shield-hit', 0.9); },
  unlock(){ play('unlock', 0.75); },
  smash(){ play('smash', 0.75); },
  superJump(){ play('super-jump', 0.75); },
  expire(id){ play('power-end', 0.6); if(id==='turbo' && nitroSrc){ try{ nitroSrc.stop(); }catch(e){} nitroSrc=null; } },
  select(){ play('select', 0.8); },
  confirm(){ play('confirm', 0.7); },
};
function setMusicOff(off){
  musicOff = off; try{ localStorage.setItem('rc-rampage-music-off', off?'1':'0'); }catch(e){}
  if(musicOut) musicOut.gain.setTargetAtTime(off?0:1, actx.currentTime, 0.05);
  $('musicBtn').setAttribute('aria-pressed', String(!off));
  $('musicBtn').setAttribute('aria-label', off ? 'Background music off' : 'Background music on');
}
function setSfxOff(off){
  sfxOff = off; try{ localStorage.setItem('rc-rampage-sfx-off', off?'1':'0'); }catch(e){}
  if(fxOut) fxOut.gain.setTargetAtTime(off?0:1, actx.currentTime, 0.05);
  if(off && nitroSrc){ try{ nitroSrc.stop(); }catch(e){} nitroSrc = null; }
  $('sfxBtn').setAttribute('aria-pressed', String(!off));
  $('sfxBtn').setAttribute('aria-label', off ? 'Sound effects off' : 'Sound effects on');
}
setMusicOff(musicOff); setSfxOff(sfxOff);

// ---------- game state ----------
let state = 'menu', prevState='menu';
let speed = 8, dist = 0, coinsN = 0, bonus = 0, nextRow = 0, shake = 0, crashTimer = 0, overShown = true;
let gameTime = 0, nextEventAt = 500, pendingEvent = null;
let best = 0; try{ best = parseInt(localStorage.getItem('rc-rampage-best')||'0',10)||0; }catch(e){}
const T = {lane:1, x:0, y:0, vy:0, grounded:true, air:0, onRoof:false, susp:0, suspV:0, spin:0, roll:0};
const cam = {x:0, y:2.6};

// ---------- super powers ----------
const POWERS = [
  {id:'jump',   name:'Super Jump',  unlock:250,  dur:15, color:'#3ddc84', weight:3},
  {id:'magnet', name:'Coin Magnet', unlock:600,  dur:12, color:'#4fa3ff', weight:3},
  {id:'shield', name:'Shield',      unlock:1000, dur:20, color:'#b57bff', weight:2},
  {id:'turbo',  name:'Nitro',       unlock:1600, dur:5,  color:'#ff3b5c', weight:1},
];
const PW = Object.fromEntries(POWERS.map(p=>[p.id,p]));
const powers = {jump:0, magnet:0, shield:0, turbo:0};
let unlocked = 0, pendingPower = null, turboMul = 1, invuln = 0;
const powerups = [];

function iconTex(id, color){
  return canvasTex(128,128,(g,w)=>{
    g.fillStyle=color; g.beginPath(); g.arc(64,64,60,0,Math.PI*2); g.fill();
    g.lineWidth=6; g.strokeStyle='rgba(255,255,255,.9)'; g.stroke();
    g.fillStyle='#fff'; g.strokeStyle='#fff'; g.lineCap='round'; g.lineJoin='round';
    if(id==='jump'){ g.lineWidth=14; for(const y of [58,86]){ g.beginPath(); g.moveTo(36,y); g.lineTo(64,y-28); g.lineTo(92,y); g.stroke(); } }
    else if(id==='magnet'){ g.lineWidth=20; g.beginPath(); g.arc(64,58,24,Math.PI,0,true); g.stroke(); g.beginPath(); g.moveTo(40,58); g.lineTo(40,34); g.moveTo(88,58); g.lineTo(88,34); g.stroke(); }
    else if(id==='shield'){ g.beginPath(); g.moveTo(64,24); g.lineTo(98,36); g.quadraticCurveTo(96,84,64,106); g.quadraticCurveTo(32,84,30,36); g.closePath(); g.fill(); }
    else { g.beginPath(); g.moveTo(72,18); g.lineTo(36,70); g.lineTo(60,70); g.lineTo(52,110); g.lineTo(92,54); g.lineTo(68,54); g.closePath(); g.fill(); }
  });
}
const powerAssets = {};
for(const p of POWERS){
  powerAssets[p.id] = {
    sprite: new THREE.SpriteMaterial({map:iconTex(p.id,p.color), transparent:true, depthWrite:false}),
    glow: new THREE.MeshBasicMaterial({color:p.color, transparent:true, opacity:0.28, depthWrite:false}),
    ring: new THREE.MeshBasicMaterial({color:p.color}),
  };
}
const orbGeo = new THREE.SphereGeometry(0.62,20,14);
const orbRingGeo = new THREE.TorusGeometry(0.72,0.05,8,32);
function addPowerup(id, lane, z){
  const a = powerAssets[id], g = new THREE.Group();
  g.add(new THREE.Mesh(orbGeo, a.glow));
  const ring = new THREE.Mesh(orbRingGeo, a.ring); g.add(ring);
  const s = new THREE.Sprite(a.sprite); s.scale.set(0.95,0.95,1); g.add(s);
  g.position.set(LANES[lane], 0.85, z); scene.add(g);
  powerups.push({g, ring, id});
}
function laneClearAt(l, z){
  for(const o of obstacles){ if(o.lane!==l) continue; for(const zn of o.zones){ if(o.z+zn.z1 < z+3 && o.z+zn.z0 > z-3) return false; } }
  return true;
}
function maybePower(z){
  if(unlocked===0) return;
  let id = pendingPower;
  if(!id){
    if(Math.random() > (truckId==='blaze' ? 0.32 : 0.24)) return;
    const pool = POWERS.slice(0,unlocked); let r = Math.random()*pool.reduce((s,p)=>s+p.weight,0);
    for(const p of pool){ r -= p.weight; if(r<=0){ id=p.id; break; } }
  }
  const lanes = shuffle([0,1,2]).filter(l=>laneClearAt(l,z));
  if(!lanes.length) return;              // try again on the next row
  pendingPower = null;
  addPowerup(id, lanes[0], z);
}
function activatePower(id){
  const p = PW[id];
  powers[id] = powersMax[id] = powerDur(id);
  if(run) run.powers++;
  sfx.power(id); pop(p.name.toUpperCase()+'!', 'power', p.color);
  burst(T.x, T.y+0.6, 0, p.color, 14, 2, 3, 0.6);
}
function superJump(){
  if(state==='playing' && !T.grounded){ startTrick('roll'); return; }
  if(state!=='playing' || powers.jump<=0 || !T.grounded) return;
  T.vy = 9.8; T.grounded = false; T.air = 0; T.suspV = -1.2;
  if(run) run.superJumps++;
  sfx.superJump(); burst(T.x, T.y+0.05, 0, '#3ddc84', 10, 1.6, 1.5, 0.5);
}
function smash(o){
  if(o.fling) return;
  o.zones = [];
  o.fling = {vy:rand(7,10), vx:(o.x>=T.x?1:-1)*rand(3,6), rx:rand(-5,5), rz:rand(-6,6)};
  award(truckId==='howler' ? 100 : 50, 'SMASH'); shake = Math.max(shake, 0.35);
  if(run) run.smashes++;
  sfx.smash(); burst(o.x, 1, o.z, '#ffd34d', 12, 3, 5, 0.7); burst(o.x, 1, o.z, '#2a2c31', 10, 3, 4, 0.7);
}

// truck effects for each power
const fx = {};
fx.shield = new THREE.Mesh(new THREE.SphereGeometry(0.95,24,16), new THREE.MeshBasicMaterial({color:'#b57bff', transparent:true, opacity:0.22, depthWrite:false}));
fx.shield.position.y = 0.45; fx.shield.scale.set(1,0.8,1.1); truck.add(fx.shield);
fx.magnet = new THREE.Mesh(new THREE.TorusGeometry(0.32,0.05,8,24), new THREE.MeshBasicMaterial({color:'#4fa3ff'}));
fx.magnet.position.y = 1.2; fx.magnet.rotation.x = Math.PI/2; truck.add(fx.magnet);
fx.jump = new THREE.Mesh(new THREE.TorusGeometry(0.62,0.04,8,32), new THREE.MeshBasicMaterial({color:'#3ddc84', transparent:true, opacity:0.85}));
fx.jump.position.y = 0.04; fx.jump.rotation.x = Math.PI/2; truck.add(fx.jump);
fx.turbo = new THREE.Group(); truck.add(fx.turbo);
{ const fm = new THREE.MeshBasicMaterial({color:'#ff7a1a'}), fi = new THREE.MeshBasicMaterial({color:'#fff0a0'});
  for(const x of [-0.2,0.2]){
    const outer = new THREE.Mesh(new THREE.ConeGeometry(0.1,0.6,10), fm); outer.rotation.x = Math.PI/2; outer.position.set(x,0.45,0.85); fx.turbo.add(outer);
    const inner = new THREE.Mesh(new THREE.ConeGeometry(0.05,0.35,8), fi); inner.rotation.x = Math.PI/2; inner.position.set(x,0.45,0.75); fx.turbo.add(inner);
  } }
for(const k in fx) fx[k].visible = false;

const launchVy = s => 8.6 + clamp((s-START_SPEED)/(MAX_SPEED-START_SPEED),0,1)*1.9;
const bumpVy = s => 6.5 + clamp((s-START_SPEED)/(MAX_SPEED-START_SPEED),0,1)*0.9;
const score = () => Math.floor(dist) + coinsN*10 + bonus;

function placeCar(lane, z, roofCoins, kind){
  kind = kind || (Math.random()<0.2 ? 'van' : Math.random()<0.35 ? 'taxi' : 'sedan');
  const c = makeCar(kind); addObstacle(c, lane, z);
  if(roofCoins) for(let i=-1;i<=1;i++) addCoin(LANES[lane], c.H+0.45, z+i*1.3);
  return c;
}

function spawnRow(z){
  const early = dist < 140;
  if(pendingEvent && !early){ const e = pendingEvent; pendingEvent = null; return e==='train' ? spawnTrainCrossing(z) : spawnRoadblock(z); }
  const th = themeAt(z), r = Math.random();
  let type;
  if(early) type = r<0.72 ? 'traffic' : 'coins';
  else if(th==='show')   type = r<0.30 ? 'crush' : r<0.48 ? 'ramp' : r<0.62 ? 'dirt' : r<0.85 ? 'traffic' : 'coins';
  else if(th==='farm')   type = r<0.20 ? 'cows'  : r<0.45 ? 'traffic' : r<0.65 ? 'ramp' : r<0.84 ? 'works' : 'coins';
  else if(th==='suburb') type = r<0.20 ? 'bins'  : r<0.47 ? 'traffic' : r<0.67 ? 'ramp' : r<0.84 ? 'works' : 'coins';
  else                   type = r<0.38 ? 'traffic' : r<0.62 ? 'ramp' : r<0.84 ? 'works' : 'coins';
  const lanes = shuffle([0,1,2]);
  if(type==='traffic'){
    const n = early ? 1 : (Math.random()<0.5 ? 2 : 1);
    const placed = lanes.slice(0,n).map(l=>placeVehicle(l, z+rand(-1.5,1.5), th, !early && Math.random()<0.25));
    const free = lanes.slice(n);
    let coinLane = free[0];
    // city drivers sometimes signal and switch into a free lane
    if(th==='city' && !early && Math.random()<0.5){
      const c = pick(placed), opts = free.filter(l=>Math.abs(l-c.lane)===1);
      if(opts.length && c.blink){ const tgt = pick(opts); setLaneChange(c, tgt); if(coinLane===tgt) coinLane = c.lane; }
    }
    if(th==='suburb' && free.length > 1 && Math.random()<0.5) placeBins(free[1], z+rand(-3,3));
    if(Math.random()<0.6) coinLine(coinLane, z+7, 5);
    return 18 + speed*0.85 + (placed.some(p=>p.long) ? 8 : 0);
  }
  if(type==='ramp'){
    const L = lanes[0];
    addObstacle(makeRampTrailer(), L, z);
    lanes.slice(1).forEach(l=>{ if(Math.random()<0.6) placeCar(l, z+rand(-3,1)); });
    const vy = launchVy(speed);
    for(let k=1;k<=8;k++){ const t=k*0.09; addCoin(LANES[L], 0.9+vy*t-0.5*G*t*t+0.4, z+3.0-speed*t); }
    let extra = 0;
    if(Math.random()<0.55){
      const n = Math.random()<0.4 ? 3 : 2;
      for(let i=0;i<n;i++) placeCar(L, z-12.4-i*5.0, true, Math.random()<0.3?'taxi':'sedan');
      extra = n*5;
    }
    return 34 + extra + speed*0.9;
  }
  if(type==='works'){
    const n = Math.random()<0.4 ? 1 : Math.random()<0.6 ? 2 : 3;
    lanes.slice(0,n).forEach(l=>addObstacle(makeRoadworks(), l, z));
    const vy = bumpVy(speed), cl = lanes[0];
    for(let k=1;k<=5;k++){ const t=k*0.1; addCoin(LANES[cl], vy*t-0.5*G*t*t+0.45, z+3.0-speed*t); }
    if(n<3 && Math.random()<0.4) placeCar(lanes[n], z+rand(-2,2));
    return 22 + speed*0.85;
  }
  if(type==='cows'){
    const n = Math.random()<0.5 ? 1 : 2;
    for(let i=0;i<n;i++) addCow(z - i*8, Math.random()<0.5 ? 1 : -1);
    if(Math.random()<0.5) coinLine(lanes[0], z+9, 4);
    return 24 + speed*0.85 + n*4;
  }
  if(type==='bins'){
    const k = Math.random()<0.5 ? 1 : 2;
    lanes.slice(0,k).forEach(l=>placeBins(l, z));
    coinLine(lanes[2], z+6, 5);
    return 16 + speed*0.7;
  }
  if(type==='crush'){
    const nl = Math.random()<0.6 ? 1 : 2;
    lanes.slice(0,nl).forEach(l=>{
      for(let i=0;i<3;i++) addObstacle(makeJunkCar(), l, z - i*4.6);
      for(let i=0;i<3;i++) addCoin(LANES[l], 1.45, z - i*4.6);
    });
    if(nl===1 && Math.random()<0.5) placeCar(lanes[1], z+rand(-2,2));
    return 28 + speed*0.85;
  }
  if(type==='dirt'){
    const withRamp = lanes.filter(()=>Math.random()<0.75);
    if(!withRamp.length) withRamp.push(lanes[0]);
    withRamp.forEach(l=>addObstacle(makeDirtRamp(), l, z));
    const vy = launchVy(speed), cl = withRamp[0];
    for(let k=1;k<=8;k++){ const t=k*0.09; addCoin(LANES[cl], 1.2+vy*t-0.5*G*t*t+0.4, z-speed*t); }
    return 30 + speed*0.9;
  }
  // coins: a weaving trail
  let l = lanes[0];
  for(let i=0;i<3;i++){ coinLine(l, z - i*9, 3); l = clamp(l + (Math.random()<0.5?-1:1), 0, 2); }
  return 24 + speed*0.6;
}

function clearWorld(){
  obstacles.forEach(o=>disposeGroup(o.g)); obstacles.length=0;
  coins.forEach(c=>scene.remove(c)); coins.length=0;
  powerups.forEach(p=>scene.remove(p.g)); powerups.length=0;
  parts.forEach(p=>{p.m.visible=false; p.life=0;});
  for(const k in powers) powers[k]=0;
  for(const k in fx) fx[k].visible=false;
  unlocked=0; pendingPower=null; turboMul=1; invuln=0;
  $('jumpBtn').hidden = true;
}

function startGame(){
  initAudio();
  clearWorld(); clearDeath(); newRun();
  if(signedIn) run.ticket = ON.startRun(truckId, RULES.GAME_VERSION);
  setRankLine('');
  Object.assign(T,{lane:1,x:0,y:0,vy:0,grounded:true,air:0,onRoof:false,susp:0,suspV:0,spin:0,roll:0,trick:null,airTricks:[],prevLane:1,laneT:-9,onRamp:false});
  combo.n = 0; combo.t = 0; gameTime = 0; nextEventAt = rand(380, 600); pendingEvent = null;
  weather.target = 0; weather.rain = 0; dayT = 0.2;
  truck.rotation.set(0,0,0); tBody.rotation.set(0,0,0);
  dist=0; coinsN=0; bonus=0; speed=START_SPEED; shake=0;
  resetScenery(); duckMusic(1);
  let z = -48;
  while(z > SPAWN_Z) z -= spawnRow(z);
  nextRow = SPAWN_Z - z;
  state='playing';
  if(truckId==='bulldog'){ powers.shield = powersMax.shield = powerDur('shield'); }
  $('menu').hidden=true; $('over').hidden=true; $('paused').hidden=true;
  renderer.domElement.focus({preventScroll:true});
}

// ---------- crash styles: a random way to wreck the truck each time ----------
const DEATHS = [
  {id:'flip',    name:'Flipped',       dur:1.0},
  {id:'shatter', name:'Shattered',     dur:1.6},
  {id:'orbit',   name:'Sent to orbit', dur:1.9},
  {id:'balls',   name:'Ball pit',      dur:1.8},
  {id:'pancake', name:'Pancaked',      dur:1.4},
  {id:'wheels',  name:'Wheels off',    dur:1.8},
  {id:'kaboom',  name:'Kaboom',        dur:1.6},
  {id:'pixels',  name:'Pixelated',     dur:2.0},
  {id:'ghost',   name:'Ghosted',       dur:2.2},
  {id:'balloon', name:'Popped',        dur:1.7},
];
let death = null, lastDeath = null;
let foundDeaths = new Set();
try{ foundDeaths = new Set(JSON.parse(localStorage.getItem('rc-rampage-crashes')||'[]')); }catch(e){}
const debris = [];
const smallBallGeo = new THREE.SphereGeometry(0.075, 8, 6);
const smallCubeGeo = new THREE.BoxGeometry(0.09, 0.09, 0.09);
const fireGeo = new THREE.IcosahedronGeometry(0.5, 1);
const starGeo = new THREE.OctahedronGeometry(0.6, 0);
const haloGeo = new THREE.TorusGeometry(0.28, 0.035, 8, 24);
const basicCache = {};
const basic = c => basicCache[c] || (basicCache[c] = new THREE.MeshBasicMaterial({color:c}));
const ghostMat = new THREE.MeshBasicMaterial({color:'#e8f1ff', transparent:true, opacity:0.45, depthWrite:false});
const CONFETTI = ['#ff5a1f','#ffc21a','#3d95f0','#b06bff','#3ddc84','#f4f1ea'];

function addDebris(mesh, o){
  mesh.castShadow = o.shadow !== false;
  scene.add(mesh);
  const p = Object.assign({m:mesh, v:new THREE.Vector3(), av:new THREE.Vector3(), g:G, bounce:0.45, floor:0.05, age:0, life:99, delay:0, s0:mesh.scale.clone()}, o);
  debris.push(p); return p;
}
function updateDebris(dt){
  for(let i=debris.length-1;i>=0;i--){
    const p = debris[i]; p.age += dt;
    if(p.age < p.delay) continue;
    p.v.y -= p.g*dt; p.m.position.addScaledVector(p.v, dt);
    p.m.rotation.x += p.av.x*dt; p.m.rotation.y += p.av.y*dt; p.m.rotation.z += p.av.z*dt;
    if(p.bounce > 0 && p.m.position.y < p.floor){
      p.m.position.y = p.floor; p.v.y = Math.abs(p.v.y) > 1 ? -p.v.y*p.bounce : 0;
      p.v.x *= 0.75; p.v.z *= 0.75; p.av.multiplyScalar(0.7);
    }
    if(p.grow){ const k = p.grow(Math.min(1,(p.age-p.delay)/p.life)); p.m.scale.copy(p.s0).multiplyScalar(Math.max(0.001,k)); }
    if(p.age > p.life + p.delay){ scene.remove(p.m); debris.splice(i,1); }
  }
}
function clearDeath(){
  debris.forEach(p=>scene.remove(p.m)); debris.length = 0;
  if(death && death.cleanup) death.cleanup();
  death = null;
  truck.visible = true; truck.scale.set(1,1,1); truck.rotation.set(0,0,0);
  tWheels.forEach(w=>w.visible = true);
}
const truckPalette = () => { const d = rigNow.def; return [d.shell, d.shell, d.shell, d.accent, '#1a1a1c', '#2a2c31']; };
const pointInTruck = () => new THREE.Vector3(truck.position.x+rand(-0.45,0.45), truck.position.y+rand(0.1,0.85), rand(-0.55,0.55));
function shownInWorld(o){ for(let a=o; a; a=a.parent){ if(!a.visible) return false; } return true; }
// every visible part of the truck becomes its own flying piece
function shatterTruck(power){
  truck.updateMatrixWorld(true);
  const c = truck.position.clone(); c.y += 0.45;
  const parts = [];
  truck.traverse(m=>{ if(m.isMesh && shownInWorld(m)) parts.push(m); });
  for(const m of parts){
    const piece = new THREE.Mesh(m.geometry, m.material);
    m.matrixWorld.decompose(piece.position, piece.quaternion, piece.scale);
    const dir = piece.position.clone().sub(c); dir.y = Math.abs(dir.y) + 0.3; dir.normalize();
    addDebris(piece, {v:dir.multiplyScalar(rand(3,7)*power).add(new THREE.Vector3(0, rand(2,5)*power, rand(-1,1))),
      av:new THREE.Vector3(rand(-12,12),rand(-12,12),rand(-12,12)), bounce:0.35, life:5});
  }
  truck.visible = false;
}
// a tumbling truck (used by Flipped and Kaboom)
function tumble(vy, spinMin, spinMax){
  T.vy = vy; T.roll = 0; T.spin = (Math.random()<0.5?-1:1)*rand(spinMin,spinMax);
  return (dt)=>{
    T.vy -= G*dt; T.y += T.vy*dt;
    if(T.y < 0){ T.y = 0; T.vy = Math.abs(T.vy) > 2 ? -T.vy*0.35 : 0; T.spin *= 0.5; }
    T.roll += T.spin*dt; T.spin *= Math.pow(0.5,dt);
    truck.position.set(T.x, T.y, 0); truck.rotation.z = T.roll; truck.rotation.x = T.roll*0.4;
  };
}
const DEATH_FX = {
  flip(){
    burst(T.x,T.y+0.5,0,'#ff5a1f',18,4,6,0.9); burst(T.x,T.y+0.5,0,'#2a2c31',14,3,5,0.9);
    return {update: tumble(6, 7, 10)};
  },
  shatter(){
    shatterTruck(1); shake = 0.9; play('smash', 0.8);
    burst(T.x,T.y+0.5,0,'#ffd34d',16,4,5,0.6);
    return {};
  },
  orbit(){
    const v = new THREE.Vector3((Math.random()<0.5?-1:1)*rand(1.5,3), 13, -16);
    let t = 0, star = null;
    play('ramp-jump', 0.9, 0.7);
    return {
      update(dt){
        t += dt;
        if(!star){
          v.y -= 7*dt; truck.position.addScaledVector(v, dt);
          truck.rotation.x += 9*dt; truck.rotation.z += 5*dt;
          truck.scale.setScalar(Math.max(0.05, 1 - t*0.5));
          if(t > 1.25){
            truck.visible = false;
            star = new THREE.Mesh(starGeo, basic('#fff6c8')); star.position.copy(truck.position); scene.add(star);
            play('select', 1, 0.7); play('coin', 0.8, 1.6);
          }
        } else {
          const k = (t-1.25)/0.5;
          star.scale.setScalar(Math.max(0.01, Math.sin(Math.min(1,k)*Math.PI)*1.8));
          star.rotation.z += dt*8;
        }
      },
      cleanup(){ if(star) scene.remove(star); },
    };
  },
  balls(){
    const pal = truckPalette();
    for(let i=0;i<150;i++){
      const m = new THREE.Mesh(smallBallGeo, mat(pick(pal),{roughness:0.3, metalness:0.1}));
      m.position.copy(pointInTruck());
      const d = m.position.clone().sub(truck.position);
      addDebris(m, {v:new THREE.Vector3(d.x*rand(4,9)+rand(-1,1), rand(2,7), d.z*rand(4,9)+rand(-2,1)), bounce:0.7, floor:0.075, life:6});
    }
    truck.visible = false; play('coin', 0.9, 0.6); play('hop', 0.7, 1.4);
    return {};
  },
  pancake(){
    let t = 0; const y0 = T.y;
    burst(T.x,0.1,0,'#b8ad9c',16,2.5,1.2,0.6); play('land', 1, 0.6);
    return {update(dt){
      t += dt;
      const k = Math.min(1, t/0.12), tt = Math.max(0, t-0.12);
      const wob = Math.sin(tt*30)*Math.exp(-tt*5)*0.08;
      truck.scale.set(1+0.55*k+wob, Math.max(0.08, 1-0.9*k-wob), 1+0.4*k+wob);
      truck.position.set(T.x, y0*(1-k), 0);
      if(t > 0.1 && t-dt <= 0.1) play('hop', 0.8, 0.55);
    }};
  },
  wheels(){
    truck.updateMatrixWorld(true);
    tWheels.forEach(w=>{
      const g = w.clone(); w.getWorldPosition(g.position); g.rotation.set(0,0,0);
      g.traverse(m=>{ m.castShadow = true; });
      w.visible = false;
      const sx = Math.sign(w.position.x) || 1;
      addDebris(g, {v:new THREE.Vector3(sx*rand(2,4.5), rand(2,4), rand(-5,2)), av:new THREE.Vector3(-rand(10,22),0,rand(-2,2)), bounce:0.55, floor:0.24, life:6});
    });
    play('smash', 0.6, 1.2);
    let t = 0, y = T.y, vy = 0;
    return {update(dt){
      t += dt; vy -= G*dt; y += vy*dt; if(y < -0.2){ y = -0.2; vy = 0; }
      const k = Math.min(1, t*4);
      truck.position.set(T.x, y, 0); truck.rotation.x = -0.18*k; truck.rotation.z = 0.12*k;
      if(y <= -0.2 && t < 1.1 && Math.random() < 0.7) burst(T.x+rand(-0.4,0.4), 0.08, 0.5, '#ffd34d', 2, 1.6, 1.6, 0.3);
    }};
  },
  kaboom(){
    const c = truck.position.clone(); c.y += 0.5;
    const fire = ['#fff3a8','#ffc21a','#ff8a1f','#ff5a1f','#d8321f'];
    for(let i=0;i<18;i++){
      const m = new THREE.Mesh(fireGeo, basic(pick(fire))); m.position.copy(c).add(new THREE.Vector3(rand(-0.6,0.6),rand(-0.2,0.7),rand(-0.6,0.6)));
      addDebris(m, {v:new THREE.Vector3(rand(-1.5,1.5),rand(1,3),rand(-1.5,1.5)), g:-1, bounce:0, life:rand(0.55,0.95), delay:rand(0,0.15),
        s0:new THREE.Vector3(1,1,1).multiplyScalar(rand(0.9,1.9)), grow:k=>Math.sin(k*Math.PI), shadow:false});
      m.scale.setScalar(0.001);
    }
    for(let i=0;i<12;i++){
      const m = new THREE.Mesh(fireGeo, mat(pick(['#3a3c42','#55585f','#6b6e76']),{roughness:1, flatShading:true})); m.position.copy(c).add(new THREE.Vector3(rand(-0.8,0.8),rand(0,0.8),rand(-0.8,0.8)));
      addDebris(m, {v:new THREE.Vector3(rand(-0.6,0.6),rand(1.5,3),rand(-0.6,0.6)), g:0, bounce:0, life:rand(1.2,1.8), delay:rand(0.15,0.4),
        s0:new THREE.Vector3(1,1,1).multiplyScalar(rand(0.7,1.4)), grow:k=>Math.sin(k*Math.PI), shadow:false});
      m.scale.setScalar(0.001);
    }
    shake = 1.2; play('smash', 1, 0.7);
    burst(c.x,c.y,0,'#ffd34d',20,6,7,0.8);
    return {update: tumble(10, 9, 13)};
  },
  pixels(){
    const pal = truckPalette(), ty = truck.position.y;
    for(let i=0;i<190;i++){
      const p = pointInTruck();
      const m = new THREE.Mesh(smallCubeGeo, mat(pick(pal),{roughness:0.5})); m.position.copy(p);
      addDebris(m, {v:new THREE.Vector3(rand(-0.4,0.4), rand(0.8,2.2), rand(-0.4,0.4)), g:-0.8, bounce:0, life:rand(0.8,1.3),
        delay:(0.95-(p.y-ty))*0.9 + rand(0,0.15), grow:k=>1-k});
    }
    truck.visible = false; play('power-end', 1, 0.7); play('unlock', 0.5, 0.6);
    return {};
  },
  ghost(){
    const g = rigNow.rig.clone();
    g.traverse(m=>{ if(m.isMesh){ m.material = ghostMat; m.castShadow = false; } });
    const halo = new THREE.Mesh(haloGeo, basic('#ffe27a')); halo.rotation.x = Math.PI/2; halo.position.y = 1.15; g.add(halo);
    g.scale.setScalar(1.25); scene.add(g); ghostMat.opacity = 0.45;
    let t = 0; const y0 = T.y;
    play('power-shield', 0.9, 0.55);
    return {
      update(dt){
        t += dt;
        const k = Math.min(1, t*4);
        truck.rotation.z = Math.PI*k; truck.position.set(T.x, Math.max(0.86*k, y0*(1-k)) + Math.sin(k*Math.PI)*0.5, 0);
        g.position.set(T.x + Math.sin(t*3)*0.35, 0.3 + t*1.5, -t*0.6); g.rotation.y = Math.sin(t*2)*0.5;
        ghostMat.opacity = Math.max(0, 0.5 - Math.max(0, t-1.4)*0.6);
      },
      cleanup(){ scene.remove(g); ghostMat.opacity = 0.45; },
    };
  },
  balloon(){
    let t = 0, popped = false;
    play('hop', 0.8, 0.45);
    return {update(dt){
      t += dt;
      if(popped) return;
      const k = Math.min(1, t/0.8);
      const s = 1 + k*1.5 + Math.sin(t*25)*0.06*k;
      truck.scale.setScalar(s); truck.position.set(T.x, T.y + t*0.9, 0); truck.rotation.z = Math.sin(t*6)*0.12;
      if(t >= 0.85){
        popped = true; truck.visible = false;
        const c = truck.position.clone(); c.y += 0.45*s;
        for(let i=0;i<80;i++){
          const m = new THREE.Mesh(smallCubeGeo, basic(pick(CONFETTI))); m.scale.set(1.5,0.25,1); m.position.copy(c);
          addDebris(m, {v:new THREE.Vector3(rand(-6,6),rand(-1,7),rand(-6,4)), g:5, bounce:0.05, floor:0.02, life:3,
            av:new THREE.Vector3(rand(-10,10),rand(-10,10),rand(-10,10)), shadow:false});
        }
        play('crash', 0.8, 1.5); shake = 0.5;
      }
    }};
  },
};

function crash(){
  state='over'; shake=0.7; overShown=false;
  T.trick = null; T.airTricks = []; combo.n = 0; weather.target = 0;
  for(const k in powers) powers[k]=0;
  $('jumpBtn').hidden = true;
  T.grounded=false;
  const def = pick(DEATHS.filter(d=>d.id!==lastDeath));
  lastDeath = def.id; crashTimer = def.dur;
  sfx.crash();
  death = Object.assign({def}, DEATH_FX[def.id]());
  const isNew = !foundDeaths.has(def.id);
  if(isNew && run) run.newCrash = true;
  foundDeaths.add(def.id);
  if(!signedIn) try{ localStorage.setItem('rc-rampage-crashes', JSON.stringify([...foundDeaths])); }catch(e){}
  if(run) run.crash = def.id;
  pop(def.name.toUpperCase()+'!', 'power', '#ff5a1f');
  $('overTitle').textContent = def.name + '!';
  $('crashFound').textContent = `Crash styles found: ${foundDeaths.size} / ${DEATHS.length}` + (isNew ? ' · new one!' : '');
  setEngine(0,0); duckMusic(0.45);
  const earned = finishRun();
  $('earned').textContent = `+${earned} coins banked · ${bank.toLocaleString('en')} in the bank`;
  renderMissions($('mListOver'));
  const s = score(); const nb = s > best;
  if(nb){ best=s; if(!signedIn) try{ localStorage.setItem('rc-rampage-best', String(best)); }catch(e){} }
  $('oScore').textContent=s; $('oCoins').textContent=coinsN; $('oDist').textContent=Math.floor(dist);
  $('bestOver').textContent=best; $('bestMenu').textContent=best; $('newBest').hidden=!nb;
}

function setPaused(p){
  if(p && state==='playing'){ prevState='playing'; state='paused'; $('paused').hidden=false; if(actx) actx.suspend(); $('resumeBtn').focus(); }
  else if(!p && state==='paused'){ state='playing'; if(actx) actx.resume(); $('paused').hidden=true; renderer.domElement.focus({preventScroll:true}); }
}
function toMenu(){
  if(actx && actx.state==='suspended') actx.resume();
  finishRun(); run = null;
  clearWorld(); clearDeath(); state='menu'; updateMyTruck(); Object.assign(T,{lane:1,x:0,y:0,vy:0}); truck.rotation.set(0,0,0); tBody.rotation.set(0,0,0);
  $('paused').hidden=true; $('over').hidden=true; $('menu').hidden=false; $('bestMenu').textContent=best; duckMusic(1); $('startBtn').focus();
}

const popEl = $('popup');
let popFree = 0;
function showPop(text, cls, color){ popEl.className=''; popEl.textContent=text; popEl.style.setProperty('--pc', color||'#fff'); void popEl.offsetWidth; popEl.className='show '+cls; }
function pop(text, cls='', color=''){
  // queue banners ~0.5 s apart; drop ones that would show too late to matter
  const now = performance.now(), at = Math.max(now, popFree);
  if(at - now > 1400) return;
  popFree = at + 520;
  if(at === now) showPop(text, cls, color); else setTimeout(()=>showPop(text, cls, color), at - now);
}

function steer(dir){
  if(state!=='playing') return;
  const nl = clamp(T.lane+dir,0,2);
  if(nl!==T.lane){ T.prevLane = T.lane; T.laneT = gameTime; T.lane = nl; }
}

// ---------- physics ----------
function physics(dt){
  // lateral
  T.x += (LANES[T.lane]-T.x)*Math.min(1, dt*11);
  // vertical integrate
  const wasGrounded = T.grounded;
  if(!T.grounded){ T.vy -= G*dt; T.y += T.vy*dt; T.air += dt; }
  let support = 0, ramp = null, bump = false, hit = false, roof = false;
  const touching = [];
  for(const o of obstacles){
    for(const zn of o.zones){
      if(Math.abs(T.x - (o.x+zn.x)) > TRUCK_HW + zn.hw) continue;
      const near = o.z + zn.z0, far = o.z + zn.z1;
      if(far > TRUCK_HL || near < -TRUCK_HL) continue;
      if(zn.kind==='ramp'){
        const lz = -o.z;                         // truck centre in obstacle space
        if(lz <= zn.z0 && lz >= zn.z1){
          const h = (zn.z0 - lz)/(zn.z0 - zn.z1) * zn.h;
          if(T.y <= h + 0.35) ramp = {h, boost:zn.boost};
        }
      } else touching.push({zn,o});
    }
  }
  if(ramp) T.y = ramp.h;                       // ride the ramp surface before testing walls
  const hitList = [], props = [], crushes = [];
  for(const {zn,o} of touching){
    if(zn.kind==='bump'){
      if(T.y < 0.2) bump = true;
    } else if(zn.kind==='prop'){
      if(T.y < zn.h) props.push(o);
    } else if(zn.kind==='crush'){
      if(T.y < zn.h + 0.05) crushes.push(o);
    } else {
      if(T.y >= zn.h - STEP){ if(zn.h > support){ support = zn.h; roof = zn.h > 1.2; } }
      else { hit = true; if(!hitList.includes(o)) hitList.push(o); }
    }
  }
  if(hit){
    if(powers.turbo > 0 || invuln > 0){ hitList.forEach(smash); }
    else if(powers.shield > 0){
      hitList.forEach(smash); powers.shield = 0; invuln = 0.8; sfx.shieldHit();
      pop('SHIELD SAVED YOU', 'power', PW.shield.color);
    }
    else { crash(); return; }
  }
  props.forEach(bashProp);
  if(crushes.length){
    crushes.forEach(crushCar);
    T.vy = Math.max(T.vy, 5); T.y = Math.max(T.y, 0.3); T.grounded = false; T.air = 0; T.suspV = -1.5;
    return;
  }
  if(ramp){
    T.y = ramp.h; T.vy = ramp.boost || launchVy(speed); T.grounded = false; T.air = 0; T.onRamp = true; T.trick = null;
    return;
  }
  if(T.onRamp){ T.onRamp=false; sfx.jump(); if(run) run.ramps++; award(10, 'AIR!'); burst(T.x,0.9,0,'#c9b79c',8,1.5,2); }
  if(T.trick){
    T.trick.t += dt;
    if(T.trick.t >= T.trick.dur){ T.airTricks.push(T.trick.type); T.trick = null; }
  }
  if(bump && T.grounded){
    T.vy = bumpVy(speed); T.grounded=false; T.air=0; sfx.hop(); if(run) run.bumps++; award(5, 'HOP', true); burst(T.x,0.2,0,'#ffc21a',6,1.2,2);
    return;
  }
  if(T.grounded){
    if(T.y > support + 0.02){ T.grounded=false; T.vy = 0; T.air = 0; }   // drove off an edge
    else T.y = support;
  } else if(T.y <= support && T.vy <= 0){
    // a trick that isn't finished when the wheels touch down is a crash
    if(T.trick){
      const p = T.trick.t/T.trick.dur;
      if(p > 0.15 && p < 0.85){ T.trick = null; T.airTricks = []; crash(); return; }
      if(p >= 0.85) T.airTricks.push(T.trick.type);
      T.trick = null;
    }
    const impact = -T.vy;
    T.y = support; T.grounded = true;
    if(T.air > 0.3){
      T.suspV = -Math.min(3, impact*0.35); sfx.land(); burst(T.x,support+0.05,0,'#b8ad9c',10,1.8,1.6);
      if(T.airTricks.length){
        const pts = T.airTricks.reduce((a,k)=>a+TRICKS[k].pts, 0);
        award(pts, T.airTricks.map(k=>TRICKS[k].name).join(' + '));
        if(run) run.tricks += T.airTricks.length;
      }
      if(T.air > 0.8){ award(25, 'BIG AIR', T.airTricks.length>0); if(run) run.bigAir++; }
      if(roof){ award(15, 'ROOF RIDE'); if(run) run.roofs++; }
    }
    T.airTricks = [];
    T.vy = 0; T.air = 0;
  }
  T.onRoof = T.grounded && support > 1.2;
  void wasGrounded;
}

// ---------- main update ----------
function update(dt){
  if(state==='playing'){
    turboMul += ((powers.turbo>0 ? 1.5 : 1) - turboMul)*Math.min(1, dt*4);
    speed = Math.min(MAX_SPEED, START_SPEED + dist*0.011) * turboMul;
  }
  else if(state==='menu') speed = 7;
  else if(state==='over') speed *= Math.pow(0.03, dt);
  const d = speed*dt;

  if(state==='playing'){
    gameTime += dt;
    if(combo.n > 0){ combo.t -= dt; if(combo.t <= 0) combo.n = 0; }
    // random events: rain, a train crossing or a police roadblock
    if(dist >= nextEventAt){
      nextEventAt = dist + rand(550, 900);
      const opts = ['train','police']; if(!weather.target) opts.push('rain','rain');
      const e = pick(opts);
      if(e==='rain') startRain(); else pendingEvent = e;
    }
    dist += d; nextRow -= d;
    if(nextRow <= 0){ const zr = SPAWN_Z + nextRow, gap = spawnRow(zr); nextRow += gap; maybePower(zr - gap*0.5); }
    // unlock new powers as the score climbs
    while(unlocked < POWERS.length && score() >= POWERS[unlocked].unlock){
      const p = POWERS[unlocked++]; pendingPower = p.id;
      sfx.unlock(); pop(p.name.toUpperCase()+' UNLOCKED', 'power', p.color);
    }
    checkMissions();
    // tick power timers
    invuln = Math.max(0, invuln - dt);
    for(const k in powers){
      if(powers[k] > 0){ powers[k] = Math.max(0, powers[k]-dt); if(powers[k]===0) sfx.expire(k); }
    }
  }

  // scroll world
  roadTex.offset.y = (roadTex.offset.y + d/TILE) % 1;
  updateScenery(d);
  for(let i=obstacles.length-1;i>=0;i--){
    const o = obstacles[i]; o.z += d; o.g.position.z = o.z;
    for(const w of o.wheels) w.rotation.x -= d*0.35/0.33;
    if(o.move && !o.fling) o.move(o, dt);
    if(o.squash !== undefined && o.squash < 1){ o.squash = Math.min(1, o.squash + dt*8); o.g.scale.y = 1 - 0.55*o.squash; }
    // near miss: you were in this vehicle's lane and swerved out just before reaching it
    if(state==='playing' && o.vehicle && !o.passed && o.z + o.front > -TRUCK_HL){
      o.passed = true;
      if(!o.fling && T.prevLane===o.lane && T.lane!==o.lane && gameTime - T.laneT < 0.9 && T.y < o.top - 0.3){
        award(20, 'NEAR MISS'); if(run) run.nearMiss++;
      }
    }
    if(o.fling){
      const f = o.fling; f.vy -= G*dt;
      o.g.position.y += f.vy*dt; o.g.position.x += f.vx*dt;
      o.g.rotation.x += f.rx*dt; o.g.rotation.z += f.rz*dt;
      if(o.g.position.y < -6){ disposeGroup(o.g); obstacles.splice(i,1); continue; }
    }
    if(o.z + o.back > 14){ disposeGroup(o.g); obstacles.splice(i,1); }
  }
  for(let i=powerups.length-1;i>=0;i--){
    const p = powerups[i]; p.g.position.z += d;
    p.g.position.y = 0.85 + Math.sin(performance.now()/250 + i)*0.12;
    p.ring.rotation.y += dt*3; p.ring.rotation.x = 0.6;
    if(state==='playing' && Math.abs(p.g.position.x-T.x)<1.1 && Math.abs(p.g.position.z)<1.1 && Math.abs(p.g.position.y-(T.y+0.4))<1.3){
      activatePower(p.id); scene.remove(p.g); powerups.splice(i,1); continue;
    }
    if(p.g.position.z > 8){ scene.remove(p.g); powerups.splice(i,1); }
  }
  const magnetOn = state==='playing' && powers.magnet > 0;
  for(let i=coins.length-1;i>=0;i--){
    const c = coins[i]; c.position.z += d; c.rotation.y += dt*4;
    if(magnetOn && c.position.z > (truckId==='shark' ? -24 : -16) && c.position.z < 1.5){
      const k = Math.min(1, dt*9);
      c.position.x += (T.x - c.position.x)*k;
      c.position.y += (T.y + 0.4 - c.position.y)*k;
      c.position.z += (0 - c.position.z)*k*0.6;
    }
    if(state==='playing' && Math.abs(c.position.x-T.x)<0.95 && Math.abs(c.position.z)<0.9 && Math.abs(c.position.y-(T.y+0.4))<0.85){
      coinsN++; sfx.coin(); if(run) run.themeCoins[playerTheme] = (run.themeCoins[playerTheme]||0) + 1; burst(c.position.x,c.position.y,0,'#ffd34d',6,1.2,2.5,0.45);
      scene.remove(c); coins.splice(i,1); continue;
    }
    if(c.position.z > 8){ scene.remove(c); coins.splice(i,1); }
  }
  for(const p of parts){
    if(p.life<=0) continue;
    p.life -= dt; p.v.y -= G*0.5*dt;
    p.m.position.addScaledVector(p.v, dt); p.m.position.z += d;
    if(p.m.position.y < 0.05){ p.m.position.y=0.05; p.v.y*=-0.3; p.v.x*=0.7; }
    const k = Math.max(0.01, p.life/p.max); p.m.scale.setScalar(k);
    p.m.rotation.x += dt*6; p.m.rotation.y += dt*4;
    if(p.life<=0) p.m.visible=false;
  }

  // truck
  if(state==='playing') physics(dt);
  else if(state==='menu'){ T.x += (0-T.x)*Math.min(1,dt*4); T.y = 0; }
  else if(state==='over'){
    if(death && death.update) death.update(dt);
    crashTimer -= dt; if(crashTimer <= 0 && !overShown){ overShown=true; $('over').hidden=false; $('retryBtn').focus(); }
  }

  // suspension spring
  T.suspV += (-T.susp*180 - T.suspV*12)*dt; T.susp += T.suspV*dt;
  const dx = LANES[T.lane]-T.x;
  updateDebris(dt);
  if(state!=='over'){
    truck.position.set(T.x, T.y, 0);
    truck.rotation.y = -dx*0.12;
    truck.rotation.x = T.grounded ? 0 : clamp(T.vy*0.03,-0.3,0.35);
    truck.rotation.z = 0;
    trickPose();
  }
  const t = performance.now()/1000;
  tBody.position.y = T.susp + (T.grounded ? Math.sin(t*28)*0.006*Math.min(1,speed/10) : 0.03);
  tBody.rotation.z = dx*0.05;
  antenna.rotation.z = -dx*0.18 + Math.sin(t*9)*0.04;
  antenna.rotation.x = 0.35 + (T.grounded?0:-T.vy*0.02);
  const spinRate = (T.grounded ? speed : speed*1.6) / 0.24;
  for(const w of tWheels) w.rotation.x -= spinRate*dt;

  // power effects on the truck (blink during the last 2 seconds)
  const showFx = (k, extra=true) => { const v = powers[k] > 0 && extra; fx[k].visible = v && (powers[k] > 2 || Math.sin(t*22) > 0); };
  showFx('shield'); showFx('magnet'); showFx('jump'); showFx('turbo');
  if(invuln > 0){ fx.shield.visible = Math.sin(t*30) > 0; }
  fx.shield.material.opacity = 0.18 + Math.sin(t*6)*0.06;
  fx.magnet.rotation.z += dt*6;
  fx.jump.scale.setScalar(1 + Math.sin(t*8)*0.08);
  fx.turbo.children.forEach((c,i)=>{ c.scale.set(1, 0.7+Math.random()*0.6, 1); });

  // motor sound: RC whine, revs up when wheels are in the air
  if(actx){
    if(state==='playing') setEngine(clamp((speed-7)/(MAX_SPEED*1.5-7),0,1) + (T.grounded?0:0.25), 0.16);
    else if(state==='menu') setEngine(0.05, 0.05);
    setMusic(playerTheme);
  }

  // camera
  const tx = T.x*0.72, ty = (portrait?3.6:2.7) + T.y*0.55;
  cam.x += (tx-cam.x)*Math.min(1,dt*6);
  cam.y += (ty-cam.y)*Math.min(1,dt*5);
  shake = Math.max(0, shake - dt);
  const sh = shake*0.25;
  camera.position.set(cam.x + rand(-sh,sh), cam.y + rand(-sh,sh), (portrait?6.2:5.0) + (speed-START_SPEED)*0.03);
  camera.lookAt(cam.x*1.1, 0.55 + T.y*0.45, -10);
  const fov = baseFov + Math.max(0,speed-START_SPEED)*0.35;
  if(Math.abs(camera.fov-fov)>0.05){ camera.fov=fov; camera.updateProjectionMatrix(); }

  sun.position.set(T.x-6, 14, -12); sun.target.position.set(T.x, 0, -4);
  updateSkyAndWeather(dt, d);

  // HUD
  if(state==='playing' || state==='over'){
    $('score').textContent = String(score()).padStart(6,'0');
    $('coins').textContent = coinsN;
    $('dist').textContent = Math.floor(dist);
    $('spd').textContent = Math.round(speed*3.6);
    const nx = POWERS[unlocked];
    $('next').textContent = nx ? `NEXT POWER ▸ ${nx.name.toUpperCase()} @ ${nx.unlock}` : 'ALL POWERS UNLOCKED';
    for(const p of POWERS){
      const chip = chips[p.id], left = powers[p.id];
      chip.el.hidden = !(left > 0);
      if(left > 0){ chip.bar.style.width = (left/(powersMax[p.id]||p.dur)*100).toFixed(1)+'%'; chip.el.classList.toggle('low', left < 2); }
    }
    jumpBtn.hidden = !(state==='playing' && powers.jump > 0 && coarse);
    const m = comboMult(), showCombo = state==='playing' && m > 1;
    comboBox.hidden = !showCombo;
    if(showCombo){ comboMultEl.textContent = '×'+m; comboBar.style.width = (combo.t/COMBO_WINDOW*100).toFixed(1)+'%'; }
  }
}
const chips = Object.fromEntries(POWERS.map(p=>{ const el=$('chip-'+p.id); return [p.id,{el, bar:el.querySelector('.bar i')}]; }));
const jumpBtn = $('jumpBtn');
const comboBox = $('comboBox'), comboMultEl = $('comboMult'), comboBar = $('comboBar');
const coarse = window.matchMedia ? window.matchMedia('(pointer: coarse)').matches : false;

// ---------- loop ----------
let last = performance.now();
function frame(now){
  const dt = Math.min(0.05, (now-last)/1000); last = now;
  if(state!=='paused') update(dt);
  renderer.render(scene, camera);
  renderGarage(dt);
  requestAnimationFrame(frame);
}

function resize(){
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w,h,false);
  camera.aspect = w/h;
  portrait = camera.aspect < 0.9;
  // keep all three lanes in view on narrow screens
  const wantH = 64 * Math.PI/180;
  baseFov = clamp(2*Math.atan(Math.tan(wantH/2)/camera.aspect)*180/Math.PI, 60, 92);
  camera.fov = baseFov; camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

// ---------- progression: coin bank, trucks to buy, power upgrades, missions ----------
let signedIn = false;                          // true once the server state has loaded
const SAVE = {
  load(k, d){ try{ const v = localStorage.getItem('rc-rampage-'+k); return v==null ? d : JSON.parse(v); }catch(e){ return d; } },
  save(k, v){ if(signedIn) return; try{ localStorage.setItem('rc-rampage-'+k, JSON.stringify(v)); }catch(e){} },
};
let bank = SAVE.load('bank', 0);
const TRUCK_PRICE = RULES.TRUCK_PRICE;
const TRUCK_PERK = {
  blaze:   'Lucky: super-power orbs show up more often',
  bulldog: 'Tough: starts every run with a Shield',
  shark:   'Coin hunter: Coin Magnet lasts 50% longer and reaches further',
  howler:  'Speed demon: Nitro lasts 2 s longer and smashes pay double',
};
let owned = SAVE.load('owned', null);
if(!Array.isArray(owned)){
  // first time: Blaze is free, and anyone who already picked another truck keeps it
  owned = ['blaze'];
  if(truckId && truckId!=='blaze') owned.push(truckId);
  SAVE.save('owned', owned);
}
const ownsTruck = id => owned.includes(id);

const UPG_STEP = {jump:4, magnet:3, shield:5, turbo:1};
const UPG_COST = RULES.UPG_COST;
const UPG_MAX = RULES.UPG_MAX;
const upgrades = Object.assign({jump:0, magnet:0, shield:0, turbo:0}, SAVE.load('upgrades', {}));
const powersMax = {jump:0, magnet:0, shield:0, turbo:0};
function powerDur(id, lvl = upgrades[id], truck = truckId){
  let d = PW[id].dur + lvl*UPG_STEP[id];
  if(id==='magnet' && truck==='shark') d *= 1.5;
  if(id==='turbo' && truck==='howler') d += 2;
  return Math.round(d*10)/10;
}

function addBank(n){ bank += n; SAVE.save('bank', bank); updateWallets(); }
function updateWallets(){ for(const id of ['bankMenu','bankGarage']) $(id).textContent = bank.toLocaleString('en'); }

const THEME_NAMES = RULES.THEME_NAMES;
const missionDef = RULES.missionDef;
let missions = SAVE.load('missions', []).filter(RULES.validMission);
let missionsDone = SAVE.load('missions-done', 0);
let run = null;

function fillMissions(){
  // signed in: the server hands out new missions after each run
  if(signedIn){ missions = missions.filter(m=>!m.done); return; }
  missions = RULES.fillMissions(missions, missionsDone, foundDeaths.size, Math.random);
  SAVE.save('missions', missions);
}
const goalNum = RULES.goalNum;
function liveStats(){
  return Object.assign({}, run, {coins:coinsN, dist, score:score(), themes:[...run.themes]});
}
function missionValue(m){
  if(run && run.finished && missionDef(m).total) return m.base;   // the run is already folded into base
  return RULES.missionValue(m, run ? liveStats() : null);
}
function newRun(){
  fillMissions();
  run = {roofs:0, ramps:0, bumps:0, powers:0, superJumps:0, smashes:0, bigAir:0, nearMiss:0, tricks:0, maxMult:1, crushed:0, bins:0, themes:new Set(['city']), themeCoins:{}, newCrash:false, finished:false, crash:null, ticket:null};
}
let missionPopAt = 0;
function checkMissions(){
  if(!run || run.finished) return;
  for(const m of missions){
    if(m.done || missionValue(m) < goalNum(m)) continue;
    m.done = true; missionsDone++;
    addBank(m.reward);
    sfx.unlock();
    // don't stomp on another banner shown in the same instant
    const delay = Math.max(0, missionPopAt - performance.now());
    missionPopAt = performance.now() + delay + 1100;
    setTimeout(()=>pop(`MISSION DONE +${m.reward}`, 'power', '#3ddc84'), delay);
  }
}
// bank the run's coins and lock in progress for missions that count across runs
function finishRun(){
  if(!run || run.finished) return 0;
  checkMissions();
  for(const m of missions) if(!m.done && missionDef(m).total) m.base = missionValue(m);
  run.finished = true;
  SAVE.save('missions', missions); SAVE.save('missions-done', missionsDone);
  addBank(coinsN);
  if(signedIn) submitRun(run);
  else setRankLine(ON.enabled ? 'Sign in to put your runs on the leaderboard.' : '', true);
  return coinsN;
}
function runReport(r){
  const stats = {};
  for(const k of RULES.RUN_STAT_KEYS) stats[k] = r[k];
  stats.themes = [...r.themes]; stats.themeCoins = Object.assign({}, r.themeCoins);
  return {version:RULES.GAME_VERSION, dist:Math.round(dist*100)/100, coins:coinsN, bonus,
          playTime:Math.round(gameTime*100)/100, stats, crash:r.crash};
}
function setRankLine(text, bad){ const el = $('rankLine'); el.textContent = text; el.classList.toggle('bad', !!bad); }
const UNRANKED = {guest:'', offline:'Couldn’t reach the server, so this run isn’t ranked. We’ll retry when you’re back online.',
                  needs_name:'Pick a driver name in Account to get ranked.'};
function submitRun(r){
  setRankLine('Sending your run…', true);
  const sent = r;
  ON.finishRun(r.ticket, runReport(r)).then(res=>{
    if(run !== sent && state==='playing') return;     // already driving again
    if(res.ranked){
      const parts = ['Verified ✓'];
      if(res.rankWeek) parts.push(`#${res.rankWeek} this week`);
      if(res.rank) parts.push(`#${res.rank} all time`);
      setRankLine(parts.join(' · '));
    } else setRankLine(UNRANKED[res.reason] ?? `Not ranked: ${ON.message(res.reason)}`, true);
  });
}
function renderMissions(el){
  el.textContent = '';
  for(const m of missions){
    const d = missionDef(m), g = goalNum(m), v = m.done ? g : Math.min(g, missionValue(m));
    const li = document.createElement('li'); if(m.done) li.className = 'done';
    const tx = document.createElement('span'); tx.className = 'mtext'; tx.textContent = d.text(m.goal);
    const rw = document.createElement('span'); rw.className = 'mreward';
    const ci = document.createElement('span'); ci.className = 'coinico'; ci.setAttribute('aria-hidden','true');
    rw.append(ci, document.createTextNode(m.done ? `+${m.reward} ✓` : String(m.reward)));
    const bar = document.createElement('span'); bar.className = 'mbar'; const bi = document.createElement('i'); bi.style.width = (v/g*100).toFixed(0)+'%'; bar.append(bi);
    const mt = document.createElement('span'); mt.className = 'mmeta';
    mt.textContent = m.done ? 'Done' : (g===1 ? 'Not yet' : `${v.toLocaleString('en')} / ${g.toLocaleString('en')}`);
    li.append(tx, rw, bar, mt); el.append(li);
  }
}

// ---------- garage: pick one of four trucks ----------
const UI_COLOR = {blaze:'#ff5a1f', bulldog:'#a3b862', shark:'#3d95f0', howler:'#b06bff'};
const garageEl = $('garage'), pCv = $('previewCv');
const pRenderer = new THREE.WebGLRenderer({canvas:pCv, antialias:true, alpha:true, preserveDrawingBuffer:true});
pRenderer.setClearColor(0x000000,0);
pRenderer.setPixelRatio(Math.min(window.devicePixelRatio||1, 2));
pRenderer.shadowMap.enabled = true; pRenderer.shadowMap.type = THREE.PCFSoftShadowMap;
const pScene = new THREE.Scene();
pScene.add(new THREE.HemisphereLight(0xe6eeff, 0x3a3540, 0.75));
{ const key = new THREE.DirectionalLight(0xffe6c8, 1.15); key.position.set(2,4,2.5); key.castShadow = true; key.shadow.mapSize.set(1024,1024);
  Object.assign(key.shadow.camera,{left:-2,right:2,top:2,bottom:-2,near:0.5,far:12}); pScene.add(key);
  const rim = new THREE.DirectionalLight(0x8fb0ff, 0.9); rim.position.set(-2.5,2,-3); pScene.add(rim); }
const turntable = new THREE.Mesh(new THREE.CylinderGeometry(1.05,1.12,0.07,48), mat('#2a2e37',{roughness:0.55,metalness:0.4}));
turntable.position.y = -0.035; turntable.receiveShadow = true; pScene.add(turntable);
const ttRing = new THREE.Mesh(new THREE.TorusGeometry(1.06,0.015,6,64), new THREE.MeshBasicMaterial({color:'#ffc21a'}));
ttRing.rotation.x = Math.PI/2; ttRing.position.y = 0.002; pScene.add(ttRing);
const pCam = new THREE.PerspectiveCamera(30, 2, 0.1, 50);
pCam.position.set(2.3,1.25,3.0); pCam.lookAt(0.25,0.34,0);
const pRigs = {};
TRUCKS.forEach(t=>{ const r = buildTruck(t.id); r.rig.visible = false; r.rig.traverse(m=>{ if(m.isMesh){ m.castShadow = true; } }); pScene.add(r.rig); pRigs[t.id] = r; });

const thumbs = {};
pRenderer.setSize(320,240,false); pCam.aspect = 320/240; pCam.updateProjectionMatrix();
TRUCKS.forEach(t=>{
  TRUCKS.forEach(o=>pRigs[o.id].rig.visible = o.id===t.id);
  pRigs[t.id].rig.rotation.y = Math.PI*0.78;
  ttRing.material.color.set(UI_COLOR[t.id]);
  pRenderer.render(pScene, pCam);
  try{ thumbs[t.id] = pCv.toDataURL('image/png'); }catch(e){ thumbs[t.id] = ''; }
});

let gSel = truckId || 'blaze', gMode = 'start', gAngle = Math.PI*0.78;
const cardEls = {};
TRUCKS.forEach(t=>{
  const bt = document.createElement('button');
  bt.type = 'button'; bt.className = 'card'; bt.id = 'card-'+t.id;
  bt.setAttribute('role','radio'); bt.style.setProperty('--gc', UI_COLOR[t.id]);
  const img = document.createElement('img'); img.alt = ''; img.src = thumbs[t.id];
  const nm = document.createElement('b'); nm.textContent = t.name;
  const tg = document.createElement('small'); tg.textContent = t.tag;
  const pr = document.createElement('span'); pr.className = 'price';
  const lb = document.createElement('span'); lb.className = 'lockbadge'; lb.textContent = 'LOCKED';
  bt.append(img, nm, tg, pr, lb);
  bt.addEventListener('click', ()=>gSelect(t.id));
  $('cards').appendChild(bt); cardEls[t.id] = bt;
});
function refreshCards(){
  TRUCKS.forEach(t=>{
    const el = cardEls[t.id], own = ownsTruck(t.id);
    el.classList.toggle('locked', !own);
    el.querySelector('.lockbadge').hidden = own;
    const pr = el.querySelector('.price'); pr.textContent = '';
    if(own){ pr.textContent = t.id===truckId ? 'Driving' : 'Owned'; pr.style.color = 'var(--muted)'; }
    else { const ci=document.createElement('span'); ci.className='coinico'; pr.append(ci, document.createTextNode(TRUCK_PRICE[t.id])); pr.style.color = ''; }
    el.setAttribute('aria-label', `${t.name}, ${own ? 'owned' : 'locked, costs '+TRUCK_PRICE[t.id]+' coins'}`);
  });
}
function refreshGarageButton(){
  const ok = $('gOk'), own = ownsTruck(gSel), price = TRUCK_PRICE[gSel];
  ok.disabled = false;
  if(own){ ok.textContent = gMode==='start' ? 'Drive this truck' : 'Use this truck'; $('gNote').textContent = ''; }
  else if(bank >= price){ ok.textContent = `Buy for ${price}`; $('gNote').textContent = `You have ${bank.toLocaleString('en')} coins`; }
  else { ok.textContent = `Buy for ${price}`; ok.disabled = true; $('gNote').textContent = `${(price-bank).toLocaleString('en')} more coins needed`; }
}
function gSelect(id, quiet){
  gSel = id;
  const t = TRUCKS.find(x=>x.id===id);
  TRUCKS.forEach(o=>{ const on = o.id===id; cardEls[o.id].setAttribute('aria-checked', String(on)); cardEls[o.id].tabIndex = on ? 0 : -1; pRigs[o.id].rig.visible = on; });
  $('gName').textContent = t.name; $('gTag').textContent = t.tag; $('gDesc').textContent = t.desc;
  $('gPerk').textContent = 'Perk · ' + TRUCK_PERK[id];
  $('gName').style.setProperty('--gc', UI_COLOR[id]);
  ttRing.material.color.set(UI_COLOR[id]);
  refreshGarageButton();
  if(!quiet) sfx.select();
}
function renderUpgrades(){
  const ul = $('ulist'); ul.textContent = '';
  for(const p of POWERS){
    const lvl = upgrades[p.id];
    const li = document.createElement('li'); li.style.setProperty('--c', p.color);
    const dot = document.createElement('i'); dot.className = 'dot';
    const info = document.createElement('div');
    const b = document.createElement('b'); b.textContent = p.name;
    const sm = document.createElement('small');
    sm.textContent = lvl < UPG_MAX ? `Lasts ${powerDur(p.id, lvl)} s → ${powerDur(p.id, lvl+1)} s` : `Lasts ${powerDur(p.id, lvl)} s · max level`;
    const pips = document.createElement('span'); pips.className = 'pips';
    for(let i=0;i<UPG_MAX;i++){ const pi = document.createElement('i'); if(i<lvl) pi.className = 'on'; pips.append(pi); }
    info.append(b, sm, pips);
    const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'btn';
    if(lvl >= UPG_MAX){ btn.textContent = 'Maxed'; btn.disabled = true; }
    else {
      const cost = UPG_COST[lvl];
      const ci = document.createElement('span'); ci.className = 'coinico';
      btn.append(document.createTextNode('Upgrade '), ci, document.createTextNode(String(cost)));
      btn.disabled = bank < cost;
      btn.setAttribute('aria-label', `Upgrade ${p.name} for ${cost} coins`);
      btn.addEventListener('click', ()=>{
        if(bank < cost || upgrades[p.id] >= UPG_MAX) return;
        if(signedIn){ buyOnline(`upg:${p.id}:${upgrades[p.id]+1}`, btn, null, ()=>{ sfx.power(p.id==='turbo' ? 'jump' : p.id); $('ulist').querySelectorAll('button')[POWERS.indexOf(p)]?.focus(); }); return; }
        addBank(-cost); upgrades[p.id]++; SAVE.save('upgrades', upgrades);
        sfx.power(p.id==='turbo' ? 'jump' : p.id);
        renderUpgrades(); refreshGarageButton();
        $('ulist').querySelectorAll('button')[POWERS.indexOf(p)]?.focus();
      });
    }
    li.append(dot, info, btn); ul.append(li);
  }
}
function showTab(which){
  const trucks = which==='trucks';
  $('tabTrucks').setAttribute('aria-selected', String(trucks)); $('tabUpgrades').setAttribute('aria-selected', String(!trucks));
  $('paneTrucks').hidden = !trucks; $('paneUpgrades').hidden = trucks;
  if(trucks) sizePreview(); else renderUpgrades();
}
function sizePreview(){
  const w = pCv.clientWidth || 600, h = pCv.clientHeight || 300;
  pRenderer.setSize(w, h, false); pCam.aspect = w/h; pCam.updateProjectionMatrix();
}
function openGarage(mode){
  gMode = mode;
  $('menu').hidden = true; $('over').hidden = true;
  garageEl.hidden = false;
  updateWallets(); refreshCards();
  showTab('trucks');
  gSelect(truckId || gSel, true);
  cardEls[gSel].focus({preventScroll:true});
}
function closeGarage(){
  garageEl.hidden = true;
  if(gMode==='over'){ $('over').hidden = false; $('retryBtn').focus(); }
  else { $('menu').hidden = false; updateMyTruck(); $('startBtn').focus(); }
}
function confirmGarage(){
  if(!ownsTruck(gSel)){
    const price = TRUCK_PRICE[gSel];
    if(bank < price) return;
    if(signedIn){ buyOnline('truck:'+gSel, $('gOk'), $('gNote')); return; }
    addBank(-price); owned.push(gSel); SAVE.save('owned', owned);
    sfx.unlock(); refreshCards(); refreshGarageButton();
    return;                                    // bought: the button now offers to drive it
  }
  truckId = gSel; sfx.confirm();
  if(signedIn){ if(ON.state?.truck !== truckId) ON.setTruck(truckId); }
  else try{ localStorage.setItem('rc-rampage-truck', truckId); }catch(e){}
  setTruckModel(truckId); updateMyTruck();
  if(gMode==='start'){ garageEl.hidden = true; startGame(); }
  else closeGarage();
}
function updateMyTruck(){
  const has = !!truckId;
  $('myTruck').hidden = !has;
  if(has){ const t = TRUCKS.find(x=>x.id===truckId); $('myTruckName').textContent = t.name; $('myTruckImg').src = thumbs[t.id]; }
  updateWallets(); renderMissions($('mListMenu'));
}
function requestStart(){ if(truckId) startGame(); else { initAudio(); openGarage('start'); } }
function cycleTruck(dir){ const i = TRUCKS.findIndex(t=>t.id===gSel); const n = TRUCKS[(i+dir+TRUCKS.length)%TRUCKS.length].id; gSelect(n); cardEls[n].focus({preventScroll:true}); }
function renderGarage(dt){
  if(garageEl.hidden || $('paneTrucks').hidden) return;
  gAngle += dt*0.7;
  const r = pRigs[gSel]; r.rig.rotation.y = gAngle;
  r.antenna.rotation.z = Math.sin(gAngle*3)*0.08;
  pRenderer.render(pScene, pCam);
}
window.addEventListener('resize', ()=>{ if(!garageEl.hidden) sizePreview(); });
$('gOk').addEventListener('click', confirmGarage);
$('gBack').addEventListener('click', closeGarage);
$('gBack2').addEventListener('click', closeGarage);
$('tabTrucks').addEventListener('click', ()=>showTab('trucks'));
$('tabUpgrades').addEventListener('click', ()=>showTab('upgrades'));
$('changeBtn').addEventListener('click', ()=>openGarage('menu'));
$('overChangeBtn').addEventListener('click', ()=>openGarage('over'));
// ---------- online: when signed in, the server owns coins, trucks, upgrades, missions and best ----------
function buyOnline(item, btn, note, after){
  btn.disabled = true; btn.setAttribute('aria-busy','true');
  ON.buy(item).then(()=>{
    if(item.startsWith('truck:')){ sfx.unlock(); refreshCards(); refreshGarageButton(); }
    else { renderUpgrades(); refreshGarageButton(); }
    if(after) after();
  }).catch(e=>{
    btn.disabled = false;
    const msg = ON.message(e.code);
    if(note) note.textContent = msg; else { $('gNote').textContent = msg; }
    if(!note) renderUpgrades();
  }).finally(()=>btn.removeAttribute('aria-busy'));
}
function applyServerState(st){
  signedIn = true;
  bank = st.coins; owned = st.trucks.slice(); Object.assign(upgrades, st.upgrades);
  missions = st.missions; missionsDone = st.missionsDone; foundDeaths = new Set(st.crashes);
  best = st.best;
  if(state!=='playing' && owned.includes(st.truck) && st.truck !== truckId){ truckId = st.truck; setTruckModel(truckId); }
  refreshProgressUI();
}
function loadGuestState(){
  signedIn = false;
  bank = SAVE.load('bank', 0);
  owned = SAVE.load('owned', ['blaze']); if(!Array.isArray(owned)) owned = ['blaze'];
  Object.assign(upgrades, {jump:0, magnet:0, shield:0, turbo:0}, SAVE.load('upgrades', {}));
  missions = SAVE.load('missions', []).filter(RULES.validMission); missionsDone = SAVE.load('missions-done', 0);
  try{ foundDeaths = new Set(JSON.parse(localStorage.getItem('rc-rampage-crashes')||'[]')); }catch(e){ foundDeaths = new Set(); }
  try{ best = parseInt(localStorage.getItem('rc-rampage-best')||'0',10)||0; }catch(e){ best = 0; }
  let t = null; try{ t = localStorage.getItem('rc-rampage-truck'); }catch(e){}
  if(state!=='playing'){ truckId = t && owned.includes(t) ? t : (t ? 'blaze' : null); if(truckId) setTruckModel(truckId); }
  if(state!=='playing') fillMissions();
  refreshProgressUI();
}
function refreshProgressUI(){
  $('bestMenu').textContent = best; $('bestOver').textContent = best;
  updateMyTruck();
  if(!$('over').hidden) renderMissions($('mListOver'));
  if(!garageEl.hidden){ refreshCards(); refreshGarageButton(); if(!$('paneUpgrades').hidden) renderUpgrades(); }
  const u = ON.user, name = ON.state?.name;
  $('accountBtn').textContent = u ? 'Account' : 'Sign in';
  const who = $('whoami'); who.textContent = '';
  if(u){ who.append('Driving as '); const b = document.createElement('b'); b.textContent = name || 'no name yet'; who.append(b); }
  else who.textContent = ON.enabled ? 'Playing as guest · progress saved on this device' : 'Progress saved on this device';
}
ON.guestSnapshot = () => ({
  coins: SAVE.load('bank', 0) | 0,
  trucks: (SAVE.load('owned', ['blaze']) || []).filter(t=>RULES.TRUCK_IDS.includes(t)),
  upgrades: Object.fromEntries(RULES.POWER_IDS.map(p=>[p, Math.max(0, Math.min(UPG_MAX, (SAVE.load('upgrades', {})||{})[p]|0))])),
  missions: SAVE.load('missions', []).filter(RULES.validMission).slice(0,3),
  missionsDone: SAVE.load('missions-done', 0) | 0,
  crashes: (()=>{ try{ return JSON.parse(localStorage.getItem('rc-rampage-crashes')||'[]').filter(d=>RULES.DEATH_IDS.includes(d)); }catch(e){ return []; } })(),
});
ON.on('state', applyServerState);
ON.on('auth', u=>{ if(!u) loadGuestState(); else refreshProgressUI(); });
ON.on('closed', back=>{ $(back==='over' ? 'retryBtn' : 'startBtn').focus(); });
$('boardBtn').addEventListener('click', ()=>ON.openBoard());
$('overBoardBtn').addEventListener('click', ()=>ON.openBoard());
$('accountBtn').addEventListener('click', ()=>ON.openAccount());

fillMissions();
updateMyTruck();
refreshProgressUI();
ON.init();

// ---------- input ----------
window.addEventListener('keydown', e=>{
  const k = e.key;
  if(ON.isOpen()){ if(k==='Escape' && !(e.target instanceof HTMLInputElement && e.target.value)) ON.closeUI(); return; }
  if(e.target instanceof HTMLInputElement) return;
  if(!garageEl.hidden){
    const onTrucks = !$('paneTrucks').hidden;
    if(onTrucks && (k==='ArrowLeft' || k==='ArrowUp')){ cycleTruck(-1); e.preventDefault(); }
    else if(onTrucks && (k==='ArrowRight' || k==='ArrowDown')){ cycleTruck(1); e.preventDefault(); }
    else if(k==='Escape'){ closeGarage(); }
    return;
  }
  if(k==='ArrowLeft' || k==='a' || k==='A'){ steer(-1); e.preventDefault(); }
  else if(k==='ArrowRight' || k==='d' || k==='D'){ steer(1); e.preventDefault(); }
  else if(k==='p' || k==='P' || k==='Escape'){ if(state==='playing') setPaused(true); else if(state==='paused') setPaused(false); }
  else if(k==='m' || k==='M'){ initAudio(); setMusicOff(!musicOff); }
  else if(k==='n' || k==='N'){ initAudio(); setSfxOff(!sfxOff); }
  else if(state==='playing' && (k==='ArrowUp' || k==='w' || k==='W' || k===' ')){ superJump(); e.preventDefault(); }
  else if(state==='playing' && (k==='ArrowDown' || k==='s' || k==='S')){ startTrick('flip'); e.preventDefault(); }
  else if((k===' ' || k==='Enter') && document.activeElement===renderer.domElement){
    if(state==='menu' && !$('menu').hidden) { requestStart(); e.preventDefault(); }
    else if(state==='over' && !$('over').hidden) { startGame(); e.preventDefault(); }
  }
});
let ptr = null;
const cv = renderer.domElement;
cv.addEventListener('pointerdown', e=>{ ptr = {x:e.clientX, y:e.clientY, t:performance.now(), used:false}; });
cv.addEventListener('pointermove', e=>{
  if(!ptr || ptr.used) return;
  const dx = e.clientX-ptr.x, dy = e.clientY-ptr.y;
  if(dy < -28 && Math.abs(dy) > Math.abs(dx)){ superJump(); ptr.used = true; }
  else if(dy > 28 && Math.abs(dy) > Math.abs(dx)){ startTrick('flip'); ptr.used = true; }
  else if(Math.abs(dx) > 28){ steer(dx>0?1:-1); ptr.used = true; }
});
jumpBtn.addEventListener('pointerdown', e=>{ e.preventDefault(); superJump(); });
jumpBtn.addEventListener('click', e=>{ if(e.detail===0) superJump(); });
cv.addEventListener('pointerup', e=>{
  if(ptr && !ptr.used && performance.now()-ptr.t < 350){
    steer(e.clientX < window.innerWidth/2 ? -1 : 1);
  }
  ptr = null;
});
cv.addEventListener('pointercancel', ()=>{ ptr=null; });

$('startBtn').addEventListener('click', requestStart);
$('retryBtn').addEventListener('click', startGame);
$('resumeBtn').addEventListener('click', ()=>setPaused(false));
$('quitBtn').addEventListener('click', toMenu);
$('pauseBtn').addEventListener('click', ()=>{ if(state==='playing') setPaused(true); else if(state==='paused') setPaused(false); });
$('musicBtn').addEventListener('click', ()=>{ initAudio(); setMusicOff(!musicOff); });
$('sfxBtn').addEventListener('click', ()=>{ initAudio(); setSfxOff(!sfxOff); });
document.addEventListener('visibilitychange', ()=>{ if(document.hidden) setPaused(true); });

$('bestMenu').textContent = best; $('bestOver').textContent = best;
$('startBtn').focus({preventScroll:true});
requestAnimationFrame(t=>{ last=t; requestAnimationFrame(frame); });
})();
