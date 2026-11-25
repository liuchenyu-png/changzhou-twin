// 近景立面实体几何：相机附近的楼按 bld.bin 轮廓实时生成楼板挑檐、窗间柱、阳台、竖向肋片、雨棚、勒脚、压顶
// 网格与立面着色器的窗格一致（uv0 = 周长米/高度米），构件用“类型 +10”（同墙色、无窗）
import * as THREE from 'three';

const CELL = 200;                         // 分格边长（米）
const GRID = { 1: [3.3, 3.0], 2: [1.6, 3.9], 3: [6.5, 6.0], 4: [4.2, 3.4] };   // 类型 → [柱距, 层高]

// 单栋几何写入器：Blender XY → three (x, z, -y)
export class Sink {
  constructor() { this.p = []; this.n = []; this.u = []; this.u1 = []; this.i = []; }
  quad(a, b, c, d, ua, ub, code, H) {      // a,b,c,d 逆时针（从外看），坐标为 Blender [x,y,z]
    const o = this.p.length / 3;
    const ex = b[0] - a[0], ey = b[1] - a[1], ez = b[2] - a[2], fx = d[0] - a[0], fy = d[1] - a[1], fz = d[2] - a[2];
    let nx = ey * fz - ez * fy, ny = ez * fx - ex * fz, nz = ex * fy - ey * fx; const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    for (const q of [a, b, c, d]) { this.p.push(q[0], q[2], -q[1]); this.n.push(nx, nz, -ny); this.u1.push(code, 1 - H); }
    // uv：x 沿构件，y 为高度（米）；V 预翻转（材质里按 glTF 约定再翻回来）
    this.u.push(ua[0], 1 - ua[1], ub[0], 1 - ua[1], ub[0], 1 - ub[1], ua[0], 1 - ub[1]);
    this.i.push(o, o + 1, o + 2, o, o + 2, o + 3);
  }
  tri(a, b, c, w, code, H) {               // 山墙三角：uv x 沿底边、y 为高度
    const o = this.p.length / 3;
    const ex = b[0] - a[0], ey = b[1] - a[1], ez = b[2] - a[2], fx = c[0] - a[0], fy = c[1] - a[1], fz = c[2] - a[2];
    let nx = ey * fz - ez * fy, ny = ez * fx - ex * fz, nz = ex * fy - ey * fx; const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    for (const q of [a, b, c]) { this.p.push(q[0], q[2], -q[1]); this.n.push(nx, nz, -ny); this.u1.push(code, 1 - H); }
    this.u.push(0, 1 - a[2], w, 1 - b[2], w / 2, 1 - c[2]);
    this.i.push(o, o + 1, o + 2);
  }
}

// 沿墙边的长方体：s 沿边、o 外法向、z 高度；faces 位掩码 1 前 2 顶 4 底 8 起端 16 末端
function edgeBox(S, E, s0, s1, o0, o1, z0, z1, code, H, faces = 31) {
  const P = (s, o, z) => [E.ax + E.tx * s + E.nx * o, E.ay + E.ty * s + E.ny * o, z];
  const u0 = E.per + s0, u1 = E.per + s1;
  if (faces & 1) S.quad(P(s0, o1, z0), P(s1, o1, z0), P(s1, o1, z1), P(s0, o1, z1), [u0, z0], [u1, z1], code, H);
  if (faces & 2) S.quad(P(s0, o1, z1), P(s1, o1, z1), P(s1, o0, z1), P(s0, o0, z1), [u0, z1], [u1, z1 + o1 - o0], code, H);
  if (faces & 4) S.quad(P(s0, o0, z0), P(s1, o0, z0), P(s1, o1, z0), P(s0, o1, z0), [u0, z0], [u1, z0 + o1 - o0], code, H);
  if (faces & 8) S.quad(P(s0, o0, z0), P(s0, o1, z0), P(s0, o1, z1), P(s0, o0, z1), [u0, z0], [u0 + o1 - o0, z1], code, H);
  if (faces & 16) S.quad(P(s1, o1, z0), P(s1, o0, z0), P(s1, o0, z1), P(s1, o1, z1), [u1, z0], [u1 + o1 - o0, z1], code, H);
}

function buildOne(S, st, sd, z0, h, ph, ring) {
  const n = ring.length, top = h + ph, Hw = h - z0;
  if (Hw < 2.5) return;
  const [colW, floorH] = GRID[st] || GRID[1];
  const solid = st + 10 + sd, stone = 12 + sd;
  // 边表 + 凸凹角（CCW：左转为凸角）
  const E = []; let per = 0;
  for (let k = 0; k < n; k++) {
    const a = ring[k], b = ring[(k + 1) % n]; const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const tx = (b[0] - a[0]) / (L || 1), ty = (b[1] - a[1]) / (L || 1);
    E.push({ ax: a[0], ay: a[1], tx, ty, nx: ty, ny: -tx, L, per }); per += L;
  }
  for (let k = 0; k < n; k++) {
    const e = E[k], p = E[(k + n - 1) % n], q = E[(k + 1) % n];
    const ca = p.tx * e.ty - p.ty * e.tx, cb = e.tx * q.ty - e.ty * q.tx;
    e.cvA = ca > 0.2 ? 1 : (ca < -0.2 ? -1 : 0);   // 起点角
    e.cvB = cb > 0.2 ? 1 : (cb < -0.2 ? -1 : 0);   // 终点角
  }
  // 绕楼一圈的水平带：凸角伸出 d 搭接，凹角缩回 d 避免插进墙里
  const band = (za, zb, d, code, faces = 7) => {
    for (const e of E) {
      if (e.L < 0.4) continue;
      const s0 = e.cvA > 0 ? -d : (e.cvA < 0 ? d : 0), s1 = e.L + (e.cvB > 0 ? d : (e.cvB < 0 ? -d : 0));
      if (s1 - s0 > 0.2) edgeBox(S, e, s0, s1, 0, d, za, zb, code, h, faces);
    }
  };
  // 勒脚（石材，略外凸）
  band(z0, z0 + Math.min(0.7, Hw * 0.15), 0.1, stone, 3);
  // 女儿墙压顶
  if (ph > 0) band(top - 0.16, top, 0.09, solid, 7);
  if (st === 4) return;
  const floors = [];
  for (let z = Math.ceil((z0 + 0.5) / floorH) * floorH; z < h - 0.8; z += floorH) floors.push(z);

  if (st === 1) {
    // 楼板挑檐
    for (const z of floors) band(z - 0.1, z + 0.12, 0.22, solid);
    if (ph === 0 && Hw > 5) band(h - 0.3, h, 0.3, solid);
    const balOff = Math.floor(sd * 5);
    for (const e of E) {
      if (e.L < 2) continue;
      // 窗间柱：窗格边界两侧各 0.17 柱距
      for (let c = Math.ceil(e.per / colW); c * colW <= e.per + e.L; c++) {
        const s = c * colW - e.per, a = Math.max(0.25, s - 0.17 * colW), b = Math.min(e.L - 0.25, s + 0.17 * colW);
        if (b - a > 0.3) edgeBox(S, e, a, b, 0, 0.16, z0 + 0.7, h, solid, h, 25);
      }
      // 阳台：板 + 实心栏板（与着色器 balc 规则同列）
      if (Hw < 6) continue;
      for (let c = Math.floor(e.per / colW); (c + 1) * colW <= e.per + e.L + 1e-3; c++) {
        if (((c + balOff) % 3 + 3) % 3 >= 1) continue;
        const a = (c + 0.12) * colW - e.per, b = (c + 0.88) * colW - e.per;
        if (a < 0.2 || b > e.L - 0.2) continue;
        for (const z of floors) {
          if (z < 2.9) continue;
          edgeBox(S, e, a, b, 0.16, 1.15, z - 0.1, z + 0.12, solid, h, 1 | 4 | 8 | 16);  // 楼板
          edgeBox(S, e, a, b, 1.03, 1.15, z + 0.12, z + 1.05, solid, h, 1 | 2 | 8 | 16); // 前栏板
          edgeBox(S, e, a, b, 0.16, 1.03, z + 0.12, z + 0.13, solid, h, 2);             // 阳台地面
        }
      }
    }
  } else if (st === 2) {
    // 层间带（窗下槛墙位置）+ 竖向铝肋 + 底商雨棚
    for (const z of floors) if (z > 4.5) band(z, z + 0.78, 0.12, solid, 7);
    const step = per > 160 ? 2 : 1;
    for (const e of E) {
      if (e.L < 1.5) continue;
      for (let c = Math.ceil(e.per / colW); c * colW <= e.per + e.L; c++) {
        if (c % step) continue;
        const s = c * colW - e.per; if (s < 0.3 || s > e.L - 0.3) continue;
        edgeBox(S, e, s - 0.06, s + 0.06, 0.12, 0.42, Math.max(z0, 5), h, solid, h, 1 | 8 | 16);
      }
      if (z0 < 1 && e.L > 4) edgeBox(S, e, 0.3, e.L - 0.3, 0, 1.6, 4.65, 4.9, solid, h, 31);
    }
    if (ph === 0) band(h - 0.5, h, 0.25, solid);
  } else if (st === 3) {
    // 钢柱 + 窗台 + 檐口
    for (const e of E) {
      if (e.L < 3) continue;
      for (let c = Math.ceil(e.per / colW); c * colW <= e.per + e.L; c++) {
        const s = c * colW - e.per; if (s < 0.4 || s > e.L - 0.4) continue;
        edgeBox(S, e, s - 0.2, s + 0.2, 0, 0.22, z0 + 0.7, h, solid, h, 25);
      }
    }
    for (let z = Math.floor(z0 / floorH) * floorH; z < h; z += floorH) { const zs = z + floorH * 0.55; if (zs > z0 + 1 && zs < h - 0.5) band(zs - 0.08, zs, 0.14, solid); }
    band(h - 0.45, h, 0.35, solid);
  }
}

export class Facades {
  constructor(scene, material, buf, extra = []) {
    this.mat = material; this.group = new THREE.Group(); this.group.name = 'facades'; scene.add(this.group);
    this.cells = new Map(); this.live = new Map(); this.visible = true; this.tris = 0;
    const f = new Float32Array(buf); const N = f[0]; let k = 1;
    for (let b = 0; b < N; b++) {
      const st = f[k], sd = f[k + 1], z0 = f[k + 2], h = f[k + 3], ph = f[k + 4], n = f[k + 5]; k += 6;
      const ring = []; let cx = 0, cy = 0;
      for (let j = 0; j < n; j++) { ring.push([f[k], f[k + 1]]); cx += f[k]; cy += f[k + 1]; k += 2; }
      const i = Math.floor(cx / n / CELL), j = Math.floor(cy / n / CELL), key = i + ',' + j;
      let c = this.cells.get(key); if (!c) { c = { key, x: (i + 0.5) * CELL, y: (j + 0.5) * CELL, b: [], hmax: 0 }; this.cells.set(key, c); }
      c.b.push([st, sd, z0, h, ph, ring]); c.hmax = Math.max(c.hmax, h);
    }
    for (const rec of extra) {
      const ring = rec[5]; const cx = (ring[0][0] + ring[2][0]) / 2, cy = (ring[0][1] + ring[2][1]) / 2;
      const i = Math.floor(cx / CELL), j = Math.floor(cy / CELL), key = i + ',' + j;
      let c = this.cells.get(key); if (!c) { c = { key, x: (i + 0.5) * CELL, y: (j + 0.5) * CELL, b: [], hmax: 0 }; this.cells.set(key, c); }
      c.b.push(rec); c.hmax = Math.max(c.hmax, rec[3]);
    }
  }
  build(c) {
    const S = new Sink();
    for (const [st, sd, z0, h, ph, ring] of c.b) buildOne(S, st, sd, z0, h, ph, ring);
    if (!S.i.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(S.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(S.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(S.u, 2));
    g.setAttribute('uv1', new THREE.Float32BufferAttribute(S.u1, 2));
    g.setIndex(S.p.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(S.i, 1) : new THREE.Uint16BufferAttribute(S.i, 1));
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, this.mat); m.castShadow = true; m.receiveShadow = true; m.matrixAutoUpdate = false;
    return m;
  }
  drop(key) {
    const m = this.live.get(key);
    if (m) { this.group.remove(m); this.tris -= m.geometry.index.count / 3; m.geometry.dispose(); }
    this.live.delete(key);
  }
  // 相机（three 坐标）附近的格子生成，远的释放；每帧限时 6 ms
  update(cam) {
    if (!this.visible) return;
    const cx = cam.x, cy = -cam.z, R = THREE.MathUtils.clamp(420 + cam.y * 0.5, 420, 800);
    const want = [];
    for (const c of this.cells.values()) {
      const d = Math.hypot(c.x - cx, c.y - cy, Math.max(0, cam.y - c.hmax));
      if (d < R) want.push([d, c]); else if (d > R + 150 && this.live.has(c.key)) this.drop(c.key);
    }
    want.sort((a, b) => a[0] - b[0]);
    const t0 = performance.now();
    for (const [, c] of want) {
      if (this.live.has(c.key)) continue;
      const m = this.build(c); this.live.set(c.key, m);
      if (m) { this.group.add(m); this.tris += m.geometry.index.count / 3; }
      if (performance.now() - t0 > 6) break;
    }
  }
  setVisible(v) { this.visible = v; this.group.visible = v; }
}
