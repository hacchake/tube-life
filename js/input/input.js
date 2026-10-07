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
    constructor() { this.bus = new TL.EventBus(); this.sources = []; }
    add(source) { this.sources.push(source); source.attach(this); return source; }
    activate(cellId, source) { this.bus.emit('activate', { cellId, source }); }
    hover(cellId) { this.bus.emit('hover', { cellId }); }
  }

  class VirtualPointerInput {
    constructor(dom, picker) { this.dom = dom; this.picker = picker; }
    attach(input) {
      const dom = this.dom;
      let down = null;
      dom.addEventListener('pointerdown', (e) => { if (e.button === 0) down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
      dom.addEventListener('pointerup', (e) => {
        if (!down || e.button !== 0) return;
        const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
        down = null;
        if (moved > 5) return; // ドラッグ(見回し)はクリックにしない
        const h = this.picker.pickClient(e.clientX, e.clientY, dom);
        if (h) input.activate(h.cell.id, 'pointer');
      });
      let raf = 0, last = null;
      dom.addEventListener('pointermove', (e) => {
        last = e;
        if (raf) return;
        raf = requestAnimationFrame(() => {
          raf = 0;
          const h = this.picker.pickClient(last.clientX, last.clientY, dom);
          input.hover(h ? h.cell.id : -1);
        });
      });
      dom.addEventListener('pointerleave', () => input.hover(-1));
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
  TL.MidiPadInput = MidiPadInput;
})(window.TL = window.TL || {});
