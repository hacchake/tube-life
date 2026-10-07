// 音(Web Audio)。CA のイベントと生物のイベントを、控えめな音に対応させる。
//
//   Birth  → 高めの澄んだ音       Growth → 波が広がるほど音程が上がる
//   Mature → 和音                 Decay  → 下がっていく音        Death → 消えていく息のような音
//   生物ごとに音色が違う: Fish = 泡のような丸い音 / Bird = さえずり(FM)/ Lizard = 乾いたはじく音
//
// 音程はペンタトニック。周方向の位置で音が変わる。
(function (TL) {
  'use strict';
  const { clamp } = TL.util;
  const mtof = (n) => 440 * Math.pow(2, (n - 69) / 12);
  const SCALE = [0, 2, 5, 7, 9]; // D ドリアン系のペンタトニック
  const ROOT = 50; // D3

  class AudioSystem {
    constructor() {
      this.ctx = null;
      this.enabled = true;
      this.volume = 0.6;
      this.lastGrowth = 0;
      this.voices = 0;
    }

    ensure() {
      if (!this.enabled) return null;
      if (!this.ctx) this._build();
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    }

    _build() {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = (this.ctx = new AC());
      this.master = ctx.createGain();
      this.master.gain.value = this.volume;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -18;
      comp.ratio.value = 3;
      this.master.connect(comp);
      comp.connect(ctx.destination);
      this.dry = ctx.createGain();
      this.dry.connect(this.master);
      // 長めの残響(チューブの中の響き)
      const conv = ctx.createConvolver();
      const len = ctx.sampleRate * 4.5;
      const buf = ctx.createBuffer(2, len, ctx.sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const d = buf.getChannelData(ch);
        let lp = 0;
        for (let i = 0; i < len; i++) {
          const t = i / len;
          lp += ((Math.random() * 2 - 1) * Math.pow(1 - t, 2.2) - lp) * (0.1 + 0.7 * (1 - t));
          d[i] = lp;
        }
      }
      conv.buffer = buf;
      this.wet = ctx.createGain();
      this.wet.gain.value = 0.55;
      this.dry.connect(conv);
      conv.connect(this.wet);
      this.wet.connect(this.master);
    }

    setVolume(v) { this.volume = v; if (this.ctx) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05); }

    note(deg, octave = 0) {
      const o = Math.floor(deg / SCALE.length);
      return ROOT + 12 * (o + octave) + SCALE[((deg % SCALE.length) + SCALE.length) % SCALE.length];
    }

    // 周方向の位置 u (0..1) を音階に
    degreeOf(u) { return Math.floor(u * 10); }

    _tone({ freq, freq2, type = 'sine', vel = 0.2, attack = 0.005, dur = 1, pan = 0, when = 0, vibrato = 0, fm = 0, fmRatio = 2 }) {
      const ctx = this.ensure();
      if (!ctx || this.voices > 28) return;
      const t = ctx.currentTime + 0.01 + when;
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(freq, t);
      if (freq2) o.frequency.exponentialRampToValueAtTime(freq2, t + dur * 0.8);
      const nodes = [o];
      if (vibrato) {
        const l = ctx.createOscillator(), lg = ctx.createGain();
        l.frequency.value = 6; lg.gain.value = freq * vibrato;
        l.connect(lg); lg.connect(o.frequency); nodes.push(l);
      }
      if (fm) {
        const m = ctx.createOscillator(), mg = ctx.createGain();
        m.frequency.value = freq * fmRatio;
        mg.gain.setValueAtTime(freq * fm, t);
        mg.gain.exponentialRampToValueAtTime(freq * 0.01, t + dur * 0.6);
        m.connect(mg); mg.connect(o.frequency); nodes.push(m);
      }
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vel, t + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      const p = ctx.createStereoPanner();
      p.pan.value = clamp(pan, -1, 1);
      o.connect(g); g.connect(p); p.connect(this.dry);
      this.voices++;
      for (const n of nodes) { n.start(t); n.stop(t + dur + 0.05); }
      o.onended = () => { this.voices--; g.disconnect(); };
    }

    // 生物ごとの音色
    _voice(species, midi, vel, opts = {}) {
      const f = mtof(midi);
      if (species === 'bird') this._tone({ freq: f * 2, freq2: f * 2.6, vel: vel * 0.6, fm: 1.5, fmRatio: 3, dur: 0.35, ...opts });
      else if (species === 'lizard') this._tone({ freq: f, type: 'triangle', vel: vel * 0.8, fm: 3, fmRatio: 5, dur: 0.25, ...opts });
      else this._tone({ freq: f, vel, vibrato: 0.012, fm: 0.6, fmRatio: 2, dur: 1.6, ...opts }); // fish
    }

    // ---------- CA イベント ----------

    seed(u, species, pan) {
      if (!this.enabled) return;
      this._voice(species, this.note(this.degreeOf(u), 2), 0.22, { pan });
    }

    // 1 ステップぶんのイベント。鳴らしすぎないよう 1 ステップ 1〜2 音まで。
    step(ev, uOf, panOf) {
      if (!this.enabled || !this.ctx) return;
      const now = performance.now();
      if (ev.born.length && now - this.lastGrowth > 140) {
        this.lastGrowth = now;
        const c = ev.born[Math.floor(Math.random() * ev.born.length)];
        // Growth: 波が外へ広がるほど音程が上がる
        this._voice(c.species, this.note(this.degreeOf(uOf(c)) + c.generation, 1), clamp(0.05 + ev.born.length * 0.006, 0.05, 0.14), { pan: panOf(c) });
      }
      for (const c of ev.matured) {
        if (c.origin !== c.id) continue;
        // Mature: 種の場所で和音
        const d = this.degreeOf(uOf(c));
        [0, 2, 4].forEach((k, i) => this._tone({ freq: mtof(this.note(d + k, 0)), vel: 0.08, attack: 0.25, dur: 3.2, pan: panOf(c), when: i * 0.06 }));
      }
      for (const c of ev.decayed) {
        if (c.origin !== c.id) continue;
        // Decay: 下がっていく音
        const f = mtof(this.note(this.degreeOf(uOf(c)), 0));
        this._tone({ freq: f, freq2: f * 0.5, type: 'triangle', vel: 0.07, attack: 0.05, dur: 1.4, pan: panOf(c) });
      }
      for (const c of ev.died) {
        if (c.origin !== c.id) continue;
        // Death: 低く消えていく
        const f = mtof(this.note(this.degreeOf(uOf(c)), -1));
        this._tone({ freq: f, freq2: f * 0.7, vel: 0.05, attack: 0.3, dur: 2.2, pan: panOf(c) });
      }
    }

    // ---------- 生物イベント ----------

    // 羽音: 細かく震えるノイズ
    _flutter(pan, when = 0, dur = 0.9) {
      const ctx = this.ensure();
      if (!ctx) return;
      const t = ctx.currentTime + 0.01 + when;
      const len = Math.floor(ctx.sampleRate * dur);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) {
        const k = i / ctx.sampleRate;
        const beat = 0.5 + 0.5 * Math.sin(2 * Math.PI * 14 * k); // 羽ばたきの周期
        d[i] = (Math.random() * 2 - 1) * beat * beat * (1 - i / len);
      }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 1400; bp.Q.value = 0.8;
      const g = ctx.createGain();
      g.gain.value = 0.12;
      const p = ctx.createStereoPanner();
      p.pan.value = clamp(pan, -1, 1);
      src.connect(bp); bp.connect(g); g.connect(p); p.connect(this.dry);
      src.start(t);
    }

    emerge(species, u, pan) {
      if (!this.enabled) return;
      const f = mtof(this.note(this.degreeOf(u), 1));
      if (species === 'bird') {
        this._flutter(pan, 0.9);
        this._voice('bird', this.note(this.degreeOf(u) + 3, 1), 0.22, { pan, when: 1.0 });
        return;
      }
      this._tone({ freq: f * 0.5, freq2: f * 1.5, vel: 0.1, attack: 0.4, dur: 1.8, vibrato: 0.02, pan }); // 泡が昇るような音
    }

    landed(species, u, pan) {
      if (!this.enabled) return;
      const f = mtof(this.note(this.degreeOf(u), 1));
      if (species === 'bird') {
        // 二声のさえずり
        this._voice('bird', this.note(this.degreeOf(u) + 4, 1), 0.2, { pan });
        this._voice('bird', this.note(this.degreeOf(u) + 2, 1), 0.16, { pan, when: 0.16 });
        return;
      }
      this._tone({ freq: f * 1.6, freq2: f * 0.8, vel: 0.12, attack: 0.005, dur: 0.5, pan }); // ぽちゃん
      this._voice(species, this.note(this.degreeOf(u) + 2, 1), 0.12, { pan, when: 0.12 });
    }
  }

  TL.AudioSystem = AudioSystem;
})(window.TL = window.TL || {});
