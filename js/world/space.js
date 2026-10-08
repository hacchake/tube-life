// 空間: Topology の平面 (x = 周方向, y = 長さ方向) を 3D の壁面に巻き付ける。
//
// 共通インターフェース(どの空間もこれを実装すれば、タイル・生物・クリック判定・カメラがそのまま動く):
//   point(x, y, h, out)   平面座標と壁からの高さ h(内側が正)→ 3D 位置
//   frame(x, y)           { pos, normal(内向き), tu(周方向), tv(長さ方向) }
//   toPlane(p)            3D 位置 → { x, y, h }
//   raycastWall(ray)      視線と内壁の交点の平面座標 { x, y, point } または null
//   clampInside(pos)      カメラが壁の外に出ないようにする
//   toAxis(pos)           その位置からチューブの中心線へ向かう単位ベクトル(生物の「背」の向き)
//   tangentAt(y)          長さ方向の向き(カメラが漂う向き)
//   startPose()           カメラの最初の位置と向き
//   periodicY             長さ方向も周期的か(トーラスの時だけ true)
//
//   CylinderSpace : まっすぐな円筒(計算は全部式で解ける)
//   SpineSpace    : 中心線(スパイン)に沿って枠を運ぶ汎用のチューブ(曲がったチューブ・トーラス)
(function (TL) {
  'use strict';
  const { clamp } = TL.util;

  class CylinderSpace {
    constructor(radius, length) {
      this.kind = 'cylinder';
      this.R = radius;
      this.L = length;
      this.C = 2 * Math.PI * radius; // 周の長さ = 平面の Lx
    }

    get periodicY() { return false; }

    point(x, y, h = 0, out = new THREE.Vector3()) {
      const t = (x / this.C) * 2 * Math.PI, r = this.R - h;
      return out.set(r * Math.cos(t), r * Math.sin(t), y);
    }

    frame(x, y) {
      const t = (x / this.C) * 2 * Math.PI;
      const c = Math.cos(t), s = Math.sin(t);
      return {
        pos: new THREE.Vector3(this.R * c, this.R * s, y),
        normal: new THREE.Vector3(-c, -s, 0),
        tu: new THREE.Vector3(-s, c, 0),
        tv: new THREE.Vector3(0, 0, 1),
      };
    }

    toPlane(p) {
      let t = Math.atan2(p.y, p.x);
      if (t < 0) t += 2 * Math.PI;
      return { x: (t / (2 * Math.PI)) * this.C, y: p.z, h: this.R - Math.hypot(p.x, p.y) };
    }

    // 円筒の内側にいるカメラからの視線と壁の交点(xy 平面上で円との交点を解く)
    raycastWall(ray) {
      const o = ray.origin, d = ray.direction;
      const a = d.x * d.x + d.y * d.y;
      if (a < 1e-9) return null;
      const b = 2 * (o.x * d.x + o.y * d.y);
      const c = o.x * o.x + o.y * o.y - this.R * this.R;
      const disc = b * b - 4 * a * c;
      if (disc < 0) return null;
      const t = (-b + Math.sqrt(disc)) / (2 * a); // 内側からなので遠い方の解
      if (t <= 0) return null;
      const point = o.clone().addScaledVector(d, t);
      if (point.z < 0 || point.z > this.L) return null;
      return Object.assign(this.toPlane(point), { point });
    }

    toAxis(pos, out = new THREE.Vector3()) {
      out.set(-pos.x, -pos.y, 0);
      if (out.lengthSq() < 1e-8) out.set(0, 1, 0);
      return out.normalize();
    }

    tangentAt() { return new THREE.Vector3(0, 0, 1); }

    startPose() { return { pos: new THREE.Vector3(0, -2.5, 10), dir: new THREE.Vector3(0, 0, 1) }; }

    clampInside(pos, margin = 1.2) {
      const r = Math.hypot(pos.x, pos.y), max = this.R - margin;
      if (r > max) { pos.x *= max / r; pos.y *= max / r; }
      pos.z = clamp(pos.z, 2, this.L - 2);
      return pos;
    }
  }

  // 中心線に沿って「平行移動」で枠(N, B)を運ぶチューブ。kind = 'curve'(うねるチューブ)/ 'torus'(輪)
  // curveFn(u) を渡すと、その曲線を中心線にする(分岐の幹・枝など)。n0 は最初の枠の向き。
  class SpineSpace {
    constructor(radius, length, kind, curveFn = null, n0 = null) {
      this.kind = kind;
      this.R = radius;
      this.L = length;
      this.C = 2 * Math.PI * radius;
      this.M = curveFn ? 500 : 900;
      this.curveFn = curveFn;
      this.n0 = n0;
      this._build();
      this._hint = 0;
    }

    get periodicY() { return this.kind === 'torus'; }

    _build() {
      const M = this.M, L = this.L;
      const P = [];
      if (this.kind === 'torus') {
        // 半径 Rm の輪(XZ 平面)。y = 0 で原点、+Z 向きに出発する
        const Rm = L / (2 * Math.PI);
        for (let i = 0; i < M; i++) {
          const a = (i / M) * 2 * Math.PI;
          P.push(new THREE.Vector3(Rm * Math.cos(a) - Rm, 0, Rm * Math.sin(a)));
        }
      } else {
        // うねるチューブ: 曲線を細かく作ってから、長さ方向に等間隔(弧長)で取り直す
        const curve = this.curveFn || ((u) => new THREE.Vector3(11 * Math.sin(u * 0.052), 7 * Math.sin(u * 0.037 + 0.8) - 7 * Math.sin(0.8), u));
        const fine = [];
        let len = 0, prev = curve(0);
        for (let u = 0; len < L * 1.02; u += 0.05) {
          const p = curve(u);
          len += p.distanceTo(prev);
          fine.push([len, p]);
          prev = p;
        }
        let k = 0;
        for (let i = 0; i < M; i++) {
          const s = (i / (M - 1)) * L;
          while (k < fine.length - 2 && fine[k + 1][0] < s) k++;
          const [l0, p0] = fine[k], [l1, p1] = fine[k + 1];
          P.push(p0.clone().lerp(p1, clamp((s - l0) / (l1 - l0 || 1), 0, 1)));
        }
      }
      this.P = P;
      this.step = this.periodicY ? L / M : L / (M - 1);
      // 接線と、ねじれない枠(平行移動)
      const T = P.map((_, i) => {
        const a = P[this.periodicY ? (i - 1 + M) % M : Math.max(0, i - 1)], b = P[this.periodicY ? (i + 1) % M : Math.min(M - 1, i + 1)];
        return b.clone().sub(a).normalize();
      });
      const N = [], B = [];
      const n = this.n0 ? this.n0.clone() : new THREE.Vector3(1, 0, 0);
      for (let i = 0; i < M; i++) {
        n.addScaledVector(T[i], -n.dot(T[i])).normalize();
        N.push(n.clone());
        B.push(new THREE.Vector3().crossVectors(T[i], n));
      }
      this.T = T; this.N = N; this.B = B;
    }

    // 長さ方向の位置 y の枠(サンプルの間は線形補間)
    _at(y) {
      const M = this.M;
      let f = y / this.step;
      if (this.periodicY) f = ((f % M) + M) % M;
      else f = clamp(f, 0, M - 1);
      const i = Math.min(M - 1, Math.floor(f)), j = this.periodicY ? (i + 1) % M : Math.min(M - 1, i + 1), t = f - i;
      const lerp = (arr) => arr[i].clone().lerp(arr[j], t);
      const P = lerp(this.P);
      if (!this.periodicY && (y < 0 || y > this.L)) P.addScaledVector(this.T[i], y < 0 ? y : y - this.L); // 端の外は真っすぐ延長
      const T = lerp(this.T).normalize();
      const N = lerp(this.N); N.addScaledVector(T, -N.dot(T)).normalize();
      const B = new THREE.Vector3().crossVectors(T, N);
      return { P, T, N, B };
    }

    point(x, y, h = 0, out = new THREE.Vector3()) {
      const t = (x / this.C) * 2 * Math.PI, s = this._at(y), r = this.R - h;
      return out.copy(s.P).addScaledVector(s.N, r * Math.cos(t)).addScaledVector(s.B, r * Math.sin(t));
    }

    frame(x, y) {
      const t = (x / this.C) * 2 * Math.PI, s = this._at(y);
      const c = Math.cos(t), si = Math.sin(t);
      const radial = s.N.clone().multiplyScalar(c).addScaledVector(s.B, si);
      return {
        pos: s.P.clone().addScaledVector(radial, this.R),
        normal: radial.clone().negate(),
        tu: s.N.clone().multiplyScalar(-si).addScaledVector(s.B, c),
        tv: s.T.clone(),
      };
    }

    // 3D 位置に一番近い中心線上の位置 y(直前の答えの近くから探すと速い)
    _nearestY(p, hint) {
      const M = this.M;
      let best = 0, bd = Infinity;
      const scan = (from, to) => {
        for (let k = from; k <= to; k++) {
          const i = this.periodicY ? ((k % M) + M) % M : clamp(k, 0, M - 1);
          const d = this.P[i].distanceToSquared(p);
          if (d < bd) { bd = d; best = i; }
        }
      };
      if (hint !== undefined) scan(Math.round(hint / this.step) - 40, Math.round(hint / this.step) + 40);
      if (hint === undefined || bd > (this.R * 1.6) ** 2) { bd = Infinity; scan(0, M - 1); }
      // 隣のサンプルとの間で細かく合わせる
      const along = p.clone().sub(this.P[best]).dot(this.T[best]);
      let y = best * this.step + clamp(along, -this.step, this.step);
      if (this.periodicY) y = ((y % this.L) + this.L) % this.L;
      return y;
    }

    toPlane(p, hint) {
      const y = this._nearestY(p, hint);
      const s = this._at(y);
      const d = p.clone().sub(s.P);
      d.addScaledVector(s.T, -d.dot(s.T));
      let t = Math.atan2(d.dot(s.B), d.dot(s.N));
      if (t < 0) t += 2 * Math.PI;
      return { x: (t / (2 * Math.PI)) * this.C, y, h: this.R - d.length() };
    }

    // 視線を少しずつ進め、中心線からの距離が半径を超えた所を二分探索で詰める
    raycastWall(ray) {
      const o = ray.origin, d = ray.direction;
      let hint = this._nearestY(o, this._hint);
      this._hint = hint;
      const p = new THREE.Vector3();
      const inside = (t) => {
        p.copy(o).addScaledVector(d, t);
        const pl = this.toPlane(p, hint);
        hint = pl.y;
        return pl.h > 0;
      };
      let prev = 0;
      for (let t = 0.25; t < 160; t += 0.25) {
        if (inside(t)) { prev = t; continue; }
        let a = prev, b = t;
        for (let k = 0; k < 14; k++) { const m = (a + b) / 2; if (inside(m)) a = m; else b = m; }
        const point = o.clone().addScaledVector(d, (a + b) / 2);
        const pl = this.toPlane(point, hint);
        if (!this.periodicY && (pl.y < 0 || pl.y > this.L)) return null;
        return Object.assign(pl, { point });
      }
      return null;
    }

    toAxis(pos, out = new THREE.Vector3()) {
      const s = this._at(this._nearestY(pos, this._hint));
      out.copy(s.P).sub(pos);
      out.addScaledVector(s.T, -out.dot(s.T));
      if (out.lengthSq() < 1e-8) out.copy(s.B);
      return out.normalize();
    }

    tangentAt(y) { return this._at(y).T; }

    startPose() {
      const s = this._at(10);
      return { pos: s.P.clone().addScaledVector(s.B, -2.5), dir: s.T.clone() };
    }

    clampInside(pos, margin = 1.2) {
      let y = this._nearestY(pos, this._camHint);
      if (!this.periodicY) y = clamp(y, 2, this.L - 2);
      this._camHint = y;
      const s = this._at(y);
      const rel = pos.clone().sub(s.P);
      const along = rel.dot(s.T);
      const d = rel.addScaledVector(s.T, -along); // 中心線から見た横方向のずれ
      const max = this.R - margin;
      if (d.length() > max) d.setLength(max);
      const keep = this.periodicY ? along : clamp(along, -0.5, 0.5); // 端では先へ進めない
      return pos.copy(s.P).add(d).addScaledVector(s.T, keep);
    }
  }

  const SPACES = [
    { id: 'cylinder', name: '円筒' },
    { id: 'curve', name: '曲がったチューブ' },
    { id: 'torus', name: 'トーラス' },
    { id: 'branch', name: '分岐(Y字)' },
  ];

  TL.CylinderSpace = CylinderSpace;
  TL.SpineSpace = SpineSpace;
  TL.SPACES = SPACES;
  TL.makeSpace = (kind, radius, length) => {
    if (kind === 'branch') return new TL.BranchSpace(radius);
    if (kind === 'cylinder' || !kind) return new CylinderSpace(radius, length);
    return new SpineSpace(radius, length, kind);
  };
})(window.TL = window.TL || {});
