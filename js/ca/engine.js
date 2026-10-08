// Cellular Automaton エンジン(表示にも 3D にも依存しない)
//
// 表示用の状態(どのルールでも共通):
//   IDLE → ACTIVATING → BORN → GROWING → MATURE → DECAY → DEAD → IDLE
//
// 生命の振る舞いは「ルール」で差し替えられる(RULES):
//   wave   : 種から輪になって広がる波(興奮性媒質)
//   pulse  : 種が心臓のように何度も脈打ち、波を送り続ける
//   life   : ライフゲーム。隣の数で生まれ・生き残る(近傍の数に合わせて規則を選ぶ)
//   spiral : 興奮と不応期をくり返す媒質で、ちぎれた波がらせんを描いて回る
//   coral  : 枝分かれしながらゆっくり育ち、長く残る珊瑚
//   rain   : 波に加えて、あちこちに小さな雨粒のような生命が降る
(function (TL) {
  'use strict';

  const ST = { IDLE: 0, ACTIVATING: 1, BORN: 2, GROWING: 3, MATURE: 4, DECAY: 5, DEAD: 6 };
  const NAMES = ['IDLE', 'ACTIVATING', 'BORN', 'GROWING', 'MATURE', 'DECAY', 'DEAD'];
  // 各状態に何ステップ留まるか(DEAD は休眠期間)。ルールによって上書きする。
  const DURATION = [Infinity, 1, 2, 3, 4, 3, 10];

  // 状態の色(仕様: DEAD=黒/透明, BIRTH=青, GROWING=緑, MATURE=黄, DECAY=赤)。テーマで変更できる。
  const COLORS = {
    idle: '#1d2a66',
    activating: '#cfe6ff',
    born: '#1f4fff',
    growing: '#22e07a',
    mature: '#ffd23a',
    decay: '#ff3b2f',
    dead: '#000000',
  };

  const ALIVE = (s) => s === ST.BORN || s === ST.GROWING || s === ST.MATURE;

  // ライフゲームの規則。格子ごとに、実際に計算して「止まらず・埋め尽くさない」ものを選んで Topology に持たせてある
  // (topology.lifeRule)。無い時は近傍の数から選ぶ。
  const parseRule = (str) => { const m = /B(\d*)\/S(\d*)/.exec(str); return [[...m[1]].map(Number), [...m[2]].map(Number)]; };
  const BY_DEGREE = { 6: 'B25/S34', 8: 'B34/S34', 12: 'B45/S236' };

  const RULES = {
    wave: { name: 'Wave(波)' },
    pulse: { name: 'Pulse(鼓動)' },
    life: { name: 'Life(ライフゲーム)' },
    spiral: { name: 'Spiral(らせん)' },
    coral: { name: 'Coral(珊瑚)' },
    rain: { name: 'Rain(雨)' },
  };

  class CAEngine {
    constructor(topology, rng) {
      this.topology = topology;
      this.rng = rng || Math.random;
      this.spread = 0.82;   // 隣へ広がる確率
      this.energy = 7;      // 種が持つ生命力(波の届く距離の目安)
      this.rule = 'wave';
      this.bus = new TL.EventBus();
      this._lifeCache = new Map();
      this.reset();
    }

    _lifeRule(d) {
      const str = this.topology.lifeRule || BY_DEGREE[d] || (d < 6 ? 'B23/S34' : d < 10 ? 'B34/S34' : 'B45/S236');
      if (!this._lifeCache.has(str)) this._lifeCache.set(str, parseRule(str));
      return this._lifeCache.get(str);
    }

    setRule(rule) {
      this.rule = RULES[rule] ? rule : 'wave';
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
        age: 0,
        phase: 0,        // spiral の段階
        fuel: 0,         // spiral の残りの回数
      }));
      this.active = new Set();
      this.pacemakers = [];
      this.colonies = new Map(); // life: 種ごとの群れが生まれたステップ(寿命のため)
      this.stepCount = 0;
      this.bus.emit('reset', this);
    }

    // 状態を変え、イベントと活動中の集合を更新する
    _set(c, state, ev) {
      c.state = state;
      c.timer = 0;
      if (state === ST.IDLE) { this.active.delete(c.id); c.species = null; } else this.active.add(c.id);
      if (!ev) return;
      ev.changed.push(c.id);
      if (state === ST.BORN) ev.born.push(c);
      else if (state === ST.MATURE) ev.matured.push(c);
      else if (state === ST.DECAY) ev.decayed.push(c);
      else if (state === ST.DEAD) ev.died.push(c);
    }

    _inherit(n, from, extra) {
      Object.assign(n, { species: from.species, generation: from.generation + 1, energy: from.energy - 1, origin: from.origin, chain: from.chain }, extra);
    }

    // 生命を植える(クリック・生物の着地・MIDI など、入力の種類は問わない)
    seed(id, { species = 'fish', energy = this.energy, chain = 0, source = 'user' } = {}) {
      const c = this.cells[id];
      if (!c) return null;
      if (c.state !== ST.IDLE && c.state !== ST.DEAD) return null; // 生きている所には植えない
      Object.assign(c, { species, generation: 0, energy, origin: id, chain, age: 0 });
      const ev = { changed: [], born: [], matured: [], decayed: [], died: [] };
      if (this.rule === 'life') {
        // まとまった生命の塊を置く(1 つだけだとすぐ消えるため)
        this.colonies.set(id, this.stepCount);
        this._set(c, ST.BORN, ev);
        this.topology.rings(id, 3).forEach((ring, r) => {
          if (!r) return;
          for (const nid of ring) {
            const n = this.cells[nid];
            if (!ALIVE(n.state) && this.rng() < 0.55) { this._inherit(n, c, { age: 0, generation: r }); this._set(n, ST.BORN, ev); }
          }
        });
      } else if (this.rule === 'spiral') {
        // 周囲に段階のばらばらな塊を置くと、ちぎれた波がらせんになって回り出す
        const rings = this.topology.rings(id, 4);
        rings.forEach((ring, r) => {
          for (const nid of ring) {
            const n = this.cells[nid];
            if (n.state !== ST.IDLE && nid !== id) continue;
            Object.assign(n, { species, origin: id, chain, generation: r, fuel: 14 });
            n.phase = r === 0 ? 1 : this.rng() < 0.5 ? 0 : 1 + Math.floor(this.rng() * 5);
            this._set(n, this._spiralState(n), ev);
          }
        });
      } else if (this.rule === 'coral') {
        this._set(c, ST.MATURE, ev);
      } else {
        this._set(c, ST.ACTIVATING, ev);
        if (this.rule === 'pulse') this.pacemakers.push({ id, beats: 6, t: 0, species, chain, energy: Math.max(3, energy - 2) });
      }
      this.bus.emit('seed', { cell: c, source });
      if (ev.changed.length) this.bus.emit('change', ev.changed);
      return c;
    }

    _spiralState(n) {
      // 段階 0 = 休み、1 = 興奮、2..6 = 不応期
      return [n.fuel > 0 ? ST.IDLE : ST.IDLE, ST.BORN, ST.GROWING, ST.MATURE, ST.MATURE, ST.DECAY, ST.DEAD][n.phase] ?? ST.IDLE;
    }

    step() {
      const ev = { changed: [], born: [], matured: [], decayed: [], died: [], step: this.stepCount };
      const r = this.rule;
      if (r === 'life') this._stepLife(ev);
      else if (r === 'spiral') this._stepSpiral(ev);
      else if (r === 'coral') this._stepCoral(ev);
      else this._stepWave(ev);
      this.stepCount++;
      this.bus.emit('step', ev);
      if (ev.changed.length) this.bus.emit('change', ev.changed);
      return ev;
    }

    // ---------- wave / pulse / rain ----------
    _stepWave(ev) {
      const cells = this.cells;
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
      this._advance(ev);
      // 3) 伝播を反映
      for (const [n, from] of spawn) {
        if (n.state !== ST.IDLE) continue;
        this._inherit(n, from);
        this._set(n, ST.ACTIVATING, ev);
      }
      // 鼓動: 種が一定の間隔で何度も脈打つ
      if (this.rule === 'pulse') {
        for (const p of this.pacemakers) {
          p.t++;
          if (p.t % 16 !== 0) continue;
          const c = cells[p.id];
          if (c.state !== ST.IDLE) continue;
          Object.assign(c, { species: p.species, generation: 0, energy: p.energy, origin: p.id, chain: p.chain });
          this._set(c, ST.ACTIVATING, ev);
          p.beats--;
        }
        this.pacemakers = this.pacemakers.filter((p) => p.beats > 0);
      }
      // 雨: あちこちに小さな生命が降る
      if (this.rule === 'rain' && this.rng() < 0.7) {
        const c = cells[Math.floor(this.rng() * cells.length)];
        if (c.state === ST.IDLE) {
          Object.assign(c, { species: ['fish', 'bird', 'lizard'][Math.floor(this.rng() * 3)], generation: 0, energy: 1 + Math.floor(this.rng() * 3), origin: -2, chain: 99 });
          this._set(c, ST.ACTIVATING, ev);
        }
      }
    }

    _advance(ev) {
      for (const id of [...this.active]) {
        const c = this.cells[id];
        c.timer++;
        if (c.timer < DURATION[c.state]) continue;
        this._set(c, c.state === ST.DEAD ? ST.IDLE : c.state + 1, ev);
      }
    }

    // ---------- life ----------
    _stepLife(ev) {
      const cells = this.cells;
      const candidates = new Set();
      for (const id of this.active) { candidates.add(id); for (const nb of cells[id].neighbors) candidates.add(nb); }
      const next = [];
      for (const id of candidates) {
        const c = cells[id];
        let n = 0, src = null;
        for (const nb of c.neighbors) if (ALIVE(cells[nb].state)) { n++; src = src || cells[nb]; }
        const [B, S] = this._lifeRule(c.neighbors.length);
        const alive = ALIVE(c.state);
        // 群れには寿命と広がる距離の上限がある(壁を埋め尽くさず、やがて静まる)
        const born = this.colonies.get(src ? src.origin : c.origin);
        const young = born !== undefined && this.stepCount - born < 220;
        // 長く生きすぎたセルは老いて消える(動かない形で止まらないように)
        if (alive) next.push([c, S.includes(n) && c.age < 40 && young, src]);
        else if (B.includes(n) && c.state !== ST.DECAY && young && src && src.generation < this.energy * 2.5) next.push([c, true, src]);
      }
      for (const [c, live, src] of next) {
        const alive = ALIVE(c.state);
        if (alive && live) {
          c.age++;
          if (c.state === ST.BORN) this._set(c, ST.GROWING, ev);
          else if (c.state === ST.GROWING && c.age >= 3) this._set(c, ST.MATURE, ev);
        } else if (alive && !live) {
          this._set(c, ST.DECAY, ev);
        } else if (!alive && live && src) {
          this._inherit(c, src, { age: 0, energy: src.energy });
          this._set(c, ST.BORN, ev);
        }
      }
      // 死にゆくセルの後始末
      for (const id of [...this.active]) {
        const c = cells[id];
        if (c.state === ST.DECAY || c.state === ST.DEAD) {
          c.timer++;
          if (c.state === ST.DECAY && c.timer >= 1) this._set(c, ST.DEAD, ev);
          else if (c.state === ST.DEAD && c.timer >= 2) this._set(c, ST.IDLE, ev);
        }
      }
    }

    // ---------- spiral ----------
    _stepSpiral(ev) {
      const cells = this.cells;
      const candidates = new Set();
      for (const id of this.active) { candidates.add(id); for (const nb of cells[id].neighbors) candidates.add(nb); }
      const updates = [];
      for (const id of candidates) {
        const c = cells[id];
        if (c.phase > 0) { updates.push([c, (c.phase + 1) % 7, null]); continue; }
        // 休んでいるセルは、興奮した隣があれば興奮する(燃料が尽きるまで)
        let src = null;
        for (const nb of c.neighbors) { const n = cells[nb]; if (n.phase === 1 && n.fuel > 0) { src = n; break; } }
        if (src) updates.push([c, 1, src]);
      }
      for (const [c, phase, src] of updates) {
        if (src) Object.assign(c, { species: src.species, origin: src.origin, chain: src.chain, generation: src.generation + 1, fuel: Math.max(c.fuel, src.fuel) });
        if (phase === 1) c.fuel--;
        c.phase = phase;
        const s = phase === 0 ? ST.IDLE : this._spiralState(c);
        if (s !== c.state) this._set(c, s, ev);
      }
    }

    // ---------- coral ----------
    _stepCoral(ev) {
      const cells = this.cells;
      const grow = [];
      for (const id of this.active) {
        const c = cells[id];
        if (c.state !== ST.MATURE || c.generation > this.energy * 3) continue;
        for (const nb of c.neighbors) {
          const n = cells[nb];
          if (n.state !== ST.IDLE || this.rng() > 0.09) continue;
          // 枝分かれ: 珊瑚の隣が 1 つだけの所に伸びる
          let k = 0;
          for (const m of n.neighbors) if (cells[m].state === ST.MATURE || cells[m].state === ST.GROWING) k++;
          if (k === 1) grow.push([n, c]);
        }
      }
      for (const id of [...this.active]) {
        const c = cells[id];
        c.timer++;
        const dur = c.state === ST.MATURE ? 70 : c.state === ST.DEAD ? 12 : DURATION[c.state];
        if (c.timer < dur) continue;
        this._set(c, c.state === ST.DEAD ? ST.IDLE : c.state + 1, ev);
      }
      for (const [n, from] of grow) {
        if (n.state !== ST.IDLE) continue;
        this._inherit(n, from, { energy: from.energy });
        this._set(n, ST.BORN, ev);
      }
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
  TL.CA_RULES = RULES;
  TL.CAEngine = CAEngine;
})(window.TL = window.TL || {});
