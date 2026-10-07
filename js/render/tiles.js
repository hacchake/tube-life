// 壁面タイルの描画。全セルを 1 つの BufferGeometry にまとめ、
// 状態が変わったセルだけ色と「浮き上がり」を更新する(CA の計算とは独立)。
(function (TL) {
  'use strict';
  const { clamp } = TL.util;

  // 状態ごとの見た目: 色の明るさ倍率(1を超えるとブルームで発光)と、壁から浮く高さ
  const LOOK = [
    { key: 'idle', k: 1, lift: 0 },
    { key: 'activating', k: 1.1, lift: 0.38 },
    { key: 'born', k: 0.75, lift: 0.3 },
    { key: 'growing', k: 0.7, lift: 0.18 },
    { key: 'mature', k: 0.65, lift: 0.1 },
    { key: 'decay', k: 0.6, lift: 0.04 },
    { key: 'dead', k: 0, lift: 0 },
  ];
  const SHRINK = { petal: 0.93, face: 0.9, hex: 0.9 };

  class TileMesh {
    constructor(scene, space) {
      this.scene = scene;
      this.space = space;
      this.dirty = new Set();
      this.hover = -1;
      this.colors = {};
      this.setColors(TL.STATE_COLORS);
    }

    setColors(hexes) {
      for (const k in hexes) this.colors[k] = new THREE.Color(hexes[k]).convertSRGBToLinear(); // 頂点色はリニア空間
      if (this.topology) for (let i = 0; i < this.topology.cells.length; i++) this.dirty.add(i);
    }

    build(topology) {
      this.dispose();
      this.topology = topology;
      const space = this.space;
      const cells = topology.cells;
      let nv = 0, nt = 0;
      for (const c of cells) { nv += c.shape.length + 1; nt += c.shape.length; }
      const pos = new Float32Array(nv * 3), base = new Float32Array(nv * 3), nrm = new Float32Array(nv * 2), col = new Float32Array(nv * 3);
      const index = new Uint32Array(nt * 3);
      this.start = new Uint32Array(cells.length);
      this.count = new Uint16Array(cells.length);
      const linePts = [];
      const v = new THREE.Vector3();
      let vi = 0, ti = 0;
      const put = (x, y) => {
        space.point(x, y, 0, v);
        base[vi * 3] = pos[vi * 3] = v.x;
        base[vi * 3 + 1] = pos[vi * 3 + 1] = v.y;
        base[vi * 3 + 2] = pos[vi * 3 + 2] = v.z;
        const r = Math.hypot(v.x, v.y);
        nrm[vi * 2] = -v.x / r; nrm[vi * 2 + 1] = -v.y / r;
        return vi++;
      };
      for (const c of cells) {
        this.start[c.id] = vi;
        const { x: cx, y: cy } = c.position;
        const k = SHRINK[c.kind] || 0.92;
        const center = put(cx, cy);
        const first = vi;
        for (const [x, y] of c.shape) put(cx + (x - cx) * k, cy + (y - cy) * k);
        const n = c.shape.length;
        for (let i = 0; i < n; i++) {
          index[ti++] = center; index[ti++] = first + i; index[ti++] = first + ((i + 1) % n);
        }
        this.count[c.id] = n + 1;
        // 輪郭線(タイルの模様)
        for (let i = 0; i < n; i++) {
          const a = c.shape[i], b = c.shape[(i + 1) % n];
          linePts.push(space.point(a[0], a[1], 0.01), space.point(b[0], b[1], 0.01));
        }
      }
      // 待機中の色: 模様が見えるよう種類と場所で少しずつ変える
      this.baseColor = cells.map((c) => {
        const col0 = this.colors.idle.clone();
        const hsl = {};
        col0.getHSL(hsl);
        const tone = c.kind === 'petal' ? 1.25 : c.kind === 'face' ? 0.75 : 1;
        const hue = hsl.h + 0.035 * Math.sin(c.position.y * 0.05) + 0.02 * Math.sin((c.position.x / topology.Lx) * Math.PI * 2 * 3);
        return new THREE.Color().setHSL(hue, hsl.s, clamp(hsl.l * tone, 0, 1));
      });
      this.disp = new Float32Array(cells.length * 4); // r, g, b, lift(表示中の値)
      cells.forEach((c, i) => {
        const b = this.baseColor[i];
        this.disp.set([b.r, b.g, b.b, 0], i * 4);
      });

      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      g.setIndex(new THREE.BufferAttribute(index, 1));
      this.base = base;
      this.nrm = nrm;
      this.geometry = g;
      this.mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));
      this.scene.add(this.mesh);

      const lg = new THREE.BufferGeometry().setFromPoints(linePts);
      this.lines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0x6f8cff, transparent: true, opacity: 0.32 }));
      this.scene.add(this.lines);

      for (let i = 0; i < cells.length; i++) this._write(i);
      g.attributes.color.needsUpdate = true;
    }

    dispose() {
      if (!this.mesh) return;
      this.scene.remove(this.mesh, this.lines);
      this.mesh.geometry.dispose(); this.mesh.material.dispose();
      this.lines.geometry.dispose(); this.lines.material.dispose();
      this.mesh = null;
      this.dirty.clear();
    }

    markDirty(ids) { for (const id of ids) this.dirty.add(id); }

    setHover(id) {
      if (id === this.hover) return;
      if (this.hover >= 0) this.dirty.add(this.hover);
      this.hover = id;
      if (id >= 0) this.dirty.add(id);
    }

    // 一瞬強く光らせる(種まき・着地の瞬間)
    flash(id, amount = 3) {
      const d = this.disp;
      d[id * 4] = d[id * 4 + 1] = d[id * 4 + 2] = amount;
      d[id * 4 + 3] = 0.5;
      this.dirty.add(id);
    }

    _target(id, cell) {
      const look = LOOK[cell.state];
      let c;
      if (cell.state === TL.ST.IDLE) c = this.baseColor[id];
      else c = this.colors[look.key];
      let k = look.k, lift = look.lift;
      if (id === this.hover) { k += 0.35; lift += 0.06; }
      return [c.r * k, c.g * k, c.b * k, lift];
    }

    _write(i) {
      const d = this.disp, col = this.geometry.attributes.color.array, pos = this.geometry.attributes.position.array;
      const s = this.start[i], n = this.count[i];
      const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2], lift = d[i * 4 + 3];
      for (let k = s; k < s + n; k++) {
        col[k * 3] = r; col[k * 3 + 1] = g; col[k * 3 + 2] = b;
        pos[k * 3] = this.base[k * 3] + this.nrm[k * 2] * lift;
        pos[k * 3 + 1] = this.base[k * 3 + 1] + this.nrm[k * 2 + 1] * lift;
      }
    }

    update(dt, caCells) {
      if (!this.mesh || !this.dirty.size) return;
      const kc = 1 - Math.exp(-dt / 0.12), kl = 1 - Math.exp(-dt / 0.18);
      const d = this.disp;
      for (const i of this.dirty) {
        const t = this._target(i, caCells[i]);
        let done = true;
        for (let k = 0; k < 4; k++) {
          const j = i * 4 + k;
          d[j] += (t[k] - d[j]) * (k === 3 ? kl : kc);
          if (Math.abs(t[k] - d[j]) > 0.004) done = false;
        }
        this._write(i);
        if (done) this.dirty.delete(i);
      }
      this.geometry.attributes.color.needsUpdate = true;
      this.geometry.attributes.position.needsUpdate = true;
    }
  }

  TL.TileMesh = TileMesh;
})(window.TL = window.TL || {});
