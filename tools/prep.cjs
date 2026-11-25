// 预处理：OSM（本地米坐标）→ 裁剪到建模范围 + 道路宽度/交叉口 + 楼高推断 + 程序化补楼 + 树位
// 用法：node prep.cjs <cz_osm.json> <outDir>
const fs = require('fs');
const path = require('path');
const [, , SRC, OUT] = process.argv;
const d = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const B = { x0: -14000, x1: 7000, y0: -12000, y1: 10000 };

// ---------- 工具 ----------
function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const hash2 = (x, y) => (Math.imul(Math.round(x * 10), 73856093) ^ Math.imul(Math.round(y * 10), 19349663)) >>> 0;
const R = rng(20261119);
const BB0 = B;
const inB = (p, m = 0) => p[0] >= B.x0 - m && p[0] <= B.x1 + m && p[1] >= B.y0 - m && p[1] <= B.y1 + m;
function clipRing(ring, m = 0) { // Sutherland–Hodgman 矩形裁剪（m=外扩）
  let pts = ring; const B = { x0: BB0.x0 - m, x1: BB0.x1 + m, y0: BB0.y0 - m, y1: BB0.y1 + m };
  const edges = [[p => p[0] >= B.x0, (a, b) => ix(a, b, 0, B.x0)], [p => p[0] <= B.x1, (a, b) => ix(a, b, 0, B.x1)],
                 [p => p[1] >= B.y0, (a, b) => ix(a, b, 1, B.y0)], [p => p[1] <= B.y1, (a, b) => ix(a, b, 1, B.y1)]];
  function ix(a, b, k, v) { const t = (v - a[k]) / (b[k] - a[k]); return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; }
  for (const [inside, inter] of edges) {
    const res = []; for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      if (inside(b)) { if (!inside(a)) res.push(inter(a, b)); res.push(b); } else if (inside(a)) res.push(inter(a, b));
    } pts = res; if (!pts.length) break;
  }
  return pts;
}
function cleanRing(r) { const o = []; for (const p of r) { const q = o[o.length - 1]; if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 0.3) o.push([+p[0].toFixed(1), +p[1].toFixed(1)]); }
  if (o.length > 2 && Math.hypot(o[0][0] - o[o.length - 1][0], o[0][1] - o[o.length - 1][1]) < 0.3) o.pop(); return o; }
function clipPoly(rings, m = 0) { const out = []; for (let i = 0; i < rings.length; i++) { const c = cleanRing(clipRing(rings[i], m)); if (c.length >= 3) out.push(c); else if (i === 0) return null; } return out; }
const area = r => { let s = 0; for (let i = 0; i < r.length; i++) { const a = r[i], b = r[(i + 1) % r.length]; s += a[0] * b[1] - b[0] * a[1]; } return s / 2; };
const centroid = r => { let x = 0, y = 0; for (const p of r) { x += p[0]; y += p[1]; } return [x / r.length, y / r.length]; };
function pip(pt, ring) { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const a = ring[i], b = ring[j];
  if ((a[1] > pt[1]) !== (b[1] > pt[1]) && pt[0] < (b[0] - a[0]) * (pt[1] - a[1]) / (b[1] - a[1]) + a[0]) c = !c; } return c; }
const pipPoly = (pt, rings) => pip(pt, rings[0]) && !rings.slice(1).some(h => pip(pt, h));
function domAngle(r) { const bins = new Float64Array(45); for (let i = 0; i < r.length; i++) { const a = r[i], b = r[(i + 1) % r.length];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]); let ang = Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI; ang = ((ang % 90) + 90) % 90; bins[Math.floor(ang / 2) % 45] += L; }
  let bi = 0; for (let i = 1; i < 45; i++) if (bins[i] > bins[bi]) bi = i; let a = bi * 2 + 1; if (a > 45) a -= 90; return a * Math.PI / 180; }

// ---------- 占用栅格（4 m） ----------
const CS = 4, GW = Math.ceil((B.x1 - B.x0) / CS), GH = Math.ceil((B.y1 - B.y0) / CS);
const occ = new Uint8Array(GW * GH); // 0 空 1 水 2 楼 3 路 4 铁路
const gi = (x, y) => { const i = Math.floor((x - B.x0) / CS), j = Math.floor((y - B.y0) / CS); return (i < 0 || j < 0 || i >= GW || j >= GH) ? -1 : j * GW + i; };
function fillPoly(rings, v, pad = 0) { // 扫描线填充（偶奇规则，含洞）
  let y0 = Infinity, y1 = -Infinity; for (const p of rings[0]) { y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
  const j0 = Math.max(0, Math.floor((y0 - B.y0) / CS)), j1 = Math.min(GH - 1, Math.floor((y1 - B.y0) / CS));
  for (let j = j0; j <= j1; j++) { const y = B.y0 + (j + 0.5) * CS; const xs = [];
    for (const r of rings) for (let i = 0, k = r.length - 1; i < r.length; k = i++) { const a = r[i], b = r[k];
      if ((a[1] > y) !== (b[1] > y)) xs.push(a[0] + (y - a[1]) * (b[0] - a[0]) / (b[1] - a[1])); }
    xs.sort((a, b) => a - b);
    for (let n = 0; n + 1 < xs.length; n += 2) { const i0 = Math.max(0, Math.floor((xs[n] - pad - B.x0) / CS)), i1 = Math.min(GW - 1, Math.floor((xs[n + 1] + pad - B.x0) / CS));
      for (let i = i0; i <= i1; i++) if (occ[j * GW + i] < v || v === 1) occ[j * GW + i] = Math.max(occ[j * GW + i], v); } } }
function stampLine(pts, hw, v) { for (let s = 0; s + 1 < pts.length; s++) { const a = pts[s], b = pts[s + 1]; const L = Math.hypot(b[0] - a[0], b[1] - a[1]); const n = Math.ceil(L / 2) + 1;
    const rr = Math.ceil(hw / CS); for (let k = 0; k <= n; k++) { const x = a[0] + (b[0] - a[0]) * k / n, y = a[1] + (b[1] - a[1]) * k / n;
      const ci = Math.floor((x - B.x0) / CS), cj = Math.floor((y - B.y0) / CS);
      for (let dj = -rr; dj <= rr; dj++) for (let di = -rr; di <= rr; di++) { if ((di * di + dj * dj) * CS * CS > hw * hw + 8) continue;
        const i = ci + di, j = cj + dj; if (i >= 0 && j >= 0 && i < GW && j < GH && occ[j * GW + i] < v) occ[j * GW + i] = v; } } } }

// ---------- 道路 ----------
const RW = { motorway: [26, 3], trunk: [24, 3], primary: [22, 3], secondary: [16, 2], tertiary: [12, 1], minor: [8, 1], service: [5, 0], busway: [8, 1], track: [3.5, 0], path: [2.5, 0] };
const roads = [];
for (const r of d.roads) {
  if (!RW[r.c] || r.br === 'tunnel') continue;
  if (!r.pts.some(p => inB(p, 50))) continue;
  const pts = cleanRing(r.pts.map(p => [Math.min(B.x1 + 30, Math.max(B.x0 - 30, p[0])), Math.min(B.y1 + 30, Math.max(B.y0 - 30, p[1]))]));
  if (pts.length < 2) continue;
  let w = RW[r.c][0]; if (r.o && ['primary', 'trunk', 'motorway', 'secondary'].includes(r.c)) w *= 0.55;
  roads.push({ c: r.c, w, lanes: RW[r.c][1], o: r.o, br: r.br === 'bridge' ? 1 : 0, pts });
}
// 交叉口：端点或中间点被多条路共用 → 标线淡出
const nodeCount = new Map(); const nk = p => Math.round(p[0] / 3) + ',' + Math.round(p[1] / 3);
for (const r of roads) { const seen = new Set(); for (const p of r.pts) { const k = nk(p); if (!seen.has(k)) { seen.add(k); nodeCount.set(k, (nodeCount.get(k) || 0) + 1); } } }
for (const r of roads) r.x = r.pts.map((p, i) => (nodeCount.get(nk(p)) > 1 ? 1 : 0));
const rail = d.rail.filter(r => r.c === 'rail' && r.br !== 'tunnel' && r.pts.some(p => inB(p))).map(r => ({ br: r.br === 'bridge' ? 1 : 0, pts: cleanRing(r.pts) }));

// ---------- 面 ----------
const polyList = (arr, keep, m = 0) => { const o = []; for (const f of arr) { if (keep && !keep(f)) continue; if (!f.r[0].some(p => inB(p, 20 + m))) continue; const c = clipPoly(f.r, m); if (c && Math.abs(area(c[0])) > 30) o.push({ c: f.c, s: f.s, n: f.n, r: c }); } return o; };
const water = polyList(d.water);   // 只保留建模范围内（不再铺 6 km 外围）
const landuse = polyList(d.landuse);
const landcover = polyList(d.landcover);
const parks = polyList(d.park);
const waterway = d.waterway.filter(w => w.pts.some(p => inB(p))).map(w => ({ c: w.c, n: w.n, pts: cleanRing(w.pts) }));

for (const w of water) fillPoly(w.r, 1);
for (const w of waterway) stampLine(w.pts, w.c === 'river' ? 10 : w.c === 'canal' ? 12 : 3, 1);
for (const r of roads) stampLine(r.pts, r.w / 2 + 3, 3);
for (const r of rail) stampLine(r.pts, 6, 4);

// 用地查询（栅格索引 → 类型）
const LUG = 50, LW = Math.ceil((B.x1 - B.x0) / LUG), LH = Math.ceil((B.y1 - B.y0) / LUG); const luIndex = new Map();
function indexPolys(list, tag) { list.forEach((f, idx) => { let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9; for (const p of f.r[0]) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
  for (let j = Math.floor((y0 - B.y0) / LUG); j <= Math.floor((y1 - B.y0) / LUG); j++) for (let i = Math.floor((x0 - B.x0) / LUG); i <= Math.floor((x1 - B.x0) / LUG); i++) {
    const k = j * LW + i; if (!luIndex.has(k)) luIndex.set(k, []); luIndex.get(k).push([tag, idx]); } }); }
indexPolys(landuse, 'lu'); indexPolys(parks, 'pk'); indexPolys(landcover, 'lc');
function luAt(pt) { const k = Math.floor((pt[1] - B.y0) / LUG) * LW + Math.floor((pt[0] - B.x0) / LUG); const o = { lu: null, pk: null, lc: null };
  for (const [t, i] of luIndex.get(k) || []) { const f = t === 'lu' ? landuse[i] : t === 'pk' ? parks[i] : landcover[i]; if (!o[t] && pipPoly(pt, f.r)) o[t] = f; } return o; }

// ---------- 楼：OSM 实测 + 推断高度 ----------
const CORE = [0, -900]; // 天宁寺附近 = 老城中心
const buildings = [];
for (const b of d.buildings) {
  if (!b.r[0].some(p => inB(p))) continue; const r = clipPoly(b.r); if (!r) continue;
  const A = Math.abs(area(r[0])); if (A < 12) continue;
  const c = centroid(r[0]); const rr = rng(hash2(c[0], c[1])); const ctx = luAt(c);
  let h = b.h, style = 0; const known = !(h <= 5);
  const distCore = Math.hypot(c[0] - CORE[0], c[1] - CORE[1]);
  const hist = ctx.pk && ctx.pk.c === 'historic' || (ctx.pk && /历史|古|巷/.test(ctx.pk.n || ''));
  if (hist) { style = 4; if (!known || h < 12) h = 6 + rr() * 3; }
  else if (!known) {
    const lu = ctx.lu ? ctx.lu.c : '';
    if (A < 160) h = 6 + rr() * 5;
    else if (lu === 'industrial') h = 9 + rr() * 8;
    else if (lu === 'residential') h = (distCore < 2500 && rr() < 0.7) ? 15 + rr() * 6 : (rr() < 0.5 ? 18 : 33 + rr() * 60);
    else if (lu === 'commercial' || lu === 'retail') h = 18 + rr() * 40;
    else if (lu === 'school' || lu === 'university' || lu === 'college') h = 14 + rr() * 8;
    else h = A > 1500 ? 12 + rr() * 10 : 9 + rr() * 12;
  }
  if (!hist) { const lu = ctx.lu ? ctx.lu.c : ''; style = lu === 'industrial' ? 3 : (lu === 'commercial' || lu === 'retail' || h > 90) ? 2 : 1; if (h > 60 && rr() < 0.5) style = 2; }
  buildings.push({ h: +h.toFixed(1), mh: b.mh || 0, s: style, src: 0, r });
  fillPoly(r, 2, 4);
}
console.log('osm buildings', buildings.length);

// ---------- 程序化补楼 ----------
function footprintFree(cx, cy, L, D, ang, pad) {
  const ca = Math.cos(ang), sa = Math.sin(ang);
  for (let u = -L / 2 - pad; u <= L / 2 + pad; u += 3) for (let v = -D / 2 - pad; v <= D / 2 + pad; v += 3) {
    const x = cx + u * ca - v * sa, y = cy + u * sa + v * ca; const k = gi(x, y); if (k < 0 || occ[k]) return false; }
  return true;
}
const rectPts = (cx, cy, L, D, ang) => { const ca = Math.cos(ang), sa = Math.sin(ang);
  return [[-L / 2, -D / 2], [L / 2, -D / 2], [L / 2, D / 2], [-L / 2, D / 2]].map(([u, v]) => [+(cx + u * ca - v * sa).toFixed(1), +(cy + u * sa + v * ca).toFixed(1)]); };
const FILL = {
  residential: (r, dc) => r() < (dc < 2500 ? 0.3 : 0.75)
    ? { L: 26 + r() * 10, D: 18 + r() * 5, sx: 55, sy: 62, h: () => 54 + Math.floor(r() * 18) * 3, s: 1 }
    : { L: 45 + r() * 20, D: 12 + r() * 2, sx: 66, sy: 34, h: () => 15 + Math.floor(r() * 3) * 3, s: 1 },
  commercial: r => ({ L: 34 + r() * 26, D: 26 + r() * 16, sx: 72, sy: 62, h: () => r() < 0.18 ? 90 + r() * 90 : 16 + r() * 30, s: 2 }),
  retail: r => ({ L: 50 + r() * 30, D: 35 + r() * 20, sx: 90, sy: 70, h: () => 12 + r() * 14, s: 2 }),
  industrial: r => ({ L: 70 + r() * 50, D: 34 + r() * 22, sx: 120, sy: 70, h: () => 9 + r() * 7, s: 3 }),
  school: r => ({ L: 60 + r() * 15, D: 15, sx: 85, sy: 48, h: () => 15 + r() * 6, s: 1 }),
  university: r => ({ L: 60 + r() * 25, D: 18, sx: 95, sy: 60, h: () => 18 + r() * 14, s: 1 }),
  college: r => ({ L: 60 + r() * 25, D: 18, sx: 95, sy: 60, h: () => 18 + r() * 14, s: 1 }),
  hospital: r => ({ L: 50, D: 30, sx: 75, sy: 60, h: () => 30 + r() * 40, s: 2 }),
};
let nFill = 0;
for (const f of landuse) {
  const mk = FILL[f.c]; if (!mk) continue; const ring = f.r[0]; const A = Math.abs(area(ring)); if (A < 1500) continue;
  const c = centroid(ring); const r = rng(hash2(c[0], c[1]) ^ 0x9e37);
  const dc = Math.hypot(c[0] - CORE[0], c[1] - CORE[1]);
  const T = mk(r, dc); const ang = domAngle(ring); const ca = Math.cos(ang), sa = Math.sin(ang);
  let u0 = 1e9, u1 = -1e9, v0 = 1e9, v1 = -1e9; for (const p of ring) { const u = p[0] * ca + p[1] * sa, v = -p[0] * sa + p[1] * ca; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
  const ou = r() * T.sx, ov = r() * T.sy;
  for (let v = v0 + ov; v < v1; v += T.sy) for (let u = u0 + ou; u < u1; u += T.sx) {
    const cx = u * ca - v * sa, cy = u * sa + v * ca; if (!inB([cx, cy], -20)) continue;
    const L = T.L * (0.9 + r() * 0.2), D = T.D;
    const corners = rectPts(cx, cy, L, D, ang); if (!corners.every(p => pipPoly(p, f.r))) continue;
    if (!footprintFree(cx, cy, L, D, ang, 3)) continue;
    const h = T.h(); buildings.push({ h: +h.toFixed(1), mh: 0, s: h > 90 ? 2 : T.s, src: 1, r: [corners] });
    fillPoly([corners], 2, 4); nFill++;
  }
}
console.log('procedural buildings', nFill, 'total', buildings.length);

// ---------- 全覆盖补楼：240 m 一个“小区”，空地按类型排楼（输出 infill.bin，网页端拼体块） ----------
const ZC = 240; const segIdx = new Map();
const RWT = { motorway: 3, trunk: 3, primary: 3, secondary: 2, tertiary: 2, minor: 1, service: 0.5, busway: 1 };
for (const r of roads) { const wt = RWT[r.c]; if (!wt) continue;
  for (let s = 0; s + 1 < r.pts.length; s++) { const a = r.pts[s], b = r.pts[s + 1]; const k = Math.floor((a[0] + b[0]) / 2 / ZC) + ',' + Math.floor((a[1] + b[1]) / 2 / ZC);
    if (!segIdx.has(k)) segIdx.set(k, []); segIdx.get(k).push([a, b, wt]); } }
function zoneAngle(i, j) { const bins = new Float64Array(45); let tot = 0;
  for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) for (const [a, b, wt] of segIdx.get((i + di) + ',' + (j + dj)) || []) {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]); let ang = Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI; ang = ((ang % 90) + 90) % 90; bins[Math.floor(ang / 2) % 45] += L * wt; tot += L * wt; }
  if (!tot) return 0; let bi = 0; for (let k = 1; k < 45; k++) if (bins[k] > bins[bi]) bi = k; let a = bi * 2 + 1; if (a > 45) a -= 90; return a * Math.PI / 180; }
const vnoise = (x, y, s, seed) => { const fx = x / s, fy = y / s, i = Math.floor(fx), j = Math.floor(fy), u = fx - i, v = fy - j;
  const h = (a, b) => rng(hash2(a * 7.3 + seed, b * 3.1))(); const su = u * u * (3 - 2 * u), sv = v * v * (3 - 2 * v);
  return (h(i, j) * (1 - su) + h(i + 1, j) * su) * (1 - sv) + (h(i, j + 1) * (1 - su) + h(i + 1, j + 1) * su) * sv; };
const NOBUILD_LU = new Set(['pitch', 'track', 'cemetery', 'stadium', 'park', 'playground', 'theme_park', 'railway', 'dam', 'zoo']);
// 类型：L/D 面宽进深，gu/gv 间距，h 高，st 立面类型
const ZT = {
  mid:   r => { const fl = 5 + Math.floor(r() * 3); return { L: 42 + r() * 22, D: 12 + r() * 2, gu: 10 + r() * 8, gv: fl * 3 * 1.15 + 4, h: () => fl * 3, st: 1 }; },
  high:  r => { const fl = 18 + Math.floor(r() * 16); return { L: 30 + r() * 12, D: 17 + r() * 4, gu: 22 + r() * 12, gv: 42 + r() * 14, h: () => (fl + Math.floor(r() * 3) - 1) * 3, st: 1 }; },
  mixed: r => { const fl = 6 + Math.floor(r() * 6); return { L: 28 + r() * 30, D: 13 + r() * 8, gu: 12 + r() * 10, gv: 20 + r() * 10, h: () => (fl + Math.floor(r() * 4) - 2) * 3, st: 1 }; },
  com:   r => ({ L: 40 + r() * 35, D: 26 + r() * 18, gu: 18 + r() * 14, gv: 22 + r() * 12, h: () => r() < 0.22 ? 70 + r() * 80 : 14 + r() * 26, st: 2 }),
  ind:   r => ({ L: 60 + r() * 60, D: 30 + r() * 26, gu: 14 + r() * 10, gv: 16 + r() * 10, h: () => 8 + r() * 7, st: 3 }),
  vil:   r => ({ L: 13 + r() * 18, D: 10 + r() * 2, gu: 4 + r() * 4, gv: 7 + r() * 5, h: () => 6.5 + Math.floor(r() * 2) * 3 + r() * 0.8, st: 4 }),
};
function pickZone(c, r, lu) {
  if (lu === 'industrial') return 'ind'; if (lu === 'commercial' || lu === 'retail') return 'com';
  const dc = Math.hypot(c[0] - CORE[0], c[1] - CORE[1]); const q = r();
  if (lu === 'residential') return dc < 3500 ? (q < 0.6 ? 'mid' : q < 0.8 ? 'mixed' : 'high') : (q < 0.55 ? 'high' : q < 0.85 ? 'mid' : 'mixed');
  const n = vnoise(c[0], c[1], 1100, 17);     // 低频片区：工业片 / 村落片 / 居住片
  if (dc < 3000) return q < 0.42 ? 'mid' : q < 0.62 ? 'mixed' : q < 0.82 ? 'com' : 'high';
  if (dc < 6500) { if (n > 0.66) return 'ind'; return q < 0.35 ? 'high' : q < 0.65 ? 'mid' : q < 0.8 ? 'mixed' : q < 0.9 ? 'com' : 'vil'; }
  if (n > 0.6) return 'ind'; if (n < 0.33) return q < 0.8 ? 'vil' : 'mid';
  return q < 0.45 ? 'high' : q < 0.7 ? 'mid' : q < 0.85 ? 'vil' : 'com';
}
const infill = []; let nZone = 0; const zones = [];
for (let j = Math.floor(B.y0 / ZC); j * ZC < B.y1; j++) for (let i = Math.floor(B.x0 / ZC); i * ZC < B.x1; i++) {
  const x0 = i * ZC, y0 = j * ZC, c = [x0 + ZC / 2, y0 + ZC / 2]; const r = rng(hash2(i * 13.7, j * 7.9) ^ 0x51ed);
  if (r() < 0.06) continue;                      // 偶尔留一块空地/广场
  const ctx = luAt(c); const zt = pickZone(c, r, ctx.lu ? ctx.lu.c : '');
  const T = ZT[zt](r); const ang = zoneAngle(i, j) + (zt === 'vil' ? (r() - 0.5) * 0.1 : 0); const ca = Math.cos(ang), sa = Math.sin(ang);
  const su = T.L + T.gu, sv = T.D + T.gv; const ou = r() * su, ov = r() * sv; let placed = 0;
  // 本格四角投到旋转坐标求 u/v 范围
  let u0 = 1e9, u1 = -1e9, v0 = 1e9, v1 = -1e9;
  for (const [x, y] of [[x0, y0], [x0 + ZC, y0], [x0, y0 + ZC], [x0 + ZC, y0 + ZC]]) { const u = x * ca + y * sa, v = -x * sa + y * ca; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
  for (let v = Math.floor((v0 - ov) / sv) * sv + ov; v < v1; v += sv) for (let u = Math.floor((u0 - ou) / su) * su + ou + (zt === 'vil' ? (Math.round(v / sv) % 2) * su * 0.5 : 0); u < u1; u += su) {
    const cx = u * ca - v * sa, cy = u * sa + v * ca; if (cx < x0 || cx >= x0 + ZC || cy < y0 || cy >= y0 + ZC || !inB([cx, cy], -30)) continue;
    let L = T.L * (0.85 + r() * 0.3), D = T.D;
    if (!footprintFree(cx, cy, L, D, ang, 2)) { L *= 0.6; if (!footprintFree(cx, cy, L, D, ang, 2)) { if (zt !== 'ind') continue; D *= 0.6; if (!footprintFree(cx, cy, L, D, ang, 2)) continue; } }
    const lx = luAt([cx, cy]); if (lx.pk || lx.lc || (lx.lu && NOBUILD_LU.has(lx.lu.c))) continue;
    const h = Math.max(4, T.h()); const st = T.st === 2 || h > 100 ? 2 : T.st;
    infill.push(cx, cy, L, D, ang, h, st, r() * 0.98); placed++;
    fillPoly([rectPts(cx, cy, L, D, ang)], 2, 4);
  }
  if (placed) { nZone++; zones.push({ x: x0, y: y0, t: zt }); }
}
console.log('infill buildings', infill.length / 8, 'zones', nZone);

// ---------- 树 ----------
// 种类：0 香樟（常绿） 1 悬铃木 2 樱花 3 红梅 4 松柏 5 水杉
const trees = [];
const freeCell = (x, y) => { const k = gi(x, y); return k >= 0 && occ[k] === 0; };
const plant = (x, y, kind, s) => { const k = gi(x, y); if (k < 0 || occ[k]) return false; occ[k] = 5; trees.push(+x.toFixed(1), +y.toFixed(1), kind, +s.toFixed(2)); return true; };
const ST = { trunk: 1, primary: 1, secondary: 1, tertiary: 1, motorway: 0 };
for (const rd of roads) {
  if (!ST[rd.c]) continue; const r = rng(hash2(rd.pts[0][0], rd.pts[0][1]));
  const kind = r() < 0.16 ? 2 : r() < 0.5 ? 1 : 0; const off = rd.w / 2 + 3.5; let carry = r() * 12;
  for (let s = 0; s + 1 < rd.pts.length; s++) { const a = rd.pts[s], b = rd.pts[s + 1]; const L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 1) continue;
    const tx = (b[0] - a[0]) / L, ty = (b[1] - a[1]) / L;
    for (let t = carry; t < L; t += 13) { for (const side of [-1, 1]) { const x = a[0] + tx * t - ty * off * side, y = a[1] + ty * t + tx * off * side;
        // 离开占用格（路沿 3 m 缓冲区算路），所以直接看外侧一格
        const k = gi(x, y); if (k < 0) continue; if (occ[k] === 3 || occ[k] === 0) { if (occ[k] === 3) occ[k] = 5; trees.push(+x.toFixed(1), +y.toFixed(1), kind, +(0.85 + r() * 0.35).toFixed(2)); } } }
    carry = (carry - L) % 13; if (carry < 0) carry += 13; }
}
const nStreet = trees.length / 4;
function scatter(f, density, kinds, rr) { const ring = f.r[0]; let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9; for (const p of ring) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
  const step = Math.sqrt(1 / density);
  for (let y = y0; y < y1; y += step) for (let x = x0; x < x1; x += step) { const px = x + (rr() - 0.5) * step * 0.9, py = y + (rr() - 0.5) * step * 0.9;
    if (!freeCell(px, py) || !pipPoly([px, py], f.r)) continue; const q = rr(); let acc = 0, kind = kinds[kinds.length - 1][0];
    for (const [k, p] of kinds) { acc += p; if (q < acc) { kind = k; break; } } plant(px, py, kind, 0.8 + rr() * 0.5); } }
// 补楼小区：宅间绿化
const ZTREE = { mid: 1 / 650, high: 1 / 560, mixed: 1 / 720, vil: 1 / 1200, com: 1 / 1400, ind: 1 / 2200 };
for (const z of zones) { const rr = rng(hash2(z.x, z.y) ^ 0x77);
  scatter({ r: [[[z.x, z.y], [z.x + ZC, z.y], [z.x + ZC, z.y + ZC], [z.x, z.y + ZC]]] }, ZTREE[z.t], [[0, 0.55], [1, 0.2], [2, 0.15], [4, 0.1]], rr); }
const isPlum = f => /红梅/.test(f.n || '');
for (const f of landcover) { const rr = rng(hash2(...centroid(f.r[0])));
  if (f.c === 'wood') scatter(f, 1 / 70, [[0, 0.45], [4, 0.25], [5, 0.15], [1, 0.15]], rr);
  else if (f.c === 'grass' && (f.s === 'park' || f.s === 'garden' || f.s === 'recreation_ground')) scatter(f, 1 / 260, [[0, 0.45], [2, 0.25], [1, 0.15], [4, 0.15]], rr);
  else if (f.c === 'grass') scatter(f, 1 / 900, [[0, 0.6], [2, 0.2], [4, 0.2]], rr); }
for (const f of parks) { const rr = rng(hash2(...centroid(f.r[0]))); scatter(f, isPlum(f) ? 1 / 110 : 1 / 320, isPlum(f) ? [[3, 0.55], [2, 0.15], [0, 0.3]] : [[0, 0.5], [2, 0.25], [4, 0.25]], rr); }
for (const f of landuse) { if (!['residential', 'school', 'university', 'college', 'hospital', 'commercial'].includes(f.c)) continue; const rr = rng(hash2(...centroid(f.r[0])) ^ 7);
  scatter(f, f.c === 'residential' ? 1 / 380 : 1 / 600, [[0, 0.6], [1, 0.2], [2, 0.12], [4, 0.08]], rr); }
console.log('trees', trees.length / 4, 'street', nStreet);

// ---------- 输出 ----------
fs.mkdirSync(OUT, { recursive: true });
const geo = { bbox: B, origin: d.origin, roads, rail, water, waterway, landuse, landcover, parks, buildings, zones: zones.map(z => [z.x, z.y, ZC, z.t]) };
fs.writeFileSync(path.join(OUT, 'city_geo.json'), JSON.stringify(geo));
fs.writeFileSync(path.join(OUT, 'infill.bin'), Buffer.from(new Float32Array([infill.length / 8, ...infill]).buffer));
fs.writeFileSync(path.join(OUT, 'trees.bin'), Buffer.from(new Float32Array(trees).buffer));
// 网页用：车流道路（主干路以上）
const traffic = roads.filter(r => ['motorway', 'trunk', 'primary', 'secondary', 'tertiary'].includes(r.c)).map(r => ({ c: r.c, w: r.w, l: r.lanes, o: r.o, br: r.br, p: r.pts.flat().map(v => Math.round(v)) }));
fs.writeFileSync(path.join(OUT, 'traffic.json'), JSON.stringify(traffic));
const roadKm = roads.filter(r => r.c !== 'path' && r.c !== 'track').reduce((s, r) => { let L = 0; for (let i = 1; i < r.pts.length; i++) L += Math.hypot(r.pts[i][0] - r.pts[i - 1][0], r.pts[i][1] - r.pts[i - 1][1]); return s + L; }, 0) / 1000;
let green = 0; for (let i = 0; i < occ.length; i++) if (occ[i] === 0 || occ[i] === 5) { } // 绿地按 landcover/park 面积统计
for (const f of [...landcover.filter(f => f.c === 'grass' || f.c === 'wood'), ...parks]) green += Math.abs(area(f.r[0]));
fs.writeFileSync(path.join(OUT, 'stats.json'), JSON.stringify({ buildings: buildings.length + infill.length / 8, osmBuildings: buildings.filter(b => !b.src).length, roadKm: Math.round(roadKm), greenKm2: +(green / 1e6).toFixed(1), trees: trees.length / 4 }));
console.log({ roads: roads.length, rail: rail.length, water: water.length, landuse: landuse.length, landcover: landcover.length, parks: parks.length, roadKm: Math.round(roadKm), greenKm2: green / 1e6 });
