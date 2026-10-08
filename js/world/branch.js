// 分岐(Y 字)のチューブ: 幹 1 本と枝 2 本。
//
// それぞれは SpineSpace(中心線に沿ったチューブ)で、平面上では長さ方向(y)に積み重ねて 1 枚にする:
//   幹 y ∈ [0, Lt)、枝A y ∈ [oA, oA + Lb)、枝B y ∈ [oB, oB + Lb)(間はすき間)
// 他のチューブの内側に入り込んだタイルは取り除くので、分かれ目に自然な開口ができる。
// 分かれ目付近のタイルは 3D の距離で隣につなぐので、CA の波は幹から枝へ伝わる。
// 生物がチューブをまたぐ時は route() が分かれ目の中心を通る道を返す。
(function (TL) {
  'use strict';
  const { clamp } = TL.util;

  const TRUNK = 82;        // 幹の長さ(分かれ目より少し先まで伸ばして、股の部分を覆う)
  const JUNCTION = 72;     // 幹の上で枝が分かれる位置
  const BRANCH = 78;       // 枝の長さ
  const ANGLE = 0.62;      // 枝の開き(ラジアン)
  const GAP = 20;          // 平面上で積み重ねる時のすき間

  class BranchSpace {
    constructor(radius) {
      this.kind = 'branch';
      this.R = radius;
      this.C = 2 * Math.PI * radius;
      const J = new THREE.Vector3(0, 0, JUNCTION);
      this.J = J;
      const seg = (L, fn, n0) => new TL.SpineSpace(radius, L, 'segment', fn, n0);
      const dir = (s) => new THREE.Vector3(Math.sin(s * ANGLE), 0, Math.cos(s * ANGLE));
      const dA = dir(1), dB = dir(-1);
      this.segs = [
        { name: 'trunk', space: seg(TRUNK, (u) => new THREE.Vector3(0, 0, u)), offset: 0, junctionY: JUNCTION },
        { name: 'branchA', space: seg(BRANCH, (u) => J.clone().addScaledVector(dA, u), new THREE.Vector3(1, 0, 0)), offset: TRUNK + GAP, junctionY: 0 },
        { name: 'branchB', space: seg(BRANCH, (u) => J.clone().addScaledVector(dB, u), new THREE.Vector3(1, 0, 0)), offset: TRUNK + GAP + BRANCH + GAP, junctionY: 0 },
      ];
      this.L = this.segs[2].offset + BRANCH;
    }

    get periodicY() { return false; }

    // 平面の y → どのチューブか
    segOf(y) {
      let best = this.segs[0];
      for (const s of this.segs) if (y >= s.offset - GAP / 2) best = s;
      return best;
    }
    local(y) { const s = this.segOf(y); return [s, clamp(y - s.offset, 0, s.space.L)]; }

    point(x, y, h = 0, out) { const [s, ly] = this.local(y); return s.space.point(x, ly, h, out); }
    frame(x, y) { const [s, ly] = this.local(y); return s.space.frame(x, ly); }
    tangentAt(y) { const [s, ly] = this.local(y); return s.space.tangentAt(ly); }

    // 3D 位置がどのチューブの中にあるか(一番深く入っているもの)
    _inside(p) {
      let best = null;
      for (const s of this.segs) {
        const pl = s.space.toPlane(p, s._hint);
        s._hint = pl.y;
        const along = pl.y > 0.01 && pl.y < s.space.L - 0.01;
        if (!along) continue;
        if (!best || pl.h > best.pl.h) best = { s, pl };
      }
      return best;
    }

    toPlane(p) {
      const b = this._inside(p) || { s: this.segs[0], pl: this.segs[0].space.toPlane(p) };
      return { x: b.pl.x, y: b.pl.y + b.s.offset, h: b.pl.h };
    }

    // ある点が、指定のチューブ以外のどれかの内側にあるか(開口を作るため)
    insideOther(p, self, depth = 0.15) {
      for (const s of this.segs) {
        if (s === self) continue;
        const pl = s.space.toPlane(p);
        if (pl.y > 0.05 && pl.y < s.space.L - 0.05 && pl.h > depth) return true;
      }
      return false;
    }

    // 3 本のチューブを合わせた内部から出る所(= どれかの壁)を探す
    raycastWall(ray) {
      const o = ray.origin, d = ray.direction;
      const p = new THREE.Vector3();
      const inside = (t) => { p.copy(o).addScaledVector(d, t); const b = this._inside(p); return !!b && b.pl.h > 0; };
      let prev = 0;
      for (let t = 0.25; t < 170; t += 0.25) {
        if (inside(t)) { prev = t; continue; }
        let a = prev, b = t;
        for (let k = 0; k < 14; k++) { const m = (a + b) / 2; if (inside(m)) a = m; else b = m; }
        const point = o.clone().addScaledVector(d, a);
        // 当たった壁: 壁に一番近いチューブ(他のチューブの中にある壁は取り除いてあるので見えない)
        let best = null;
        for (const s of this.segs) {
          const pl = s.space.toPlane(point);
          if (pl.y < 0 || pl.y > s.space.L) continue;
          if (this.insideOther(point, s, 0.05)) continue;
          if (!best || Math.abs(pl.h) < Math.abs(best.pl.h)) best = { s, pl };
        }
        if (!best || Math.abs(best.pl.h) > 0.6) return null; // 開いた端から外へ出た
        return { x: best.pl.x, y: best.pl.y + best.s.offset, h: best.pl.h, point };
      }
      return null;
    }

    toAxis(pos, out = new THREE.Vector3()) {
      const b = this._inside(pos);
      return (b ? b.s.space : this.segs[0].space).toAxis(pos, out);
    }

    clampInside(pos, margin = 1.2) {
      const b = this._inside(pos);
      if (b && b.pl.h >= margin) return pos; // どれかのチューブの十分内側
      if (b) {
        // 幹の分かれ目より先へは、枝の中でなければ進めない
        const ly = clamp(b.pl.y, b.s.name === 'trunk' ? 2 : 0.5, b.s.space.L - 2);
        const s = b.s.space._at(ly);
        const rel = pos.clone().sub(s.P);
        const along = rel.dot(s.T);
        const dvec = rel.addScaledVector(s.T, -along);
        if (dvec.length() > this.R - margin) dvec.setLength(this.R - margin);
        return pos.copy(s.P).add(dvec).addScaledVector(s.T, clamp(along, -0.5, 0.5));
      }
      return this.segs[0].space.clampInside(pos, margin);
    }

    startPose() { return this.segs[0].space.startPose(); }

    // 漂うモード用: 幹は分かれ目の先(枝)へ抜けられるので折り返さない。枝の先端でだけ折り返す。
    driftBounds(y) {
      const s = this.segOf(y);
      if (s.name === 'trunk') return { lo: 12, hi: Infinity };
      return { lo: -Infinity, hi: s.offset + s.space.L - 12 };
    }

    // 生物がチューブをまたぐ時の通り道(分かれ目の中心を通る)。同じチューブ内なら null。
    route(from, to, rng) {
      const a = this.segOf(from.y), b = this.segOf(to.y);
      if (a === b) return null;
      const axis = (s, ly) => s.space._at(clamp(ly, 0, s.space.L)).P;
      const wobble = () => new THREE.Vector3((rng() - 0.5) * this.R * 0.6, (rng() - 0.5) * this.R * 0.6, 0);
      const la = from.y - a.offset, lb = to.y - b.offset;
      return [
        axis(a, (la + a.junctionY) / 2).add(wobble()),
        this.J.clone().add(wobble()),
        axis(b, (lb + b.junctionY) / 2).add(wobble()),
      ];
    }

    // 生物の行き先の y: 同じチューブの中で前後に、時々は分かれ目を越えて別のチューブへ
    // sameSeg: 壁を這う生物はチューブをまたがない
    pickY(fromY, dist, rng, sameSeg = false) {
      const s = this.segOf(fromY);
      let ly = fromY - s.offset + (rng() < 0.5 ? -1 : 1) * dist;
      let target = s;
      if (!sameSeg && (ly < 3 || ly > s.space.L - 3 || rng() < 0.25)) {
        // 別のチューブへ(分かれ目の近く)
        const others = this.segs.filter((o) => o !== s);
        target = others[Math.floor(rng() * others.length)];
        ly = target.name === 'trunk' ? JUNCTION - 6 - rng() * 30 : 8 + rng() * 40;
      }
      return target.offset + clamp(ly, 3, target.space.L - 3);
    }
  }

  // 3 本ぶんの Topology をまとめて 1 つにする
  function buildBranchTopology(type, space, around) {
    const parts = space.segs.map((s) => TL.Topology.build(type, space.C, s.space.L, around, {}));
    const T = new TL.Topology(type + '+branch', space.C, space.L, false);
    T.cellSize = parts[0].cellSize;
    T.segTopos = [];
    const idMaps = [];
    parts.forEach((part, k) => {
      const seg = space.segs[k];
      const map = new Map();
      for (const c of part.cells) {
        const w = seg.space.point(c.position.x, c.position.y, 0);
        if (space.insideOther(w, seg)) continue; // 他のチューブの中に入り込んだタイルは無し(開口)
        const extra = {};
        for (const key of Object.keys(c)) if (!['id', 'kind', 'position', 'shape', 'neighbors'].includes(key)) extra[key] = c[key];
        if (c.decor) extra.decor = c.decor.map((d) => d.map(([x, y]) => [x, y + seg.offset]));
        const nc = T.add(c.kind, c.position.x, c.position.y + seg.offset, c.shape.map(([x, y]) => [x - c.position.x, y - c.position.y]), extra);
        nc.seg = k;
        nc.world = w;
        map.set(c.id, nc.id);
      }
      idMaps.push(map);
      T.segTopos.push({ part, map, offset: seg.offset });
    });
    // それぞれのチューブの中のつながり
    parts.forEach((part, k) => {
      const map = idMaps[k];
      for (const c of part.cells) {
        if (!map.has(c.id)) continue;
        T.cells[map.get(c.id)].neighbors = c.neighbors.filter((n) => map.has(n)).map((n) => map.get(n));
      }
    });
    // 分かれ目: 別のチューブのタイルでも、3D で近ければ隣
    const near = T.cells.filter((c) => c.world.distanceTo(space.J) < space.R * 2.6);
    const lim = T.cellSize * 1.15;
    for (let i = 0; i < near.length; i++) {
      for (let j = i + 1; j < near.length; j++) {
        const a = near[i], b = near[j];
        if (a.seg === b.seg || a.world.distanceTo(b.world) > lim) continue;
        a.neighbors.push(b.id); b.neighbors.push(a.id);
      }
    }
    if (parts[0].waveEnergy) T.waveEnergy = parts[0].waveEnergy;
    // セル探し: y からチューブを決めて、そのチューブの Topology で探す
    T.locate = function (x, y) {
      const seg = space.segOf(y);
      const k = space.segs.indexOf(seg);
      const { part, map, offset } = this.segTopos[k];
      const c = part.locate(x, clamp(y - offset, 0, seg.space.L));
      if (c && map.has(c.id)) return this.cells[map.get(c.id)];
      // 開口で取り除いたタイルの所なら、近くの残っているタイル
      let best = null, bd = Infinity;
      for (const n of this.cells) {
        if (n.seg !== k) continue;
        const d = (n.position.x - x) ** 2 + (n.position.y - y) ** 2;
        if (d < bd) { bd = d; best = n; }
      }
      return best;
    };
    return T;
  }

  TL.BranchSpace = BranchSpace;
  TL.buildBranchTopology = buildBranchTopology;
})(window.TL = window.TL || {});
