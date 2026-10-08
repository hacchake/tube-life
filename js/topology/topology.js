// Topology: セルの形と「つながり」(neighbor graph)。CA にも 3D 表示にも依存しない。
//
// 平面座標 (x, y) で作る。x は周方向で 0..Lx が周期的につながり(チューブを一周する)、
// y は長さ方向で 0..Ly。トーラスの時だけ y も周期的につながる(periodicY)。
// 表示側(world/space.js)がこの平面を円筒・曲がったチューブ・トーラスに巻き付ける。
//
// 各セル: { id, position: {x, y}, kind, shape: [[x,y]...](平面上の輪郭), neighbors: [id...], tone?, circle? }
// 新しい格子は TL.Topology.register(id, name, builder) で追加できる。
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

  const wrap = (v, L) => ((v % L) + L) % L;

  class Topology {
    constructor(type, Lx, Ly, periodicY = false) {
      this.type = type;
      this.Lx = Lx;
      this.Ly = Ly;
      this.periodicY = periodicY;
      this.cells = [];
      this.centers = []; // Flower of Life の円の中心など、格子の基準点
    }

    // 行の数を決める。周期的な時は偶数にして、行の間隔で Ly をぴったり割り切る(継ぎ目を作らない)。
    rowsFor(rowH) {
      if (!this.periodicY) return Math.floor(this.Ly / rowH);
      const rows = Math.max(2, Math.round(this.Ly / rowH / 2) * 2);
      this.Ly = rows * rowH;
      return rows;
    }

    add(kind, x, y, relShape, extra) {
      const px = wrap(x, this.Lx);
      const py = this.periodicY ? wrap(y, this.Ly) : y;
      const cell = Object.assign({
        id: this.cells.length,
        kind,
        position: { x: px, y: py },
        shape: relShape.map(([dx, dy]) => [px + dx, py + dy]),
        neighbors: [],
      }, extra);
      this.cells.push(cell);
      return cell;
    }

    // 周方向は周期的、長さ方向は periodicY の時だけ周期的な差分
    delta(a, b) {
      let dx = b.position.x - a.position.x;
      dx -= this.Lx * Math.round(dx / this.Lx);
      let dy = b.position.y - a.position.y;
      if (this.periodicY) dy -= this.Ly * Math.round(dy / this.Ly);
      return [dx, dy];
    }

    // 種類の組ごとの最大距離で近傍をつなぐ(バケットで高速化)
    link(thr) {
      const cells = this.cells;
      let maxThr = 0;
      const kinds = [...new Set(cells.map((c) => c.kind))];
      for (const a of kinds) for (const b of kinds) maxThr = Math.max(maxThr, thr(a, b));
      const nbx = Math.max(1, Math.floor(this.Lx / maxThr));
      const nby = this.periodicY ? Math.max(1, Math.floor(this.Ly / maxThr)) : 0;
      const bx = (x) => Math.floor(x / (this.Lx / nbx)) % nbx;
      const by = (y) => (nby ? Math.floor(y / (this.Ly / nby)) % nby : Math.floor(y / maxThr));
      const buckets = new Map();
      for (const c of cells) {
        c._b = [bx(c.position.x), by(c.position.y)];
        const k = c._b[0] + ',' + c._b[1];
        if (!buckets.has(k)) buckets.set(k, []);
        buckets.get(k).push(c);
      }
      for (const a of cells) {
        const seen = new Set();
        for (let ox = -1; ox <= 1; ox++) {
          for (let oy = -1; oy <= 1; oy++) {
            const ky = nby ? (a._b[1] + oy + nby) % nby : a._b[1] + oy;
            const list = buckets.get(((a._b[0] + ox + nbx) % nbx) + ',' + ky);
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

    // 輪郭の点を共有するセル同士をつなぐ(形が複雑なタイル用)。
    // 隣り合うタイルは境界の点をまったく同じ位置に持つように作ってあるので、量子化して突き合わせる。
    // minShared = 1 なら角を共有するだけでも隣、2 なら辺を共有する時だけ隣。
    linkByVertices(quantum, minShared = 1) {
      const nq = Math.max(1, Math.round(this.Lx / quantum));
      const q = this.Lx / nq;
      const ny = this.periodicY ? Math.max(1, Math.round(this.Ly / q)) : 0;
      const qy = ny ? this.Ly / ny : q;
      const map = new Map();
      const all = this.cells.map((c) => {
        const keys = new Set();
        for (const [x, y] of c.shape) {
          const kx = wrap(Math.round(x / q), nq);
          let ky = Math.round(y / qy);
          if (ny) ky = wrap(ky, ny);
          keys.add(kx + ',' + ky);
        }
        for (const k of keys) { if (!map.has(k)) map.set(k, []); map.get(k).push(c.id); }
        return keys;
      });
      this.cells.forEach((c, i) => {
        const count = new Map();
        for (const k of all[i]) for (const id of map.get(k)) if (id !== c.id) count.set(id, (count.get(id) || 0) + 1);
        c.neighbors = [...count].filter(([, n]) => n >= minShared).map(([id]) => id);
      });
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
      const { size, sizeY, nbx, nby, map } = this._index;
      x = wrap(x, this.Lx);
      if (this.periodicY) y = wrap(y, this.Ly);
      const bx = Math.floor(x / size), by = Math.floor(y / sizeY);
      let best = null, bd = Infinity;
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          const ky = nby ? wrap(by + oy, nby) : by + oy;
          const list = map.get(wrap(bx + ox, nbx) + ',' + ky);
          if (!list) continue;
          for (const c of list) {
            let dx = x - c.position.x;
            dx -= this.Lx * Math.round(dx / this.Lx);
            let dy = y - c.position.y;
            if (this.periodicY) dy -= this.Ly * Math.round(dy / this.Ly);
            // 輪郭はセル中心の近くで連続しているので、そちらへ寄せて判定
            if (inPolygon(c.shape, c.position.x + dx, c.position.y + dy)) return c;
            const d = dx * dx + dy * dy;
            if (d < bd) { bd = d; best = c; }
          }
        }
      }
      return best;
    }

    _buildIndex() {
      const size0 = this.cellSize || this.Lx / 24;
      const nbx = Math.max(1, Math.floor(this.Lx / size0));
      const size = this.Lx / nbx;
      const nby = this.periodicY ? Math.max(1, Math.floor(this.Ly / size0)) : 0;
      const sizeY = nby ? this.Ly / nby : size;
      const map = new Map();
      for (const c of this.cells) {
        const ky = nby ? Math.floor(c.position.y / sizeY) % nby : Math.floor(c.position.y / sizeY);
        const k = (Math.floor(c.position.x / size) % nbx) + ',' + ky;
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(c);
      }
      this._index = { size, sizeY, nbx, nby, map };
    }

    // 平面上の点に最も近いセル
    nearest(x, y) {
      let best = null, bd = Infinity;
      for (const c of this.cells) {
        let dx = c.position.x - x;
        dx -= this.Lx * Math.round(dx / this.Lx);
        let dy = c.position.y - y;
        if (this.periodicY) dy -= this.Ly * Math.round(dy / this.Ly);
        const d = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = c; }
      }
      return best;
    }

    static register(id, name, builder) {
      builders[id] = builder;
      META.push({ id, name });
    }

    // around: 周方向の基準格子点の数(細かさ)、opts.periodicY: 長さ方向もつなぐ(トーラス)
    static build(type, Lx, Ly, around, opts = {}) {
      const b = builders[type] || builders.flower;
      return b(Lx, Ly, around, opts);
    }

    static get types() { return META; }
  }

  // ---------- 三角格子の共通部品 ----------
  // 格子点 p(i, j) と、各点から右・右下・左下へ伸びる辺、2 つの三角形を返す
  function triLattice(T, around, periodic, fn) {
    const s = T.Lx / around;
    const h = (s * S3) / 2;
    const rows = T.rowsFor(h);
    T.cellSize = s;
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < around; i++) {
        const px = (i + 0.5 * (j & 1)) * s, py = (j + 0.5) * h;
        fn(px, py, j + 1 < rows || periodic, s, h);
      }
    }
  }

  const lensOf = (v, h, steps) => {
    const O = [-v[0] / 2, -v[1] / 2], P = [v[0] / 2, v[1] / 2];
    const len = Math.hypot(v[0], v[1]);
    const n = [(-v[1] / len) * h, (v[0] / len) * h];
    return { O, P, Q: n, R: [-n[0], -n[1]], steps };
  };
  // 曲線三角形(三角形 A,B,C の内側に残る部分)。各辺は向こう側の格子点を中心とする円弧。
  const faceOf = (A, B, C, steps) => {
    const g = [(A[0] + B[0] + C[0]) / 3, (A[1] + B[1] + C[1]) / 3];
    const rel = (p) => [p[0] - g[0], p[1] - g[1]];
    const [a, b, c] = [rel(A), rel(B), rel(C)];
    const opp = (p, q, r) => [p[0] + q[0] - r[0], p[1] + q[1] - r[1]];
    return { g, a, b, c, ab: arc(opp(a, b, c), a, b, steps), bc: arc(opp(b, c, a), b, c, steps), ca: arc(opp(c, a, b), c, a, steps) };
  };

  // ---------- Flower of Life ----------
  // 三角格子の各点(円の中心)に半径 s の円。円が作る「花びら」(格子の辺ごと)と
  // 「曲線三角形」(格子の三角形ごと)がセル。近傍はどちらも 6。
  Topology.register('flower', 'Flower of Life', (Lx, Ly, around, opts) => {
    const T = new Topology('flower', Lx, Ly, !!opts.periodicY);
    let petal, f1, f2, s0;
    triLattice(T, around, T.periodicY, (px, py, down, s, h) => {
      if (!petal) {
        s0 = s;
        const E = [s, 0], SE = [s / 2, h], SW = [-s / 2, h];
        const lens = (v) => { const L = lensOf(v, h); return [L.O].concat(arc(L.R, L.O, L.P, 8), arc(L.Q, L.P, L.O, 8).slice(0, -1)); };
        const face = (A, B, C) => { const f = faceOf(A, B, C, 6); return { g: f.g, pts: [f.a].concat(f.ab, f.bc, f.ca.slice(0, -1)) }; };
        petal = { E: [E, lens(E)], SE: [SE, lens(SE)], SW: [SW, lens(SW)] };
        f1 = face([0, 0], E, SE); f2 = face([0, 0], SE, SW);
      }
      const circle = T.centers.length;
      T.centers.push({ id: circle, x: px, y: py });
      T.add('petal', px + petal.E[0][0] / 2, py, petal.E[1], { circle });
      if (!down) return; // 下の列が無い所は花びら・三角形を作らない
      T.add('petal', px + petal.SE[0][0] / 2, py + petal.SE[0][1] / 2, petal.SE[1], { circle });
      T.add('petal', px + petal.SW[0][0] / 2, py + petal.SW[0][1] / 2, petal.SW[1], { circle });
      T.add('face', px + f1.g[0], py + f1.g[1], f1.pts, { circle });
      T.add('face', px + f2.g[0], py + f2.g[1], f2.pts, { circle });
    });
    T.link((a, b) => (a === 'petal' && b === 'petal' ? 0.55 * s0 : a === 'face' && b === 'face' ? 0.6 * s0 : 0.35 * s0));
    T.lifeRule = 'B2/S23';
    return T;
  });

  // ---------- Flower of Life(重層)----------
  // 花びらを中心線で 2 つに、曲線三角形を中心から 3 つに分けた、より細かい構造。
  // 向きごとに塗り分けるので、円の重なりの中に星形や六芒星の模様が浮かぶ。辺を共有するセル同士が隣。
  Topology.register('flower-deep', 'Flower of Life(重層)', (Lx, Ly, around, opts) => {
    const T = new Topology('flower-deep', Lx, Ly, !!opts.periodicY);
    let parts;
    triLattice(T, around, T.periodicY, (px, py, down, s, h) => {
      if (!parts) {
        const E = [s, 0], SE = [s / 2, h], SW = [-s / 2, h];
        const halves = (v, dir) => {
          const L = lensOf(v, h);
          // 2 つの半分: 片側の弧 + 中心線(弦)
          return [
            { c: [0, 0], pts: [L.O].concat(arc(L.R, L.O, L.P, 8)), tone: dir },
            { c: [0, 0], pts: [L.P].concat(arc(L.Q, L.P, L.O, 8)), tone: dir },
          ];
        };
        const pieces = (A, B, C, base) => {
          const f = faceOf(A, B, C, 8);
          return [
            { c: f.g, pts: [[0, 0], f.a].concat(f.ab), tone: base },
            { c: f.g, pts: [[0, 0], f.b].concat(f.bc), tone: (base + 1) % 3 },
            { c: f.g, pts: [[0, 0], f.c].concat(f.ca), tone: (base + 2) % 3 },
          ];
        };
        parts = {
          petals: [[E, halves(E, 0)], [SE, halves(SE, 1)], [SW, halves(SW, 2)]],
          faces: pieces([0, 0], E, SE, 0).concat(pieces([0, 0], SE, SW, 1)),
        };
      }
      const circle = T.centers.length;
      T.centers.push({ id: circle, x: px, y: py });
      parts.petals.forEach(([v, hs], k) => {
        if (k > 0 && !down) return;
        for (const hf of hs) {
          // 半分のセルの中心は、その形の重心に置く
          const cx = hf.pts.reduce((a, p) => a + p[0], 0) / hf.pts.length, cy = hf.pts.reduce((a, p) => a + p[1], 0) / hf.pts.length;
          T.add('half', px + v[0] / 2 + cx, py + v[1] / 2 + cy, hf.pts.map(([x, y]) => [x - cx, y - cy]), { circle, tone: hf.tone });
        }
      });
      if (!down) return;
      for (const pc of parts.faces) {
        // 小片は弧が内側へ凹んでいるので、点の平均ではなく「中心と弧の中点の間」を中心にする(必ず形の内側)
        const mid = pc.pts[2 + Math.floor((pc.pts.length - 2) / 2)];
        const cx = mid[0] * 0.45, cy = mid[1] * 0.45;
        T.add('piece', px + pc.c[0] + cx, py + pc.c[1] + cy, pc.pts.map(([x, y]) => [x - cx, y - cy]), { circle, tone: pc.tone });
      }
    });
    T.linkByVertices(T.cellSize * 0.01, 2);
    T.waveEnergy = 11; // 隣が少ない(3〜5)ので、波が十分広がるよう生命力を多めに
    T.lifeRule = 'B23/S34';
    return T;
  });

  // ---------- 六角形 ----------
  Topology.register('hex', 'Hex', (Lx, Ly, around, opts) => {
    const T = new Topology('hex', Lx, Ly, !!opts.periodicY);
    const s = Lx / around;
    const h = (s * S3) / 2;
    const rows = T.rowsFor(h);
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
    T.lifeRule = 'B25/S34';
    return T;
  });

  // ---------- 三角形 ----------
  // 三角格子の上向き・下向きの三角形がセル。角を共有する三角形まで隣(近傍 12)。
  Topology.register('triangle', 'Triangle', (Lx, Ly, around, opts) => {
    const T = new Topology('triangle', Lx, Ly, !!opts.periodicY);
    triLattice(T, Math.round(around * 1.25), T.periodicY, (px, py, down, s, h) => {
      if (!down) return;
      const tris = [[[0, 0], [s, 0], [s / 2, h]], [[0, 0], [s / 2, h], [-s / 2, h]]];
      tris.forEach((tri, k) => {
        const g = [(tri[0][0] + tri[1][0] + tri[2][0]) / 3, (tri[0][1] + tri[1][1] + tri[2][1]) / 3];
        T.add('tri', px + g[0], py + g[1], tri.map(([x, y]) => [x - g[0], y - g[1]]), { tone: k });
      });
    });
    T.linkByVertices(T.cellSize * 0.02, 1);
    T.lifeRule = 'B45/S236';
    return T;
  });

  TL.Topology = Topology;
})(window.TL = window.TL || {});
