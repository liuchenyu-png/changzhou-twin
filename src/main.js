// 常州主城区数字孪生：Blender 模型（city / landmarks / props）+ 程序化材质 + 昼夜天气 + 车流 + 地标卡片 + 漫游
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { U, makeMaterial } from './materials.js';
import { makeSky, lighting, WEATHER } from './sky.js';
import { Trees } from './trees.js';
import { Traffic } from './traffic.js';
import { Facades } from './facades.js';
import { parseInfill, buildInfill, infillRecords } from './infill.js';
import { LANDMARKS, FAR, CAT_COLOR, toLonLat, fromLonLat } from './data.js';

// 大气透视：指数高度雾（fogNear = 地面密度，fogFar = 标高米），近处清透、远处与低空发蓝
THREE.ShaderChunk.fog_pars_vertex = `#ifdef USE_FOG
 varying vec3 vFogRel;
#endif`;
THREE.ShaderChunk.fog_vertex = `#ifdef USE_FOG
 vFogRel = (vec4(mvPosition.xyz, 0.) * viewMatrix).xyz;
#endif`;
THREE.ShaderChunk.fog_pars_fragment = `#ifdef USE_FOG
 uniform vec3 fogColor; uniform float fogNear; uniform float fogFar; varying vec3 vFogRel;
#endif`;
THREE.ShaderChunk.fog_fragment = `#ifdef USE_FOG
  { float fd = length(vFogRel); float dy = vFogRel.y / max(fd, 1e-3); float hc = max(cameraPosition.y, 0.);
    float k = abs(dy * fd) > .5 ? (1. - exp(-dy * fd / fogFar)) / (dy * fd / fogFar) : 1. - dy * fd / fogFar * .5;
    float od = fogNear * exp(-hc / fogFar) * fd * k;
    float fogFactor = 1. - exp(-od);
    gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, clamp(fogFactor, 0., 1.)); }
#endif`;

const BBOX = { x0: -14000, x1: 7000, y0: -12000, y1: 10000 };
const $ = (s) => document.querySelector(s);
const W3 = (x, y, h = 0) => new THREE.Vector3(x, h, -y); // 地图 (x 东, y 北) → three

// ---------- 渲染器 ----------
const canvas = $('#gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, reversedDepthBuffer: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.9;
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap; renderer.shadowMap.autoUpdate = false;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 2, 90000);
const controls = new MapControls(camera, canvas);
controls.enableDamping = true; controls.dampingFactor = 0.08; controls.screenSpacePanning = false;
controls.minDistance = 40; controls.maxDistance = 26000; controls.maxPolarAngle = Math.PI * 0.47; controls.zoomToCursor = true;

const sky = makeSky(); scene.add(sky.mesh);
const skyEnvScene = new THREE.Scene(); const envMat = sky.mesh.material.clone(); envMat.uniforms = { ...sky.uniforms, uDisk: { value: 0 } }; const envSky = new THREE.Mesh(sky.mesh.geometry, envMat); envSky.scale.setScalar(50); skyEnvScene.add(envSky);
const pmrem = new THREE.PMREMGenerator(renderer);
const sun = new THREE.DirectionalLight(0xffffff, 3); sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096); sun.shadow.bias = -0.0003; sun.shadow.normalBias = 0.8;
scene.add(sun, sun.target);
const hemi = new THREE.HemisphereLight(0xbcd6ec, 0x4a4a3c, 0.8); scene.add(hemi);
scene.fog = new THREE.Fog(0xb9d3e8, 0.00006, 900);

const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(innerWidth, innerHeight, { type: THREE.HalfFloatType, samples: 4 }));
composer.addPass(new RenderPass(scene, camera));
// 环境光遮蔽：楼脚、街道峡谷、树下、女儿墙内侧的接触阴影
const gtao = new GTAOPass(scene, camera, innerWidth, innerHeight); gtao.blendIntensity = 1.0;
gtao.updateGtaoMaterial({ radius: 8, distanceExponent: 1.4, thickness: 2, scale: 1.2, samples: 12 });
gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 12 });
composer.addPass(gtao);
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth / 2, innerHeight / 2), 0.2, 0.55, 0.92); composer.addPass(bloom);
composer.addPass(new OutputPass());
// 调色：轻 S 曲线、饱和度、暗角；夜里叠加“蓝调时刻”三段色映射（借鉴 The Blue Hour：暗部深蓝、中间调钴蓝、亮部暖橙）
const grade = new ShaderPass({
  uniforms: { tDiffuse: { value: null }, uSat: { value: 1.06 }, uCon: { value: 1.06 }, uVig: { value: 0.28 }, uTint: { value: new THREE.Vector3(1.0, 1.0, 1.0) },
    uNight: { value: 0 }, uRamp: { value: 0.4 }, uTime: { value: 0 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }',
  fragmentShader: `uniform sampler2D tDiffuse; uniform float uSat; uniform float uCon; uniform float uVig; uniform vec3 uTint; uniform float uNight; uniform float uRamp; uniform float uTime; varying vec2 vUv;
    void main(){ vec3 c = texture2D(tDiffuse, vUv).rgb;
      if (uNight > .01) {   // 在线性空间里按亮度映射到三段色，保留一半原色度
        vec3 g = pow(c, vec3(2.2)); float L = clamp(dot(g, vec3(.2126, .7152, .0722)), 0., 1.);
        vec3 ramp = mix(mix(vec3(.004, .006, .022), vec3(.04, .11, .27), smoothstep(0., .45, L)), vec3(1., .8, .52), smoothstep(.35, 1., L));
        vec3 graded = ramp * mix(vec3(1.), g / max(L, 1e-4), .5);
        g = mix(g, graded, uRamp * uNight);
        c = pow(max(g, 0.), vec3(1. / 2.2));
        c = max(c - .012 * uNight, 0.) / (1. - .012 * uNight);                    // 压黑点
      }
      float l = dot(c, vec3(.2126, .7152, .0722)); c = mix(vec3(l), c, uSat);
      c = clamp((c - .5) * uCon + .5, 0., 1.); c = mix(c, c * c * (3. - 2. * c), .25);
      c *= uTint;
      vec2 q = vUv - .5; c *= 1. - uVig * smoothstep(.25, .85, dot(q, q) * 2.2);
      float gr = fract(sin(dot(vUv * 1000. + fract(uTime) * 17., vec2(12.9898, 78.233))) * 43758.5453);
      c += (gr - .5) * .025 * uNight * (.3 + .7 * smoothstep(0., .1, l));       // 夜里细颗粒，压住暗部色带
      gl_FragColor = vec4(c, 1.); }`,
});
composer.addPass(grade);

// ---------- 水面平面反射 ----------
const WATER_Y = 0.18;
const reflRT = new THREE.WebGLRenderTarget(Math.round(innerWidth * 0.5), Math.round(innerHeight * 0.5), { type: THREE.HalfFloatType, samples: 2 });
const reflCam = new THREE.PerspectiveCamera(); const reflPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -WATER_Y + 0.05);
const reflBias = new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
U.tReflect.value = reflRT.texture;
function renderReflection() {
  if (camera.position.y < WATER_Y + 0.3 || !layers.water.length || !layers.water[0].visible) { U.uReflOn.value = 0; return; }
  reflCam.copy(camera);
  reflCam.position.y = 2 * WATER_Y - camera.position.y;
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion); fwd.y = -fwd.y;
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion); up.y = -up.y;
  reflCam.up.copy(up); reflCam.lookAt(reflCam.position.clone().add(fwd)); reflCam.updateMatrixWorld();
  U.uReflMat.value.multiplyMatrices(reflBias, reflCam.projectionMatrix).multiply(reflCam.matrixWorldInverse);
  for (const o of layers.water) o.visible = false; fx.visible = false; trees?.far.forEach((m) => m.visible = false);
  const fogFar = scene.fog.far; scene.fog.far = fogFar * 0.7;
  renderer.clippingPlanes = [reflPlane];
  renderer.setRenderTarget(reflRT); renderer.clear(); renderer.render(scene, reflCam); renderer.setRenderTarget(null);
  renderer.clippingPlanes = [];
  scene.fog.far = fogFar;
  for (const o of layers.water) o.visible = true; fx.visible = true; if (trees?.visible) trees.far.forEach((m) => m.visible = true);
  U.uReflOn.value = 1;
}

// ---------- 载入 ----------
const manager = new THREE.LoadingManager();
manager.onProgress = (url, a, b) => setLoad(a / b);
let loadFrac = 0; function setLoad(f) { loadFrac = Math.max(loadFrac, f); $('#lbar').style.width = (loadFrac * 100).toFixed(0) + '%'; $('#ltxt').textContent = (loadFrac * 100).toFixed(0) + '%'; }
const draco = new DRACOLoader(manager).setDecoderPath('./draco/');
const gltf = new GLTFLoader(manager).setDRACOLoader(draco);
const load = (u) => new Promise((res, rej) => gltf.load(u, res, (e) => { if (e.total) setLoad(Math.min(0.95, e.loaded / e.total * 0.9)); }, rej));

const layers = { bld: [], roads: [], ground: [], water: [], landmarks: [] };
let trees, traffic, stats, facades;
const matCache = new Map(); const floodMats = new Set();
function convert(root, layerOf) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    const src = o.material; let m = matCache.get(src.name);
    if (m === undefined) { m = makeMaterial(src); matCache.set(src.name, m); }
    if (m) o.material = m; else if (src.isMeshStandardMaterial) {
      src.envMapIntensity = 1;
      if (/^LM_dino_LM_dino_brachio/.test(src.name)) src.color.set(0x56633f); if (/^LM_dino_LM_dino_trex/.test(src.name)) src.color.set(0x6a4630);
      // 地标夜景泛光：贴图自身作为自发光，强度随夜色
      if (/^LMT_|^LM_/.test(src.name)) { src.emissive = new THREE.Color(1, 0.86, 0.66); if (src.map) src.emissiveMap = src.map; src.emissiveIntensity = 0; floodMats.add(src); }
    }
    const L = layerOf(o);
    if (L) layers[L].push(o);
    o.castShadow = L === 'bld' || L === 'landmarks' || (L === 'roads' && /R_bridge/.test(o.material.name));
    o.receiveShadow = true;
    if (L === 'water') o.castShadow = false;
  });
}

async function init() {
  const [city, lm, props, treeBuf, bldBuf, infBuf, roads, st] = await Promise.all([
    load('./models/city.glb'), load('./models/landmarks.glb'), load('./models/props.glb'),
    fetch('./data/trees.bin').then((r) => r.arrayBuffer()), fetch('./data/bld.bin').then((r) => r.arrayBuffer()), fetch('./data/infill.bin').then((r) => r.arrayBuffer()), fetch('./data/traffic.json').then((r) => r.json()), fetch('./data/stats.json').then((r) => r.json()),
  ]);
  stats = st;
  convert(city.scene, (o) => { let p = o; while (p && !/^(bld|roads|ground|water)_/.test(p.name)) p = p.parent; return p ? p.name.split('_')[0] : 'ground'; });
  scene.add(city.scene);
  convert(lm.scene, () => 'landmarks');
  scene.add(lm.scene);
  trees = new Trees(scene, props.scene, new Float32Array(treeBuf), BBOX);
  traffic = new Traffic(scene, props.scene, roads);
  const inf = parseInfill(infBuf);
  const bm = (n) => { if (!matCache.has(n)) matCache.set(n, makeMaterial(new THREE.MeshStandardMaterial({ name: n }))); return matCache.get(n); };
  for (const m of buildInfill(inf, [bm('B_wall'), bm('B_roof'), bm('B_hroof')])) { scene.add(m); layers.bld.push(m); }
  facades = new Facades(scene, matCache.get('B_wall'), bldBuf, infillRecords(inf));
  $('#st-b').textContent = st.buildings.toLocaleString(); $('#st-r').textContent = st.roadKm.toLocaleString(); $('#st-g').textContent = st.greenKm2; $('#st-l').textContent = LANDMARKS.length;
  buildLabels(); buildList();
  applyLighting(true);
  setLoad(1); setTimeout(() => $('#loading').classList.add('done'), 300);
  window.__cz = { facades, renderer, bloom, gtao, grade, composer, sun, hemi, U, scene, camera, controls, trees, traffic, setHour, setWeather, flyTo, openCard, enterWalk, exitWalk, LANDMARKS, ready: true };
  intro();
}

// ---------- 时间 / 天气 ----------
let hour = 15.5, weather = 'clear', playing = false, envKey = '';
function setHour(h) { hour = (h + 24) % 24; $('#time').value = hour; applyLighting(); }
function setWeather(w) { weather = w; document.querySelectorAll('.wx button').forEach((b) => b.classList.toggle('on', b.dataset.w === w)); applyLighting(true); }
function applyLighting(force) {
  const w = WEATHER[weather]; const L = lighting(hour, w);
  const su = sky.uniforms;
  su.uSun.value.copy(L.sun.dir); su.uMoon.value.copy(L.moon); su.uZenith.value.copy(L.zen); su.uHorizon.value.copy(L.hor);
  su.uGround.value.copy(L.hor).multiplyScalar(0.55); su.uSunCol.value.copy(L.sunCol); su.uCloud.value = w.cloud; su.uCloudDark.value = w.dark; su.uNight.value = L.night; su.uHaze.value = w.haze;
  const nightLight = L.sun.elev < -2;
  const ldir = nightLight ? L.moon : L.sun.dir;
  sun.userData.dir = ldir.clone();
  sun.color.copy(nightLight ? new THREE.Color(0x8aa4d6) : L.sunCol);
  sun.intensity = nightLight ? 0.25 * (1 - w.cloud * 0.8) : L.sunI;
  sun.castShadow = sun.intensity > 0.15 && w.sun > 0.25;
  hemi.color.copy(L.zen).lerp(new THREE.Color(0xffffff), 0.35); hemi.groundColor.copy(L.hor).multiplyScalar(0.4);
  hemi.intensity = L.hemiI + (nightLight ? 0.12 : 0);
  scene.fog.color.copy(L.hor).lerp(L.zen, 0.15);
  U.uSunDir.value.copy(ldir); U.uSunCol.value.copy(sun.color).multiplyScalar(sun.intensity * (nightLight ? 0.3 : 1));
  grade.uniforms.uSat.value = 1.08 - w.cloud * 0.12 - L.night * 0.12; grade.uniforms.uNight.value = L.night; grade.uniforms.uVig.value = 0.28 + L.night * 0.12; grade.uniforms.uTint.value.set(1 + L.golden * 0.04, 1, 1 - L.golden * 0.05);
  U.uNight.value = L.night; for (const m of floodMats) m.emissiveIntensity = L.night * (m.map ? 0.55 : 0.18); U.uWet.value = w.wet; U.uSnow.value = w.snow;
  renderer.toneMappingExposure = 0.72 + L.night * 0.2;
  bloom.strength = 0.06 + L.night * 0.38; bloom.threshold = 1.6 - L.night * 0.85; bloom.radius = 0.55 + L.night * 0.3;
  // 时钟
  const hh = Math.floor(hour), mm = Math.floor((hour - hh) * 60);
  $('#clock').textContent = String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
  $('#ampm').textContent = hour < 5 ? '凌晨' : hour < 11 ? '上午' : hour < 13 ? '中午' : hour < 18 ? '下午' : '晚上';
  $('#wxlabel').textContent = w.label;
  const temp = 13 + 6 * Math.sin((hour - 9) / 24 * Math.PI * 2) + w.temp; $('#temp').textContent = (temp >= 0 ? '+' : '') + temp.toFixed(0) + '°';
  // 环境贴图（天空变化够大才重算）
  const key = weather + Math.round(hour * 4);
  if (force || key !== envKey) {
    envKey = key; const rt = pmrem.fromScene(skyEnvScene, 0.02, 0.1, 200);
    if (scene.environment) scene.environment.dispose(); scene.environment = rt.texture;
  }
  setWeatherFx(w);
}

// ---------- 雨雪 ----------
const fx = new THREE.Group(); scene.add(fx);
const RAIN_N = 14000, FX_R = 220;
const rainGeo = new THREE.BufferGeometry(); const rainPos = new Float32Array(RAIN_N * 6);
for (let i = 0; i < RAIN_N; i++) { const x = (Math.random() - 0.5) * 2 * FX_R, y = Math.random() * 300, z = (Math.random() - 0.5) * 2 * FX_R; rainPos.set([x, y, z, x + 0.15, y - 2.2, z], i * 6); }
rainGeo.setAttribute('position', new THREE.BufferAttribute(rainPos, 3));
const rain = new THREE.LineSegments(rainGeo, new THREE.LineBasicMaterial({ color: 0xaab8c4, transparent: true, opacity: 0.35, fog: false }));
rain.frustumCulled = false;
const SNOW_N = 16000; const snowGeo = new THREE.BufferGeometry(); const snowPos = new Float32Array(SNOW_N * 3);
for (let i = 0; i < SNOW_N; i++) snowPos.set([(Math.random() - 0.5) * 2 * FX_R, Math.random() * 300, (Math.random() - 0.5) * 2 * FX_R], i * 3);
snowGeo.setAttribute('position', new THREE.BufferAttribute(snowPos, 3));
const flake = (() => { const c = document.createElement('canvas'); c.width = c.height = 32; const g = c.getContext('2d'); const gr = g.createRadialGradient(16, 16, 0, 16, 16, 16); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, 32, 32); return new THREE.CanvasTexture(c); })();
const snow = new THREE.Points(snowGeo, new THREE.PointsMaterial({ size: 0.9, map: flake, transparent: true, depthWrite: false, opacity: 0.9, fog: false }));
snow.frustumCulled = false;
function setWeatherFx(w) { fx.clear(); if (w.wet >= 1) fx.add(rain); if (w.snow) fx.add(snow); }
function updateFx(dt) {
  fx.position.set(camera.position.x, Math.max(0, camera.position.y - 150), camera.position.z);
  if (rain.parent) { const a = rainPos; for (let i = 0; i < RAIN_N; i++) { const o = i * 6; a[o + 1] -= 60 * dt; a[o + 4] -= 60 * dt; if (a[o + 4] < 0) { a[o + 1] += 300; a[o + 4] += 300; } } rainGeo.attributes.position.needsUpdate = true; }
  if (snow.parent) { const a = snowPos; const t = performance.now() / 1000; for (let i = 0; i < SNOW_N; i++) { const o = i * 3; a[o + 1] -= 3 * dt; a[o] += Math.sin(t + i) * 0.6 * dt; if (a[o + 1] < 0) a[o + 1] += 300; } snowGeo.attributes.position.needsUpdate = true; }
}

// ---------- 地标标注 ----------
const labelEls = [];
function buildLabels() {
  const box = $('#labels');
  for (const lm of LANDMARKS) {
    const el = document.createElement('div'); el.className = 'lb';
    el.innerHTML = `<div class="chip"><i style="background:${CAT_COLOR[lm.cat]}">${lm.cat[0]}</i>${lm.name}</div><div class="stem"></div>`;
    el.onclick = () => openCard(lm, true); box.appendChild(el);
    labelEls.push({ el, lm, pos: W3(lm.p[0], lm.p[1], lm.h + 6), w: 0, h: 0 });
  }
  // 地图外名胜：沿方位投到地图边缘
  const cx = (BBOX.x0 + BBOX.x1) / 2, cy = (BBOX.y0 + BBOX.y1) / 2;
  for (const f of FAR) {
    const [x, y] = fromLonLat(f.lon, f.lat); const dx = x - cx, dy = y - cy;
    const t = Math.min((dx > 0 ? BBOX.x1 - cx : BBOX.x0 - cx) / dx, (dy > 0 ? BBOX.y1 - cy : BBOX.y0 - cy) / dy) * 0.97;
    const km = Math.round(Math.hypot(x, y) / 1000);
    const ang = Math.atan2(dx, dy) * 180 / Math.PI; const arrow = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'][Math.round(((ang + 360) % 360) / 45) % 8];
    const el = document.createElement('div'); el.className = 'lb far';
    el.innerHTML = `<div class="chip"><i style="background:#d9b26a">${arrow}</i>${f.name}<small>${f.note} · 约 ${km} km</small></div><div class="stem"></div>`;
    $('#labels').appendChild(el);
    labelEls.push({ el, far: f, pos: W3(cx + dx * t, cy + dy * t, 40), w: 0, h: 0 });
  }
}
const v3 = new THREE.Vector3();
let labelsOn = true, selected = null;
function updateLabels() {
  const placed = []; const W = innerWidth, H = innerHeight;
  const items = labelEls.map((L) => { v3.copy(L.pos).project(camera); return { L, x: (v3.x + 1) / 2 * W, y: (1 - v3.y) / 2 * H, z: v3.z, d: camera.position.distanceTo(L.pos) }; });
  items.sort((a, b) => (b.L === selected) - (a.L === selected) || a.d - b.d);
  for (const it of items) {
    const { L } = it; const el = L.el;
    const inView = labelsOn && it.x > -50 && it.x < W + 50 && it.y > 0 && it.y < H + 50 && Math.abs(it.z) <= 1 && camera.position.distanceTo(L.pos) < 40000;
    if (!inView) { if (el.style.display !== 'none') el.style.display = 'none'; continue; }
    if (!L.w) { el.style.display = ''; L.w = el.firstChild.offsetWidth; L.h = el.firstChild.offsetHeight; }
    const stem = L.far ? 10 : Math.max(14, Math.min(46, 9000 / it.d * 4));
    const x = it.x - 10, y = it.y - stem - L.h;
    const r = [x, y, x + L.w, y + L.h];
    if (placed.some((p) => !(r[2] < p[0] || r[0] > p[2] || r[3] < p[1] || r[1] > p[3])) && L !== selected) { el.style.display = 'none'; continue; }
    placed.push(r); el.style.display = '';
    el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`; el.lastChild.style.height = stem + 'px';
    el.classList.toggle('sel', L === selected);
  }
}
function buildList() {
  const box = $('#lmlist');
  for (const lm of LANDMARKS) { const b = document.createElement('button'); b.innerHTML = `<i style="background:${CAT_COLOR[lm.cat]}"></i>${lm.name}`; b.onclick = () => openCard(lm, true); box.appendChild(b); }
}

// ---------- 卡片 ----------
let cardLm = null;
function openCard(lm, fly) {
  cardLm = lm; selected = labelEls.find((L) => L.lm === lm) || null;
  $('#c-cat').textContent = lm.cat; $('#c-name').textContent = lm.name; $('#c-en').textContent = lm.en;
  $('#c-hero').style.background = `linear-gradient(120deg, ${CAT_COLOR[lm.cat]}99, rgba(40,52,64,.2) 70%)`;
  $('#c-stats').innerHTML = lm.stats.map(([k, v, u]) => `<div><small>${k}</small><b>${v}</b><em>${u}</em></div>`).join('');
  $('#c-desc').textContent = lm.desc; $('#c-pts').innerHTML = lm.pts.map((p) => `<li>${p}</li>`).join('');
  const [lon, lat] = toLonLat(lm.p[0], lm.p[1]);
  $('#c-ll').textContent = `${lat.toFixed(4)}°N  ${lon.toFixed(4)}°E · 距天宁寺 ${(Math.hypot(lm.p[0] + 20, lm.p[1] + 982) / 1000).toFixed(1)} km`;
  $('#c-dist').textContent = '常州 · ' + (lm.p[1] > 1500 ? '新北' : lm.p[1] < -5000 ? '武进' : lm.p[0] < -1200 ? '钟楼' : '天宁');
  $('#card').hidden = false;
  if (fly) flyTo(lm);
}
$('#c-close').onclick = () => { $('#card').hidden = true; selected = null; };
$('#c-fly').onclick = () => cardLm && flyTo(cardLm);
$('#c-walk').onclick = () => cardLm && walkTo(cardLm);

// ---------- 相机动画 ----------
let anim = null;
function flyTo(lm, opt = {}) {
  if (mode === 'walk') exitWalk();
  const h = lm.h; const dist = opt.dist || Math.max(h * 2.6, 340); const tgt = W3(lm.p[0], lm.p[1], Math.min(h * 0.4, 90));
  const az = opt.az ?? (-35 * Math.PI / 180); const el = opt.el ?? (30 * Math.PI / 180);
  const pos = tgt.clone().add(new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).multiplyScalar(dist));
  animateTo(pos, tgt, opt.dur || 2.4);
}
function animateTo(pos, tgt, dur) {
  anim = { p0: camera.position.clone(), t0: controls.target.clone(), p1: pos, t1: tgt, t: 0, dur };
  // 远距离：中途抬高，像飞行
  anim.lift = Math.min(4000, anim.p0.distanceTo(pos) * 0.25);
}
function stepAnim(dt) {
  if (!anim) return; anim.t = Math.min(1, anim.t + dt / anim.dur); const k = anim.t < 0.5 ? 4 * anim.t ** 3 : 1 - (-2 * anim.t + 2) ** 3 / 2;
  camera.position.lerpVectors(anim.p0, anim.p1, k); camera.position.y += Math.sin(Math.PI * k) * anim.lift;
  controls.target.lerpVectors(anim.t0, anim.t1, k);
  if (anim.t >= 1) anim = null;
}
function intro() {
  camera.position.copy(W3(5200, -9500, 9000)); controls.target.copy(W3(0, -600, 0)); controls.update();
  animateTo(W3(1700, -3100, 1150), W3(150, -1000, 40), 4.5);
}
function home() { animateTo(W3(3800, -6200, 3600), W3(-500, -500, 0), 2.6); }

// ---------- 漫游 ----------
let mode = 'orbit'; const keys = {}; let yaw = 0, pitch = 0;
function enterWalk(pos, lookAt) {
  mode = 'walk'; anim = null; controls.enabled = false;
  document.querySelectorAll('.modes button').forEach((b) => b.classList.toggle('on', b.dataset.mode === 'walk'));
  if (pos) camera.position.copy(pos); else {
    // 落到离视点最近的道路边（不会掉进楼或地标里）
    const tx = controls.target.x, ty = -controls.target.z; let best = null, bd = Infinity;
    for (const p of traffic.paths) { const a = p.pts; for (let i = 0; i < a.length; i += 3) { const d = (a[i] - tx) ** 2 + (a[i + 1] - ty) ** 2; if (d < bd && a[i + 2] < 1) { bd = d; best = [a[i], a[i + 1]]; } } }
    const d = controls.target.clone().sub(camera.position); d.y = 0; d.normalize();
    camera.position.copy(best ? W3(best[0], best[1], 1.7) : controls.target.clone().addScaledVector(d, -30).setY(1.7));
    lookAt = camera.position.clone().add(d.multiplyScalar(50)); }
  const dir = (lookAt || camera.position.clone().add(new THREE.Vector3(0, 0, -1))).clone().sub(camera.position).normalize();
  yaw = Math.atan2(-dir.x, -dir.z); pitch = Math.asin(Math.max(-0.9, Math.min(0.9, dir.y)));
  $('#walkhint').hidden = false;
}
function exitWalk() {
  if (mode !== 'walk') return; mode = 'orbit'; controls.enabled = true; $('#walkhint').hidden = true;
  const f = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
  controls.target.copy(camera.position).addScaledVector(f, 120); controls.target.y = 0;
  camera.position.addScaledVector(f, -80); camera.position.y = Math.max(camera.position.y, 60);
  document.querySelectorAll('.modes button').forEach((b) => b.classList.toggle('on', b.dataset.mode === 'orbit'));
}
function walkTo(lm) {
  // 找离地标最近的主干道点，站在路边看向地标
  let best = null, bd = Infinity;
  for (const p of traffic.paths) { const a = p.pts; for (let i = 0; i < a.length; i += 3) { const d = Math.hypot(a[i] - lm.p[0], a[i + 1] - lm.p[1]); const want = Math.abs(d - Math.max(90, lm.h * 1.1)); if (want < bd && a[i + 2] < 1) { bd = want; best = [a[i], a[i + 1]]; } } }
  const pos = best ? W3(best[0], best[1], 1.7) : W3(lm.p[0], lm.p[1] - 150, 1.7);
  enterWalk(pos, W3(lm.p[0], lm.p[1], Math.min(lm.h * 0.5, 60)));
}
addEventListener('keydown', (e) => { keys[e.code] = true; if (e.code === 'Escape') exitWalk(); });
addEventListener('keyup', (e) => { keys[e.code] = false; });
let drag = null;
canvas.addEventListener('pointerdown', (e) => { if (mode === 'walk') { drag = [e.clientX, e.clientY]; canvas.setPointerCapture(e.pointerId); } });
canvas.addEventListener('pointermove', (e) => { if (mode === 'walk' && drag) { yaw -= (e.clientX - drag[0]) * 0.003; pitch = Math.max(-1.3, Math.min(1.3, pitch - (e.clientY - drag[1]) * 0.003)); drag = [e.clientX, e.clientY]; } });
canvas.addEventListener('pointerup', () => { drag = null; });
function stepWalk(dt) {
  const sp = (keys.ShiftLeft || keys.ShiftRight ? 60 : 9) * dt;
  const f = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw)), r = new THREE.Vector3(-f.z, 0, f.x);
  if (keys.KeyW) camera.position.addScaledVector(f, sp); if (keys.KeyS) camera.position.addScaledVector(f, -sp);
  if (keys.KeyD) camera.position.addScaledVector(r, sp); if (keys.KeyA) camera.position.addScaledVector(r, -sp);
  if (keys.Space) camera.position.y += sp; if (keys.KeyC) camera.position.y -= sp;
  camera.position.y = Math.max(1.7, camera.position.y);
  camera.quaternion.setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
}

// ---------- UI ----------
document.querySelectorAll('.modes button').forEach((b) => b.onclick = () => b.dataset.mode === 'walk' ? (mode !== 'walk' && enterWalk()) : exitWalk());
document.querySelectorAll('.wx button').forEach((b) => b.onclick = () => setWeather(b.dataset.w));
$('#time').oninput = (e) => { hour = +e.target.value; applyLighting(); };
$('#play').onclick = () => { playing = !playing; $('#play').textContent = playing ? '❚❚' : '▶'; };
$('#reset').onclick = () => { exitWalk(); $('#card').hidden = true; selected = null; setWeather('clear'); setHour(15.5); home(); };
$('#home').onclick = () => { exitWalk(); home(); };
$('#help').onclick = () => { $('#helpbox').hidden = false; }; $('#helpclose').onclick = () => { $('#helpbox').hidden = true; };
$('#shot').onclick = () => { composer.render(); const a = document.createElement('a'); a.href = renderer.domElement.toDataURL('image/png'); a.download = `changzhou-twin-${Date.now()}.png`; a.click(); };
document.querySelectorAll('[data-layer]').forEach((c) => c.onchange = () => {
  const L = c.dataset.layer, v = c.checked;
  if (L === 'bld') facades?.setVisible(v);
  if (L === 'trees') trees?.setVisible(v); else if (L === 'traffic') traffic?.setVisible(v); else if (L === 'labels') labelsOn = v;
  else if (L === 'roads') layers.roads.forEach((o) => o.visible = v); else (layers[L] || []).forEach((o) => o.visible = v);
});
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); composer.setSize(innerWidth, innerHeight); reflRT.setSize(Math.round(innerWidth * 0.5), Math.round(innerHeight * 0.5)); labelEls.forEach((L) => L.w = 0); });

// ---------- 帧循环 ----------
const clock = new THREE.Clock(); let fpsAcc = 0, fpsN = 0, fps = 0;
function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.1); U.uTime.value += dt; sky.uniforms.uTime.value = U.uTime.value; grade.uniforms.uTime.value = U.uTime.value;
  if (playing) { hour = (hour + dt * 0.25) % 24; $('#time').value = hour; applyLighting(); }
  if (mode === 'walk') stepWalk(dt); else { stepAnim(dt); controls.update(); }
  // 约束目标点在城区内
  controls.target.x = THREE.MathUtils.clamp(controls.target.x, BBOX.x0, BBOX.x1); controls.target.z = THREE.MathUtils.clamp(controls.target.z, -BBOX.y1, -BBOX.y0);
  const tgt = mode === 'walk' ? camera.position : controls.target;
  const dist = camera.position.distanceTo(mode === 'walk' ? camera.position.clone().setY(0) : controls.target);
  // 阴影相机跟随视点
  const S = THREE.MathUtils.clamp(dist * 0.75, 120, 2600);
  const sc = sun.shadow.camera; sc.left = -S; sc.right = S; sc.top = S; sc.bottom = -S; sc.near = 10; sc.far = 9000; sc.updateProjectionMatrix();
  const focus = mode === 'walk' ? camera.position.clone().add(new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw)).multiplyScalar(S * 0.6)).setY(0) : controls.target;
  const texel = (2 * S) / 4096; const ld = sun.userData.dir || new THREE.Vector3(0, 1, 0);
  sun.target.position.set(Math.round(focus.x / texel) * texel, 0, Math.round(focus.z / texel) * texel);
  sun.position.copy(sun.target.position).addScaledVector(ld, 4000);
  // 雾随高度
  const w = WEATHER[weather]; const hgt = Math.max(camera.position.y, 2);
  scene.fog.near = 0.000055 * w.fog * w.fog * (w.fog > 3 ? 1.6 : 1); scene.fog.far = w.fog > 3 ? 260 : 700;
  gtao.updateGtaoMaterial({ radius: THREE.MathUtils.clamp(dist * 0.012, 1.5, 30) });
  if (trees) trees.update(camera.position, tgt);
  if (traffic) traffic.update(dt, camera.position, tgt);
  if (facades) facades.update(camera.position);
  updateFx(dt);
  renderer.shadowMap.needsUpdate = true;
  renderReflection();
  composer.render();
  updateLabels();
  fpsAcc += dt; fpsN++; if (fpsAcc > 0.5) { fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0;
    const [lon, lat] = toLonLat(controls.target.x, -controls.target.z);
    $('#coords').textContent = `POS ${lat.toFixed(5)}°N ${lon.toFixed(5)}°E · ALT ${camera.position.y.toFixed(0)} m · ${fps.toFixed(0)} FPS · 树 ${trees?.shown ?? 0} · 车 ${traffic?.shown ?? 0}`; }
}
frame();
init().catch((e) => { console.error(e); $('#ltxt').textContent = '载入失败：' + e.message; });
