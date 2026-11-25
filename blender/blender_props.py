# Blender 小件：树 ×6、车 ×4、路灯 → props.glb（网页按对象名做 InstancedMesh）
# 用法：blender -b -P blender_props.py -- <out.glb> <out.blend>
import bpy, bmesh, math, random, sys
from mathutils import Vector, noise

argv = sys.argv[sys.argv.index('--') + 1:]
OUT_GLB, OUT_BLEND = argv
bpy.ops.wm.read_factory_settings(use_empty=True)
rnd = random.Random(3)

def mat(name, col, rough=0.8, metal=0.0):
    m = bpy.data.materials.get(name)
    if m: return m
    m = bpy.data.materials.new(name); m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*col, 1); b.inputs['Roughness'].default_value = rough; b.inputs['Metallic'].default_value = metal
    return m

def join(objs, name):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs: o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join(); ob = bpy.context.object; ob.name = name
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    return ob

def blob(loc, r, m, sub=1, jitter=0.22, squash=1.0):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=sub, radius=r, location=loc)
    o = bpy.context.object
    for v in o.data.vertices:
        n = noise.noise(Vector(v.co) * 0.9 / r + Vector(loc) * 0.37)
        v.co *= 1 + jitter * n + rnd.uniform(-0.08, 0.08)
        v.co.z *= squash
    o.data.materials.append(m)
    for f in o.data.polygons: f.use_smooth = True
    return o

BARK = mat('TR_bark', (0.16, 0.12, 0.09), 0.95)
def trunk(h, r, m, lean=0.0):
    bpy.ops.mesh.primitive_cone_add(vertices=8, radius1=r, radius2=r * 0.55, depth=h, location=(lean * 0.5, 0, h / 2))
    o = bpy.context.object; o.rotation_euler = (0, lean * 0.15, 0); o.data.materials.append(m)
    for f in o.data.polygons: f.use_smooth = True
    return o

def limb(p0, p1, r0, r1, m):
    # 枝干：两点间的锥台
    d = Vector(p1) - Vector(p0); L = d.length
    bpy.ops.mesh.primitive_cone_add(vertices=6, radius1=r0, radius2=r1, depth=L, location=(Vector(p0) + d / 2))
    o = bpy.context.object; o.rotation_mode = 'QUATERNION'; o.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(d.normalized())
    o.data.materials.append(m)
    for f in o.data.polygons: f.use_smooth = True
    return o

def crown_normals(ob, leaf_idx, C, R):
    # 树冠法线：几何法线与“冠心→顶点”方向混合，烘进自定义法线（远看是一团柔和的体积）
    me = ob.data; me.update()
    vn = [Vector(v.normal) for v in me.vertices]
    out = []
    leafv = set()
    for f in me.polygons:
        if f.material_index == leaf_idx: leafv.update(f.vertices)
    for i, v in enumerate(me.vertices):
        if i in leafv:
            q = Vector(((v.co.x - C[0]) / R[0], (v.co.y - C[1]) / R[1], (v.co.z - C[2]) / R[2]))
            n = (vn[i] * 0.35 + q.normalized() * 0.65).normalized()
        else: n = vn[i]
        out.append(n)
    me.normals_split_custom_set_from_vertices(out)

def broadleaf(name, leaf, h=9, crown=3.6, n=6, trunk_h=None, squash=0.8, lobes=14):
    th = trunk_h or h * 0.45
    tr = 0.17 * h / 9
    parts = [trunk(th + crown * 0.4, tr, BARK)]
    cz = th + crown * squash * 0.95
    # 主枝：从干顶向冠壳伸出
    for i in range(4):
        a = 2 * math.pi * i / 4 + rnd.uniform(-0.4, 0.4)
        p1 = (math.cos(a) * crown * 0.55, math.sin(a) * crown * 0.55, cz + rnd.uniform(-0.3, 0.6) * crown * squash)
        parts.append(limb((0, 0, th * 0.92), p1, tr * 0.55, tr * 0.18, BARK))
    # 叶团：壳层上的多个小团 + 中心大团（剪影凹凸、团间有缝能看到枝）
    pts = []
    for i in range(lobes):
        z = rnd.uniform(-0.55, 0.95); a = i * 2.39996 + rnd.uniform(-0.2, 0.2)
        rr = math.sqrt(max(0.0, 1 - z * z)) * rnd.uniform(0.75, 1.0)
        pts.append((math.cos(a) * rr * crown * 0.78, math.sin(a) * rr * crown * 0.78, cz + z * crown * squash * 0.78))
    for p in pts:
        parts.append(blob(p, crown * rnd.uniform(0.36, 0.5), leaf, sub=2, jitter=0.3, squash=0.85))
    parts.append(blob((0, 0, cz), crown * 0.74, leaf, sub=2, jitter=0.2, squash=squash))
    ob = join(parts, name); bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)   # 原点 = 树根
    li = [i for i, m in enumerate(ob.data.materials) if m.name.startswith('TR_leaf')][0]
    crown_normals(ob, li, (0, 0, cz), (crown, crown, crown * squash))
    return ob

def conifer(name, leaf, h=10, r=2.6, tiers=6, narrow=False):
    parts = [trunk(h * 0.9, 0.22 * h / 10, BARK)]
    base = h * 0.18
    for i in range(tiers):
        t = i / tiers; rr = r * (1 - t * 0.8) * (0.62 if narrow else 1)
        dep = (h - base) / tiers * 1.9
        bpy.ops.mesh.primitive_cone_add(vertices=12, radius1=rr, radius2=rr * 0.12, depth=dep, location=(0, 0, base + (h - base) * t + dep * 0.5))
        c = bpy.context.object
        for v in c.data.vertices:   # 下缘锯齿 + 外轮廓扰动
            if v.co.z < 0: k = rnd.uniform(0.8, 1.2); v.co.x *= k; v.co.y *= k; v.co.z -= rnd.uniform(0, 0.5) * rr / r
        c.data.materials.append(leaf)
        for f in c.data.polygons: f.use_smooth = True
        parts.append(c)
    ob = join(parts, name); bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)   # 原点 = 树根
    li = [i for i, m in enumerate(ob.data.materials) if m.name.startswith('TR_leaf')][0]
    crown_normals(ob, li, (0, 0, h * 0.45), (r * (0.62 if narrow else 1), r * (0.62 if narrow else 1), h * 0.5))
    return ob

trees = [
    broadleaf('TREE_0', mat('TR_leaf_camphor', (0.11, 0.25, 0.08)), h=9, crown=3.8, lobes=10),                 # 香樟
    broadleaf('TREE_1', mat('TR_leaf_plane', (0.22, 0.34, 0.10)), h=12, crown=4.4, lobes=11, squash=0.85),     # 悬铃木
    broadleaf('TREE_2', mat('TR_leaf_sakura', (0.96, 0.80, 0.84)), h=6.5, crown=3.2, lobes=9, squash=0.7),   # 樱花
    broadleaf('TREE_3', mat('TR_leaf_plum', (0.86, 0.36, 0.48)), h=4.5, crown=2.2, lobes=7, squash=0.75),     # 红梅
    conifer('TREE_4', mat('TR_leaf_pine', (0.07, 0.17, 0.08)), h=10, r=2.6, tiers=6),                        # 松柏
    conifer('TREE_5', mat('TR_leaf_metasequoia', (0.18, 0.30, 0.10)), h=18, r=2.2, tiers=8, narrow=True),    # 水杉
]
for i, t in enumerate(trees): t.location = (i * 14, 0, 0)

# ---------- 车 ----------
GLASS = mat('CAR_glass', (0.04, 0.05, 0.06), 0.1, 0.5)
TIRE = mat('CAR_tire', (0.03, 0.03, 0.03), 0.9)
HEAD = mat('CAR_headlight', (0.9, 0.9, 0.85), 0.2)
TAIL = mat('CAR_taillight', (0.6, 0.02, 0.02), 0.3)
def box(c, s, m):
    bpy.ops.mesh.primitive_cube_add(size=1, location=c); o = bpy.context.object; o.scale = s
    bpy.ops.object.transform_apply(scale=True); o.data.materials.append(m); return o
def bevel(o, w):
    b = o.modifiers.new('bv', 'BEVEL'); b.width = w; b.segments = 2
    bpy.context.view_layer.objects.active = o; bpy.ops.object.modifier_apply(modifier='bv'); return o
def wheels(L, W, r, xs):
    out = []
    for x in xs:
        for y in (-W / 2 + 0.12, W / 2 - 0.12):
            bpy.ops.mesh.primitive_cylinder_add(vertices=10, radius=r, depth=0.25, location=(x, y, r), rotation=(math.pi / 2, 0, 0))
            w = bpy.context.object; w.data.materials.append(TIRE); out.append(w)
    return out
def car(name, L, W, H, body_col, cabin=(0.55, 0.35), bus=False):
    BODY = mat('CAR_body', (0.8, 0.8, 0.8), 0.35, 0.4)  # 网页按实例染色
    parts = []
    if bus:
        parts.append(bevel(box((0, 0, 0.45 + H / 2), (L, W, H), BODY), 0.15))
        parts.append(box((0, 0, 0.45 + H * 0.62), (L * 0.96, W + 0.02, H * 0.38), GLASS))
    else:
        parts.append(bevel(box((0, 0, 0.35 + H * 0.22), (L, W, H * 0.42), BODY), 0.12))
        parts.append(bevel(box((-L * 0.05, 0, 0.35 + H * 0.62), (L * cabin[0], W * 0.86, H * cabin[1] * 1.15), BODY), 0.1))
        parts.append(box((-L * 0.05, 0, 0.35 + H * 0.62), (L * cabin[0] * 1.02, W * 0.80, H * cabin[1]), GLASS))
    parts.append(box((L / 2, W * 0.33, 0.35 + H * 0.28), (0.06, 0.32, 0.14), HEAD)); parts.append(box((L / 2, -W * 0.33, 0.35 + H * 0.28), (0.06, 0.32, 0.14), HEAD))
    parts.append(box((-L / 2, W * 0.36, 0.35 + H * 0.3), (0.06, 0.28, 0.12), TAIL)); parts.append(box((-L / 2, -W * 0.36, 0.35 + H * 0.3), (0.06, 0.28, 0.12), TAIL))
    parts += wheels(L, W, 0.34 if not bus else 0.5, [L * 0.32, -L * 0.32])
    return join(parts, name)
cars = [car('CAR_0', 4.7, 1.85, 1.45, None), car('CAR_1', 4.8, 1.95, 1.75, None, cabin=(0.62, 0.42)),
        car('CAR_2', 12, 2.5, 2.9, None, bus=True), car('CAR_3', 8.5, 2.4, 3.2, None, cabin=(0.25, 0.5))]
for i, c in enumerate(cars): c.location = (i * 14, 20, 0)

# 路灯
pole = mat('LAMP_pole', (0.25, 0.26, 0.28), 0.5, 0.7)
lampm = mat('LAMP_light', (0.95, 0.9, 0.8), 0.3)
bpy.ops.mesh.primitive_cylinder_add(vertices=8, radius=0.12, depth=10, location=(0, 0, 5)); p = bpy.context.object; p.data.materials.append(pole)
bpy.ops.mesh.primitive_cylinder_add(vertices=6, radius=0.07, depth=2.2, location=(1.0, 0, 9.8), rotation=(0, math.pi / 2, 0)); a = bpy.context.object; a.data.materials.append(pole)
l = box((2.1, 0, 9.75), (0.7, 0.3, 0.12), lampm)
lamp = join([p, a, l], 'LAMP_0'); lamp.location = (0, 40, 0)

bpy.ops.wm.save_as_mainfile(filepath=OUT_BLEND)
bpy.ops.export_scene.gltf(filepath=OUT_GLB, export_format='GLB', export_yup=True, export_apply=True)
for o in bpy.data.objects: print('obj', o.name, len(o.data.polygons))
