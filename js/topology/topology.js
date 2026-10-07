// Topology: セルの形と「つながり」(neighbor graph)。CA にも 3D 表示にも依存しない。
//
// 平面座標 (x, y) で作る。x は周方向で 0..Lx が周期的につながり(チューブを一周する)、
// y は長さ方向で 0..Ly(つながらない)。表示側(world/space.js)がこの平面を円筒などに巻き付ける。
//
// 各セル: { id, position: {x, y}, kind, shape: [[x,y]...](平面上の輪郭), neighbors: [id...], circle }
// 新しい格子は TL.Topology.register(id, builder) で追加できる(Square / Triangle / Escher / Custom など)。
(function (TL) {
  'use strict';

  const S3 = Math.sqrt(3);
  const builders = {};
  const META = [];

  // 円(中心 c)上を A から B まで短い方の弧で辿る点列(A は含めず B は含む)
  function arc(c, a, b, steps) {
    const r = Math.hypot(a[0] - c[0], a[1] - c[1]);
    const a0 = Math.atan2(a[1] - c[1], a[0] - c[0]);
    let d = Math.atan2(b[1] - c[1], b[0] - c[0]) - a0;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    const out = [];
    for (let k = 1; k <= steps; k++) {
      const t = a0 + (d * k) / steps;
      out.push([c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)]);
    }
    return out;
  }

  function inPolygon(pts, x, y) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i], [xj, yj] = pts[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  class Topology {
    constructor(type, Lx, Ly) {
      this.type = type;
      this.Lx = Lx;
      this.Ly = Ly;
      this.cells = [];
      this.centers = []; // Flower of Life の円の中心など、格子の基準点
    }

    add(kind, x, y, relShape, extra) {
      const px = ((x % this.Lx) + this.Lx) % this.Lx;
      const cell = Object.assign({
        id: this.cells.length,
        kind,
        position: { x: px, y },
        shape: relShape.map(([dx, dy]) => [px + dx, y + dy]),
        neighbors: [],
      }, extra);
      this.cells.push(cell);
      return cell;
    }

    // 周方向は周期的、長さ方向はつながらない差分
    delta(a, b) {
      let dx = b.position.x - a.position.x;
      dx -= this.Lx * Math.round(dx / this.Lx);
      return [dx, b.position.y - a.position.y];
    }

    // 種類の組ごとの最大距離で近傍をつなぐ(バケットで高速化)
    link(thr) {
      const cells = this.cells;
      let maxThr = 0;
      const kinds = [...new Set(cells.map((c) => c.kind))];
      for (const a of kinds) for (const b of kinds) maxThr = Math.max(maxThr, thr(a, b));
      const bs = maxThr;
      const nbx = Math.max(1, Math.floor(this.Lx / bs));
      const buckets = new Map();
      const key = (bx, by) => bx + ',' + by;
      for (const c of cells) {
        const bx = Math.floor(c.position.x / (this.Lx / nbx)) % nbx, by = Math.floor(c.position.y / bs);
        c._b = [bx, by];
        const k = key(bx, by);
        if (!buckets.has(k)) buckets.set(k, []);
        buckets.get(k).push(c);
      }
      for (const a of cells) {
        const seen = new Set();
        for (let ox = -1; ox <= 1; ox++) {
          for (let oy = -1; oy <= 1; oy++) {
            const list = buckets.get(key((a._b[0] + ox + nbx) % nbx, a._b[1] + oy));
            if (!list) continue;
            for (const b of list) {
              if (b.id <= a.id || seen.has(b.id)) continue;
              seen.add(b.id);
              const t = thr(a.kind, b.kind);
              if (!t) continue;
              const [dx, dy] = this.delta(a, b);
              if (Math.hypot(dx, dy) <= t + 1e-6) { a.neighbors.push(b.id); b.neighbors.push(a.id); }
            }
          }
        }
      }
      for (const c of cells) delete c._b;
    }

    // 中心セルからグラフ距離ごとのリング(0 = 中心, 1 = 第1リング …)
    rings(centerId, n) {
      const out = [[centerId]];
      const seen = new Set([centerId]);
      for (let r = 1; r <= n; r++) {
        const ring = [];
        for (const id of out[r - 1]) {
          for (const nb of this.cells[id].neighbors) if (!seen.has(nb)) { seen.add(nb); ring.push(nb); }
        }
        out.push(ring);
      }
      return out;
    }

    // 平面上の点を含むセル(輪郭の内外判定)。見つからなければ一番近いセル。
    locate(x, y) {
      if (!this._index) this._buildIndex();
      const { size, nbx, map } = this._index;
      x = ((x % this.Lx) + this.Lx) % this.Lx;
      const bx = Math.floor(x / size), by = Math.floor(y / size);
      let best = null, bd = Infinity;
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          const list = map.get(((bx + ox + nbx) % nbx) + ',' + (by + oy));
          if (!list) continue;
          for (const c of list) {
            let dx = x - c.position.x;
            dx -= this.Lx * Math.round(dx / this.Lx);
            const px = c.position.x + dx; // 輪郭はセル中心の近くで連続しているので、そちらへ寄せて判定
            if (inPolygon(c.shape, px, y)) return c;
            const d = dx * dx + (y - c.position.y) ** 2;
            if (d < bd) { bd = d; best = c; }
          }
        }
      }
      return best;
    }

    _buildIndex() {
      const size = this.cellSize || this.Lx / 24;
      const nbx = Math.max(1, Math.floor(this.Lx / size));
      const real = this.Lx / nbx;
      const map = new Map();
      for (const c of this.cells) {
        const k = (Math.floor(c.position.x / real) % nbx) + ',' + Math.floor(c.position.y / real);
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(c);
      }
      this._index = { size: real, nbx, map };
    }

    // 平面上の点に最も近いセル
    nearest(x, y) {
      let best = null, bd = Infinity;
      for (const c of this.cells) {
        let dx = c.position.x - x;
        dx -= this.Lx * Math.round(dx / this.Lx);
        const d = dx * dx + (c.position.y - y) ** 2;
        if (d < bd) { bd = d; best = c; }
      }
      return best;
    }

    static register(id, name, builder) {
      builders[id] = builder;
      META.push({ id, name });
    }

    // around: 周方向の基準格子点の数(細かさ)
    static build(type, Lx, Ly, around) {
      const b = builders[type] || builders.flower;
      return b(Lx, Ly, around);
    }

    static get types() { return META; }
  }

  // ---------- Flower of Life ----------
  // 三角格子の各点(円の中心)に半径 s の円。円が作る「花びら」(格子の辺ごと)と
  // 「曲線三角形」(格子の三角形ごと)がセル。近傍はどちらも 6。
  Topology.register('flower', 'Flower of Life', (Lx, Ly, around) => {
    const s = Lx / around;
    const h = (s * S3) / 2;
    const rows = Math.floor(Ly / h);
    const T = new Topology('flower', Lx, Ly);
    T.cellSize = s;
    const E = [s, 0], SE = [s / 2, h], SW = [-s / 2, h];

    const lens = (v) => {
      const O = [-v[0] / 2, -v[1] / 2], P = [v[0] / 2, v[1] / 2];
      const len = Math.hypot(v[0], v[1]);
      const n = [(-v[1] / len) * h, (v[0] / len) * h];
      const Q = n, R = [-n[0], -n[1]];
      return [O].concat(arc(R, O, P, 8), arc(Q, P, O, 8).slice(0, -1));
    };
    const face = (A, B, C) => {
      const g = [(A[0] + B[0] + C[0]) / 3, (A[1] + B[1] + C[1]) / 3];
      const rel = (p) => [p[0] - g[0], p[1] - g[1]];
      const [a, b, c] = [rel(A), rel(B), rel(C)];
      const opp = (p, q, r) => [p[0] + q[0] - r[0], p[1] + q[1] - r[1]];
      return { g, pts: [a].concat(arc(opp(a, b, c), a, b, 6), arc(opp(b, c, a), b, c, 6), arc(opp(c, a, b), c, a, 6).slice(0, -1)) };
    };
    const petal = { E: lens(E), SE: lens(SE), SW: lens(SW) };
    const f1 = face([0, 0], E, SE), f2 = face([0, 0], SE, SW);

    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < around; i++) {
        const px = (i + 0.5 * (j & 1)) * s, py = (j + 0.5) * h;
        const circle = T.centers.length;
        T.centers.push({ id: circle, x: px, y: py });
        T.add('petal', px + E[0] / 2, py, petal.E, { circle });
        if (j + 1 >= rows) continue; // 下の列が無い所は花びら・三角形を作らない
        T.add('petal', px + SE[0] / 2, py + SE[1] / 2, petal.SE, { circle });
        T.add('petal', px + SW[0] / 2, py + SW[1] / 2, petal.SW, { circle });
        T.add('face', px + f1.g[0], py + f1.g[1], f1.pts, { circle });
        T.add('face', px + f2.g[0], py + f2.g[1], f2.pts, { circle });
      }
    }
    T.link((a, b) => (a === 'petal' && b === 'petal' ? 0.55 * s : a === 'face' && b === 'face' ? 0.6 * s : 0.35 * s));
    return T;
  });

  // ---------- 六角形 ----------
  Topology.register('hex', 'Hex', (Lx, Ly, around) => {
    const s = Lx / around;
    const h = (s * S3) / 2;
    const rows = Math.floor(Ly / h);
    const T = new Topology('hex', Lx, Ly);
    T.cellSize = s;
    const r = s / S3;
    const shape = [];
    for (let k = 0; k < 6; k++) { const t = -Math.PI / 2 + (k * Math.PI) / 3; shape.push([r * Math.cos(t), r * Math.sin(t)]); }
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < around; i++) {
        const x = (i + 0.5 + 0.5 * (j & 1)) * s, y = (j + 0.5) * h;
        T.centers.push({ id: T.centers.length, x, y });
        T.add('hex', x, y, shape);
      }
    }
    T.link(() => 1.05 * s);
    return T;
  });

  TL.Topology = Topology;
})(window.TL = window.TL || {});
