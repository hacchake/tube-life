// 最小限の UI: 右下の小さなボタンから開く設定パネルと、開発用の Debug 表示。
// 作品の世界を邪魔しないよう、普段は何も出さない。M でメニュー、I でデバッグ。
(function (TL) {
  'use strict';
  const $ = (s) => document.querySelector(s);

  class UI {
    constructor(app) {
      this.app = app;
      this.frames = 0;
      this.fpsT = performance.now();
      this.fps = 0;
      this.dbgT = 0;
      this._bind();
      this.applyDebug();
      setTimeout(() => $('#title').classList.add('fade'), 4500);
    }

    _bind() {
      const app = this.app, st = app.settings;
      const panel = $('#panel');
      const toggle = () => panel.classList.toggle('open');
      $('#menuBtn').addEventListener('click', toggle);
      window.addEventListener('keydown', (e) => {
        if (e.target.closest && e.target.closest('input, select')) return;
        if (e.code === 'KeyM') toggle();
        if (e.code === 'KeyI') { st.debug = !st.debug; $('#debugToggle').checked = st.debug; this.applyDebug(); app.persist(); }
        if (e.code === 'Escape') panel.classList.remove('open');
      });

      const bindCheck = (sel, key, after) => {
        const el = $(sel);
        el.checked = !!st[key];
        el.addEventListener('change', () => { st[key] = el.checked; if (after) after(el.checked); app.persist(); });
      };
      bindCheck('#caToggle', 'caOn');
      bindCheck('#soundToggle', 'sound', (on) => { app.audio.enabled = on; if (on) app.audio.ensure(); });
      bindCheck('#ambientToggle', 'ambient');
      bindCheck('#debugToggle', 'debug', () => this.applyDebug());

      $('#resetBtn').addEventListener('click', () => app.reset());
      $('#seedBtn').addEventListener('click', () => { app.randomSeed(); this.showSeed(); });
      this.showSeed();

      const grid = $('#gridSelect');
      const planned = [{ id: 'triangle', name: 'Triangle' }, { id: 'escher', name: 'Escher' }];
      grid.innerHTML = TL.Topology.types.map((t) => `<option value="${t.id}">${t.name}</option>`).join('') +
        planned.map((t) => `<option value="${t.id}" disabled>${t.name}(準備中)</option>`).join('');
      grid.value = st.grid;
      grid.addEventListener('change', () => app.setGrid(grid.value));

      const sp = $('#speciesSelect');
      sp.innerHTML = TL.Species.all.filter((s) => s.ready).map((s) => `<option value="${s.id}">${s.name}</option>`).join('') +
        '<option value="cycle">Fish ⇄ Bird(交互)</option>' +
        TL.Species.all.filter((s) => !s.ready).map((s) => `<option value="${s.id}" disabled>${s.name}(準備中)</option>`).join('');
      sp.value = st.species;
      sp.addEventListener('change', () => { st.species = sp.value; app.persist(); });

      const speed = $('#speedRange');
      speed.value = st.speed;
      $('#speedVal').textContent = st.speed;
      speed.addEventListener('input', () => { st.speed = +speed.value; $('#speedVal').textContent = speed.value; app.persist(); });

      const vol = $('#volumeRange');
      vol.value = st.volume;
      vol.addEventListener('input', () => { st.volume = +vol.value; app.audio.setVolume(st.volume); app.persist(); });

      const cam = $('#cameraSelect');
      cam.value = st.cameraMode;
      cam.addEventListener('change', () => { st.cameraMode = cam.value; app.cameraCtl.mode = cam.value; app.persist(); });

      $('#midiBtn').addEventListener('click', () => {
        app.midi.enable().then(() => { $('#midiBtn').textContent = 'MIDI 接続中'; })
          .catch((err) => { $('#midiBtn').textContent = 'MIDI 不可'; console.warn(err); });
      });
    }

    showSeed() { $('#seedVal').textContent = '#' + this.app.settings.seed; }

    hideHint() { $('#hint').classList.add('fade'); }

    applyDebug() { $('#debug').hidden = !this.app.settings.debug; }

    frame(now) {
      this.frames++;
      if (now - this.fpsT >= 500) {
        this.fps = Math.round((this.frames * 1000) / (now - this.fpsT));
        this.frames = 0;
        this.fpsT = now;
      }
      if (!this.app.settings.debug || now - this.dbgT < 200) return;
      this.dbgT = now;
      const app = this.app, p = app.camera.position;
      const sel = app.hoverId >= 0 ? app.hoverId : app.selectedId;
      let selText = '-';
      if (sel >= 0) {
        const tc = app.topology.cells[sel], cc = app.ca.cells[sel];
        selText = `#${sel} ${tc.kind} ${TL.STATE_NAMES[cc.state]} gen ${cc.generation} neighbors ${tc.neighbors.length}`;
      }
      const species = Object.entries(app.creatures.countBy()).map(([k, v]) => `${k} ${v}`).join(', ') || 'なし';
      $('#debug').textContent = [
        `FPS          ${this.fps}`,
        `generation   ${app.ca.stepCount}`,
        `active cells ${app.ca.activeCount} / ${app.topology.cells.length} (${app.topology.type})`,
        `living       ${species}`,
        `camera       ${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}`,
        `selected     ${selText}`,
        `seeds→spawn  ${app.pendingSpawn.size}`,
      ].join('\n');
    }
  }

  TL.UI = UI;
})(window.TL = window.TL || {});
