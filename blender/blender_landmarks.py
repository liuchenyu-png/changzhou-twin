# Blender 地标：借用已有写实模型（减面+真实尺度+真实坐标）+ 程序化新建 → landmarks.glb + landmarks.blend
# 用法：blender -b -P blender_landmarks.py -- <models_dir_atlas> <models_dir_feiyi> <out.glb> <out.blend>
import bpy, bmesh, math, sys
from mathutils import Vector, Matrix

argv = sys.argv[sys.argv.index('--') + 1:]
ATLAS, FEIYI, OUT_GLB, OUT_BLEND = argv
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
root = bpy.data.collections.new('Landmarks'); scene.collection.children.link(root)

# id, 文件, 位置(x 东, y 北), 目标尺寸('h' 高 / 'w' 最大水平边), 朝向(度), 目标面数
IMPORTS = [
    ('tianning_pagoda', FEIYI + '/tianning.glb', (70, -803), ('h', 153.8), 0, 140000),
    ('wenbi_pagoda', FEIYI + '/wenta.glb', (433, -1245), ('h', 48), 0, 90000),
    ('hongmei_pavilion', ATLAS + '/hongmeige.glb', (302, -1081), ('w', 46), 0, 70000),
    ('baolin_temple', FEIYI + '/baolin.glb', (-5287, -7841), ('h', 46), 0, 90000),
    ('lotus_hall', FEIYI + '/lianhua.glb', (-2133, -9389), ('w', 112), 0, 90000),
    ('gehu_star', FEIYI + '/gehu.glb', (-11686, -11250), ('h', 108), 0, 80000),
]

def link_only(ob):
    for c in list(ob.users_collection): c.objects.unlink(ob)
    root.objects.link(ob)

def import_model(lid, path, pos, size, rot, target):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.data.objects if o not in before]
    meshes = [o for o in new if o.type == 'MESH']
    # 烘焙变换后合并
    bpy.ops.object.select_all(action='DESELECT')
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    for o in new:
        if o.type != 'MESH': o.select_set(False)
    if len(meshes) > 1: bpy.ops.object.join()
    ob = bpy.context.view_layer.objects.active
    ob.parent = None
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    for o in new:
        if o != ob and o.name in bpy.data.objects and o.type != 'MESH': bpy.data.objects.remove(o)
    # 减面
    n = len(ob.data.polygons)
    if n > target:
        m = ob.modifiers.new('dec', 'DECIMATE'); m.ratio = target / n
        bpy.ops.object.modifier_apply(modifier='dec')
    # 尺度与落地
    bb = [Vector(c) for c in ob.bound_box]
    mn = Vector((min(v.x for v in bb), min(v.y for v in bb), min(v.z for v in bb)))
    mx = Vector((max(v.x for v in bb), max(v.y for v in bb), max(v.z for v in bb)))
    s = size[1] / ((mx.z - mn.z) if size[0] == 'h' else max(mx.x - mn.x, mx.y - mn.y))
    c = (mn + mx) / 2
    ob.data.transform(Matrix.Translation(Vector((-c.x, -c.y, -mn.z))))
    ob.data.transform(Matrix.Scale(s, 4))
    ob.data.transform(Matrix.Rotation(math.radians(rot), 4, 'Z'))
    ob.location = (pos[0], pos[1], 0)
    ob.name = 'LM_' + lid
    for i, mt in enumerate(ob.data.materials):
        if mt: mt.name = 'LMT_%s_%d' % (lid, i)
    for img in bpy.data.images:
        if img.size[0] > 1024: img.scale(1024, 1024)
    link_only(ob)
    print('imported', lid, 'faces', len(ob.data.polygons), 'scale', round(s, 1))
    return ob

for args in IMPORTS:
    import_model(*args)

# ---------- 程序化地标 ----------
def mat(name, col, rough=0.6, metal=0.0, emit=None):
    m = bpy.data.materials.get(name)
    if m: return m
    m = bpy.data.materials.new(name); m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*col, 1); b.inputs['Roughness'].default_value = rough; b.inputs['Metallic'].default_value = metal
    return m

def mesh_obj(name, verts, faces, mats, mi=None, uv=None, uv1=None, loc=(0, 0, 0), smooth=False):
    me = bpy.data.meshes.new(name); me.from_pydata(verts, [], faces)
    for m in mats: me.materials.append(m)
    if mi: me.polygons.foreach_set('material_index', mi)
    if uv:
        l = me.uv_layers.new(name='UVMap'); l.data.foreach_set('uv', [c for f in uv for p in f for c in p])
    if uv1:
        l = me.uv_layers.new(name='UVData'); l.data.foreach_set('uv', [c for f in uv1 for p in f for c in p])
    if smooth: me.shade_smooth()
    me.validate(); me.update()
    ob = bpy.data.objects.new(name, me); ob.location = loc; root.objects.link(ob); return ob

# 1) 常州现代传媒中心 332 m：方形收分塔身（沿用楼宇幕墙 UV 约定，网页画玻璃窗）+ 冠顶 + 天线
def media_tower(pos):
    W = mat('B_wall', (0.7, 0.72, 0.75)); R = mat('B_roof', (0.3, 0.3, 0.3)); M = mat('LM_metal', (0.75, 0.77, 0.8), 0.25, 0.9)
    verts = []; faces = []; uv = []; uv1 = []; mi = []
    levels = [(0, 27), (60, 27), (150, 25.5), (230, 23), (290, 19.5), (300, 17)]
    seed = (2 + 0.37, 300)
    rings = []
    for z, hw in levels:
        o = len(verts)
        # 切角方形（八边形）更像实楼
        ch = hw * 0.28
        pts = [(-hw + ch, -hw), (hw - ch, -hw), (hw, -hw + ch), (hw, hw - ch), (hw - ch, hw), (-hw + ch, hw), (-hw, hw - ch), (-hw, -hw + ch)]
        verts += [(x, y, z) for x, y in pts]; rings.append((o, pts, z))
    for k in range(len(rings) - 1):
        o0, p0, z0 = rings[k]; o1, p1, z1 = rings[k + 1]; per = 0.0
        for i in range(8):
            j = (i + 1) % 8; L = (Vector(p0[j]) - Vector(p0[i])).length
            faces.append((o0 + i, o0 + j, o1 + j, o1 + i)); mi.append(0)
            uv.append([(per, z0), (per + L, z0), (per + L, z1), (per, z1)]); uv1.append([seed] * 4); per += L
    o, p, z = rings[-1]; faces.append(tuple(o + i for i in range(8))); mi.append(1); uv.append([(0, 0)] * 8); uv1.append([seed] * 8)
    mesh_obj('LM_media_tower', verts, faces, [W, R], mi, uv, uv1, loc=(pos[0], pos[1], 0))
    # 冠顶钢构环 + 天线
    bpy.ops.mesh.primitive_cylinder_add(vertices=8, radius=14, depth=14, location=(pos[0], pos[1], 307)); c = bpy.context.object
    c.data.materials.append(M); c.name = 'LM_media_crown'; link_only(c)
    bpy.ops.mesh.primitive_cone_add(vertices=8, radius1=2.2, radius2=0.3, depth=36, location=(pos[0], pos[1], 332 - 18)); a = bpy.context.object
    a.data.materials.append(M); a.name = 'LM_media_spire'; link_only(a)
    # 裙楼
    bpy.ops.mesh.primitive_cube_add(size=1, location=(pos[0] + 10, pos[1] - 45, 12)); pd = bpy.context.object; pd.scale = (110, 50, 24)
    bpy.ops.object.transform_apply(scale=True); pd.data.materials.append(mat('LM_glass_podium', (0.35, 0.42, 0.48), 0.15, 0.6)); pd.name = 'LM_media_podium'; link_only(pd)
media_tower((241, 3427))

# 2) 常州奥体中心体育场：椭圆看台碗 + 白色肋拱外壳 + 环形挑篷 + 草坪/跑道
def stadium(pos, A=108, B=92):
    white = mat('LM_white', (0.88, 0.88, 0.86), 0.45); seat = mat('LM_seat', (0.55, 0.12, 0.10), 0.7)
    grass = mat('LM_grass', (0.12, 0.42, 0.12), 0.9); track = mat('LM_track', (0.62, 0.22, 0.15), 0.9)
    roof = mat('LM_canopy', (0.92, 0.92, 0.9), 0.35); steel = mat('LM_metal', (0.75, 0.77, 0.8), 0.25, 0.9)
    N = 96
    def ring(rx, ry, z): return [(rx * math.cos(2 * math.pi * i / N), ry * math.sin(2 * math.pi * i / N), z) for i in range(N)]
    verts = []; faces = []; mi = []
    def add_ring(r):
        o = len(verts); verts.extend(r); return o
    def bridge(a, b, m):
        for i in range(N):
            j = (i + 1) % N; faces.append((a + i, a + j, b + j, b + i)); mi.append(m)
    # 场地：草坪椭圆 + 跑道环
    c0 = add_ring([(0, 0, 0.5)]) if False else None
    g_in = add_ring(ring(A * 0.5, B * 0.42, 0.5)); t_in = add_ring(ring(A * 0.62, B * 0.58, 0.5)); t_out = add_ring(ring(A * 0.72, B * 0.7, 0.5))
    ctr = len(verts); verts.append((0, 0, 0.5))
    for i in range(N): faces.append((ctr, g_in + i, g_in + (i + 1) % N)); mi.append(2)
    bridge(g_in, t_in, 2); bridge(t_in, t_out, 3)
    # 看台：下层+上层
    s0 = add_ring(ring(A * 0.72, B * 0.7, 2)); s1 = add_ring(ring(A * 0.88, B * 0.86, 14)); s2 = add_ring(ring(A * 0.9, B * 0.88, 16)); s3 = add_ring(ring(A * 1.0, B * 0.98, 34))
    bridge(t_out, s0, 0); bridge(s0, s1, 1); bridge(s1, s2, 0); bridge(s2, s3, 1)
    # 外立面：外墙下沿到看台顶
    w0 = add_ring(ring(A * 1.08, B * 1.06, 0)); w1 = add_ring(ring(A * 1.04, B * 1.02, 38))
    bridge(w1, w0, 0); bridge(s3, w1, 0)
    mesh_obj('LM_stadium_bowl', verts, faces, [white, seat, grass, track], mi, loc=(pos[0], pos[1], 0))
    # 挑篷：外高内低的环面
    verts = []; faces = []; mi = []
    r0 = add_ring(ring(A * 1.1, B * 1.08, 46)); r1 = add_ring(ring(A * 0.8, B * 0.76, 40)); bridge(r1, r0, 0)
    r0b = add_ring(ring(A * 1.1, B * 1.08, 44.5)); r1b = add_ring(ring(A * 0.8, B * 0.76, 38.5)); bridge(r0b, r1b, 0); bridge(r0, r0b, 0); bridge(r1b, r1, 0)
    mesh_obj('LM_stadium_canopy', verts, faces, [roof], mi, loc=(pos[0], pos[1], 0))
    # 外壳肋拱
    for i in range(0, N, 3):
        a = 2 * math.pi * i / N; x = A * 1.08 * math.cos(a); y = B * 1.06 * math.sin(a)
        bpy.ops.mesh.primitive_cube_add(size=1, location=(pos[0] + x, pos[1] + y, 23)); rb = bpy.context.object
        rb.scale = (1.2, 1.2, 46); rb.rotation_euler = (0, 0, a); bpy.ops.object.transform_apply(scale=True, rotation=True)
        rb.data.materials.append(steel); rb.name = 'LM_stadium_rib'; link_only(rb)
stadium((844, 2538))

# 3) 恐龙园：腕龙 / 霸王龙雕塑（骨架折线 + 皮肤修改器 + 细分）
def skin_creature(name, chain, legs, loc, rot, col):
    verts = []; edges = []; radii = []
    for i, (x, y, z, r) in enumerate(chain):
        verts.append((x, y, z)); radii.append(r)
        if i: edges.append((i - 1, i))
    for (attach, pts) in legs:
        prev = attach
        for (x, y, z, r) in pts:
            verts.append((x, y, z)); radii.append(r); edges.append((prev, len(verts) - 1)); prev = len(verts) - 1
    me = bpy.data.meshes.new(name); me.from_pydata(verts, edges, [])
    ob = bpy.data.objects.new(name, me); root.objects.link(ob)
    ob.location = loc; ob.rotation_euler = (0, 0, math.radians(rot))
    sk = ob.modifiers.new('skin', 'SKIN'); ob.modifiers.new('sub', 'SUBSURF').levels = 2
    for v, r in zip(ob.data.skin_vertices[0].data, radii): v.radius = (r, r * 0.9)
    ob.data.skin_vertices[0].data[0].use_root = True
    bpy.context.view_layer.objects.active = ob; ob.select_set(True)
    bpy.ops.object.modifier_apply(modifier='skin'); bpy.ops.object.modifier_apply(modifier='sub')
    ob.data.materials.append(mat('LM_dino_' + name, col, 0.75)); bpy.ops.object.shade_smooth()
    return ob
# 腕龙：尾 → 躯干 → 长颈 → 头（单位 m，总高约 22 m）
brachio = [(-26, 0, 6, 0.4), (-20, 0, 8, 1.0), (-14, 0, 10, 1.8), (-7, 0, 11.5, 3.0), (0, 0, 12, 3.6), (5, 0, 13, 3.0), (8, 0, 15.5, 1.7),
           (10, 0, 18.5, 1.2), (11.5, 0, 21, 1.0), (12.5, 0, 23, 1.0), (14, 0, 23.4, 0.9), (15.2, 0, 23.0, 0.55)]
legs = [(4, [(-3, 2.6, 6, 1.4), (-3, 2.8, 0.6, 1.1)]), (4, [(-3, -2.6, 6, 1.4), (-3, -2.8, 0.6, 1.1)]),
        (5, [(5, 2.6, 7, 1.3), (5.5, 2.8, 0.6, 1.0)]), (5, [(5, -2.6, 7, 1.3), (5.5, -2.8, 0.6, 1.0)])]
skin_creature('LM_dino_brachio', brachio, legs, (2870, 4390, 0), 35, (0.36, 0.40, 0.30))
trex = [(-9, 0, 4.5, 0.25), (-6, 0, 5, 0.7), (-3, 0, 5.4, 1.4), (0, 0, 5.8, 1.9), (2.5, 0, 6.6, 1.6), (4, 0, 7.6, 1.0), (5.5, 0, 8.0, 1.2), (7, 0, 7.8, 1.0), (7.9, 0, 7.6, 0.6)]
tlegs = [(3, [(-1, 1.4, 3.6, 0.9), (0.2, 1.5, 0.5, 0.5)]), (3, [(-1, -1.4, 3.6, 0.9), (0.2, -1.5, 0.5, 0.5)]),
         (4, [(3.2, 1.1, 5.4, 0.25), (3.8, 1.2, 5.0, 0.2)]), (4, [(3.2, -1.1, 5.4, 0.25), (3.8, -1.2, 5.0, 0.2)])]
skin_creature('LM_dino_trex', trex, tlegs, (2925, 4362, 0), -20, (0.42, 0.30, 0.22))

# 4) 舣舟亭：方亭、四根红柱、飞檐攒尖
def pavilion(name, pos, s=1.0):
    red = mat('LM_redwood', (0.45, 0.07, 0.05), 0.6); tile = mat('LM_tile', (0.10, 0.10, 0.11), 0.7); stone = mat('LM_stone', (0.62, 0.60, 0.55), 0.85)
    x0, y0 = pos
    bpy.ops.mesh.primitive_cube_add(size=1, location=(x0, y0, 0.45 * s)); b = bpy.context.object; b.scale = (8 * s, 8 * s, 0.9 * s)
    bpy.ops.object.transform_apply(scale=True); b.data.materials.append(stone); b.name = name + '_base'; link_only(b)
    for dx in (-2.6, 2.6):
        for dy in (-2.6, 2.6):
            bpy.ops.mesh.primitive_cylinder_add(vertices=10, radius=0.22 * s, depth=3.6 * s, location=(x0 + dx * s, y0 + dy * s, (0.9 + 1.8) * s))
            c = bpy.context.object; c.data.materials.append(red); c.name = name + '_col'; link_only(c)
    # 飞檐：四角上翘的攒尖屋面
    N = 4; verts = [(x0, y0, 7.6 * s)]; faces = []
    eave = []
    for i in range(16):
        a = math.pi / 4 + 2 * math.pi * i / 16
        rr = 4.4 * s / max(abs(math.cos(a - math.pi / 4 + math.pi / 4)), abs(math.sin(a)), 0.001) if False else 4.4 * s
        corner = abs(math.cos(2 * (a - math.pi / 4)))  # 1 在四角
        R = 4.2 * s * (1 + 0.32 * corner)
        verts.append((x0 + R * math.cos(a), y0 + R * math.sin(a), (4.6 + 0.9 * corner ** 3) * s))
    for i in range(16): faces.append((0, 1 + i, 1 + (i + 1) % 16))
    o = len(verts)
    for i in range(16):
        x, y, z = verts[1 + i]; verts.append((x, y, z - 0.35 * s))
    for i in range(16):
        j = (i + 1) % 16; faces.append((1 + i, o + i, o + j, 1 + j))
    faces.append(tuple(o + i for i in reversed(range(16))))
    mesh_obj(name + '_roof', verts, faces, [tile], smooth=False)
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.35 * s, location=(x0, y0, 7.9 * s)); k = bpy.context.object
    k.data.materials.append(mat('LM_gold', (0.85, 0.62, 0.22), 0.3, 1.0)); k.name = name + '_finial'; link_only(k)
pavilion('LM_yizhou', (666, -1828), 1.0)

bpy.ops.wm.save_as_mainfile(filepath=OUT_BLEND)
bpy.ops.export_scene.gltf(filepath=OUT_GLB, export_format='GLB', export_yup=True, export_apply=True,
                          export_image_format='JPEG', export_jpeg_quality=86,
                          export_draco_mesh_compression_enable=True, export_draco_mesh_compression_level=6,
                          export_draco_texcoord_quantization=16)
print('done')
