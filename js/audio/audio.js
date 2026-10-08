// 音(Web Audio)。CA と生物の出来事を、空間に置かれた音にする。
//
// ・立体音響: 音は出来事が起きた 3D の位置に置き、カメラが聴き手(HRTF)。振り向けば音も回り込む。
// ・和声: 12 秒ごとにコードが進み、どの音もそのコードの構成音に乗る(音階は選べる)。
// ・背景の響き(ベッド): テーマごとの持続音が流れ、生命が多いほど明るく・大きくなる。
// ・音色セット(theme)と鳴り方(pattern)で、同じ出来事がまったく違う音楽になる。
//
// 出来事: seed(植えた)/ step(誕生・成熟・衰退・死の波)/ emerge・landed(生物の出入り)/ morph(変態)/ meet(出会い)/ footstep
(function (TL) {
  'use strict';
  const { clamp } = TL.util;
  const mtof = (n) => 440 * Math.pow(2, (n - 69) / 12);

  const SCALES = {
    pentatonic: { name: 'ペンタトニック', steps: [0, 2, 4, 7, 9] },
    minorPenta: { name: 'マイナーペンタ', steps: [0, 3, 5, 7, 10] },
    dorian: { name: 'ドリアン', steps: [0, 2, 3, 5, 7, 9, 10] },
    lydian: { name: 'リディアン', steps: [0, 2, 4, 6, 7, 9, 11] },
    hirajoshi: { name: '平調子', steps: [0, 2, 3, 7, 8] },
    pelog: { name: 'ペロッグ', steps: [0, 1, 3, 7, 8] },
    wholeTone: { name: '全音音階', steps: [0, 2, 4, 6, 8, 10] },
    hijaz: { name: 'ヒジャーズ', steps: [0, 1, 4, 5, 7, 8, 10] },
  };

  const THEMES = {
    crystal: { name: '結晶(透明)', root: 50, scale: 'pentatonic' },
    gamelan: { name: 'ガムラン(青銅)', root: 49, scale: 'pelog' },
    choir: { name: '聖歌(声)', root: 45, scale: 'dorian' },
    pulse: { name: '電子(パルス)', root: 45, scale: 'minorPenta' },
    abyss: { name: '深海(ソナー)', root: 38, scale: 'hirajoshi' },
  };

  const PATTERNS = {
    ambient: { name: 'アンビエント' },
    melodic: { name: '旋律(波が歌う)' },
    rhythm: { name: 'リズム(拍に揃える)' },
    drone: { name: 'ドローン(響きだけ)' },
  };

  class AudioSystem {
    constructor() {
      this.ctx = null;
      this.enabled = true;
      this.volume = 0.6;
      this.theme = 'crystal';
      this.scale = null;       // null = テーマの音階
      this.pattern = 'ambient';
      this.voices = 0;
      this.lastGrowth = 0;
      this.chordIndex = 0;
      this.chordT = 0;
      this.activity = 0;
      this.bpm = 96;
    }

    get scaleId() { return this.scale || THEMES[this.theme].scale; }
    get steps() { return SCALES[this.scaleId].steps; }
    get root() { return THEMES[this.theme].root; }

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
      // 最後に軽いコンプレッサーとリミッター
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -20; comp.knee.value = 10; comp.ratio.value = 3.5; comp.attack.value = 0.01; comp.release.value = 0.3;
      const limit = ctx.createDynamicsCompressor();
      limit.threshold.value = -3; limit.ratio.value = 20; limit.attack.value = 0.002;
      this.master.connect(comp); comp.connect(limit); limit.connect(ctx.destination);

      // 全体の明るさ(生命が多いほど開く)
      this.tone = ctx.createBiquadFilter();
      this.tone.type = 'lowpass'; this.tone.frequency.value = 6000; this.tone.Q.value = 0.4;
      this.tone.connect(this.master);
      this.dry = ctx.createGain();
      this.dry.connect(this.tone);

      // 大きな空間の残響(チューブの中)
      const conv = ctx.createConvolver();
      conv.buffer = this._impulse(4.2, 2.8);
      this.revSend = ctx.createGain(); this.revSend.gain.value = 0.45;
      this.dry.connect(this.revSend); this.revSend.connect(conv);
      const revOut = ctx.createGain(); revOut.gain.value = 0.9;
      conv.connect(revOut); revOut.connect(this.tone);

      // テンポに合わせたこだま(左右に揺れる)
      this.delay = ctx.createDelay(3); this.delay.delayTime.value = (60 / this.bpm) * 0.75;
      const fb = ctx.createGain(); fb.gain.value = 0.3;
      const dtone = ctx.createBiquadFilter(); dtone.type = 'bandpass'; dtone.frequency.value = 1800; dtone.Q.value = 0.5;
      const dpan = ctx.createStereoPanner(); dpan.pan.value = 0.4;
      this.delaySend = ctx.createGain(); this.delaySend.gain.value = 0.22;
      this.dry.connect(this.delaySend); this.delaySend.connect(this.delay);
      this.delay.connect(dtone); dtone.connect(fb); fb.connect(this.delay);
      dtone.connect(dpan); dpan.connect(this.tone); dpan.connect(this.revSend);

      // ドラム・ノイズ用(白と茶色のノイズを交互に)
      const len = ctx.sampleRate * 2;
      this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
      const nd = this.noise.getChannelData(0);
      let brown = 0;
      for (let i = 0; i < len; i++) { const w = Math.random() * 2 - 1; brown = (brown + 0.02 * w) / 1.02; nd[i] = i % 2 ? w : brown * 3.5; }

      this._startBed();
    }

    _impulse(sec, decay) {
      const ctx = this.ctx, rate = ctx.sampleRate, len = Math.floor(rate * sec);
      const buf = ctx.createBuffer(2, len, rate);
      for (let ch = 0; ch < 2; ch++) {
        const d = buf.getChannelData(ch);
        let lp = 0;
        for (let i = Math.floor(rate * 0.03); i < len; i++) {
          const t = i / len;
          lp += ((Math.random() * 2 - 1) * Math.pow(1 - t, decay) - lp) * (0.08 + 0.7 * (1 - t));
          d[i] = lp * (1 + 0.3 * Math.sin(i * 0.0007 + ch));
        }
      }
      return buf;
    }

    setVolume(v) { this.volume = v; if (this.ctx) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05); }

    setTheme(id) {
      this.theme = THEMES[id] ? id : 'crystal';
      if (this.ctx) { this._stopBed(); this._startBed(); }
    }

    setEnabled(on) {
      this.enabled = on;
      if (on) this.ensure();
      if (this.ctx) this._bedLevel();
    }

    // ---------- 和声 ----------
    // 進行は音階の度数で決めるので、どの音階でも濁らない
    get chordDegrees() {
      const prog = [0, 3, 1, 4, 2, 5];
      const r = prog[this.chordIndex % prog.length];
      return [r, r + 2, r + 4, r + 6];
    }

    degreeToMidi(deg, base = this.root) {
      const st = this.steps, n = st.length;
      return base + 12 * Math.floor(deg / n) + st[((deg % n) + n) % n];
    }

    chordTones(lo, hi) {
      const pcs = new Set(this.chordDegrees.map((d) => this.degreeToMidi(d) % 12));
      const out = [];
      for (let m = lo; m <= hi; m++) if (pcs.has(m % 12)) out.push(m);
      return out;
    }

    // u (0..1) と高さ oct をコードトーンに
    noteAt(u, oct = 0) {
      const tones = this.chordTones(this.root + 12 * oct, this.root + 12 * (oct + 2));
      return tones[Math.min(tones.length - 1, Math.floor(clamp(u, 0, 0.999) * tones.length))];
    }

    // ---------- 時間 ----------
    // リズム・旋律の時は次の拍の区切りまで待つ
    _quantize(grid = 4) {
      if (!this.ctx || (this.pattern !== 'rhythm' && this.pattern !== 'melodic')) return 0;
      const beat = 60 / this.bpm / (this.pattern === 'rhythm' ? grid : 2);
      const t = this.ctx.currentTime;
      return Math.ceil(t / beat) * beat - t;
    }

    // ---------- 発音の部品 ----------
    // where: { pos: THREE.Vector3 } を渡すと、その場所に音を置く
    _out(where) {
      const ctx = this.ctx;
      const g = ctx.createGain();
      let node = g;
      if (where && where.pos && ctx.createPanner) {
        const p = ctx.createPanner();
        p.panningModel = 'HRTF'; p.distanceModel = 'inverse'; p.refDistance = 7; p.maxDistance = 400; p.rolloffFactor = 0.7;
        const { x, y, z } = where.pos;
        if (p.positionX) { p.positionX.value = x; p.positionY.value = y; p.positionZ.value = z; } else p.setPosition(x, y, z);
        g.connect(p);
        node = p;
      }
      node.connect(this.dry);
      return g;
    }

    _env(g, t, peak, attack, dur) {
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    }

    _done(nodes, out, t, end) {
      this.voices++;
      for (const n of nodes) { n.start(t); n.stop(end + 0.05); }
      setTimeout(() => { this.voices--; out.disconnect(); }, (end - this.ctx.currentTime) * 1000 + 300);
    }

    _ok() { return this.ensure() && this.voices <= 40; }

    // FM: 打った瞬間だけ明るいベル・青銅の音(ratio で倍音の性格が変わる)
    _fm(f, vel, where, when, { ratio = 2, index = 1.5, dur = 2.2, attack = 0.004, decayIndex = 0.8, partial2 = 0 } = {}) {
      if (!this._ok()) return;
      const ctx = this.ctx, t = ctx.currentTime + 0.01 + when;
      const out = this._out(where);
      const c = ctx.createOscillator(), m = ctx.createOscillator(), mg = ctx.createGain();
      c.frequency.value = f; m.frequency.value = f * ratio;
      mg.gain.setValueAtTime(f * index, t);
      mg.gain.exponentialRampToValueAtTime(Math.max(0.5, f * index * 0.02), t + dur * decayIndex);
      m.connect(mg); mg.connect(c.frequency);
      this._env(out, t, vel, attack, dur);
      c.connect(out);
      const nodes = [c, m];
      if (partial2) {
        const o2 = ctx.createOscillator(), g2 = ctx.createGain();
        o2.frequency.value = f * partial2; g2.gain.value = 0.35;
        o2.connect(g2); g2.connect(out); nodes.push(o2);
      }
      this._done(nodes, out, t, t + dur);
    }

    // のこぎり波 → フィルター: はじく音(pluck)と声のような音(formant)
    _saw(f, vel, where, when, { dur = 1, attack = 0.005, cutoff = 2400, q = 2, detune = 8, formant = 0, sweep = 0.3 } = {}) {
      if (!this._ok()) return;
      const ctx = this.ctx, t = ctx.currentTime + 0.01 + when;
      const out = this._out(where);
      const flt = ctx.createBiquadFilter();
      flt.type = formant ? 'bandpass' : 'lowpass'; flt.Q.value = q;
      flt.frequency.setValueAtTime(formant || cutoff, t);
      if (!formant) flt.frequency.exponentialRampToValueAtTime(Math.max(80, cutoff * sweep), t + dur * 0.6);
      this._env(out, t, vel, attack, dur);
      flt.connect(out);
      const nodes = [-detune, detune].map((d) => { const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f; o.detune.value = d; o.connect(flt); return o; });
      this._done(nodes, out, t, t + dur);
    }

    // サイン波の音(ソナー・低音)。glide で音程が滑る
    _sine(f, vel, where, when, { dur = 1.5, attack = 0.01, glide = 1, type = 'sine' } = {}) {
      if (!this._ok()) return;
      const ctx = this.ctx, t = ctx.currentTime + 0.01 + when;
      const out = this._out(where);
      const o = ctx.createOscillator(); o.type = type;
      o.frequency.setValueAtTime(f, t);
      if (glide !== 1) o.frequency.exponentialRampToValueAtTime(f * glide, t + dur * 0.8);
      this._env(out, t, vel, attack, dur);
      o.connect(out);
      this._done([o], out, t, t + dur);
    }

    // ノイズの打音(ハイハット・スネア・泡・羽音)。am で細かく震わせる
    _noise(vel, where, when, { dur = 0.08, freq = 8000, type = 'highpass', q = 0.7, am = 0 } = {}) {
      if (!this._ok()) return;
      const ctx = this.ctx, t = ctx.currentTime + 0.01 + when;
      const out = this._out(where);
      const src = ctx.createBufferSource(); src.buffer = this.noise;
      src.playbackRate.value = 0.8 + Math.random() * 0.4;
      const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
      this._env(out, t, vel, 0.002, dur);
      src.connect(f);
      const nodes = [src];
      if (am) {
        const g = ctx.createGain(), lfo = ctx.createOscillator(), lg = ctx.createGain();
        lfo.frequency.value = am; lg.gain.value = 0.5; g.gain.value = 0.5;
        lfo.connect(lg); lg.connect(g.gain); f.connect(g); g.connect(out); nodes.push(lfo);
      } else f.connect(out);
      this._done(nodes, out, t, t + dur);
    }

    _kick(vel, where, when) {
      if (!this._ok()) return;
      const ctx = this.ctx, t = ctx.currentTime + 0.01 + when;
      const out = this._out(where);
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(130, t); o.frequency.exponentialRampToValueAtTime(40, t + 0.16);
      this._env(out, t, vel, 0.002, 0.45);
      o.connect(out);
      this._done([o], out, t, t + 0.45);
    }

    // ---------- テーマごとの声 ----------
    // role: seed / grow / mature / decay / death / emerge / land / morph / meet / step
    _play(role, species, midi, vel, where, when = 0) {
      if (!this.enabled || !this.ensure()) return;
      const f = mtof(midi);
      const sp = species === 'bird' ? { idx: 1.6, up: 12, short: 0.7 } : species === 'lizard' ? { idx: 0.7, up: 0, short: 0.45 } : { idx: 1, up: 0, short: 1 };
      const fu = f * Math.pow(2, sp.up / 12);
      switch (this.theme) {
        case 'gamelan':
          if (role === 'step') return this._fm(f * 2, vel * 0.5, where, when, { ratio: 5.4, index: 0.8, dur: 0.25 });
          if (role === 'death' || role === 'decay') return this._fm(f / 2, vel, where, when, { ratio: 1.41, index: 2.5, dur: 5, decayIndex: 0.4, partial2: 2.76 }); // ゴング
          return this._fm(fu, vel, where, when, { ratio: 3.5 + (species === 'lizard' ? 1.7 : 0), index: 1.2 * sp.idx, dur: 3.2 * sp.short, partial2: 2.76 });
        case 'choir':
          if (role === 'step') return this._noise(vel * 0.3, where, when, { dur: 0.06, freq: 2500, type: 'bandpass', q: 3 });
          return this._saw(fu, vel * 0.7, where, when, { dur: role === 'mature' ? 4 : 2.6 * sp.short, attack: role === 'seed' ? 0.05 : 0.25, formant: [700, 1100, 2400][species === 'bird' ? 2 : species === 'lizard' ? 1 : 0], q: 4 });
        case 'pulse':
          if (role === 'step') return this._noise(vel * 0.5, where, when, { dur: 0.04, freq: 9000 });
          if (role === 'decay' || role === 'death') return this._sine(f / 2, vel * 1.4, where, when, { dur: 0.6, glide: 0.5, type: 'triangle' });
          return this._saw(fu, vel, where, when, { dur: 0.5 * (species === 'bird' ? 0.6 : 1), cutoff: 3200 * sp.idx, q: 6, sweep: 0.12 });
        case 'abyss':
          if (role === 'step') return this._noise(vel * 0.4, where, when, { dur: 0.3, freq: 600, type: 'lowpass', am: 18 });
          if (role === 'emerge' || role === 'land') return this._sine(fu * 2, vel, where, when, { dur: 3.5, attack: 0.002, glide: 0.92 }); // ソナー
          return this._sine(fu, vel * 1.2, where, when, { dur: 2.6 * sp.short, attack: 0.02, glide: role === 'decay' ? 0.7 : 1 });
        default: // crystal
          if (role === 'step') return this._fm(f * 4, vel * 0.3, where, when, { ratio: 5, index: 0.5, dur: 0.12 });
          return this._fm(fu, vel, where, when, { ratio: 2, index: 1.3 * sp.idx, dur: 2.4 * sp.short });
      }
    }

    // ---------- 背景の響き(ベッド) ----------
    _startBed() {
      const ctx = this.ctx;
      const g = ctx.createGain(); g.gain.value = 0;
      const flt = ctx.createBiquadFilter(); flt.type = 'lowpass'; flt.frequency.value = 500; flt.Q.value = 0.8;
      flt.connect(g); g.connect(this.dry);
      const oscs = [];
      const tones = this._bedTones();
      const type = { crystal: 'triangle', gamelan: 'sine', choir: 'sawtooth', pulse: 'sawtooth', abyss: 'sine' }[this.theme];
      tones.forEach((m, i) => {
        for (const det of [-6, 6]) {
          const o = ctx.createOscillator(); o.type = type; o.frequency.value = mtof(m); o.detune.value = det;
          const og = ctx.createGain(); og.gain.value = (i === 0 ? 0.11 : 0.06) * (type === 'sawtooth' ? 0.5 : 1);
          o.connect(og); og.connect(flt); o.start(); oscs.push(o);
        }
      });
      // 空気のざわめき(ノイズ)
      const air = ctx.createBufferSource(); air.buffer = this.noise; air.loop = true;
      const af = ctx.createBiquadFilter(); af.type = 'bandpass'; af.frequency.value = this.theme === 'abyss' ? 250 : 2200; af.Q.value = 0.6;
      const ag = ctx.createGain(); ag.gain.value = this.theme === 'abyss' ? 0.08 : 0.025;
      air.connect(af); af.connect(ag); ag.connect(g); air.start();
      // ゆっくり揺れるフィルター
      const lfo = ctx.createOscillator(), lg = ctx.createGain();
      lfo.frequency.value = 0.05; lg.gain.value = 220; lfo.connect(lg); lg.connect(flt.frequency); lfo.start();
      this.bed = { g, flt, oscs, air, lfo };
      this._bedLevel();
    }

    _bedTones() {
      const d = this.chordDegrees;
      return [this.degreeToMidi(d[0], this.root - 12), this.degreeToMidi(d[1], this.root - 12) + 12, this.degreeToMidi(d[2], this.root)];
    }

    _stopBed() {
      const b = this.bed;
      if (!b) return;
      b.g.gain.setTargetAtTime(0, this.ctx.currentTime, 0.6);
      setTimeout(() => { for (const o of b.oscs) o.stop(); b.air.stop(); b.lfo.stop(); b.g.disconnect(); }, 3000);
      this.bed = null;
    }

    _bedLevel() {
      const b = this.bed;
      if (!b) return;
      const t = this.ctx.currentTime, a = this.activity;
      // 生命がいない時は完全に消える(ドローンの鳴り方の時だけ、静かに残す)
      const level = this.pattern === 'drone' ? 0.9 * (0.15 + 0.85 * a) : (0.55 * Math.max(0, a - 0.02)) / 0.98;
      b.g.gain.setTargetAtTime(this.enabled ? level : 0, t, 0.9);
      b.flt.frequency.setTargetAtTime(300 + 2600 * a * a, t, 1.0);
      this.tone.frequency.setTargetAtTime(2500 + 9000 * a, t, 1.5);
    }

    // コードが変わったら、背景の響きの音程も滑らかに移す
    _retuneBed() {
      const b = this.bed;
      if (!b) return;
      const tones = this._bedTones(), t = this.ctx.currentTime;
      b.oscs.forEach((o, k) => o.frequency.setTargetAtTime(mtof(tones[Math.floor(k / 2)]), t, 1.5));
    }

    // 毎フレーム: 聴き手(カメラ)と、活動量・コード進行
    update(dt, activity, camera) {
      if (!this.ctx) return;
      // 盛り上がりにはすぐ付いていき、静まる時はゆっくり(3 秒ほど)消える
      const target = clamp(activity, 0, 1);
      this.activity += (target - this.activity) * Math.min(1, dt * (target > this.activity ? 1.5 : 0.6));
      if (this.activity < 0.005) this.activity = 0;
      this.chordT += dt;
      if (this.chordT > 12) { this.chordT = 0; this.chordIndex++; this._retuneBed(); }
      this._bedT = (this._bedT || 0) + dt;
      if (this._bedT > 0.5) { this._bedT = 0; this._bedLevel(); }
      const L = this.ctx.listener;
      if (camera && L) {
        const p = camera.position, f = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion), u = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
        if (L.positionX) {
          const t = this.ctx.currentTime;
          L.positionX.setTargetAtTime(p.x, t, 0.05); L.positionY.setTargetAtTime(p.y, t, 0.05); L.positionZ.setTargetAtTime(p.z, t, 0.05);
          L.forwardX.setTargetAtTime(f.x, t, 0.05); L.forwardY.setTargetAtTime(f.y, t, 0.05); L.forwardZ.setTargetAtTime(f.z, t, 0.05);
          L.upX.setTargetAtTime(u.x, t, 0.05); L.upY.setTargetAtTime(u.y, t, 0.05); L.upZ.setTargetAtTime(u.z, t, 0.05);
        } else { L.setPosition(p.x, p.y, p.z); L.setOrientation(f.x, f.y, f.z, u.x, u.y, u.z); }
      }
    }

    // ---------- 出来事 ----------
    // w: { u(周方向 0..1), pos(3D 位置) }
    seed(w, species) {
      if (!this.enabled || this.pattern === 'drone') return;
      const q = this._quantize();
      if (this.pattern === 'rhythm') this._kick(0.5, w, q);
      this._play('seed', species, this.noteAt(w.u, 1), 0.22, w, q);
    }

    step(ev, whereOf) {
      if (!this.enabled || !this.ctx) return;
      const now = performance.now();
      const pat = this.pattern;
      if (ev.born.length) {
        const gap = pat === 'rhythm' ? 120 : pat === 'melodic' ? 160 : pat === 'drone' ? 2200 : 260;
        if (now - this.lastGrowth > gap) {
          this.lastGrowth = now;
          const c = ev.born[Math.floor(Math.random() * ev.born.length)];
          const w = whereOf(c);
          const q = this._quantize();
          const vel = clamp(0.05 + ev.born.length * 0.004, 0.05, 0.16);
          if (pat === 'rhythm') {
            this._noise(0.06 + vel * 0.3, w, q, { dur: 0.05, freq: 7000 + Math.random() * 3000 });
            if (Math.random() < 0.35) this._play('grow', c.species, this.noteAt(w.u, 1), vel, w, q);
          } else if (pat === 'melodic') {
            // 波が外へ広がるほど音程が上がる旋律
            const tones = this.chordTones(this.root, this.root + 36);
            this._play('grow', c.species, tones[Math.min(tones.length - 1, c.generation % tones.length)], vel + 0.04, w, q);
          } else {
            this._play('grow', c.species, this.noteAt(w.u, 1) + (c.generation % 3 === 0 ? 12 : 0), vel, w, q);
          }
        }
      }
      if (pat === 'drone') return;
      for (const c of ev.matured) {
        if (c.origin !== c.id) continue;
        // 成熟: 種の場所でコード
        const w = whereOf(c);
        const tones = this.chordTones(this.root, this.root + 24);
        const q = this._quantize();
        tones.slice(0, 4).forEach((m, i) => this._play('mature', c.species, m, 0.07, w, q + i * (pat === 'rhythm' ? 60 / this.bpm / 4 : 0.07)));
        if (pat === 'rhythm') this._sine(mtof(this.root - 12), 0.25, w, q, { dur: 0.7, type: 'triangle' });
      }
      for (const c of ev.decayed) {
        if (c.origin !== c.id) continue;
        const w = whereOf(c);
        if (pat === 'rhythm') this._noise(0.12, w, this._quantize(2), { dur: 0.18, freq: 1800, type: 'bandpass', q: 0.8 });
        this._play('decay', c.species, this.noteAt(w.u, 0), 0.07, w, this._quantize());
      }
      for (const c of ev.died) {
        if (c.origin !== c.id) continue;
        this._play('death', c.species, this.noteAt(whereOf(c).u, -1), 0.06, whereOf(c), 0.1);
      }
    }

    emerge(species, w) {
      if (!this.enabled) return;
      const q = this._quantize();
      if (species === 'bird') this._noise(0.12, w, q, { dur: 0.9, freq: 1400, type: 'bandpass', am: 14 }); // 羽音
      else if (species === 'lizard') for (let k = 0; k < 4; k++) this._noise(0.08, w, q + 0.5 + k * 0.08, { dur: 0.04, freq: 3000, type: 'bandpass', q: 3 });
      else this._sine(mtof(this.noteAt(w.u, 0)), 0.1, w, q, { dur: 1.8, attack: 0.4, glide: 3 }); // 泡が昇る
      this._play('emerge', species, this.noteAt(w.u, 1) + 12, 0.16, w, q + (species === 'fish' ? 0.6 : 0.9));
    }

    landed(species, w) {
      if (!this.enabled) return;
      const q = this._quantize();
      if (species === 'fish') this._sine(mtof(this.noteAt(w.u, 1)) * 1.6, 0.12, w, q, { dur: 0.5, glide: 0.5 }); // ぽちゃん
      if (species === 'bird') this._play('land', 'bird', this.noteAt(w.u, 2), 0.14, w, q + 0.16);
      this._play('land', species, this.noteAt(w.u, 1), 0.18, w, q);
    }

    morph(from, to, w) {
      if (!this.enabled) return;
      const tones = this.chordTones(this.root + 12, this.root + 48);
      const start = Math.floor(Math.random() * 3);
      for (let k = 0; k < 6; k++) this._play('morph', k < 3 ? from : to, tones[Math.min(tones.length - 1, start + k)], 0.06, w, k * 0.07);
    }

    meet(w) {
      if (!this.enabled) return;
      const tones = this.chordTones(this.root + 12, this.root + 36);
      tones.slice(0, 4).forEach((m, i) => this._play('meet', 'fish', m, 0.07, w, i * 0.04));
    }

    footstep(species, w) {
      if (!this.enabled || !this.ctx || Math.random() < 0.4) return;
      this._play('step', species, this.noteAt(w.u, 2), 0.05, w, 0);
    }
  }

  TL.AUDIO_THEMES = THEMES;
  TL.AUDIO_SCALES = SCALES;
  TL.AUDIO_PATTERNS = PATTERNS;
  TL.AudioSystem = AudioSystem;
})(window.TL = window.TL || {});
