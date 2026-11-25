// 树：trees.bin（x, y, 种类, 缩放）→ 按相机位置重建近景/远景 InstancedMesh
import * as THREE from 'three';
import { treeMaterial } from './materials.js';

const CELL = 500;
export class Trees {
  constructor(scene, propsRoot, data, bbox) {
    this.scene = scene; this.bbox = bbox;
    const n = data.length / 4; this.n = n; this.data = data;
    // 按格子排序索引
    this.gw = Math.ceil((bbox.x1 - bbox.x0) / CELL); this.gh = Math.ceil((bbox.y1 - bbox.y0) / CELL);
    const cellOf = (i) => Math.min(this.gw - 1, Math.max(0, Math.floor((data[i * 4] - bbox.x0) / CELL))) + this.gw * Math.min(this.gh - 1, Math.max(0, Math.floor((data[i * 4 + 1] - bbox.y0) / CELL)));
    const counts = new Uint32Array(this.gw * this.gh + 1);
    for (let i = 0; i < n; i++) counts[cellOf(i) + 1]++;
    for (let c = 1; c < counts.length; c++) counts[c] += counts[c - 1];
    this.start = counts.slice(); const fill = counts.slice(); this.order = new Uint32Array(n);
    for (let i = 0; i < n; i++) this.order[fill[cellOf(i)]++] = i;
    // 每个种类的部件
    this.kinds = [];
    for (let k = 0; k < 6; k++) {
      const node = propsRoot.getObjectByName('TREE_' + k);
      const parts = [];
      node.updateMatrixWorld(true);
      const inv = new THREE.Matrix4().copy(node.matrixWorld).invert();
      node.traverse((o) => {
        if (!o.isMesh) return;
        const g = o.geometry.clone(); g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld));
        const leaf = /leaf/.test(o.material.name);
        parts.push({ g, src: o.material, leaf });
      });
      // 树冠中心/半径：给叶片着色器做球形法线、冠内遮蔽
      const leafPart = parts.find((p) => p.leaf); leafPart.g.computeBoundingBox(); const bb = leafPart.g.boundingBox;
      const sz = new THREE.Vector3(); bb.getSize(sz); const ct = new THREE.Vector3(); bb.getCenter(ct);
      for (const p of parts) p.m = treeMaterial(p.src, p.leaf, { c: ct.clone(), r: Math.max(sz.x, sz.y, sz.z) * 0.5 });
      // 远景：只留树冠的低模（按树冠包围盒放一个二十面体）
      const far = new THREE.IcosahedronGeometry(1, 1);
      far.scale(sz.x * 0.5, sz.y * 0.5, sz.z * 0.5); far.translate(ct.x, ct.y, ct.z);
      this.kinds.push({ parts, far: { g: far, m: leafPart.m } });
    }
    this.cap = { near: 60000, far: 160000 };
    this.near = []; this.far = [];
    for (let k = 0; k < 6; k++) {
      this.near.push(this.kinds[k].parts.map((p) => this.mkIM(p.g, p.m, this.cap.near, true)));
      this.far.push(this.mkIM(this.kinds[k].far.g, this.kinds[k].far.m, this.cap.far, false));
    }
    this.last = null; this.visible = true;
  }
  mkIM(g, m, cap, shadow) {
    const im = new THREE.InstancedMesh(g, m, cap); im.count = 0; im.frustumCulled = false;
    im.castShadow = shadow; im.receiveShadow = shadow; im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3); im.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.scene.add(im); return im;
  }
  setVisible(v) { this.visible = v; for (const a of this.near) for (const im of a) im.visible = v; for (const im of this.far) im.visible = v; }
  update(camPos, target) {
    if (!this.visible) return;
    const h = Math.max(camPos.y, 2);
    const cx = target.x * 0.5 + camPos.x * 0.5, cy = -(target.z * 0.5 + camPos.z * 0.5);
    const rNear = Math.min(750, 260 + h * 0.85), rFar = Math.min(6000, 1400 + h * 3.5);
    const key = [Math.round(cx / 60), Math.round(cy / 60), Math.round(rFar / 150)].join();
    if (key === this.last) return; this.last = key;
    const { data, order, start, bbox } = this;
    const nc = [0, 0, 0, 0, 0, 0], fc = [0, 0, 0, 0, 0, 0];
    const i0 = Math.max(0, Math.floor((cx - rFar - bbox.x0) / CELL)), i1 = Math.min(this.gw - 1, Math.floor((cx + rFar - bbox.x0) / CELL));
    const j0 = Math.max(0, Math.floor((cy - rFar - bbox.y0) / CELL)), j1 = Math.min(this.gh - 1, Math.floor((cy + rFar - bbox.y0) / CELL));
    const rn2 = rNear * rNear, rf2 = rFar * rFar;
    const col = new THREE.Color();
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const c = j * this.gw + i;
      for (let q = start[c]; q < start[c + 1]; q++) {
        const t = order[q]; const x = data[t * 4], y = data[t * 4 + 1], s = data[t * 4 + 3]; let k = data[t * 4 + 2] | 0;
        if (k === 2 && t % 10 < 6) k = t % 2; // 樱花只留四成，其余换成香樟/悬铃木
        const dx = x - cx, dy = y - cy, d2 = dx * dx + dy * dy; if (d2 > rf2) continue;
        const near = d2 < rn2; const idx = near ? nc[k]++ : fc[k]++;
        if (near ? idx >= this.cap.near : idx >= this.cap.far) continue;
        const r = ((t * 2654435761) >>> 0) / 4294967296 * 6.283; const ca = Math.cos(r) * s, sa = Math.sin(r) * s;
        const tint = 0.82 + (((t * 40503) >>> 0) % 1000) / 1000 * 0.36;
        col.setRGB(tint, tint * (0.95 + (t % 7) * 0.012), tint * 0.95);
        const arrs = near ? this.near[k] : [this.far[k]];
        for (const im of arrs) {
          const a = im.instanceMatrix.array, o = idx * 16;
          a[o] = ca; a[o + 1] = 0; a[o + 2] = -sa; a[o + 3] = 0; a[o + 4] = 0; a[o + 5] = s; a[o + 6] = 0; a[o + 7] = 0;
          a[o + 8] = sa; a[o + 9] = 0; a[o + 10] = ca; a[o + 11] = 0; a[o + 12] = x; a[o + 13] = 0.1; a[o + 14] = -y; a[o + 15] = 1;
          col.toArray(im.instanceColor.array, idx * 3);
        }
      }
    }
    for (let k = 0; k < 6; k++) {
      for (const im of this.near[k]) { im.count = Math.min(nc[k], this.cap.near); im.instanceMatrix.needsUpdate = true; im.instanceColor.needsUpdate = true; }
      const f = this.far[k]; f.count = Math.min(fc[k], this.cap.far); f.instanceMatrix.needsUpdate = true; f.instanceColor.needsUpdate = true;
    }
    this.shown = nc.reduce((a, b) => a + b, 0) + fc.reduce((a, b) => a + b, 0);
  }
}
