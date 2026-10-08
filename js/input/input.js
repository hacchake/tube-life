// 入力システム: 「タイルを活性化する」という操作を、入力装置から切り離す。
//
//   VirtualPointerInput : マウス/タッチでタイルをクリック(今回の主な入力)
//   MidiPadInput        : Launchpad Mini MK3 などの 8×8 パッド(将来用・未検証)
//
// どちらも picker(画面上の点 → セル)を使って 'activate' { cellId, source } を出すだけ。
// アプリ側はどの装置から来たかを気にしない。
(function (TL) {
  'use strict';

  // 画面上の点(NDC: -1..1)→ セル。視線と壁の交点を数式で解き、Topology で引く。
  class Picker {
    constructor(camera, space) {
      this.camera = camera;
      this.space = space;
      this.ray = new THREE.Raycaster();
      this.v2 = new THREE.Vector2();
    }
    setTopology(t) { this.topology = t; }
    pickNdc(nx, ny) {
      if (!this.topology) return null;
      this.v2.set(nx, ny);
      this.ray.setFromCamera(this.v2, this.camera);
      const hit = this.space.raycastWall(this.ray.ray);
      if (!hit) return null;
      const cell = this.topology.locate(hit.x, hit.y);
      return cell ? { cell, point: hit.point } : null;
    }
    pickClient(x, y, dom) {
      const r = dom.getBoundingClientRect();
      return this.pickNdc(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
    }
  }

  class InputSystem {
    constructor(picker) {
      this.bus = new TL.EventBus();
      this.sources = [];
      this.picker = picker;
      this.holds = new Map(); // 押しっぱなしの入力: key → { ndc(), t, last }
      this.repeat = 0.14;     // 押している間、何秒ごとに鳴らすか
    }
    add(source) { this.sources.push(source); source.attach(this); return source; }
    activate(cellId, source) { this.bus.emit('activate', { cellId, source }); }
    hover(cellId) { this.bus.emit('hover', { cellId }); }

    // 押しっぱなしの開始・終了。ndc() はその時点の画面上の位置(-1..1)を返す
    holdStart(key, ndc) { this.holds.set(key, { ndc, t: 0, last: -1 }); this.bus.emit('holdstart', { key }); }
    holdEnd(key) { this.holds.delete(key); }
    clearHolds() { this.holds.clear(); }

    // 毎フレーム: 押している間は一定の間隔で、なぞって別のタイルに移った時はすぐ鳴らす
    update(dt) {
      for (const h of this.holds.values()) {
        h.t -= dt;
        const p = h.ndc();
        if (!p) continue;
        const hit = this.picker.pickNdc(p[0], p[1]);
        if (!hit) continue;
        if (h.t <= 0 || hit.cell.id !== h.last) {
          h.t = this.repeat;
          h.last = hit.cell.id;
          this.activate(hit.cell.id, 'hold');
        }
      }
    }
  }

  // マウス・タッチ
  //   クリック              : そのタイルに生命を植える
  //   左ボタンを押して止める : 0.25 秒たつと「演奏」— 押している間くり返し鳴らし、なぞればその上を鳴らす
  //   右ボタン(長押し)      : すぐに「演奏」
  //   左ボタンでドラッグ      : 見回す(カメラ側)
  class VirtualPointerInput {
    constructor(dom, picker) { this.dom = dom; this.picker = picker; this.ndc = null; }
    attach(input) {
      const dom = this.dom;
      let down = null, timer = 0;
      const toNdc = (e) => { const r = dom.getBoundingClientRect(); return [((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1]; };
      const startHold = () => { down.holding = true; input.holdStart('mouse', () => this.ndc); };
      dom.addEventListener('pointerdown', (e) => {
        this.ndc = toNdc(e);
        if (e.button !== 0 && e.button !== 2) return;
        down = { x: e.clientX, y: e.clientY, button: e.button, holding: false, moved: false };
        if (e.button === 2) startHold();
        else timer = setTimeout(() => { if (down && !down.moved) startHold(); }, 250);
      });
      const end = (e) => {
        clearTimeout(timer);
        if (!down) return;
        const d = down;
        down = null;
        if (d.holding) { input.holdEnd('mouse'); return; }
        if (e.type !== 'pointerup' || d.button !== 0 || d.moved) return; // ドラッグ(見回し)はクリックにしない
        const h = this.picker.pickClient(e.clientX, e.clientY, dom);
        if (h) input.activate(h.cell.id, 'pointer');
      };
      window.addEventListener('pointerup', end);
      window.addEventListener('pointercancel', end);
      let raf = 0, last = null;
      window.addEventListener('pointermove', (e) => {
        if (e.target === dom || down) this.ndc = toNdc(e);
        if (down && !down.holding && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) { down.moved = true; clearTimeout(timer); }
        if (e.target !== dom) return;
        last = e;
        if (raf) return;
        raf = requestAnimationFrame(() => {
          raf = 0;
          const h = this.picker.pickClient(last.clientX, last.clientY, dom);
          input.hover(h ? h.cell.id : -1);
        });
      });
      dom.addEventListener('pointerleave', () => { input.hover(-1); if (!down) this.ndc = null; });
    }
  }

  // キーボード
  //   スペース : 押している間、マウスの下(無ければ画面の中央)を鳴らし続ける
  //   1〜9, 0  : 画面の下側に横一列に並んだ 10 か所。鍵盤のように、押している間鳴らし続ける
  class KeyboardInput {
    constructor(pointer) { this.pointer = pointer; }
    attach(input) {
      const keyNdc = (k) => [-0.81 + k * 0.18, -0.38];
      window.addEventListener('keydown', (e) => {
        if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || (e.target.closest && e.target.closest('input, select, textarea'))) return;
        if (e.code === 'Space') {
          e.preventDefault();
          input.holdStart('space', () => this.pointer.ndc || [0, 0]);
          return;
        }
        const m = /^Digit(\d)$/.exec(e.code);
        if (m) {
          const k = m[1] === '0' ? 9 : +m[1] - 1;
          input.holdStart(e.code, () => keyNdc(k));
        }
      });
      window.addEventListener('keyup', (e) => {
        if (e.code === 'Space') input.holdEnd('space');
        else if (/^Digit\d$/.test(e.code)) input.holdEnd(e.code);
      });
      window.addEventListener('blur', () => input.clearHolds());
    }
  }

  // Launchpad Mini MK3(Programmer モード: パッド番号 = 行*10 + 列、左下が 11)。
  // パッドの 8×8 を「今見ている画面」の 8×8 区画に対応させ、その中心のタイルを活性化する。
  class MidiPadInput {
    constructor(picker) { this.picker = picker; this.enabled = false; }
    attach(input) { this.input = input; }
    async enable() {
      if (!navigator.requestMIDIAccess) throw new Error('このブラウザは Web MIDI API に対応していません');
      const access = await navigator.requestMIDIAccess({ sysex: true });
      const bind = () => {
        for (const port of access.inputs.values()) port.onmidimessage = (ev) => this._onMessage(ev.data);
        for (const out of access.outputs.values()) {
          if (/Launchpad/i.test(out.name)) out.send([0xf0, 0x00, 0x20, 0x29, 0x02, 0x0d, 0x0e, 0x01, 0xf7]); // Programmer モード
        }
      };
      access.onstatechange = bind;
      bind();
      this.enabled = true;
    }
    _onMessage(data) {
      const st = data[0] & 0xf0;
      if (st !== 0x90 || !data[2]) return;
      const row = Math.floor(data[1] / 10), col = data[1] % 10;
      if (row < 1 || row > 8 || col < 1 || col > 8) return;
      const h = this.picker.pickNdc(((col - 0.5) / 8) * 2 - 1, ((row - 0.5) / 8) * 2 - 1);
      if (h) this.input.activate(h.cell.id, 'midi');
    }
  }

  TL.Picker = Picker;
  TL.InputSystem = InputSystem;
  TL.VirtualPointerInput = VirtualPointerInput;
  TL.KeyboardInput = KeyboardInput;
  TL.MidiPadInput = MidiPadInput;
})(window.TL = window.TL || {});
