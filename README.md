# 常州 · 主城区数字孪生（CHANGZHOU DIGITAL TWIN）

按参考视频（城市数字孪生：写实城市建模、车流、行道树、湖面、地标卡片、昼夜/天气、第一人称漫游）重做的常州地图。
所有地点按 OpenStreetMap 真实经纬度排布，模型全部在 Blender 里生成/处理。

## 运行
- 克隆后先装依赖：`npm install`（依赖只有 `three` 与 `vite`）
- 开发：`npm run dev` → http://127.0.0.1:5190/
- 发布包：`npx vite build` → `dist/`（相对路径，可放进任意子目录，例如原站的 `/atlas2/`）

## 范围与数据
- 范围：东西 21 km × 南北 22 km（x −14000…7000，y −12000…10000，单位米；原点 119.965°E, 31.785°N ≈ 天宁寺）
  北到常州北站、南到揽月湾、西到滆湖（湖面向外延伸 6 km），东到紫荆公园
- 数据：OpenFreeMap z14 矢量瓦片（OSM），缓存在 `%APPDATA%\dsh-desktop\harness\changzhou-geodata\tiles-ofm\14`（226 块）
- 38,570 栋楼：24,252 栋 OSM 真实轮廓/高度 + 14,318 栋按用地（住宅/商业/工业/学校/医院）程序化补齐
- 道路 5,169 km（按等级给宽度，高架按 9 m 抬升带桥墩），水面 2,052 块，树 76 万棵（行道树/公园/林地/小区）

## 生成流程（改数据后按顺序重跑）
```
node tools/extract.cjs data/cz_osm.json                       # 瓦片 → 本地米坐标
node --max-old-space-size=8000 tools/prep.cjs data/cz_osm.json ../build   # 裁剪、补楼、树位、车道
blender -b -P blender/blender_city.py -- ../build/city_geo.json public/models/city.glb ../build/city.blend tools/exclude.json public/data/bld.bin
blender -b -P blender/blender_landmarks.py -- <原站 atlas/assets/models> <原站 feiyi/glb> public/models/landmarks.glb ../build/landmarks.blend
blender -b -P blender/blender_props.py -- public/models/props.glb ../build/props.blend
# 再把 ../build/trees.bin traffic.json stats.json infill.bin 拷到 public/data/
```
Blender：`~/tools/blender/blender-4.2.23-windows-x64/blender.exe`。`.blend` 源文件在 `D:\wangye\changzhou\build\`。

## 地标（src/data.js，可直接改文案）
- 借用原站写实模型（Blender 里减面 + 按真实高度缩放 + 放到真实坐标）：
  天宁宝塔 153.8 m、文笔塔 48 m、红梅阁、宝林禅寺、武进莲花馆、滆湖之星
- Blender 程序化新建：常州现代传媒中心 332 m、奥体中心体育场、恐龙园腕龙/霸王龙、舣舟亭
- 只标注（楼体来自 OSM）：天宁禅寺、青果巷、南大街、篦箕巷、近园、大运河、恐龙园、市民广场、环球港、常州站、常州北站、淹城遗址/乐园
- 地图外：花神宫、嬉戏谷、茅山、天目湖、南山竹海 —— 地图边缘方向牌（含距离）
- `tools/exclude.json`：被精细模型替换掉的 OSM 楼（圆心 x, y, 半径）

## 网页实现要点
- `src/materials.js`：Blender 材质名 → 程序化 PBR。楼墙 UV = (周长米, 高度米)，UV1 = (立面类型+随机种子, 楼高)，
  四种立面（住宅/玻璃幕墙/厂房/历史民居坡屋顶），夜间按“房间”随机亮灯；路面 UV = (沿路米, 横向米)，画车道线/双黄线/斑马线/夜间路灯光斑；
  雨天路面变湿变暗变光滑，雪天屋顶/地面积雪
- `src/sky.js`：常州纬度 + 四月初的太阳轨迹，天空穹顶（云、星、月），五种天气
- `src/trees.js`：按相机位置重建近景（带阴影、风摆）/远景低模 InstancedMesh
- `src/traffic.js`：主干道按车道靠右行驶，路口接续到相连道路，夜间车灯
- 渲染管线（2026-11-20 加）：GTAO 环境光遮蔽 → Bloom → Output → 调色（S 曲线/饱和/暗角）；水面平面反射（镜像相机半分辨率 RT，`renderer.clippingPlanes` 裁水下）；
  雾改成指数高度雾（`ShaderChunk.fog_*` 全局替换，`fog.near` = 地面密度、`fog.far` = 标高米）
- 立面：室内映射（透过窗看到有进深的房间、家具、窗帘/百叶、夜间吊灯），远处按 `fwidth` 淡出成平均色；屋顶女儿墙（uv1.x = 类型+10 表示无窗同色墙）、楼梯间、水箱、空调外机（`B_equip`）、厂房光伏（`B_solar`）；人行道 `R_walk`（路缘 + 铺装 + 盲道，路口断开）
- 树：Blender 里多叶团 + 烘焙“冠心外向”自定义法线；着色器里冠内遮蔽、逆光透光
- 坑：glTF 导出会把 V 翻成 1−v（`patch()` 里统一还原）；D3D/ANGLE 快速数学下浮点判等会逐像素随机失败；插值后的常量种子不能直接喂哈希（先量化）
- 调试钩子：`window.__cz`（setHour / setWeather / flyTo / openCard / enterWalk）；截图脚本 `tools/shot.cjs`

### 实体立面（近景几何）
- `blender_city.py` 第 5 个参数输出 `public/data/bld.bin`（每栋：类型/种子/底/顶/女儿墙高/轮廓点）。
- `src/facades.js` 按 200 m 分格，在相机 420–800 m 内实时生成立面构件：住宅楼板挑檐、窗间柱、阳台板+栏板；办公层间带、竖向铝肋、底商雨棚；厂房钢柱、窗台、檐口；所有楼勒脚、女儿墙压顶。远处退回 city.glb 的平面墙 + 着色器窗格。
- 构件 uv1 用“类型+10”（同墙色无窗），网格与着色器窗格对齐（住宅 3.3×3.0、办公 1.6×3.9、厂房 6.5×6.0）。
- 白天室内映射亮度降到 0.06，玻璃以反射为主，避免“透明空壳”感。
- 坑：`tessellate_polygon` 输出三角形方向不固定，原先统一 reversed 导致 99% 屋顶法线朝下、被背面剔除（楼“中间是空的”）。现用 `up_tris()` 逐三角形保证朝上。驳岸顶面/岸壁方向同步修正，外侧仍是水的切口边不砌岸。

### 全覆盖补楼与沙盘边
- `prep.cjs` 把 bbox 切成 240 m 分区，按 landuse、离市中心距离、噪声定类型（多层/高层/混合/商业/工业/村落），沿周边道路主方向排楼，避让已有楼、水、绿地、禁建用地；输出 `infill.bin`（每栋 8 个 float）和 `city_geo.json` 的 `zones`（地面铺装 + 分区树）。
- `src/infill.js` 在浏览器端把 infill.bin 拼成体块（3 km 分块，墙/平屋顶/坡屋顶三组材质），并交给 facades.js 做近景立面。OSM 楼 3.9 万 + 补楼 7.3 万 ≈ 11.2 万栋。
- 已删除 bbox 外 6 km 的裙边，水面也裁到 bbox 内；四周用 `G_edge` 沙盘底座（z −60 → 0.13）收边。
- 树密度太高会拖慢俯瞰帧率（116 万棵时 12 FPS），分区树现约为每 560–2200 m² 一棵，共 95 万棵。

## 夜景（2026-11-24，借鉴 The Blue Hour）

参考 https://n0tanti.github.io/the-blue-hour/（three.js WebGPU/TSL，代码 MIT；源码缓存在 `D:\wangye\changzhou\ref-bluehour`）的程序化天际线，在 GLSL 里重写：
- `materials.js` `czLitFrac`：亮灯率 = 楼活跃度 × 立面成片区域噪声 × 街区噪声，两扇窗一户共用开关；`czLampCol` 暖/中性/冷白灯色 + 亮度差
- 远处（窗格 < 像素）夜里一半换成 `czLitAvg` 平均灯光（不含立面区域噪声，否则成色斑），一半保留逐窗亮点
- 夜景氛围光（仅 `uNight`）：楼脚橙色上照光（约 55% 的楼）、40–70 m 以上高楼顶部泛光 + 女儿墙下轮廓灯带（远处按像素加宽、按能量减弱）、掠射角冷蓝边缘光
- `main.js` 调色：夜里线性空间三段色映射（深蓝/钴蓝/暖橙，`grade.uniforms.uRamp` 默认 0.4）、压黑点、细颗粒；夜间暗角 +0.12、饱和 −0.12、bloom 半径 +0.3、半球光夜间补光 0.25→0.12
- 改前备份：`build/materials.js.bak.night`、`build/main.js.bak.night`；对比图 `build/night/compare.png`
- 待做：城市光晕层（地平线附近蓝雾 + 暖光）、水面光柱倒影（1×2048 光源贴图拉伸）
