// 城市材质：Blender 导出的材质名 → 带程序化细节的 PBR 材质（窗户、车道线、水波、积雪、夜灯）
import * as THREE from 'three';

export const U = {
  uTime: { value: 0 },
  uNight: { value: 0 },      // 0 白天 → 1 深夜（窗灯、路灯、车灯）
  uWet: { value: 0 },        // 雨天湿润
  uSnow: { value: 0 },       // 积雪
  uDusk: { value: 0 },
  uSunDir: { value: new THREE.Vector3(0, 1, 0) },   // 世界空间指向太阳
  uSunCol: { value: new THREE.Color(1, 1, 1) },     // 含强度
  tReflect: { value: null }, uReflMat: { value: new THREE.Matrix4() }, uReflOn: { value: 0 },
};

const NOISE = /* glsl */`
float czHash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float czNoise(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(czHash(i), czHash(i + vec2(1,0)), u.x), mix(czHash(i + vec2(0,1)), czHash(i + vec2(1,1)), u.x), u.y); }
float czFbm(vec2 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++){ s += a * czNoise(p); p *= 2.03; a *= 0.5; } return s; }
`;
const UNI = `uniform float uTime; uniform float uNight; uniform float uWet; uniform float uSnow; uniform vec3 uSunDir; uniform vec3 uSunCol;\n`;

function patch(mat, { vert = '', vertMain = '', vertNormal = '', frag = '', afterMap = '', afterRough = '', afterMetal = '', afterEmissive = '', afterNormal = '', beforeOut = '', uniforms = {} }) {
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${UNI}\n#ifndef USE_UV1\nattribute vec2 uv1;\n#endif\nvarying vec2 vCzUv; varying vec2 vCzData; varying vec3 vCzW; varying vec3 vCzN;\n${vert}`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>\n${vertNormal}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\nvCzUv = vec2(uv.x, 1. - uv.y); vCzData = vec2(uv1.x, 1. - uv1.y); vCzN = normal; // glTF 导出把 V 翻成 1-v，这里还原成 Blender 里的米制值\n${vertMain}`)
      .replace('#include <project_vertex>', `#include <project_vertex>\n{ vec4 wp = vec4(transformed, 1.0);\n#ifdef USE_INSTANCING\n wp = instanceMatrix * wp;\n#endif\n vCzW = (modelMatrix * wp).xyz; }`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${UNI}${NOISE}\nvarying vec2 vCzUv; varying vec2 vCzData; varying vec3 vCzW; varying vec3 vCzN;\n${frag}`)
      .replace('#include <map_fragment>', `#include <map_fragment>\n${afterMap}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n${afterRough}`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\n${afterMetal}`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${afterNormal}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${afterEmissive}`)
      .replace('#include <opaque_fragment>', `${beforeOut}\n#include <opaque_fragment>`);
  };
  mat.customProgramCacheKey = () => mat.name + '_cz';
  return mat;
}

// ---------- 楼 ----------
// 立面：窗格 + 室内映射（透过玻璃看到有纵深的房间：后墙/侧墙/地板/天花、家具、窗帘、吊灯）
const FACADE = /* glsl */`
struct Fac { vec3 col; float win; float glass; float metal; vec3 emis; float rough; vec3 far; };
// 夜间亮灯率（借鉴 The Blue Hour）：不是每扇窗独立掷骰子，而是“楼的活跃度 × 立面上成片的区域 × 街区”
// → 有的楼整片亮、有的几乎全黑，同一栋楼里也是一团一团地亮
float czLitFrac(vec2 uv, float sd, float base){
  float act = mix(.45, 1.4, fract(sd * 74.23));
  float zone = smoothstep(-.05, .45, czNoise(vec2(uv.x / 13. + sd * 40., uv.y / 26. + sd * 17.)) - .25);
  float hood = .55 + .9 * czNoise(vCzW.xz * .0022 + 3.7);
  return clamp(base * act * mix(.2, 1.8, zone) * hood, 0., .95);
}
// 远处用的平均亮灯率：只取楼和街区两级（立面成片区域在远处会糊成一块块色斑）
float czLitAvg(float sd, float base){
  return clamp(base * mix(.45, 1.4, fract(sd * 74.23)) * .9 * (.55 + .9 * czNoise(vCzW.xz * .0022 + 3.7)), 0., .95);
}
// 窗灯颜色：暖黄白炽 / 中性 / 冷白 LED 混合，亮度不一
vec3 czLampCol(float r){
  vec3 c = r < .5 ? mix(vec3(1., .62, .30), vec3(1., .74, .42), fract(r * 9.1))
         : r < .82 ? vec3(1., .86, .66) : vec3(.84, .9, 1.);
  return c * (.45 + .9 * pow(fract(r * 37.7), 1.5));
}
vec3 pick6(float s, vec3 a, vec3 b, vec3 c, vec3 d, vec3 e, vec3 f){ return s < .17 ? a : s < .34 ? b : s < .5 ? c : s < .67 ? d : s < .84 ? e : f; }
// 室内映射：p = 房间内入射点(米)，cell = 房间宽高，D = 进深，d = 切线空间视线（x 沿墙，y 上，z 外法线）
vec3 czRoom(vec2 p, vec2 cell, float D, vec3 d, float r, float lit, vec3 litCol, float shop){
  d.z = min(d.z, -.02); d.x = abs(d.x) < 1e-3 ? 1e-3 : d.x; d.y = abs(d.y) < 1e-3 ? 1e-3 : d.y;
  vec3 inv = 1. / d;
  float tx = d.x > 0. ? (cell.x - p.x) * inv.x : -p.x * inv.x;
  float ty = d.y > 0. ? (cell.y - p.y) * inv.y : -p.y * inv.y;
  float tz = -D * inv.z;
  // 不用 t == tz 判等：D3D 快速数学下会逐像素随机失败（噪点）
  float face = tz <= min(tx, ty) ? 0. : (ty <= tx ? 1. : 2.);
  float t = face < .5 ? tz : (face < 1.5 ? ty : tx);
  vec3 h = vec3(p, 0.) + d * t;
  vec3 wallC = pick6(fract(r * 3.7), vec3(.82,.78,.70), vec3(.86,.85,.82), vec3(.74,.76,.76), vec3(.80,.72,.62), vec3(.88,.86,.80), vec3(.66,.70,.74));
  vec3 c;
  if (face < .5) {             // 后墙 + 家具剪影
    c = wallC * .9;
    float u = h.x / cell.x;
    float a0 = .08 + .3 * fract(r * 7.1), a1 = a0 + .25 + .35 * fract(r * 13.3);
    float fur = step(h.y, .55 + .6 * fract(r * 5.3)) * step(a0, u) * step(u, a1);
    c = mix(c, mix(vec3(.30,.22,.16), vec3(.55,.52,.48), fract(r * 17.)), fur);
    float pic = step(abs(h.y - 1.6), .35) * step(abs(u - (1. - a0 * .8)), .1) * step(.5, fract(r * 23.));
    c = mix(c, vec3(.35,.42,.48), pic);
    if (shop > .5) c = mix(c, vec3(.9,.86,.8) * (.6 + .4 * step(.5, fract(h.y * 2.))), step(h.y, 2.4) * .7);
  } else if (face < 1.5) {
    c = d.y < 0. ? mix(vec3(.46,.34,.24), vec3(.62,.60,.56), step(.55, fract(r * 11.))) : vec3(.93,.92,.90);
  } else {
    c = wallC;
    c = mix(c, vec3(.32,.26,.2), step(h.y, .9) * step(.4, -h.z) * step(-h.z, D * .6) * step(.6, fract(r * 29.)) * .8);
  }
  // 白天：靠窗亮、纵深暗；夜晚：吊灯光池
  float day = mix(1., .32, clamp(-h.z / D, 0., 1.));
  vec3 lamp = vec3(cell.x * .5, cell.y - .05, -D * .45);
  float lp = exp(-dot(h - lamp, h - lamp) * .09);
  float ceilGlow = (face > .5 && face < 1.5 && d.y > 0.) ? exp(-dot(h.xz - lamp.xz, h.xz - lamp.xz) * 1.6) * 6. : 0.;
  vec3 dayC = c * day;
  vec3 nightC = c * litCol * (.35 + 1.4 * lp) + litCol * ceilGlow;
  return mix(dayC * .06, nightC * lit * .95, uNight);   // 白天玻璃以反射为主，室内只隐约可见
}
Fac facade(vec2 uv, float st, float sd, float H, vec3 d, vec2 fw){
  Fac F; F.win = 0.; F.glass = 0.; F.metal = 0.; F.emis = vec3(0.); F.rough = .85; F.far = vec3(0.);
  vec3 base = vec3(.7); float wf = 0.; vec3 wcol = vec3(.05,.06,.07);
  float floorH = 3.0, colW = 3.3, D = 4.5;
  if (st > 1.5 && st < 2.5) { floorH = 3.9; colW = 1.6; D = 9.; }
  if (st > 2.5 && st < 3.5) { floorH = 6.0; colW = 6.5; D = 14.; }
  if (st > 3.5 && st < 4.5) { floorH = 3.4; colW = 4.2; D = 4.; }
  vec2 g = vec2(uv.x / colW, uv.y / floorH); vec2 c = floor(g); vec2 f = fract(g);
  float rnd = czHash(c + sd * 97.0);
  float para = step(H, uv.y);                 // 女儿墙段
  // 两扇窗一户：相邻窗共用开关
  vec2 hc = vec2(floor(c.x / 2.), c.y);
  float nightRnd = czHash(hc * 1.37 + floor(sd * 50.) + 3.1);
  vec3 warm = czLampCol(czHash(hc + 7.7 + sd * 13.));
  if (st < 1.5) {           // 住宅：涂料/面砖 + 分户窗 + 阳台板 + 空调机位
    F.col = pick6(sd, vec3(.88,.85,.79), vec3(.82,.76,.68), vec3(.90,.90,.88), vec3(.66,.52,.44), vec3(.72,.75,.78), vec3(.86,.80,.70));
    F.col *= .96 + .06 * czNoise(uv * vec2(.6, 2.));
    base = F.col * .9; wf = .42;
    float balc = step(mod(c.x + floor(sd * 5.0), 3.0), .99);
    float wy0 = balc > .5 ? .06 : .30;
    float w = step(.17, f.x) * step(f.x, .83) * step(wy0, f.y) * step(f.y, .86);
    float frame = w * (1. - step(.20, f.x) * step(f.x, .80) * step(wy0 + .03, f.y) * step(f.y, .83));
    float mull = w * step(abs(f.x - .5), .012);
    F.win = w * (1. - frame) * (1. - mull);
    // 窗洞阴影（外墙有厚度）：上沿、左沿
    float reveal = w * (step(f.y, .86) * step(.80, f.y) + step(f.x, .21) * .6);
    // 阳台栏板
    float rail = balc * step(.17, f.x) * step(f.x, .83) * step(.02, f.y) * step(f.y, .30);
    float slab = 1. - smoothstep(.0, .035, f.y) * (1. - smoothstep(.965, 1., f.y));
    F.col *= mix(1., .78, slab * .8);
    F.col = mix(F.col, vec3(.93,.93,.92), frame);
    F.col = mix(F.col, F.col * .9, rail * (1. - F.win));
    // 空调外机
    float ac = step(.86, f.x) * step(f.x, .98) * step(.08, f.y) * step(f.y, .26) * step(.45, rnd);
    F.col = mix(F.col, vec3(.86,.87,.86) * (.8 + .2 * step(.5, fract(f.x * 30.))), ac);
    float lf = czLitFrac(uv, sd, .42);
    float lit = step(nightRnd, lf) * step(3.0, uv.y);
    F.far = vec3(1., .7, .4) * czLitAvg(sd, .42) * wf * .4;
    vec3 room = czRoom(vec2(f.x * colW, f.y * floorH), vec2(colW, floorH), D, d, rnd, lit, warm, 0.);
    float curtain = step(f.x, .17 + .3 * fract(rnd * 31.)) + step(1. - .25 * fract(rnd * 53.), f.x);
    curtain = clamp(curtain, 0., 1.) * step(.35, fract(rnd * 41.));
    room = mix(room, mix(vec3(.75,.68,.58) * .5 * (1. - uNight), warm * lit * uNight * .9, uNight), curtain);
    F.emis = room * F.win * (1. - reveal * .7);
    F.glass = F.win; F.col = mix(F.col, vec3(.02,.025,.03), F.win);
    F.col *= 1. - reveal * .35 * (1. - F.win);
    if (uv.y < 3.0) { F.col *= .86; }
  } else if (st < 2.5) {    // 办公：玻璃幕墙 + 竖梃 + 层间带 + 开敞办公室内
    vec3 mc = pick6(sd, vec3(.70,.72,.74), vec3(.50,.52,.54), vec3(.80,.80,.78), vec3(.30,.32,.34), vec3(.62,.60,.56), vec3(.76,.78,.80));
    float mull = step(f.x, .05) + step(.95, f.x);
    float spand = step(f.y, .2);
    F.win = clamp(1. - mull - spand, 0., 1.);
    float bay = mod(c.x, 4.);
    float room4 = czHash(vec2(floor(c.x / 4.), c.y) + sd * 91.);
    float lf = czLitFrac(uv, sd, .38);
    float lit = step(room4, lf);
    vec3 cool = mix(vec3(.86, .93, 1.), vec3(1., .93, .8), step(.7, fract(room4 * 7.3))) * (.6 + .6 * fract(room4 * 31.));
    F.far = vec3(.92, .94, 1.) * czLitAvg(sd, .38) * wf * .3;
    vec3 room = czRoom(vec2((bay + f.x) * colW, f.y * floorH), vec2(4. * colW, floorH), D, d, room4, lit, cool, 0.);
    // 百叶帘
    float blind = step(1. - .55 * fract(room4 * 19.), f.y) * step(.4, fract(room4 * 7.));
    room = mix(room, mix(vec3(.6,.62,.62) * (.85 + .15 * step(.5, fract(f.y * floorH * 8.))) * .55 * (1. - uNight), cool * lit * uNight * .6, uNight), blind);
    F.emis = room * F.win * .75;
    F.glass = 1. - mull * .8 - spand * .5;
    vec3 gtint = pick6(fract(sd * 7.), vec3(.05,.08,.10), vec3(.04,.06,.07), vec3(.07,.09,.10), vec3(.05,.08,.08), vec3(.08,.09,.11), vec3(.03,.05,.07));
    F.col = mix(gtint, mc, clamp(mull + spand, 0., 1.));
    base = mc; wf = .72; wcol = gtint + vec3(.04);
    F.metal = mix(.5, .7, mull) ; F.rough = mix(.04, .35, clamp(mull + spand, 0., 1.));
    if (uv.y < 5.0) {       // 底商
      float sf = step(.06, f.x) * step(f.x, .94) * step(.06, uv.y / 5.) * step(uv.y / 5., .8);
      vec3 shop = czRoom(vec2(f.x * colW, uv.y), vec2(colW, 5.), 6., d, rnd, 1., vec3(1., .88, .7), 1.);
      F.col = mix(vec3(.12,.13,.14), vec3(.03), sf); F.win = sf; F.glass = sf; F.emis = shop * sf * (1. - uNight * .35);
      float sign = step(.82, uv.y / 5.) * step(uv.y / 5., .96);
      F.col = mix(F.col, pick6(rnd, vec3(.7,.1,.1), vec3(.1,.3,.6), vec3(.9,.7,.2), vec3(.15,.15,.15), vec3(.1,.5,.4), vec3(.85,.85,.85)), sign);
      F.emis += pick6(rnd, vec3(1.,.2,.15), vec3(.3,.6,1.), vec3(1.,.8,.3), vec3(1.), vec3(.3,1.,.7), vec3(1.)) * sign * uNight * 1.1;
    }
  } else if (st < 3.5) {    // 厂房：压型钢板竖纹 + 带形窗
    F.col = pick6(sd, vec3(.84,.85,.86), vec3(.74,.78,.82), vec3(.88,.86,.82), vec3(.62,.70,.78), vec3(.80,.80,.78), vec3(.70,.72,.70));
    F.col *= .9 + .1 * smoothstep(.3, .7, abs(fract(uv.x * 4.) - .5) * 2.);
    base = F.col; wf = .14;
    float band = step(.55, f.y) * step(f.y, .78) * step(.1, f.x) * step(f.x, .9);
    F.win = band; F.glass = band;
    float lf = czLitFrac(uv, sd, .3);
    vec3 room = czRoom(vec2(f.x * colW, f.y * floorH), vec2(colW, floorH), D, d, rnd, step(rnd, lf), vec3(.9,.95,1.), 0.);
    F.far = vec3(.9, .95, 1.) * czLitAvg(sd, .3) * wf * .25;
    F.emis = room * band * .6; F.col = mix(F.col, vec3(.04,.05,.06), band);
    F.col = mix(F.col, vec3(.25,.42,.62), step(H - 1.2, uv.y) * step(.5, sd) * (1. - para));
    F.metal = .35 * (1. - band); F.rough = mix(.5, .1, band);
  } else if (st < 4.5) {    // 历史民居：白墙、灰砖勒脚、木格窗
    F.col = vec3(.92,.91,.88) * (.92 + .08 * czNoise(uv * 1.7)) * (1. - .12 * smoothstep(.6, 1., czNoise(uv * vec2(.5, 3.) + sd * 9.)));
    float w = step(.30, f.x) * step(f.x, .70) * step(.32, f.y) * step(f.y, .78) * step(.45, rnd);
    float lattice = step(.82, max(fract(f.x * 14.), fract(f.y * 12.)));
    F.win = w; F.col = mix(F.col, mix(vec3(.30,.20,.13), vec3(.18,.12,.08), lattice), w);
    if (uv.y < .7) F.col = vec3(.36,.37,.38) * (.9 + .1 * step(.1, fract(uv.x * 4.)) * step(.1, fract(uv.y * 8.)));
    F.emis = vec3(1., .66, .36) * w * (1. - lattice) * step(rnd, .85) * uNight * 1.4;
  } else {                  // 屋顶机房
    F.col = vec3(.72,.71,.68) * (.9 + .1 * czNoise(uv * .8));
  }
  if (para > .5 && st < 4.5) { F.win = 0.; F.glass = 0.; F.emis = vec3(0.); F.metal = 0.; F.rough = .85;
    F.col = st > 1.5 && st < 2.5 ? vec3(.72,.73,.74) : pick6(sd, vec3(.88,.85,.79), vec3(.82,.76,.68), vec3(.90,.90,.88), vec3(.66,.52,.44), vec3(.72,.75,.78), vec3(.86,.80,.70)) * 1.04; }
  // 远处：窗格小于一个像素时淡出成平均立面色（避免摩尔纹/闪烁）
  float lod = smoothstep(.18, .6, max(fw.x / colW, fw.y / floorH));
  if (st < 3.5) { F.col = mix(F.col, mix(base, wcol, wf), lod); F.glass = mix(F.glass, wf * .6, lod);
    // 夜里远处一半换成“亮灯率 × 平均灯色”：保留点点灯光，又压住逐窗采样的闪烁
    F.emis = mix(F.emis, mix(F.emis * .4, F.far * uNight, uNight), lod * mix(1., .55, uNight)); }
  // ---- 夜景氛围光（借鉴 The Blue Hour）----
  if (uNight > .01 && st < 4.5 && para < .5) {
    float bh = czHash(vec2(sd * 91.7, 3.3));
    // 街道光往上照：楼脚橙色光晕，越往上越淡；商业楼更亮
    float up = pow(1. - smoothstep(0., 18., uv.y), 2.2) * step(.45, bh);   // 只有一部分楼脚有店招/路灯照着
    vec3 upC = mix(vec3(.025,.02,.017), vec3(.58,.19,.04), up) * up * mix(.15, .6, bh) * (st > 1.5 && st < 2.5 ? 1.3 : .35);
    // 高楼：顶部几层泛光 + 女儿墙下的轮廓灯带（远处按像素加宽、按能量减弱，避免闪）
    float tall = smoothstep(40., 70., H);
    float crown = exp(-max(H - uv.y, 0.) / 7.) * step(.4, fract(bh * 7.)) * tall;
    vec3 crC = mix(vec3(1., .78, .5), vec3(.85, .9, 1.), step(.7, fract(bh * 13.)));
    float lw = max(.35, fw.y * 1.5);
    float line = (1. - smoothstep(lw * .5, lw, abs(uv.y - (H - .6)))) * .35 / lw * step(.55, fract(bh * 3.1)) * tall;
    vec3 lnC = pick6(fract(bh * 29.), vec3(.6,.85,1.), vec3(1.,.8,.45), vec3(.9,.95,1.), vec3(.4,.7,1.), vec3(1.,.75,.4), vec3(.9,.95,1.));
    // 冷蓝边缘光：掠射角处楼体轮廓从夜空里分出来
    vec3 rim = vec3(.035, .06, .12) * pow(1. - abs(d.z), 4.) * (1. - F.win);
    F.emis += (upC + crC * crown * .22 * (1. - F.win * .5) + lnC * line * 2. + rim) * uNight;
  }
  // 雨痕/污渍：顶部往下的竖向流痕 + 底部返潮
  float streak = czNoise(vec2(uv.x * 1.3, uv.y * .05 + sd * 20.)) * smoothstep(H, H - 12., uv.y);
  F.col *= 1. - .10 * streak * (1. - F.glass) - .06 * czNoise(uv * .3 + sd * 11.);
  F.col *= mix(.8, 1., smoothstep(0., 1.2, uv.y));
  return F;
}`;

export function buildingMaterial(name) {
  const m = new THREE.MeshStandardMaterial({ name, color: 0xffffff, roughness: 0.85, metalness: 0.0 });
  const isHRoof = name === 'B_hroof';
  return patch(m, {
    vert: 'varying float vCzWall;',
    vertMain: 'vCzWall = 1.0 - step(0.5, abs(normal.y));',
    frag: 'varying float vCzWall;\n' + FACADE + '\nFac czF;',
    afterMap: isHRoof ? `
      { float t = fract(vCzUv.y / 0.28); vec3 tile = vec3(.17,.18,.19) * (.78 + .22 * smoothstep(.0,.25,t));
        float cv = step(.85, fract(vCzUv.x / .22)); tile *= 1. - cv * .25;               // 筒瓦垄
        tile *= .88 + .12 * czNoise(vCzUv * vec2(4., 1.)) ; tile = mix(tile, vec3(.24,.26,.2), smoothstep(.65, .9, czNoise(vCzW.xz * .3)) * .4); // 苔
        diffuseColor.rgb = mix(tile, vec3(.95), uSnow * .85); czF.rough = .8; czF.emis = vec3(0.); czF.glass = 0.; czF.metal = 0.; }` : `
      // 种子量化：插值带来的 1e-7 抖动会被哈希放大成逐像素噪点
      vec2 czFw = fwidth(vCzUv);
      float st = floor(vCzData.x + .002); float sd = floor(fract(vCzData.x + .002) * 256.) / 256.; float H = vCzData.y;
      if (vCzWall > .5) {
        vec3 N = normalize(vCzN); vec3 T = normalize(vec3(N.z, 0., -N.x)); vec3 V = normalize(vCzW - cameraPosition);
        vec3 vd = vec3(dot(V, T), V.y, dot(V, N));
        if (st >= 10.) { czF.col = pick6(sd, vec3(.88,.85,.79), vec3(.82,.76,.68), vec3(.90,.90,.88), vec3(.66,.52,.44), vec3(.72,.75,.78), vec3(.86,.80,.70)) * .92;
          if (st < 12.5 && st > 11.5) czF.col = vec3(.70,.71,.72); czF.win = 0.; czF.glass = 0.; czF.emis = vec3(0.); czF.metal = 0.; czF.rough = .9; }
        else czF = facade(vCzUv, st, sd, H, vd, czFw);
        diffuseColor.rgb = czF.col;
        float ao = smoothstep(0., 5., vCzUv.y); diffuseColor.rgb *= .78 + .22 * ao; }
      else { // 屋顶：混凝土分格 + 污渍、厂房彩钢、少量屋顶绿化；女儿墙压顶用墙色
        vec3 rc = vec3(.50,.50,.48) * (.82 + .3 * czNoise(vCzW.xz * .15));
        vec2 tg = fract(vCzW.xz / 3.); rc *= .93 + .07 * step(.04, min(tg.x, tg.y));
        rc *= 1. - .18 * smoothstep(.55, .85, czFbm(vCzW.xz * .08 + sd * 30.));
        if (st > 2.5 && st < 3.5) rc = (sd < .45 ? vec3(.28,.44,.62) : vec3(.74,.75,.74)) * (.9 + .1 * step(.5, fract(dot(vCzW.xz, vec2(1.)) * 1.2)));
        if (st > 1.5 && st < 2.5) rc = vec3(.32,.33,.35) * (.9 + .2 * czNoise(vCzW.xz * .3));
        if (st < 1.5 && sd > .88) rc = vec3(.22,.36,.16) * (.8 + .4 * czNoise(vCzW.xz * 1.3));
        if (st >= 10.) rc = st > 11.5 && st < 12.5 ? vec3(.62,.63,.64) : vec3(.80,.78,.74);
        diffuseColor.rgb = rc; czF.emis = vec3(0.); czF.glass = 0.; czF.metal = 0.; czF.rough = .9;
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.96), uSnow * .9); }`,
    afterRough: `roughnessFactor = mix(czF.rough, .04, czF.glass * step(czF.metal, .01)); roughnessFactor = min(roughnessFactor, czF.glass > .5 ? czF.rough : 1.);
      roughnessFactor = mix(roughnessFactor, roughnessFactor * .45, uWet * (1. - vCzWall));`,
    afterMetal: `metalnessFactor = czF.metal;`,
    afterEmissive: `totalEmissiveRadiance += czF.emis;`,
  });
}

export function equipMaterial(name) {
  const solar = name === 'B_solar';
  const m = new THREE.MeshStandardMaterial({ name, color: solar ? 0x0d1626 : 0xa8aaac, roughness: solar ? 0.15 : 0.45, metalness: solar ? 0.4 : 0.6 });
  return patch(m, {
    afterMap: solar ? `{ vec2 g = fract(vCzUv / vec2(1.0, .66)); float ln = step(.95, max(g.x, g.y)); diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.6,.62,.65), ln * .8); }`
      : `diffuseColor.rgb *= .85 + .2 * czNoise(vCzUv * 2.); diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.96), uSnow * step(.5, normalize(vCzN).y) * .9);`,
  });
}

// ---------- 路 ----------
export function roadMaterial(name) {
  const m = new THREE.MeshStandardMaterial({ name, color: 0xffffff, roughness: 0.9 });
  return patch(m, {
    frag: 'float czMark; float czWetMask;',
    afterMap: `
      float hw = vCzData.x; float code = floor(vCzData.y); float mask = clamp(fract(vCzData.y) / .9, 0., 1.);
      float oneway = step(4.5, code); float lanes = code - 5. * oneway;
      float a = vCzUv.x, x = vCzUv.y; float ax = abs(x);
      vec3 asph = vec3(.075,.077,.08) * (.8 + .4 * czFbm(vCzW.xz * .35)) ;
      asph *= .9 + .1 * czNoise(vec2(a * .05, x * 2.));
      float m = 0.;
      float dash = step(fract(a / 9.), .5);
      float fade = 1. - smoothstep(.15, .5, mask);
      // 路缘
      float curb = step(hw - .35, ax);
      if (lanes > .5) {
        m += step(abs(ax - (hw - .9)), .08);                             // 边线
        if (oneway < .5) {
          float lw = (hw - .9) / lanes;
          float yellow = step(abs(ax - .18), .07);
          for (int k = 1; k < 4; k++) { if (float(k) < lanes) m += dash * step(abs(ax - lw * float(k)), .07); }
          diffuseColor.rgb = mix(asph, vec3(.80,.62,.18), yellow * fade);
        } else {
          float lw = 2. * (hw - .9) / lanes;
          for (int k = 1; k < 4; k++) { if (float(k) < lanes) m += dash * step(abs(x + hw - .9 - lw * float(k)), .07); }
          diffuseColor.rgb = asph;
        }
        m *= fade;
        // 斑马线：交叉口附近
        float zebra = step(.3, mask) * (1. - step(.62, mask)) * step(fract(x / 1.2), .5) * step(ax, hw - 1.);
        m = max(m, zebra);
      } else { diffuseColor.rgb = asph * 1.15; }
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.86,.86,.84), clamp(m, 0., 1.) * .85);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.46,.46,.45), curb);
      czWetMask = 1. - curb;
      diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * .55, uWet * czWetMask);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.92,.93,.95), uSnow * (.55 + .4 * czNoise(vCzW.xz * .5)) * (1. - m * .5));
      czMark = m;`,
    afterRough: `roughnessFactor = mix(.9, .12, uWet * czWetMask) - czMark * .1;`,
    // 夜间路灯光斑（每 35 m 一盏，沿路两侧）
    afterEmissive: `{ float dl = abs(mod(vCzUv.x, 32.) - 16.); float dx = abs(abs(vCzUv.y) - (hw - 1.));
      float lp = exp(-(dl * dl) / 60. - dx * dx / (hw * hw * .35));
      totalEmissiveRadiance += vec3(1., .74, .45) * lp * uNight * .16 * diffuseColor.rgb * 9. * step(2.5, vCzData.x); }`,
  });
}

// ---------- 地面 ----------
const GROUND = {
  G_base: [0.32, 0.36, 0.25, 'grass'], G_edge: [0.05, 0.06, 0.07, 'pave'], G_res: [0.47, 0.47, 0.45, 'pave'], G_com: [0.50, 0.49, 0.47, 'pave'], G_ind: [0.45, 0.46, 0.47, 'pave'],
  G_edu: [0.47, 0.45, 0.42, 'pave'], G_pitch: [0.17, 0.42, 0.15, 'pitch'], G_track: [0.62, 0.24, 0.17, 'pave'], G_grass: [0.24, 0.40, 0.15, 'grass'],
  G_park: [0.25, 0.43, 0.16, 'grass'], G_wood: [0.12, 0.24, 0.09, 'grass'], G_farm: [0.40, 0.45, 0.20, 'farm'], G_sand: [0.62, 0.57, 0.45, 'pave'],
  R_walk: [0.60, 0.58, 0.55, 'walk'], R_path: [0.55, 0.53, 0.49, 'pave'], R_bridge: [0.58, 0.58, 0.56, 'pave'], W_bank: [0.55, 0.54, 0.50, 'pave'], RAIL: [0.36, 0.33, 0.30, 'rail'],
};
export function groundMaterial(name) {
  const g = GROUND[name] || [0.4, 0.4, 0.4, 'pave'];
  const m = new THREE.MeshStandardMaterial({ name, color: new THREE.Color(g[0], g[1], g[2]).convertSRGBToLinear(), roughness: 0.95 });
  const kind = g[3];
  const body = {
    grass: `float n = czFbm(vCzW.xz * .02), n2 = czNoise(vCzW.xz * .9), n3 = czFbm(vCzW.xz * .11);
            diffuseColor.rgb *= .80 + .4 * n; diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.25, 1.12, .62), smoothstep(.5, .8, czNoise(vCzW.xz * .006)) * .6);
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.36,.33,.24), smoothstep(.62, .8, n3) * .35);          // 斑秃/泥土
            diffuseColor.rgb *= .9 + .18 * n2 * czNoise(vCzW.xz * 3.1);`,
    walk: `{ vec2 q = vec2(vCzUv.x, vCzUv.y); vec2 t = fract(q / vec2(.6, .3)); vec2 id = floor(q / vec2(.6, .3));
            diffuseColor.rgb *= .88 + .14 * czHash(id) ; diffuseColor.rgb *= .93 + .07 * step(.05, min(t.x, t.y * 2.));
            diffuseColor.rgb *= .85 + .2 * czFbm(vCzW.xz * .2);
            float tac = step(abs(vCzUv.y - vCzData.x * .45), .2); diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.78,.62,.20) * (.85 + .15 * step(.5, fract(q.x * 3.3))), tac * .85);
            if (vCzUv.y < .25) diffuseColor.rgb = vec3(.66,.66,.64) * (.9 + .1 * czNoise(q * 3.)); }`,
    farm: `vec2 q = vCzW.xz * .012; float plot = czHash(floor(q)); diffuseColor.rgb *= .75 + .45 * plot; diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.55,.5,.25), step(.8, plot) * .5);
           diffuseColor.rgb *= .9 + .15 * sin(dot(vCzW.xz, vec2(.7, .7)) * 1.6) * step(.4, plot);`,
    pave: `float n = czFbm(vCzW.xz * .05); diffuseColor.rgb *= .86 + .22 * n; vec2 t = fract(vCzW.xz / 2.4); diffuseColor.rgb *= .96 + .04 * step(.04, min(t.x, t.y));`,
    pitch: `diffuseColor.rgb *= .9 + .12 * step(.5, fract(vCzW.x / 6.)); diffuseColor.rgb *= .95 + .1 * czNoise(vCzW.xz * .5);`,
    rail: `float sl = step(.55, fract(vCzUv.x / .65)); diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.24,.20,.16), sl * step(abs(vCzUv.y), 1.3));
           float rl = step(abs(abs(vCzUv.y) - .72), .05); diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.6,.6,.62), rl);`,
  }[kind];
  return patch(m, {
    frag: 'float czGWet;',
    afterMap: body + `\n czGWet = ${kind === 'pave' || kind === 'rail' || kind === 'walk' ? '1.' : '.4'}; diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * .7, uWet * czGWet);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.93,.94,.96), uSnow * (.6 + .35 * czNoise(vCzW.xz * .3)));`,
    afterRough: `roughnessFactor = mix(roughnessFactor, .3, uWet * czGWet);`,
  });
}

// ---------- 水 ----------
export function waterMaterial() {
  const m = new THREE.MeshStandardMaterial({ name: 'W_water', color: new THREE.Color(0.05, 0.11, 0.12), roughness: 0.06, metalness: 0.0, envMapIntensity: 1.0 });
  return patch(m, {
    afterNormal: `{
      vec2 p = vCzW.xz; float t = uTime;
      float e = .6;
      float h0 = czFbm(p * .09 + vec2(t * .05, t * .03)) + .5 * czNoise(p * .45 - vec2(t * .21, -t * .13));
      float hx = czFbm((p + vec2(e, 0.)) * .09 + vec2(t * .05, t * .03)) + .5 * czNoise((p + vec2(e, 0.)) * .45 - vec2(t * .21, -t * .13));
      float hz = czFbm((p + vec2(0., e)) * .09 + vec2(t * .05, t * .03)) + .5 * czNoise((p + vec2(0., e)) * .45 - vec2(t * .21, -t * .13));
      float k = .55 + uWet * .6;
      vec3 wn = normalize(vec3(-(hx - h0) * k, 1., -(hz - h0) * k));
      normal = normalize((viewMatrix * vec4(wn, 0.)).xyz);
    }`,
    afterMap: `diffuseColor.rgb *= .8 + .35 * czFbm(vCzW.xz * .004); diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.6,.65,.7), uSnow * .15);`,
    frag: 'uniform sampler2D tReflect; uniform mat4 uReflMat; uniform float uReflOn;',
    // 平面反射：镜像相机渲染的城市倒影，按水波法线扰动 + 菲涅耳
    beforeOut: `if (uReflOn > .5) {
      vec4 rp = uReflMat * vec4(vCzW, 1.); vec2 ruv = rp.xy / rp.w;
      vec3 wn = normalize((vec4(normal, 0.) * viewMatrix).xyz);
      ruv += wn.xz * vec2(.6, .6) * (.05 + uWet * .05);
      vec3 refl = texture2D(tReflect, clamp(ruv, .001, .999)).rgb;
      vec3 Vw = normalize(cameraPosition - vCzW); float cosT = clamp(dot(Vw, wn), 0., 1.);
      float F = .02 + .98 * pow(1. - cosT, 5.);
      outgoingLight = mix(outgoingLight * .55, refl, clamp(F * 1.15 + .12, 0., .92));
    }`,
  });
}

// ---------- 树 ----------
// 树冠：法线朝冠心外“鼓起”（柔和体积感）、冠内暗、逆光透光
export function treeMaterial(src, isLeaf, crown) {
  const m = new THREE.MeshStandardMaterial({ name: src.name, color: src.color, roughness: isLeaf ? 0.88 : 0.95, metalness: 0 });
  if (!isLeaf) return patch(m, {});
  const c = crown || { c: new THREE.Vector3(0, 6, 0), r: 3 };
  return patch(m, {
    uniforms: { uCrown: { value: c.c }, uCrownR: { value: c.r } },
    vert: 'uniform vec3 uCrown; uniform float uCrownR; varying float vCzAO; varying float vCzEdge;',
    vertNormal: 'vec3 czRad = position - uCrown; czRad.y *= 1.3; objectNormal = normalize(mix(objectNormal, normalize(czRad), .3));',
    vertMain: `{ vec3 ip = vec3(0.);
      #ifdef USE_INSTANCING
        ip = instanceMatrix[3].xyz;
      #endif
      vCzAO = clamp(length(position - uCrown) / uCrownR, 0., 1.2) * .6 + clamp((position.y - uCrown.y) / uCrownR, -1., 1.) * .3 + .3;
      float sway = sin(uTime * 1.3 + ip.x * .05 + ip.z * .07) * .05 * max(transformed.y - 2., 0.) * (1. + uWet * 1.5);
      transformed.x += sway; transformed.z += sway * .6; }`,
    frag: 'varying float vCzAO; varying float vCzEdge; vec3 czLeafCol;',
    afterMap: `{ float lv = czNoise(vCzW.xz * 1.7 + vCzW.y * 1.3) * .6 + czNoise(vCzW.xz * 5.3 - vCzW.y * 4.1) * .4;
      diffuseColor.rgb *= .62 + .55 * lv; diffuseColor.rgb *= clamp(vCzAO, .35, 1.1);
      diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.15, 1.1, .7), smoothstep(.6, .9, lv) * .5);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.95), uSnow * smoothstep(.2, .9, normalize(vCzN).y) * .8); czLeafCol = diffuseColor.rgb; }`,
    afterRough: 'roughnessFactor = .75 + .2 * czNoise(vCzW.xz * 4.);',
    beforeOut: `{ vec3 V = normalize(vCzW - cameraPosition); float bl = pow(max(dot(V, uSunDir), 0.), 3.);
      outgoingLight += czLeafCol * vec3(1., 1.05, .6) * uSunCol * bl * .35 * clamp(vCzAO, .3, 1.); }`,
  });
}

export function makeMaterial(src) {
  const n = src.name || '';
  if (n === 'B_wall' || n === 'B_roof' || n === 'B_hroof') return buildingMaterial(n);
  if (n === 'B_equip' || n === 'B_solar') return equipMaterial(n);
  if (n === 'R_road') return roadMaterial(n);
  if (n === 'W_water') return waterMaterial();
  if (n.startsWith('G_') || n === 'R_path' || n === 'R_bridge' || n === 'R_walk' || n === 'W_bank' || n === 'RAIL') return groundMaterial(n);
  return null;
}
