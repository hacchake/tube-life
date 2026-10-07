// 空間: Topology の平面 (x = 周方向, y = 長さ方向) を 3D の壁面に巻き付ける。
//
// 共通インターフェース(曲がったチューブ・分岐・トーラス等もこれを実装すれば差し替えられる):
//   point(x, y, h, out)   平面座標と壁からの高さ h(内側が正)→ 3D 位置
//   frame(x, y)           { pos, normal(内向き), tu(周方向), tv(長さ方向) }
//   raycastWall(ray)      視線と内壁の交点の平面座標 { x, y, point } または null
//   clampInside(pos)      カメラが壁の外に出ないようにする
(function (TL) {
  'use strict';

  class CylinderSpace {
    constructor(radius, length) {
      this.R = radius;
      this.L = length;
      this.C = 2 * Math.PI * radius; // 周の長さ = 平面の Lx
    }

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

    // 3D 位置 → 平面座標
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

    clampInside(pos, margin = 1.2) {
      const r = Math.hypot(pos.x, pos.y), max = this.R - margin;
      if (r > max) { pos.x *= max / r; pos.y *= max / r; }
      pos.z = TL.util.clamp(pos.z, 2, this.L - 2);
      return pos;
    }
  }

  TL.CylinderSpace = CylinderSpace;
})(window.TL = window.TL || {});
