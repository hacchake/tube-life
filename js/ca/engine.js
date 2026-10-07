// Cellular Automaton エンジン(表示にも 3D にも依存しない)
//
// 状態遷移:
//   IDLE → ACTIVATING → BORN → GROWING → MATURE → DECAY → DEAD → (休眠) → IDLE
//
// 伝播ルール(興奮性媒質に近い):
//   BORN になった瞬間のセルが、隣の IDLE セルを確率 spread で ACTIVATING にする。
//   生命は energy を1ずつ失いながら広がるので、種(seed)を中心にリング状の波になる。
//   DEAD の休眠期間があるので、同じ場所を波が往復しない。
(function (TL) {
  'use strict';

  const ST = { IDLE: 0, ACTIVATING: 1, BORN: 2, GROWING: 3, MATURE: 4, DECAY: 5, DEAD: 6 };
  const NAMES = ['IDLE', 'ACTIVATING', 'BORN', 'GROWING', 'MATURE', 'DECAY', 'DEAD'];
  // 各状態に何ステップ留まるか(DEAD は休眠期間)
  const DURATION = [Infinity, 1, 2, 3, 4, 3, 10];

  // 状態の色(仕様: DEAD=黒/透明, BIRTH=青, GROWING=緑, MATURE=黄, DECAY=赤)。後から変更可能。
  const COLORS = {
    idle: '#1d2a66',
    activating: '#cfe6ff',
    born: '#1f4fff',
    growing: '#22e07a',
    mature: '#ffd23a',
    decay: '#ff3b2f',
    dead: '#000000',
  };

  class CAEngine {
    constructor(topology, rng) {
      this.topology = topology;
      this.rng = rng || Math.random;
      this.spread = 0.82;   // 隣へ広がる確率
      this.energy = 7;      // 種が持つ生命力(波の届く距離の目安)
      this.bus = new TL.EventBus();
      this.reset();
    }

    reset() {
      this.cells = this.topology.cells.map((t) => ({
        id: t.id,
        neighbors: t.neighbors,
        state: ST.IDLE,
        species: null,
        generation: 0,   // 種からの距離(何リング目か)
        timer: 0,
        energy: 0,
        origin: -1,      // どの種から来た生命か
        chain: 0,        // 生物が運んだ回数(連鎖の深さ)
      }));
      this.active = new Set();
      this.stepCount = 0;
      this.bus.emit('reset', this);
    }

    // 生命を植える(クリック・生物の着地・MIDI など、入力の種類は問わない)
    seed(id, { species = 'fish', energy = this.energy, chain = 0, source = 'user' } = {}) {
      const c = this.cells[id];
      if (!c) return null;
      if (c.state !== ST.IDLE && c.state !== ST.DEAD) return null; // 生きている所には植えない
      this._enter(c, ST.ACTIVATING);
      Object.assign(c, { species, generation: 0, energy, origin: id, chain });
      this.active.add(id);
      this.bus.emit('seed', { cell: c, source });
      this.bus.emit('change', [id]);
      return c;
    }

    _enter(c, state) {
      c.state = state;
      c.timer = 0;
    }

    step() {
      const cells = this.cells;
      const ev = { changed: [], born: [], matured: [], decayed: [], died: [], step: this.stepCount };

      // 1) 生まれた瞬間のセルから隣へ伝播する候補を集める
      const spawn = [];
      for (const id of this.active) {
        const c = cells[id];
        if (c.state !== ST.BORN || c.timer !== 0 || c.energy <= 0) continue;
        for (const nb of c.neighbors) {
          const n = cells[nb];
          if (n.state === ST.IDLE && this.rng() < this.spread) spawn.push([n, c]);
        }
      }

      // 2) 時間を進めて状態を遷移
      for (const id of [...this.active]) {
        const c = cells[id];
        c.timer++;
        if (c.timer < DURATION[c.state]) continue;
        const next = c.state === ST.DEAD ? ST.IDLE : c.state + 1;
        this._enter(c, next);
        ev.changed.push(id);
        if (next === ST.BORN) ev.born.push(c);
        else if (next === ST.MATURE) ev.matured.push(c);
        else if (next === ST.DECAY) ev.decayed.push(c);
        else if (next === ST.DEAD) ev.died.push(c);
        else if (next === ST.IDLE) { c.species = null; this.active.delete(id); }
      }

      // 3) 伝播を反映
      for (const [n, from] of spawn) {
        if (n.state !== ST.IDLE) continue;
        this._enter(n, ST.ACTIVATING);
        Object.assign(n, { species: from.species, generation: from.generation + 1, energy: from.energy - 1, origin: from.origin, chain: from.chain });
        this.active.add(n.id);
        ev.changed.push(n.id);
      }

      this.stepCount++;
      this.bus.emit('step', ev);
      if (ev.changed.length) this.bus.emit('change', ev.changed);
      return ev;
    }

    // ランダムな種を n 個
    randomSeeds(n, species = 'fish') {
      const out = [];
      for (let k = 0; k < n; k++) {
        const c = this.seed(Math.floor(this.rng() * this.cells.length), { species, source: 'random' });
        if (c) out.push(c);
      }
      return out;
    }

    get activeCount() { return this.active.size; }
  }

  TL.ST = ST;
  TL.STATE_NAMES = NAMES;
  TL.STATE_COLORS = COLORS;
  TL.CAEngine = CAEngine;
})(window.TL = window.TL || {});
