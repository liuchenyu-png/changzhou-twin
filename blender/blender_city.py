# Blender 建城：city_geo.json → 分块网格（地面/水/路/桥/铁路/楼）→ city.glb + city.blend
# 用法：blender -b -P blender_city.py -- <city_geo.json> <out.glb> <out.blend> [exclude.json]
import bpy, bmesh, json, math, sys, random
from mathutils import Vector
from mathutils.geometry import tessellate_polygon

argv = sys.argv[sys.argv.index('--') + 1:]
SRC, OUT_GLB, OUT_BLEND = argv[0], argv[1], argv[2]
EXCL = json.load(open(argv[3], encoding='utf8')) if len(argv) > 3 else []
G = json.load(open(SRC, encoding='utf8'))
BB = G['bbox']
CH = 3500.0  # 分块边长

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.unit_settings.system = 'METRIC'

# ---------- 材质（网页按材质名换着色器；这里给 Blender 里也能看的近似色） ----------
MATS = {}
def mat(name, col, rough=0.9, metal=0.0):
    if name in MATS: return MATS[name]
    m = bpy.data.materials.new(name); m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*col, 1); b.inputs['Roughness'].default_value = rough; b.inputs['Metallic'].default_value = metal
    MATS[name] = m; return m
LU_MAT = {
    'residential': ('G_res', (0.42, 0.42, 0.40)), 'commercial': ('G_com', (0.45, 0.44, 0.42)), 'retail': ('G_com', (0.45, 0.44, 0.42)),
    'industrial': ('G_ind', (0.40, 0.41, 0.42)), 'school': ('G_edu', (0.44, 0.40, 0.36)), 'university': ('G_edu', (0.44, 0.40, 0.36)),
    'college': ('G_edu', (0.44, 0.40, 0.36)), 'kindergarten': ('G_edu', (0.44, 0.40, 0.36)), 'hospital': ('G_com', (0.45, 0.44, 0.42)),
    'pitch': ('G_pitch', (0.16, 0.38, 0.14)), 'stadium': ('G_pitch', (0.16, 0.38, 0.14)), 'track': ('G_track', (0.55, 0.22, 0.16)),
    'cemetery': ('G_grass', (0.20, 0.33, 0.14)), 'theme_park': ('G_com', (0.45, 0.44, 0.42)), 'railway': ('G_ind', (0.40, 0.41, 0.42)),
    'bus_station': ('G_com', (0.45, 0.44, 0.42)), 'park': ('G_grass', (0.20, 0.36, 0.14)), 'playground': ('G_grass', (0.20, 0.36, 0.14)),
}
LC_MAT = {'wood': ('G_wood', (0.10, 0.22, 0.08)), 'grass': ('G_grass', (0.20, 0.36, 0.14)), 'farmland': ('G_farm', (0.36, 0.40, 0.18)),
          'sand': ('G_sand', (0.60, 0.55, 0.42)), 'rock': ('G_sand', (0.50, 0.48, 0.44)), 'wetland': ('G_grass', (0.20, 0.36, 0.14))}

# 每块一个“桶”：材质名 → (verts, faces, uv0, uv1)
class Bucket:
    __slots__ = ('v', 'f', 'uv0', 'uv1', 'mi')
    def __init__(self): self.v = []; self.f = []; self.uv0 = []; self.uv1 = []; self.mi = []
CHUNKS = {}
def bucket(layer, x, y):
    i = int(math.floor((x - BB['x0']) / CH)); j = int(math.floor((y - BB['y0']) / CH))
    key = (layer, i, j)
    if key not in CHUNKS: CHUNKS[key] = {}
    return CHUNKS[key]
def add_faces(layer, x, y, mname, verts, faces, uv0=None, uv1=None):
    bk = bucket(layer, x, y)
    if mname not in bk: bk[mname] = Bucket()
    b = bk[mname]; o = len(b.v)
    b.v.extend(verts)
    for f in faces:
        b.f.append(tuple(o + k for k in f))
        b.uv0.append([uv0[k] for k in f] if uv0 else [(verts[k][0] / 8, verts[k][1] / 8) for k in f])
        b.uv1.append([uv1[k] for k in f] if uv1 else [(0, 0)] * len(f))

def ring_ccw(r):
    s = 0
    for i in range(len(r)):
        a = r[i]; b = r[(i + 1) % len(r)]; s += a[0] * b[1] - b[0] * a[1]
    return r if s > 0 else r[::-1]
def centroid(r):
    return (sum(p[0] for p in r) / len(r), sum(p[1] for p in r) / len(r))

def up_tris(tris, pts):
    # 逐个三角形保证逆时针（法线朝上）：tessellate_polygon 的输出方向不固定，朝下会被网页背面剔除，屋顶/地块就“空”了
    out = []
    for t in tris:
        a, b, c = pts[t[0]], pts[t[1]], pts[t[2]]
        out.append(tuple(t) if (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]) >= 0 else (t[0], t[2], t[1]))
    return out

def fill_poly(layer, rings, z, mname):
    try:
        tris = tessellate_polygon([[Vector((p[0], p[1], 0)) for p in r] for r in rings])
    except Exception:
        return
    pts = [p for r in rings for p in r]
    verts = [(p[0], p[1], z) for p in pts]
    c = centroid(rings[0])
    add_faces(layer, c[0], c[1], mname, verts, up_tris(tris, pts))

# ---------- 地面 ----------
print('ground...')
for lu in G['landuse']:
    m = LU_MAT.get(lu['c'])
    if m: mat(m[0], m[1]); fill_poly('ground', lu['r'], 0.06, m[0])
for lc in G['landcover']:
    m = LC_MAT.get(lc['c'])
    if lc['c'] == 'grass' and lc.get('s') in ('park', 'garden', 'recreation_ground', 'flowerbed'): m = ('G_park', (0.22, 0.40, 0.14))
    if m: mat(m[0], m[1]); fill_poly('ground', lc['r'], 0.12, m[0])
for pk in G['parks']:
    mat('G_park', (0.22, 0.40, 0.14)); fill_poly('ground', pk['r'], 0.10, 'G_park')
# 底板：只铺建模范围（不再铺外围裙边）
mat('G_base', (0.30, 0.33, 0.24))
M = 0
for i in range(int((BB['x1'] - BB['x0'] + 2 * M) / CH) + 1):
    for j in range(int((BB['y1'] - BB['y0'] + 2 * M) / CH) + 1):
        x0 = BB['x0'] - M + i * CH; y0 = BB['y0'] - M + j * CH
        x1 = min(x0 + CH, BB['x1'] + M); y1 = min(y0 + CH, BB['y1'] + M)
        if x1 <= x0 or y1 <= y0: continue
        cx = min(max((x0 + x1) / 2, BB['x0'] + 1), BB['x1'] - 1); cy = min(max((y0 + y1) / 2, BB['y0'] + 1), BB['y1'] - 1)
        add_faces('ground', cx, cy, 'G_base', [(x0, y0, 0), (x1, y0, 0), (x1, y1, 0), (x0, y1, 0)], [(0, 1, 2, 3)])

# 补楼小区地坪（低于实测用地，公园/绿地/水/路会盖在上面）
ZMAT = {'ind': 'G_ind', 'com': 'G_com'}
for zx, zy, zs, zt in G.get('zones', []):
    m = ZMAT.get(zt, 'G_res'); mat(m, (0.45, 0.45, 0.43))
    add_faces('ground', zx + zs / 2, zy + zs / 2, m, [(zx, zy, 0.04), (zx + zs, zy, 0.04), (zx + zs, zy + zs, 0.04), (zx, zy + zs, 0.04)], [(0, 1, 2, 3)])

# 沙盘侧壁：范围四周向下 60 m 的深色台座
mat('G_edge', (0.05, 0.06, 0.07), 0.7)
EZ = -60.0
for (ax, ay, bx, by) in [(BB['x0'], BB['y0'], BB['x1'], BB['y0']), (BB['x1'], BB['y0'], BB['x1'], BB['y1']),
                         (BB['x1'], BB['y1'], BB['x0'], BB['y1']), (BB['x0'], BB['y1'], BB['x0'], BB['y0'])]:
    L = math.hypot(bx - ax, by - ay); n = int(L // CH) + 1
    for k in range(n):
        t0, t1 = k / n, (k + 1) / n
        x0, y0 = ax + (bx - ax) * t0, ay + (by - ay) * t0; x1, y1 = ax + (bx - ax) * t1, ay + (by - ay) * t1
        cx = min(max((x0 + x1) / 2, BB['x0'] + 1), BB['x1'] - 1); cy = min(max((y0 + y1) / 2, BB['y0'] + 1), BB['y1'] - 1)
        add_faces('ground', cx, cy, 'G_edge', [(x0, y0, EZ), (x1, y1, EZ), (x1, y1, 0.13), (x0, y0, 0.13)], [(0, 1, 2, 3)])

# ---------- 水 ----------
print('water...')
mat('W_water', (0.12, 0.22, 0.26), 0.05)
mat('W_bank', (0.45, 0.44, 0.40))
WZ = 0.18
# 水域索引：驳岸边外侧 3 m 仍是水（多边形切块的切口、河道线）就不砌岸，否则河面上会横一道石条
def pip(x, y, r):
    c = False; n = len(r)
    for k in range(n):
        a, b = r[k], r[(k + 1) % n]
        if (a[1] > y) != (b[1] > y) and x < a[0] + (y - a[1]) * (b[0] - a[0]) / (b[1] - a[1]): c = not c
    return c
WG = {}; WC = 100.0
def wg_add(x0, y0, x1, y1, item):
    for i in range(int(x0 // WC), int(x1 // WC) + 1):
        for j in range(int(y0 // WC), int(y1 // WC) + 1): WG.setdefault((i, j), []).append(item)
for wi, w in enumerate(G['water']):
    r = w['r'][0]; xs = [p[0] for p in r]; ys = [p[1] for p in r]
    wg_add(min(xs), min(ys), max(xs), max(ys), ('p', wi, min(xs), min(ys), max(xs), max(ys)))
for ww in G['waterway']:
    if ww['c'] not in ('river', 'canal'): continue
    hw = {'river': 9, 'canal': 10}[ww['c']]; pts = ww['pts']
    for k in range(len(pts) - 1):
        a, b = pts[k], pts[k + 1]
        wg_add(min(a[0], b[0]) - hw, min(a[1], b[1]) - hw, max(a[0], b[0]) + hw, max(a[1], b[1]) + hw, ('s', a, b, hw))
def wet(x, y, self_i):
    for it in WG.get((int(x // WC), int(y // WC)), ()):
        if it[0] == 'p':
            if it[1] != self_i and it[2] <= x <= it[4] and it[3] <= y <= it[5] and pip(x, y, G['water'][it[1]]['r'][0]): return True
        else:
            a, b, hw = it[1], it[2], it[3]; dx, dy = b[0] - a[0], b[1] - a[1]; L2 = dx * dx + dy * dy or 1
            t = max(0, min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L2))
            if (x - a[0] - t * dx) ** 2 + (y - a[1] - t * dy) ** 2 < hw * hw: return True
    return False
for wi, w in enumerate(G['water']):
    fill_poly('water', w['r'], WZ, 'W_water')
    # 驳岸：外圈一条 1.2 m 宽石砌岸，略高于水面
    for r in w['r'][:1]:
        r = ring_ccw(r); n = len(r)
        if n > 400: continue
        verts = []; faces = []
        for k in range(n):
            a = r[k]; b = r[(k + 1) % n]
            dx, dy = b[0] - a[0], b[1] - a[1]; L = math.hypot(dx, dy)
            if L < 0.5: continue
            nx, ny = dy / L * 1.2, -dx / L * 1.2  # 外法线（CCW 外侧）
            mx, my = (a[0] + b[0]) / 2 + nx * 2.5, (a[1] + b[1]) / 2 + ny * 2.5
            if wet(mx, my, wi) or pip(mx, my, r): continue
            o = len(verts)
            verts += [(a[0], a[1], 0.35), (b[0], b[1], 0.35), (b[0] + nx, b[1] + ny, 0.35), (a[0] + nx, a[1] + ny, 0.35),
                      (a[0], a[1], -0.6), (b[0], b[1], -0.6)]
            faces += [(o + 3, o + 2, o + 1, o), (o, o + 1, o + 5, o + 4)]   # 顶面朝上、岸壁朝向水面
        if verts:
            c = centroid(r); add_faces('water', c[0], c[1], 'W_bank', verts, faces)
for ww in G['waterway']:
    if ww['c'] not in ('river', 'canal', 'stream', 'drain', 'ditch'): continue
    hw = {'river': 9, 'canal': 10}.get(ww['c'], 2.2)
    pts = ww['pts']
    if len(pts) < 2: continue
    verts = []; faces = []
    for k in range(len(pts) - 1):
        a, b = pts[k], pts[k + 1]; dx, dy = b[0] - a[0], b[1] - a[1]; L = math.hypot(dx, dy)
        if L < 0.1: continue
        nx, ny = -dy / L * hw, dx / L * hw; o = len(verts)
        verts += [(a[0] + nx, a[1] + ny, WZ - 0.02), (a[0] - nx, a[1] - ny, WZ - 0.02), (b[0] - nx, b[1] - ny, WZ - 0.02), (b[0] + nx, b[1] + ny, WZ - 0.02)]
        faces.append((o, o + 1, o + 2, o + 3))
    if verts: add_faces('water', pts[0][0], pts[0][1], 'W_water', verts, faces)

# ---------- 路 ----------
print('roads...')
mat('R_road', (0.08, 0.08, 0.085), 0.85)
mat('R_path', (0.42, 0.40, 0.37), 0.9)
mat('R_bridge', (0.55, 0.55, 0.53), 0.8)
mat('RAIL', (0.30, 0.28, 0.26), 0.9)
RZ = {'motorway': 0.46, 'trunk': 0.44, 'primary': 0.42, 'secondary': 0.38, 'tertiary': 0.34, 'busway': 0.34, 'minor': 0.30, 'service': 0.26, 'track': 0.24, 'path': 0.22}
nodes = {}
key = lambda p: (round(p[0] / 3), round(p[1] / 3))
for r in G['roads']:
    for e in (0, -1):
        nodes.setdefault(key(r['pts'][e]), []).append(r)

def densify(pts, mx):
    out = [pts[0]]
    for k in range(1, len(pts)):
        a, b = pts[k - 1], pts[k]; L = math.hypot(b[0] - a[0], b[1] - a[1]); n = max(1, int(math.ceil(L / mx)))
        for s in range(1, n + 1): out.append((a[0] + (b[0] - a[0]) * s / n, a[1] + (b[1] - a[1]) * s / n))
    return out

def ribbon(pts, zs, hw, layer, mname, uv1fn=None, side=0.0, sidemat=None):
    n = len(pts)
    if n < 2: return
    L = [0.0]
    for k in range(1, n): L.append(L[-1] + math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]))
    norms = []
    for k in range(n):
        a = pts[max(0, k - 1)]; b = pts[min(n - 1, k + 1)]
        dx, dy = b[0] - a[0], b[1] - a[1]; l = math.hypot(dx, dy) or 1
        norms.append((-dy / l, dx / l))
    verts = []; uv0 = []; uv1 = []; faces = []
    for k in range(n):
        nx, ny = norms[k]; x, y = pts[k]; z = zs[k]
        verts += [(x + nx * hw, y + ny * hw, z), (x - nx * hw, y - ny * hw, z)]
        uv0 += [(L[k], hw), (L[k], -hw)]
        u1 = uv1fn(k) if uv1fn else (hw, 0)
        uv1 += [u1, u1]
    for k in range(n - 1):
        faces.append((2 * k + 1, 2 * k + 3, 2 * k + 2, 2 * k))
    add_faces(layer, pts[n // 2][0], pts[n // 2][1], mname, verts, faces, uv0, uv1)
    if side > 0 and sidemat:  # 桥面侧板
        sv = []; sf = []
        for s in (0, 1):
            o = len(sv)
            for k in range(n): x, y, z = verts[2 * k + s]; sv += [(x, y, z), (x, y, z - side)]
            for k in range(n - 1):
                a = o + 2 * k
                sf.append((a, a + 1, a + 3, a + 2) if s == 1 else (a, a + 2, a + 3, a + 1))
        add_faces(layer, pts[0][0], pts[0][1], sidemat, sv, sf)

def simplify(pts, tol=0.25):
    # 去掉近似共线的中间点（偏离弦线 < tol 米），人行道只在拐点处留顶点
    if len(pts) <= 2: return pts
    out = [pts[0]]; a = 0
    for k in range(2, len(pts)):
        ax, ay = pts[a]; bx, by = pts[k]; L = math.hypot(bx - ax, by - ay) or 1
        if any(abs((pts[m][0] - ax) * (by - ay) - (pts[m][1] - ay) * (bx - ax)) / L > tol for m in range(a + 1, k)) or L > 120:
            out.append(pts[k - 1]); a = k - 1
    out.append(pts[-1]); return out

SIDEWALK = {'trunk': 3.5, 'primary': 4.0, 'secondary': 3.5, 'tertiary': 2.8, 'minor': 2.0}
mat('R_walk', (0.55, 0.53, 0.50), 0.9)
def sidewalk(pts, z, hw, sw):
    # 两侧各一条：路缘立面（高 0.15）+ 铺装顶面；UV0 = (沿路米, 距路缘米)
    n = len(pts); L = [0.0]
    for k in range(1, n): L.append(L[-1] + math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]))
    if L[-1] < 4: return
    nm = []
    for k in range(n):
        a = pts[max(0, k - 1)]; b = pts[min(n - 1, k + 1)]; dx, dy = b[0] - a[0], b[1] - a[1]; l = math.hypot(dx, dy) or 1
        nm.append((-dy / l, dx / l))
    zt = z + 0.15
    for s in (1, -1):
        verts = []; uv0 = []; faces = []
        for k in range(n):
            nx, ny = nm[k][0] * s, nm[k][1] * s; x, y = pts[k]
            verts += [(x + nx * hw, y + ny * hw, z - 0.02), (x + nx * hw, y + ny * hw, zt), (x + nx * (hw + sw), y + ny * (hw + sw), zt)]
            uv0 += [(L[k], -0.15), (L[k], 0), (L[k], sw)]
        for k in range(n - 1):
            a = 3 * k; b = a + 3
            if s == -1: faces += [(a, a + 1, b + 1, b), (a + 1, a + 2, b + 2, b + 1)]
            else: faces += [(a, b, b + 1, a + 1), (a + 1, b + 1, b + 2, a + 2)]
        add_faces('roads', pts[n // 2][0], pts[n // 2][1], 'R_walk', verts, faces, uv0, [(sw, 0)] * len(verts))

PILLARS = []
for r in G['roads']:
    c = r['c']; hw = r['w'] / 2; pts = densify(r['pts'], 18)
    base = RZ.get(c, 0.3)
    zs = [base] * len(pts)
    if r['br']:
        elevated = c in ('motorway', 'trunk', 'primary') and math.hypot(pts[-1][0] - pts[0][0], pts[-1][1] - pts[0][1]) > 120
        H = 9.0 if elevated else 2.2
        cum = [0.0]
        for k in range(1, len(pts)): cum.append(cum[-1] + math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]))
        tot = cum[-1]
        def joins_bridge(e):
            return any(o is not r and o['br'] for o in nodes.get(key(r['pts'][e]), []))
        ramp = min(160.0 if elevated else 25.0, tot / 2.2)
        s0 = joins_bridge(0); s1 = joins_bridge(-1)
        for k in range(len(pts)):
            f0 = 1 if s0 else min(1, cum[k] / ramp); f1 = 1 if s1 else min(1, (tot - cum[k]) / ramp)
            f = min(f0, f1); f = f * f * (3 - 2 * f)
            zs[k] = base + H * f
        if elevated:
            acc = 0
            for k in range(1, len(pts)):
                acc += math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1])
                if acc > 36 and zs[k] > 4: acc = 0; PILLARS.append((pts[k][0], pts[k][1], zs[k] - 1.4, min(hw * 0.5, 4)))
    if c in ('path', 'track'):
        ribbon(pts, zs, hw, 'roads', 'R_path')
        continue
    lanes = r['lanes'] + (5 if r['o'] else 0)
    # 交叉口遮罩（标线淡出）：原始点中被多条路共用的节点
    xs = set(key(p) for p, x in zip(r['pts'], r['x']) if x)
    mask = [1.0 if key(p) in xs else 0.0 for p in pts]
    ribbon(pts, zs, hw, 'roads', 'R_road', lambda k: (hw, lanes + 0.9 * mask[k]), 1.3 if r['br'] else 0, 'R_bridge')
    # 人行道：路缘石 + 铺装带，路口处断开（让出横向道路）
    sw = SIDEWALK.get(c, 0)
    if sw and not r['br']:
        xpts = [p for p, x in zip(r['pts'], r['x']) if x]
        sp = densify(r['pts'], 6)
        clear = hw + sw + 9
        on = [all(math.hypot(p[0] - q[0], p[1] - q[1]) > clear for q in xpts) for p in sp]
        runs = []; cur = []
        for p, o in zip(sp, on):
            if o: cur.append(p)
            elif cur: runs.append(cur); cur = []
        if cur: runs.append(cur)
        for run in runs:
            if len(run) >= 2: sidewalk(simplify(run), base, hw, sw)

# 桥墩
for (x, y, z, s) in PILLARS:
    w = s / 2; verts = []; faces = []
    verts = [(x - w, y - w, 0), (x + w, y - w, 0), (x + w, y + w, 0), (x - w, y + w, 0), (x - w, y - w, z), (x + w, y - w, z), (x + w, y + w, z), (x - w, y + w, z)]
    faces = [(0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    add_faces('roads', x, y, 'R_bridge', verts, faces)
# 铁路：道砟带 + 两条钢轨（UV 交给网页画轨枕）
for r in G['rail']:
    pts = densify(r['pts'], 25)
    ribbon(pts, [0.5 + (6 if r['br'] else 0)] * len(pts), 3.2, 'roads', 'RAIL')

# ---------- 楼 ----------
print('buildings...')
mat('B_wall', (0.75, 0.73, 0.70), 0.7)
mat('B_roof', (0.35, 0.35, 0.35), 0.9)
mat('B_hroof', (0.12, 0.12, 0.13), 0.8)
def excluded(c):
    for e in EXCL:
        if (c[0] - e[0]) ** 2 + (c[1] - e[1]) ** 2 < e[2] ** 2: return True
    return False

def obb(r):
    best = None
    for k in range(len(r)):
        a = r[k]; b = r[(k + 1) % len(r)]; ang = math.atan2(b[1] - a[1], b[0] - a[0])
        ca, sa = math.cos(ang), math.sin(ang)
        us = [p[0] * ca + p[1] * sa for p in r]; vs = [-p[0] * sa + p[1] * ca for p in r]
        A = (max(us) - min(us)) * (max(vs) - min(vs))
        if best is None or A < best[0]: best = (A, ang, min(us), max(us), min(vs), max(vs))
    return best


mat('B_equip', (0.62, 0.63, 0.64), 0.45, 0.6)
mat('B_solar', (0.05, 0.08, 0.14), 0.15, 0.3)

def inset_ring(r, d):
    n = len(r); out = []
    for k in range(n):
        p0, p1, p2 = r[k - 1], r[k], r[(k + 1) % n]
        e1 = (p1[0] - p0[0], p1[1] - p0[1]); e2 = (p2[0] - p1[0], p2[1] - p1[1])
        l1 = math.hypot(*e1); l2 = math.hypot(*e2)
        if l1 < 1e-3 or l2 < 1e-3: return None
        n1 = (-e1[1] / l1, e1[0] / l1); n2 = (-e2[1] / l2, e2[0] / l2)   # CCW 左侧 = 内侧
        mx, my = n1[0] + n2[0], n1[1] + n2[1]; dd = 1 + n1[0] * n2[0] + n1[1] * n2[1]
        if dd < 0.25: return None
        out.append((p1[0] + mx / dd * d, p1[1] + my / dd * d))
    return out

def inside(pt, r):
    x, y = pt; c = False; n = len(r)
    for k in range(n):
        a, b = r[k], r[(k + 1) % n]
        if (a[1] > y) != (b[1] > y) and x < a[0] + (y - a[1]) * (b[0] - a[0]) / (b[1] - a[1]): c = not c
    return c

def obox(c, cx, cy, ang, hu, hv, z, hh, mname, u1x):
    ca, sa = math.cos(ang), math.sin(ang)
    W = lambda u, v, zz: (cx + u * ca - v * sa, cy + u * sa + v * ca, zz)
    cr = [(-hu, -hv), (hu, -hv), (hu, hv), (-hu, hv)]
    vv = [W(u, v, z) for u, v in cr] + [W(u, v, z + hh) for u, v in cr]
    per = [0, 2 * hu, 2 * hu + 2 * hv, 4 * hu + 2 * hv]
    uvv = [(p, z) for p in per] + [(p, z + hh) for p in per]
    add_faces('bld', c[0], c[1], mname, vv, [(0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7), (4, 5, 6, 7)], uvv, [(u1x, hh)] * 8)

def ocyl(c, cx, cy, rr, z, hh, mname, seg=10):
    vv = []; ff = []; uvv = []
    for i in range(seg):
        a = 2 * math.pi * i / seg; vv += [(cx + rr * math.cos(a), cy + rr * math.sin(a), z), (cx + rr * math.cos(a), cy + rr * math.sin(a), z + hh)]
        uvv += [(i / seg * 6.28 * rr, z), (i / seg * 6.28 * rr, z + hh)]
    for i in range(seg):
        j = (i + 1) % seg; ff.append((2 * i, 2 * j, 2 * j + 1, 2 * i + 1))
    ff.append(tuple(2 * i + 1 for i in range(seg)))
    add_faces('bld', c[0], c[1], mname, vv, ff, uvv, [(9.5, hh)] * len(vv))

def roof_props(ring, h, st, seed, c):
    o = obb(ring)
    if not o: return
    _, ang, u0, uu1, v0, v1 = o; ca, sa = math.cos(ang), math.sin(ang)
    du, dv = uu1 - u0, v1 - v0
    P = lambda u, v: (u * ca - v * sa, u * sa + v * ca)
    def rnd_pt(mu, mv):
        if du < 2 * mu + 0.2 or dv < 2 * mv + 0.2: return None
        for _ in range(12):
            u = u0 + mu + (du - 2 * mu) * rnd.random(); v = v0 + mv + (dv - 2 * mv) * rnd.random()
            if all(inside(P(u + a * mu, v + b * mv), ring) for a in (-1, 1) for b in (-1, 1)): return P(u, v)
        return None
    area = du * dv
    # 楼梯间/电梯机房：住宅、办公中高层
    if h >= 15 and st in (1, 2) and du > 9 and dv > 7:
        for q in range(1 + (du > 30) + (du > 60)):
            hu = min(du * 0.1, 4.5) + 1.2; hv = min(dv * 0.22, 4.0) + 0.8; p = rnd_pt(hu + 0.5, hv + 0.5)
            if p:
                hh = 3.2 + rnd.random() * 1.6; obox(c, p[0], p[1], ang, hu, hv, h, hh, 'B_wall', 9 + seed)
                if st == 1 and q == 0 and rnd.random() < 0.4: ocyl(c, p[0], p[1], min(hu, hv) * 0.55, h + hh, 2.2, 'B_equip', 6)
    # 空调外机 / 冷却塔：办公、商业、厂房、多层住宅
    if st in (2, 3) or (st == 1 and h < 15 and rnd.random() < 0.3):
        k = int(min({1: 2, 2: 6, 3: 4}[st], max(1, area / (120 if st == 2 else 300)))) if area > 60 else 0
        for q in range(k):
            s = 0.6 + rnd.random() * (1.6 if st == 2 else 1.0); p = rnd_pt(s + 0.3, s * 0.7 + 0.3)
            if p: obox(c, p[0], p[1], ang, s, s * 0.7, h, 0.9 + rnd.random() * (1.2 if st == 2 else 0.6), 'B_equip', 9.5)
        if st == 2 and area > 600 and rnd.random() < 0.5:
            p = rnd_pt(3, 3)
            if p: ocyl(c, p[0], p[1], 2.4, h, 3.2, 'B_equip', 8)
    # 厂房屋顶光伏：南向倾斜板带
    if st == 3 and area > 500 and rnd.random() < 0.38:
        xs = [q[0] for q in ring]; ys = [q[1] for q in ring]; y = min(ys) + 2.0; rows = 0
        while y < max(ys) - 2.5 and rows < 40:
            x = min(xs) + 1.5; run = None
            while x <= max(xs) - 1.5:
                ok = inside((x, y), ring) and inside((x, y + 2.2), ring)
                if ok and run is None: run = x
                if (not ok or x + 2 > max(xs) - 1.5) and run is not None:
                    xe = x if not ok else x + 2
                    if xe - run > 4:
                        add_faces('bld', c[0], c[1], 'B_solar', [(run, y, h + 0.4), (xe - 0.5, y, h + 0.4), (xe - 0.5, y + 2.0, h + 1.15), (run, y + 2.0, h + 1.15)],
                                  [(0, 1, 2, 3)], [(0, 0), (xe - 0.5 - run, 0), (xe - 0.5 - run, 2), (0, 2)], [(0, 0)] * 4)
                    run = None
                x += 2
            y += 4.2; rows += 1

rnd = random.Random(7)
nb = 0
BREC = []   # 网页端近景立面几何用：类型/种子/底/顶/女儿墙/轮廓
for b in G['buildings']:
    r = b['r'][0]
    if len(r) < 3: continue
    c = centroid(r)
    if excluded(c): continue
    r = ring_ccw(r); n = len(r); h = b['h']; z0 = b['mh']; st = b['s']
    seed = rnd.random() * 0.98
    u1 = (st + seed, h)
    ph = (0.6 if st == 3 else 1.1) if (h - z0) >= 7 and n <= 40 and st != 4 else 0.0   # 女儿墙高
    inner = inset_ring(r, 0.3) if ph else None
    if inner is None: ph = 0.0
    top = h + ph
    BREC.append((st, seed, z0, h, ph, n, r))
    # 墙（女儿墙段 uv.y > H，网页里不画窗）
    verts = []; faces = []; uv0 = []; uv1 = []; per = 0.0
    for k in range(n):
        a = r[k]; bb = r[(k + 1) % n]; L = math.hypot(bb[0] - a[0], bb[1] - a[1])
        o = len(verts)
        verts += [(a[0], a[1], z0), (bb[0], bb[1], z0), (bb[0], bb[1], top), (a[0], a[1], top)]
        uv0 += [(per, z0), (per + L, z0), (per + L, top), (per, top)]; uv1 += [u1] * 4
        faces.append((o, o + 1, o + 2, o + 3)); per += L
    add_faces('bld', c[0], c[1], 'B_wall', verts, faces, uv0, uv1)
    gable = False
    if st == 4:
        A_poly = abs(sum(r[k][0] * r[(k + 1) % n][1] - r[(k + 1) % n][0] * r[k][1] for k in range(n)) / 2)
        o = obb(r)
        if o and A_poly / max(o[0], 1) > 0.78:
            gable = True
            _, ang, u0, uu1, v0, v1 = o; ca, sa = math.cos(ang), math.sin(ang)
            if (uu1 - u0) < (v1 - v0):  # 屋脊顺长边
                ang += math.pi / 2; ca, sa = math.cos(ang), math.sin(ang)
                us = [p[0] * ca + p[1] * sa for p in r]; vs = [-p[0] * sa + p[1] * ca for p in r]
                u0, uu1, v0, v1 = min(us), max(us), min(vs), max(vs)
            ov = 0.6; u0 -= ov; uu1 += ov; v0 -= ov; v1 += ov
            rh = (v1 - v0) * 0.32; vm = (v0 + v1) / 2
            W = lambda u, v, z: (u * ca - v * sa, u * sa + v * ca, z)
            hv = [W(u0, v0, h - 0.2), W(uu1, v0, h - 0.2), W(uu1, vm, h + rh), W(u0, vm, h + rh), W(u0, v1, h - 0.2), W(uu1, v1, h - 0.2)]
            hf = [(0, 1, 2, 3), (3, 2, 5, 4)]
            huv = [(0, 0), (uu1 - u0, 0), (uu1 - u0, (v1 - v0) / 2), (0, (v1 - v0) / 2), (0, v1 - v0), (uu1 - u0, v1 - v0)]
            add_faces('bld', c[0], c[1], 'B_hroof', hv, hf, huv, [u1] * 6)
            # 封檐板（屋面厚度）
            fv = [W(u0, v0, h - 0.2), W(uu1, v0, h - 0.2), W(uu1, v0, h - 0.45), W(u0, v0, h - 0.45), W(uu1, v1, h - 0.2), W(u0, v1, h - 0.2), W(u0, v1, h - 0.45), W(uu1, v1, h - 0.45)]
            add_faces('bld', c[0], c[1], 'B_hroof', fv, [(3, 2, 1, 0), (7, 6, 5, 4)], [(0, 0), (1, 0), (1, .3), (0, .3)] * 2, [u1] * 8)
            # 山墙
            gv = [W(u0 + ov, v0 + ov, h), W(u0 + ov, v1 - ov, h), W(u0 + ov, vm, h + rh - 0.3), W(uu1 - ov, v1 - ov, h), W(uu1 - ov, v0 + ov, h), W(uu1 - ov, vm, h + rh - 0.3)]
            add_faces('bld', c[0], c[1], 'B_wall', gv, [(0, 1, 2), (3, 4, 5)], [(0, h), (v1 - v0, h), ((v1 - v0) / 2, h + rh)] * 2, [u1] * 6)
    if not gable:
        ring = inner if ph else r
        if ph:
            # 女儿墙：压顶 + 内侧墙（类型 +10 = 同色无窗）
            pu = (st + 10 + seed, h); cv_ = []; cf = []; cuv = []
            per = 0.0
            for k in range(n):
                a, bb = r[k], r[(k + 1) % n]; ia, ib = inner[k], inner[(k + 1) % n]; o = len(cv_)
                L = math.hypot(ib[0] - ia[0], ib[1] - ia[1])
                cv_ += [(a[0], a[1], top), (bb[0], bb[1], top), (ib[0], ib[1], top), (ia[0], ia[1], top),
                        (ib[0], ib[1], h), (ia[0], ia[1], h), (ia[0], ia[1], top), (ib[0], ib[1], top)]
                cuv += [(per, 0), (per + L, 0), (per + L, .3), (per, .3), (per + L, h), (per, h), (per, top), (per + L, top)]
                cf += [(o, o + 1, o + 2, o + 3), (o + 4, o + 5, o + 6, o + 7)]
                per += L
            add_faces('bld', c[0], c[1], 'B_wall', cv_, cf, cuv, [pu] * len(cv_))
        try:
            tris = tessellate_polygon([[Vector((p[0], p[1], 0)) for p in ring]])
            add_faces('bld', c[0], c[1], 'B_roof', [(p[0], p[1], h) for p in ring], up_tris(tris, ring),
                      [(p[0] - c[0], p[1] - c[1]) for p in ring], [u1] * len(ring))
        except Exception:
            pass
        roof_props(ring, h, st, seed, c)
    nb += 1
print('buildings', nb)
if len(argv) > 4:
    import array
    fa = array.array('f', [len(BREC)])
    for st, seed, z0, h, ph, n, r in BREC:
        fa.extend([st, seed, z0, h, ph, n]); [fa.extend((p[0], p[1])) for p in r]
    with open(argv[4], 'wb') as fo: fa.tofile(fo)
    print('bld.bin', len(fa) * 4)

# ---------- 生成对象 ----------
print('objects...')
coll = bpy.data.collections.new('City'); scene.collection.children.link(coll)
for (layer, i, j), mats in CHUNKS.items():
    name = '%s_%d_%d' % (layer, i, j)
    me = bpy.data.meshes.new(name)
    allv = []; allf = []; uv0 = []; uv1 = []; mi = []
    names = list(mats.keys())
    for idx, mn in enumerate(names):
        b = mats[mn]; o = len(allv); allv += b.v
        allf += [tuple(o + k for k in f) for f in b.f]; uv0 += b.uv0; uv1 += b.uv1; mi += [idx] * len(b.f)
    me.from_pydata(allv, [], allf)
    for mn in names: me.materials.append(MATS[mn])
    me.polygons.foreach_set('material_index', mi)
    l0 = me.uv_layers.new(name='UVMap'); l1 = me.uv_layers.new(name='UVData')
    flat0 = [c for f in uv0 for uv in f for c in uv]; flat1 = [c for f in uv1 for uv in f for c in uv]
    l0.data.foreach_set('uv', flat0); l1.data.foreach_set('uv', flat1)
    me.validate(clean_customdata=False); me.update()
    ob = bpy.data.objects.new(name, me); coll.objects.link(ob)
print('chunks', len(CHUNKS))

bpy.ops.wm.save_as_mainfile(filepath=OUT_BLEND)
bpy.ops.export_scene.gltf(filepath=OUT_GLB, export_format='GLB', export_apply=False, export_yup=True,
                          export_texcoords=True, export_normals=True, export_materials='EXPORT',
                          export_draco_mesh_compression_enable=True, export_draco_mesh_compression_level=6,
                          export_draco_position_quantization=16, export_draco_texcoord_quantization=16)
print('done')
