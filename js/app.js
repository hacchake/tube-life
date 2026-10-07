// 全体の結線(Animation / Event System)
//
//   Input(クリック・MIDI)─ activate ─▶ CA.seed ─▶ タイルが光る・波紋・音・生物が生まれる
//   CA.step ─▶ タイルの色/浮き上がり・音(Growth / Mature / Decay / Death)
//   生物 landed ─▶ 着地したタイルを CA の新しい種に ─▶ 成熟したら次の生物が生まれる(連鎖)
//
// 「セルが生きる」のではなく「セルから生命が生まれ、生命が別のセルへ生命を運ぶ」。
(function (TL) {
  'use strict';
  const { clamp } = TL.util;

  const RADIUS = 9;       // チューブの半径
  const LENGTH = 150;     // チューブの長さ
  const AROUND = 24;      // 周方向の基準格子点の数
  const STORE_KEY = 'tube-life/v1';

  class App {
    constructor() {
      const saved = TL.Store.load(STORE_KEY, {}) || {};
      this.settings = Object.assign({
        caOn: true, speed: 7, grid: 'flower', species: 'cycle', sound: true, volume: 0.6,
        cameraMode: 'free', ambient: true, debug: false, seed: (Math.random() * 1e9) | 0,
      }, saved);

      this.stage = new TL.Stage3D(document.getElementById('world'));
      this.camera = this.stage.camera;
      this.space = new TL.CylinderSpace(RADIUS, LENGTH);
      this.rngFn = TL.makeRng(this.settings.seed);
      const rng = () => this.rngFn();

      this.tiles = new TL.TileMesh(this.stage.scene, this.space);
      this.creatures = new TL.CreatureSystem(this.stage.scene, this.space, rng);
      this.ripples = new TL.Ripples(this.stage.scene, this.space);
      this.audio = new TL.AudioSystem();
      this.audio.enabled = this.settings.sound;
      this.audio.volume = this.settings.volume;

      this.picker = new TL.Picker(this.camera, this.space);
      this.input = new TL.InputSystem();
      this.input.add(new TL.VirtualPointerInput(this.stage.dom, this.picker));
      this.midi = this.input.add(new TL.MidiPadInput(this.picker));

      this.cameraCtl = new TL.CameraControls(this.camera, this.stage.dom, this.space);
      this.cameraCtl.mode = this.settings.cameraMode;
      this.camera.position.set(0, -2.5, 10);

      this.hoverId = -1;
      this.selectedId = -1;
      this.pendingSpawn = new Map(); // 種の id → 成熟したら生まれる生物の連鎖の深さ
      this.nextAmbient = 4;
      this.time = 0;
      this.acc = 0;

      this.buildWorld(this.settings.grid);

      this.input.bus.on('activate', (e) => this.activate(e.cellId, e.source));
      this.input.bus.on('hover', (e) => { this.hoverId = e.cellId; this.tiles.setHover(e.cellId); });
      this.creatures.bus.on('emerge', (e) => this.onEmerge(e));
      this.creatures.bus.on('landed', (e) => this.onLanded(e));

      const unlock = () => { if (this.audio.enabled) this.audio.ensure(); };
      window.addEventListener('pointerdown', unlock, true);
      window.addEventListener('keydown', unlock, true);

      this.ui = new TL.UI(this);
      this.last = performance.now();
      requestAnimationFrame((t) => this.loop(t));
    }

    // ---------- 世界の構築 ----------

    buildWorld(type) {
      this.topology = TL.Topology.build(type, this.space.C, this.space.L, AROUND);
      this.ca = new TL.CAEngine(this.topology, () => this.rngFn());
      this.ca.bus.on('change', (ids) => this.tiles.markDirty(ids));
      this.ca.bus.on('step', (ev) => this.onStep(ev));
      this.tiles.build(this.topology);
      this.picker.setTopology(this.topology);
      this.creatures.clear();
      this.pendingSpawn.clear();
      this.hoverId = this.selectedId = -1;
    }

    setGrid(type) {
      this.settings.grid = type;
      this.buildWorld(type);
      this.persist();
    }

    reset() {
      this.ca.reset();
      this.creatures.clear();
      this.pendingSpawn.clear();
      this.tiles.markDirty(this.topology.cells.map((c) => c.id));
    }

    // 新しい乱数の種で始め直し、見えている所にいくつか生命を植える
    randomSeed() {
      this.settings.seed = (Math.random() * 1e9) | 0;
      this.rngFn = TL.makeRng(this.settings.seed);
      this.reset();
      for (let k = 0; k < 3; k++) {
        const h = this.picker.pickNdc((this.rngFn() - 0.5) * 1.4, (this.rngFn() - 0.5) * 1.2);
        if (h) this.activate(h.cell.id, 'random');
      }
      this.persist();
    }

    // ---------- 補助 ----------

    cellPos(id) { return this.topology.cells[id].position; }
    worldOf(id, h = 0) { const p = this.cellPos(id); return this.space.point(p.x, p.y, h); }
    uOf(c) { return this.cellPos(c.id).x / this.topology.Lx; }
    // 音の左右: カメラから見て右にあるほど右へ
    panOf(c) {
      const p = this.worldOf(c.id).applyMatrix4(this.camera.matrixWorldInverse);
      return clamp(p.x / 12, -0.9, 0.9);
    }

    // Species の設定から、最初に生まれる種と、連鎖で次に生まれる種を決める
    //   fish / bird: その種だけ    cycle: 魚 ⇄ 鳥 を交互に
    firstSpecies() { return this.settings.species === 'cycle' ? 'fish' : this.settings.species; }
    nextSpecies(prev) {
      if (this.settings.species !== 'cycle') return this.settings.species;
      return prev === 'fish' ? 'bird' : 'fish';
    }

    // 生物の行き先: 種ごとの距離だけ離れた待機中のタイル(カメラの向いている側に寄せる)
    pickTarget(fromId, speciesId) {
      const [near, far] = TL.Species.get(speciesId).range;
      const from = this.cellPos(fromId);
      const ahead = this.cameraCtl.forward().z >= 0 ? 1 : -1;
      const rng = this.rngFn;
      let best = null;
      for (let k = 0; k < 14; k++) {
        const dir = rng() < 0.7 ? ahead : -ahead;
        const y = clamp(from.y + dir * (near + rng() * (far - near)), 4, this.space.L - 4);
        const cell = this.topology.locate(rng() * this.topology.Lx, y);
        if (!cell || cell.id === fromId) continue;
        best = cell;
        if (this.ca.cells[cell.id].state === TL.ST.IDLE) break;
      }
      return best;
    }

    spawnFrom(id, chain, species) {
      const to = this.pickTarget(id, species);
      if (!to) return null;
      const p0 = this.cellPos(id), p1 = to.position;
      return this.creatures.spawn({ id, x: p0.x, y: p0.y }, { id: to.id, x: p1.x, y: p1.y }, { species, chain });
    }

    // ---------- イベント ----------

    // タイルを活性化 = 生命を植える(クリックでも MIDI でも同じ)
    activate(id, source) {
      const species = this.firstSpecies();
      const cell = this.ca.seed(id, { species, chain: 0, source });
      this.selectedId = id;
      if (!cell) return;
      this.tiles.flash(id, 2);
      const p = this.cellPos(id);
      this.ripples.spawn(p.x, p.y, 0xbfe6ff, 5);
      this.audio.seed(this.uOf(cell), cell.species, this.panOf(cell));
      this.spawnFrom(id, 0, species);
      if (source === 'pointer' || source === 'midi') this.ui.hideHint();
      else this.cameraCtl.attract(this.worldOf(id), 0.12); // 自動で生まれた時だけ視線を少し寄せる
    }

    onEmerge({ creature, cell }) {
      this.audio.emerge(creature.species.id, cell.x / this.topology.Lx, this.panOf({ id: cell.id }));
    }

    // 生物が別のタイルに着いた → そこが新しい種になる
    onLanded({ creature, cell, chain }) {
      let id = cell.id;
      let seeded = this.ca.seed(id, { species: creature.species.id, chain: chain + 1, source: 'creature' });
      if (!seeded) {
        // 着地点が生きていたら、隣の待機中のタイルへ
        const nb = this.topology.cells[id].neighbors.find((n) => this.ca.cells[n].state === TL.ST.IDLE);
        if (nb !== undefined) { id = nb; seeded = this.ca.seed(id, { species: creature.species.id, chain: chain + 1, source: 'creature' }); }
      }
      if (!seeded) return;
      this.tiles.flash(id, 1.8);
      const p = this.cellPos(id);
      this.ripples.spawn(p.x, p.y, 0x9fffd0, 6, 1.9);
      this.audio.landed(creature.species.id, this.uOf(seeded), this.panOf(seeded));
      this.cameraCtl.attract(this.worldOf(id), 0.12);
      // 連鎖: 深くなるほど続きにくい。広がった波の中から次の生物が生まれる。
      if (this.rngFn() < 0.92 * Math.pow(0.8, chain)) {
        this.pendingSpawn.set(id, { chain: chain + 1, species: this.nextSpecies(creature.species.id) });
      }
    }

    onStep(ev) {
      this.audio.step(ev, (c) => this.uOf(c), (c) => this.panOf(c));
      // 種から 2 リング以上広がったセルが成熟したら、そこから次の生物が生まれる(波が小さければ種から)
      for (const c of ev.matured) {
        const p = this.pendingSpawn.get(c.origin);
        if (!p || (c.generation < 2 && c.id !== c.origin)) continue;
        if (c.id === c.origin && this.ca.cells.some((o) => o.origin === c.origin && o.generation >= 2 && o.state >= TL.ST.ACTIVATING && o.state <= TL.ST.GROWING)) continue;
        this.pendingSpawn.delete(c.origin);
        this.spawnFrom(c.id, p.chain, p.species);
      }
    }

    // 眺めているだけでも何かが起こるように、静かな時は時々どこかで生命が生まれる
    ambient(dt) {
      if (!this.settings.ambient) return;
      this.nextAmbient -= dt;
      if (this.nextAmbient > 0) return;
      this.nextAmbient = 7 + this.rngFn() * 7;
      if (this.cameraCtl.idleFor < 5 || this.creatures.count > 2 || this.ca.activeCount > 60) return;
      const h = this.picker.pickNdc((this.rngFn() - 0.5) * 1.3, (this.rngFn() - 0.5) * 1.1);
      if (h) this.activate(h.cell.id, 'ambient');
    }

    // ---------- ループ ----------

    loop(now) {
      const dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      this.time += dt;
      if (this.settings.caOn) {
        this.acc += dt;
        const stepT = 1 / this.settings.speed;
        let n = 0;
        while (this.acc >= stepT && n < 3) { this.ca.step(); this.acc -= stepT; n++; }
        if (n >= 3) this.acc = 0;
        this.ambient(dt);
      }
      this.cameraCtl.update(dt);
      this.creatures.update(dt); // 生物は CA 停止中も動く
      this.tiles.update(dt, this.ca.cells);
      this.ripples.update(dt);
      this.stage.render();
      this.ui.frame(now);
      requestAnimationFrame((t) => this.loop(t));
    }

    persist() { TL.Store.save(STORE_KEY, this.settings); }
  }

  TL.App = App;
  window.addEventListener('DOMContentLoaded', () => {
    if (!window.THREE) {
      document.getElementById('hint').textContent = 'Three.js を読み込めませんでした(ネット接続を確認してください)';
      return;
    }
    TL.app = new App();
  });
})(window.TL = window.TL || {});
