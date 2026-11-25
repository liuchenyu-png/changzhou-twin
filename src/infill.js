// 全覆盖补楼：infill.bin（每栋 cx, cy, 面宽 L, 进深 D, 朝向, 高, 类型, 种子）→ 按 3 km 分块拼体块
// 与 blender_city.py 同一套约定：墙 uv0 = (周长米, 高米)、uv1 = (类型+种子, 屋顶高)；女儿墙/压顶 = 类型+10；机房 = 9+种子
import * as THREE from 'three';
import { Sink } from './facades.js';

const CH = 3000;

function rect(cx, cy, L, D, ang) {
  const ca = Math.cos(ang), sa = Math.sin(ang);
  return [[-L / 2, -D / 2], [L / 2, -D / 2], [L / 2, D / 2], [-L / 2, D / 2]].map(([u, v]) => [cx + u * ca - v * sa, cy + u * sa + v * ca]);
}

function walls(S, ring, z0, top, code, H) {
  let per = 0;
  for (let k = 0; k < ring.length; k++) {
    const a = ring[k], b = ring[(k + 1) % ring.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    S.quad([a[0], a[1], z0], [b[0], b[1], z0], [b[0], b[1], top], [a[0], a[1], top], [per, z0], [per + L, top], code, H);
    per += L;
  }
}

function box(S, cx, cy, L, D, ang, z0, hh, code) {
  const r = rect(cx, cy, L, D, ang); const z1 = z0 + hh;
  walls(S, r, z0, z1, code, hh);
  S.quad([r[0][0], r[0][1], z1], [r[1][0], r[1][1], z1], [r[2][0], r[2][1], z1], [r[3][0], r[3][1], z1], [0, 0], [L, D], code, hh);
}

function massing(W, R, T, cx, cy, L, D, ang, h, st, sd) {
  const code = st + sd;
  if (st === 4) {                               // 村落：坡屋顶，屋脊顺面宽
    const ring = rect(cx, cy, L, D, ang); walls(W, ring, 0, h, code, h);
    const ov = 0.5, rh = D * 0.3, ca = Math.cos(ang), sa = Math.sin(ang);
    const P = (u, v, z) => [cx + u * ca - v * sa, cy + u * sa + v * ca, z];
    const u0 = -L / 2 - ov, u1 = L / 2 + ov, v0 = -D / 2 - ov, v1 = D / 2 + ov, ez = h - 0.2;
    T.quad(P(u0, v0, ez), P(u1, v0, ez), P(u1, 0, h + rh), P(u0, 0, h + rh), [0, 0], [u1 - u0, (v1 - v0) / 2], code, h);
    T.quad(P(u1, v1, ez), P(u0, v1, ez), P(u0, 0, h + rh), P(u1, 0, h + rh), [0, 0], [u1 - u0, (v1 - v0) / 2], code, h);
    // 山墙三角
    W.tri(P(-L / 2, D / 2, h), P(-L / 2, -D / 2, h), P(-L / 2, 0, h + rh - 0.3), D, code, h);
    W.tri(P(L / 2, -D / 2, h), P(L / 2, D / 2, h), P(L / 2, 0, h + rh - 0.3), D, code, h);
    return;
  }
  const ph = h >= 7 ? (st === 3 ? 0.6 : 1.1) : 0, top = h + ph;
  const ring = rect(cx, cy, L, D, ang); walls(W, ring, 0, top, code, h);
  const inner = ph ? rect(cx, cy, L - 0.6, D - 0.6, ang) : ring;
  if (ph) {
    const pc = st + 10 + sd; let per = 0;
    for (let k = 0; k < 4; k++) {
      const a = ring[k], b = ring[(k + 1) % 4], ia = inner[k], ib = inner[(k + 1) % 4], Lk = Math.hypot(ib[0] - ia[0], ib[1] - ia[1]);
      W.quad([a[0], a[1], top], [b[0], b[1], top], [ib[0], ib[1], top], [ia[0], ia[1], top], [per, 0], [per + Lk, 0.3], pc, h);
      W.quad([ib[0], ib[1], h], [ia[0], ia[1], h], [ia[0], ia[1], top], [ib[0], ib[1], top], [per + Lk, h], [per, top], pc, h);
      per += Lk;
    }
  }
  R.quad([inner[0][0], inner[0][1], h], [inner[1][0], inner[1][1], h], [inner[2][0], inner[2][1], h], [inner[3][0], inner[3][1], h], [0, 0], [L, D], code, h);
  // 屋顶机房 / 设备
  const r1 = (sd * 7.31) % 1, r2 = (sd * 13.7) % 1;
  if (h >= 15 && st <= 2 && L > 12 && D > 9) {
    const n = L > 34 ? 2 : 1;
    for (let q = 0; q < n; q++) {
      const off = n === 1 ? (r1 - 0.5) * L * 0.3 : (q ? 1 : -1) * L * 0.25;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      box(W, cx + off * ca, cy + off * sa, Math.min(L * 0.12, 4.5) + 2.4, Math.min(D * 0.4, 7), ang, h, 3.2 + r2 * 1.4, 9 + sd);
    }
  } else if (st === 3 && r1 < 0.6) {
    for (let q = 0; q < 3; q++) { const off = (q - 1) * L * 0.25, ca = Math.cos(ang), sa = Math.sin(ang); box(W, cx + off * ca, cy + off * sa, 2.2, 1.6, ang, h, 1.2, 9.5); }
  }
}

export function parseInfill(buf) {
  const f = new Float32Array(buf); const N = f[0]; const out = [];
  for (let i = 0; i < N; i++) {
    const k = 1 + i * 8; const [cx, cy, L, D, ang, h, st, sd] = f.subarray(k, k + 8);
    out.push({ cx, cy, L, D, ang, h, st: Math.round(st), sd });
  }
  return out;
}

// 返回网格数组（每块一个网格，三组材质：墙/平屋顶/坡屋顶）
export function buildInfill(list, mats) {
  const chunks = new Map();
  for (const b of list) {
    const key = Math.floor(b.cx / CH) + ',' + Math.floor(b.cy / CH);
    let c = chunks.get(key); if (!c) { c = [new Sink(), new Sink(), new Sink()]; chunks.set(key, c); }
    massing(c[0], c[1], c[2], b.cx, b.cy, b.L, b.D, b.ang, b.h, b.st, b.sd);
  }
  const meshes = [];
  for (const [W, R, T] of chunks.values()) {
    const g = new THREE.BufferGeometry(); const S3 = [W, R, T];
    const nv = S3.reduce((a, S) => a + S.p.length / 3, 0), ni = S3.reduce((a, S) => a + S.i.length, 0);
    const P = new Float32Array(nv * 3), N = new Float32Array(nv * 3), U = new Float32Array(nv * 2), U1 = new Float32Array(nv * 2), I = new Uint32Array(ni);
    let vo = 0, io = 0;
    S3.forEach((S, gi) => {
      P.set(S.p, vo * 3); N.set(S.n, vo * 3); U.set(S.u, vo * 2); U1.set(S.u1, vo * 2);
      for (let k = 0; k < S.i.length; k++) I[io + k] = S.i[k] + vo;
      g.addGroup(io, S.i.length, gi); vo += S.p.length / 3; io += S.i.length;
    });
    g.setAttribute('position', new THREE.BufferAttribute(P, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(N, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(U, 2));
    g.setAttribute('uv1', new THREE.BufferAttribute(U1, 2));
    g.setIndex(new THREE.BufferAttribute(I, 1));
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, mats); m.castShadow = true; m.receiveShadow = true; m.matrixAutoUpdate = false; m.name = 'infill';
    meshes.push(m);
  }
  return meshes;
}

// 给近景立面模块用的记录：[st, sd, z0, h, ph, ring]
export function infillRecords(list) {
  return list.map((b) => [b.st, b.sd, 0, b.h, b.st === 4 || b.h < 7 ? 0 : (b.st === 3 ? 0.6 : 1.1), rect(b.cx, b.cy, b.L, b.D, b.ang)]);
}
