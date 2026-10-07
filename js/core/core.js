// 共通基盤: イベントバス・乱数・数値ユーティリティ・保存
// file:// で直接開けるよう、ES Modules ではなく window.TL 名前空間で各モジュールをつなぐ。
(function (TL) {
  'use strict';

  class EventBus {
    constructor() { this.map = new Map(); }
    on(type, fn) {
      if (!this.map.has(type)) this.map.set(type, new Set());
      this.map.get(type).add(fn);
      return () => this.map.get(type).delete(fn);
    }
    emit(type, payload) {
      const set = this.map.get(type);
      if (set) for (const fn of [...set]) fn(payload);
    }
  }

  // 再現できる乱数(Random Seed 用)
  function makeRng(seed) {
    let a = seed >>> 0;
    const rng = () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    rng.int = (n) => Math.floor(rng() * n);
    rng.pick = (arr) => arr[Math.floor(rng() * arr.length)];
    return rng;
  }

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };

  const Store = {
    load(key, fallback) {
      try { const s = localStorage.getItem(key); return s ? JSON.parse(s) : fallback; } catch (e) { return fallback; }
    },
    save(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* 保存できない環境では無視 */ }
    },
  };

  TL.EventBus = EventBus;
  TL.makeRng = makeRng;
  TL.util = { clamp, lerp, smooth };
  TL.Store = Store;
})(window.TL = window.TL || {});
