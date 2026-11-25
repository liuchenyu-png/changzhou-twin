// 车流：主干道按车道生成车辆，靠右行驶，路口接续到相连道路；近处的车才写进实例缓冲
import * as THREE from 'three';
import { U } from './materials.js';

const RZ = { motorway: 0.46, trunk: 0.44, primary: 0.42, secondary: 0.38, tertiary: 0.34 };
const DENS = { motorway: 9, trunk: 8, primary: 7, secondary: 5, tertiary: 2.5 }; // 每车道每公里
const SPEED = { motorway: 22, trunk: 17, primary: 13, secondary: 11, tertiary: 9 };
const PALETTE = [0xf2f2f2, 0x1b1c1e, 0x9aa0a6, 0x3a3f46, 0xc8ccd0, 0x8a1f1f, 0x1f3a6b, 0xe7e2d6, 0x2c4a3a, 0xd9b44a];

export class Traffic {
  constructor(scene, propsRoot, roads) {
    this.scene = scene;
    // 道路 → 折线（含桥梁高程）
    const key = (x, y) => Math.round(x / 3) + ',' + Math.round(y / 3);
    const ends = new Map();
    roads.forEach((r, i) => { const p = r.p; [[p[0], p[1]], [p[p.length - 2], p[p.length - 1]]].forEach(([x, y]) => { const k = key(x, y); if (!ends.has(k)) ends.set(k, []); ends.get(k).push(i); }); });
    this.paths = []; const startIdx = new Map();
    roads.forEach((r, ri) => {
      const n = r.p.length / 2; if (n < 2) return;
      const pts = []; for (let i = 0; i < n; i++) pts.push([r.p[2 * i], r.p[2 * i + 1]]);
      const cum = [0]; for (let i = 1; i < n; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
      const tot = cum[n - 1]; if (tot < 15) return;
      const base = RZ[r.c] || 0.35; const zs = new Float32Array(n).fill(base);
      if (r.br) {
        const elevated = ['motorway', 'trunk', 'primary'].includes(r.c) && Math.hypot(pts[n - 1][0] - pts[0][0], pts[n - 1][1] - pts[0][1]) > 120;
        const H = elevated ? 9 : 2.2, ramp = Math.min(elevated ? 160 : 25, tot / 2.2);
        const joins = (x, y) => (ends.get(key(x, y)) || []).some((o) => o !== ri && roads[o].br);
        const s0 = joins(...pts[0]), s1 = joins(...pts[n - 1]);
        for (let i = 0; i < n; i++) { let f = Math.min(s0 ? 1 : Math.min(1, cum[i] / ramp), s1 ? 1 : Math.min(1, (tot - cum[i]) / ramp)); f = f * f * (3 - 2 * f); zs[i] = base + H * f; }
      }
      const lanes = Math.max(1, r.l || 1); const hw = r.w / 2;
      const dirs = r.o ? [1] : [1, -1];
      for (const dir of dirs) {
        const nl = r.o ? lanes : lanes; const lw = r.o ? (2 * hw - 1.8) / nl : (hw - 0.9) / nl;
        for (let L = 0; L < nl; L++) {
          const off = r.o ? (-hw + 0.9 + lw * (L + 0.5)) : (0.35 + lw * (L + 0.5)); // 正值=行驶方向右侧
          // 按行驶方向生成折线
          const P = dir > 0 ? pts : pts.slice().reverse(); const Z = dir > 0 ? Array.from(zs) : Array.from(zs).reverse();
          const out = new Float32Array(n * 3);
          for (let i = 0; i < n; i++) {
            const a = P[Math.max(0, i - 1)], b = P[Math.min(n - 1, i + 1)]; const dx = b[0] - a[0], dy = b[1] - a[1]; const l = Math.hypot(dx, dy) || 1;
            const rx = dy / l, ry = -dx / l; // 右法线
            out[i * 3] = P[i][0] + rx * off; out[i * 3 + 1] = P[i][1] + ry * off; out[i * 3 + 2] = Z[i];
          }
          const c2 = new Float32Array(n); for (let i = 1; i < n; i++) c2[i] = c2[i - 1] + Math.hypot(out[i * 3] - out[i * 3 - 3], out[i * 3 + 1] - out[i * 3 - 2]);
          const path = { pts: out, cum: c2, len: c2[n - 1], cls: r.c, lane: L, endKey: key(P[n - 1][0], P[n - 1][1]) };
          this.paths.push(path);
          const sk = key(P[0][0], P[0][1]); if (!startIdx.has(sk)) startIdx.set(sk, []); startIdx.get(sk).push(this.paths.length - 1);
        }
      }
    });
    for (const p of this.paths) p.next = startIdx.get(p.endKey) || [];
    // 车辆
    this.cars = [];
    let seed = 1; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    this.paths.forEach((p, pi) => {
      const n = Math.floor(p.len / 1000 * DENS[p.cls] + rnd());
      for (let i = 0; i < n; i++) {
        const kindR = rnd(); const kind = kindR < 0.62 ? 0 : kindR < 0.88 ? 1 : kindR < 0.95 ? 2 : 3;
        this.cars.push({ p: pi, s: rnd() * p.len, v: SPEED[p.cls] * (0.75 + rnd() * 0.4), kind, col: kind === 2 ? 0x2e8b57 : PALETTE[(rnd() * PALETTE.length) | 0], seg: 0 });
      }
    });
    // 实例网格：每种车 × 每个材质部件
    this.cap = 7000; this.kinds = [];
    for (let k = 0; k < 4; k++) {
      const node = propsRoot.getObjectByName('CAR_' + k); node.updateMatrixWorld(true);
      const inv = new THREE.Matrix4().copy(node.matrixWorld).invert(); const parts = [];
      node.traverse((o) => {
        if (!o.isMesh) return;
        const g = o.geometry.clone(); g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld));
        const nm = o.material.name; const m = o.material.clone();
        if (/headlight/.test(nm)) { m.emissive = new THREE.Color(1, 0.95, 0.85); this.head = this.head || []; this.head.push(m); }
        if (/taillight/.test(nm)) { m.emissive = new THREE.Color(1, 0.05, 0.03); this.tail = this.tail || []; this.tail.push(m); }
        if (/body/.test(nm)) { m.color.set(0xffffff); m.envMapIntensity = 1.2; m.roughness = 0.3; m.metalness = 0.5; }
        const im = new THREE.InstancedMesh(g, m, this.cap); im.count = 0; im.frustumCulled = false; im.castShadow = /body/.test(nm); im.receiveShadow = true;
        im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        if (/body/.test(nm)) { im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.cap * 3), 3); im.instanceColor.setUsage(THREE.DynamicDrawUsage); }
        scene.add(im); parts.push(im);
      });
      this.kinds.push(parts);
    }
    this.visible = true; this.speedMul = 1;
  }
  setVisible(v) { this.visible = v; for (const ps of this.kinds) for (const im of ps) im.visible = v; }
  posAt(path, s, out) {
    const c = path.cum; let lo = 0, hi = c.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (c[m] <= s) lo = m; else hi = m; }
    const t = (s - c[lo]) / Math.max(1e-3, c[hi] - c[lo]); const p = path.pts;
    out[0] = p[lo * 3] + (p[hi * 3] - p[lo * 3]) * t; out[1] = p[lo * 3 + 1] + (p[hi * 3 + 1] - p[lo * 3 + 1]) * t; out[2] = p[lo * 3 + 2] + (p[hi * 3 + 2] - p[lo * 3 + 2]) * t;
    out[3] = Math.atan2(p[hi * 3 + 1] - p[lo * 3 + 1], p[hi * 3] - p[lo * 3]);
  }
  update(dt, camPos, target) {
    if (!this.visible) return;
    const night = U.uNight.value; if (this.head) for (const m of this.head) m.emissiveIntensity = 0.3 + night * 6; if (this.tail) for (const m of this.tail) m.emissiveIntensity = 0.2 + night * 4;
    const h = Math.max(camPos.y, 2); const R = Math.min(5000, 700 + h * 2.2); const R2 = R * R;
    const cx = (camPos.x + target.x) / 2, cz = (camPos.z + target.z) / 2;
    const cnt = [0, 0, 0, 0]; const tmp = [0, 0, 0, 0]; const col = new THREE.Color();
    for (const car of this.cars) {
      let path = this.paths[car.p]; car.s += car.v * dt * this.speedMul;
      if (car.s > path.len) {
        const nx = path.next; car.s -= path.len;
        if (nx.length) { car.p = nx[(Math.random() * nx.length) | 0]; } else { car.p = (Math.random() * this.paths.length) | 0; car.s = 0; }
        path = this.paths[car.p]; if (car.s > path.len) car.s = 0;
      }
      // 粗筛：路径包围不算，直接用首点估计会漏，改为算出位置后判断
      this.posAt(path, car.s, tmp);
      const dx = tmp[0] - cx, dz = -tmp[1] - cz; if (dx * dx + dz * dz > R2) continue;
      const k = car.kind; const i = cnt[k]++; if (i >= this.cap) continue;
      const ca = Math.cos(tmp[3]), sa = Math.sin(tmp[3]);
      for (const im of this.kinds[k]) {
        const a = im.instanceMatrix.array, o = i * 16;
        // 车头沿 +x（Blender 里车头朝 +X），绕 y 转 tmp[3]
        a[o] = ca; a[o + 1] = 0; a[o + 2] = -sa; a[o + 3] = 0; a[o + 4] = 0; a[o + 5] = 1; a[o + 6] = 0; a[o + 7] = 0;
        a[o + 8] = sa; a[o + 9] = 0; a[o + 10] = ca; a[o + 11] = 0; a[o + 12] = tmp[0]; a[o + 13] = tmp[2]; a[o + 14] = -tmp[1]; a[o + 15] = 1;
        if (im.instanceColor) { col.setHex(car.col); col.toArray(im.instanceColor.array, i * 3); }
      }
    }
    for (let k = 0; k < 4; k++) for (const im of this.kinds[k]) { im.count = Math.min(cnt[k], this.cap); im.instanceMatrix.needsUpdate = true; if (im.instanceColor) im.instanceColor.needsUpdate = true; }
    this.shown = cnt.reduce((a, b) => a + b, 0);
  }
}
