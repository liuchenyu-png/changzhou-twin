// 天空穹顶 + 日照：常州纬度 31.8°N、四月初（赤纬 +5°），按时刻算太阳方位与高度
import * as THREE from 'three';

const LAT = 31.79 * Math.PI / 180, DECL = 5 * Math.PI / 180;
export function sunAt(hour) {
  const H = (hour - 12) * 15 * Math.PI / 180;
  const sinE = Math.sin(LAT) * Math.sin(DECL) + Math.cos(LAT) * Math.cos(DECL) * Math.cos(H);
  const e = Math.asin(sinE);
  const cosA = (Math.sin(DECL) - Math.sin(e) * Math.sin(LAT)) / (Math.cos(e) * Math.cos(LAT));
  let A = Math.acos(Math.min(1, Math.max(-1, cosA))); if (H > 0) A = 2 * Math.PI - A; // 方位角：0=北，顺时针
  // three：x 东，-z 北
  const dir = new THREE.Vector3(Math.sin(A) * Math.cos(e), Math.sin(e), -Math.cos(A) * Math.cos(e));
  return { elev: e * 180 / Math.PI, azim: A * 180 / Math.PI, dir };
}

const vert = /* glsl */`varying vec3 vDir; void main(){ vDir = position; vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.); gl_Position = p.xyww; }`;
const frag = /* glsl */`
uniform vec3 uSun; uniform vec3 uMoon; uniform vec3 uZenith; uniform vec3 uHorizon; uniform vec3 uGround; uniform vec3 uSunCol;
uniform float uDisk; uniform float uCloud; uniform float uCloudDark; uniform float uTime; uniform float uNight; uniform float uHaze;
varying vec3 vDir;
float h(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float n(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.-2.*f); return mix(mix(h(i), h(i+vec2(1,0)), u.x), mix(h(i+vec2(0,1)), h(i+vec2(1,1)), u.x), u.y); }
float fbm(vec2 p){ float s = 0., a = .5; for (int i = 0; i < 6; i++){ s += a * n(p); p = p * 2.07 + 13.1; a *= .5; } return s; }
void main(){
  vec3 d = normalize(vDir); float y = d.y;
  vec3 col = mix(uHorizon, uZenith, pow(clamp(y, 0., 1.), .55));
  col = mix(col, uGround, smoothstep(0., -.08, y));
  float sd = max(dot(d, uSun), 0.);
  col += uSunCol * (pow(sd, 8.) * .35 + pow(sd, 64.) * .6 * uDisk) * (1. - uCloud * .7);
  col += uSunCol * smoothstep(.9994, .9997, sd) * 18. * (1. - uCloud * .95) * uDisk;       // 太阳盘
  float md = max(dot(d, uMoon), 0.);
  col += vec3(.85,.9,1.) * smoothstep(.99985, .99992, md) * 3. * uNight * (1. - uCloud);
  col += vec3(.3,.35,.45) * pow(md, 200.) * .4 * uNight;
  // 星星
  if (uNight > .01 && y > 0.) { vec2 sp = d.xz / (y + .3) * 220.; float s = h(floor(sp)); float tw = .6 + .4 * sin(uTime * 3. + s * 50.);
    col += vec3(1.) * step(.9965, s) * smoothstep(.5, .0, length(fract(sp) - .5)) * uNight * tw * 1.4 * (1. - uCloud) * smoothstep(0., .2, y); }
  // 云：平面投影
  if (y > 0.) {
    vec2 cp = d.xz / (y + .08) * 1.6 + vec2(uTime * .006, uTime * .002);
    float c = fbm(cp); float cov = mix(.62, .18, uCloud);
    float m = smoothstep(cov, cov + .28, c) * smoothstep(0., .12, y);
    float lit = .65 + .35 * max(dot(d, uSun), 0.);
    vec3 cc = mix(uHorizon * 1.05, vec3(1.), .55) * lit; cc = mix(cc, uHorizon * .55 + uZenith * .1, uCloudDark);
    cc += uSunCol * pow(sd, 6.) * .5 * (1. - uCloud * .5);
    col = mix(col, cc, m * (.85 + .15 * uCloud));
  }
  col = mix(col, uHorizon, uHaze * (1. - smoothstep(0., .5, y)));
  gl_FragColor = vec4(col, 1.);
  #include <colorspace_fragment>
}`;

export function makeSky() {
  const uniforms = {
    uSun: { value: new THREE.Vector3(0, 1, 0) }, uMoon: { value: new THREE.Vector3(0, 1, 0) },
    uZenith: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() }, uGround: { value: new THREE.Color() }, uSunCol: { value: new THREE.Color() },
    uDisk: { value: 1 }, uCloud: { value: 0 }, uCloudDark: { value: 0 }, uTime: { value: 0 }, uNight: { value: 0 }, uHaze: { value: 0 },
  };
  const mat = new THREE.ShaderMaterial({ vertexShader: vert, fragmentShader: frag, uniforms, side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), mat);
  mesh.scale.setScalar(50000); mesh.renderOrder = -10; mesh.frustumCulled = false;
  return { mesh, uniforms };
}

const ss = (x, a, b) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); }; // 支持反向边界
const lerpC = (a, b, t) => new THREE.Color().copy(a).lerp(b, t);
const C = (hex) => new THREE.Color(hex);
// 天气：clear 晴 / cloudy 阴 / rain 雨 / fog 雾 / snow 雪
export const WEATHER = {
  clear: { cloud: 0.15, dark: 0, sun: 1, haze: 0.15, fog: 1, wet: 0, snow: 0, label: '晴 · CLEAR', temp: 0 },
  cloudy: { cloud: 0.85, dark: 0.35, sun: 0.28, haze: 0.45, fog: 1.6, wet: 0, snow: 0, label: '阴 · OVERCAST', temp: -3 },
  rain: { cloud: 1, dark: 0.75, sun: 0.12, haze: 0.7, fog: 2.6, wet: 1, snow: 0, label: '雨 · RAIN', temp: -6 },
  fog: { cloud: 0.9, dark: 0.2, sun: 0.22, haze: 1, fog: 7, wet: 0.25, snow: 0, label: '雾 · FOG', temp: -4 },
  snow: { cloud: 1, dark: 0.45, sun: 0.2, haze: 0.8, fog: 3.2, wet: 0, snow: 1, label: '雪 · SNOW', temp: -16 },
};

// 由太阳高度 + 天气给出全部光照参数
export function lighting(hour, w) {
  const s = sunAt(hour); const e = s.elev;
  const day = ss(e, -6, 8);
  const golden = ss(e, 22, 2) * day;
  const night = ss(e, 2, -10);
  let zen = lerpC(C(0x0a0f1e), C(0x2f6fb8), day); zen = lerpC(zen, C(0x3d5d8c), golden * 0.6);
  let hor = lerpC(C(0x141b2c), C(0xb9d3e8), day); hor = lerpC(hor, C(0xf0a46a), golden * 0.85);
  // 阴雨：灰化
  const gray = lerpC(C(0x1a1d24), C(0x9aa3ab), day);
  zen = lerpC(zen, lerpC(gray, C(0x6f7a85), 0.3), w.cloud * 0.9);
  hor = lerpC(hor, gray, w.cloud * 0.85);
  if (w.snow) { hor = lerpC(hor, lerpC(C(0x20242c), C(0xc9d0d8), day), 0.5); }
  const sunCol = lerpC(C(0xffd2a0), C(0xfff4e6), ss(e, 4, 35));
  if (golden > 0) sunCol.lerp(C(0xff9a55), golden * 0.6);
  const sunI = 2.3 * day * Math.min(1, Math.max(0, Math.sin(Math.max(e, 0) * Math.PI / 180) * 2.2)) * w.sun;
  const hemiI = (0.12 + 0.55 * day) * (1 + w.cloud * 0.35);
  // 月亮在太阳对面略偏
  const moon = new THREE.Vector3(-s.dir.x, Math.abs(s.dir.y) * 0.8 + 0.25, -s.dir.z).normalize();
  return { sun: s, day, golden, night, zen, hor, sunCol, sunI, hemiI, moon };
}
