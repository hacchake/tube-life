// 映像の仕上げ(メディアアートとしての質感)
//
//   GradePass : 最後にかける画面処理。色調(テーマ)・周辺減光・色のにじみ・フィルムの粒子・呼吸する明るさ
//   Motes     : チューブの中を漂う光の粒子(生命の気配)。活動が増えると明るく速くなる
//   Bursts    : 生命が生まれた所・生物が着いた所から湧き上がる光の粒
//   Trails    : 泳ぐ・飛ぶ生物が残す光の軌跡
(function (TL) {
  'use strict';
  const { clamp } = TL.util;

  // 丸くぼけた光の点(粒子のテクスチャ)
  function dotTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.25, 'rgba(255,255,255,0.55)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 64, 64);
    const t = new THREE.CanvasTexture(c);
    return t;
  }

  // ---------- 画面処理 ----------
  const GradeShader = {
    uniforms: {
      tDiffuse: { value: null },
      uTime: { value: 0 },
      uTint: { value: new THREE.Color(1, 1, 1) },
      uShadow: { value: new THREE.Color(0, 0, 0) },
      uVignette: { value: 1.1 },
      uAberration: { value: 0.0025 },
      uGrain: { value: 0.05 },
      uPulse: { value: 0 },
      uInvert: { value: 0 },
    },
    vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      uniform sampler2D tDiffuse; uniform float uTime, uVignette, uAberration, uGrain, uPulse, uInvert;
      uniform vec3 uTint, uShadow; varying vec2 vUv;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
      void main() {
        vec2 c = vUv - 0.5;
        float r = length(c);
        // 色のにじみ: 画面の端ほど赤と青がずれる
        vec2 off = c * uAberration * (0.5 + r * 2.0);
        vec3 col = vec3(texture2D(tDiffuse, vUv + off).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - off).b);
        // 色調: 暗部に影の色を、明部にテーマの色を
        float l = dot(col, vec3(0.299, 0.587, 0.114));
        col = mix(uShadow, col * uTint, 0.7 + 0.3 * smoothstep(0.0, 0.45, l));
        col = mix(col, vec3(1.0) - col * 0.92, uInvert);
        // ゆっくり呼吸する明るさと周辺減光
        col *= 1.0 + uPulse * 0.04 * sin(uTime * 0.6);
        col *= smoothstep(1.25, 0.25, r * uVignette);
        // フィルムの粒子
        col += (hash(vUv * vec2(1920.0, 1080.0) + fract(uTime * 7.0)) - 0.5) * uGrain;
        // 合成はリニアな色のまま行うので、最後に画面の色空間(sRGB)へ
        gl_FragColor = LinearTosRGB(vec4(max(col, 0.0), 1.0));
      }`,
  };

  // ---------- 漂う光の粒子 ----------
  class Motes {
    constructor(scene, count = 1400) {
      this.count = count;
      const g = new THREE.BufferGeometry();
      this.pos = new Float32Array(count * 3);
      this.col = new Float32Array(count * 3);
      g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
      g.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
      this.mat = new THREE.PointsMaterial({ size: 0.22, map: dotTexture(), vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true });
      this.points = new THREE.Points(g, this.mat);
      this.points.frustumCulled = false;
      scene.add(this.points);
      // 平面座標 (x, y) と壁からの高さ h、漂う速さ
      this.p = Array.from({ length: count }, () => ({ x: 0, y: 0, h: 0, vy: 0, vx: 0, tw: Math.random() * 10 }));
      this.color = new THREE.Color(0.6, 0.75, 1);
    }

    setSpace(space) {
      this.space = space;
      for (const q of this.p) this._respawn(q, true);
    }

    _respawn(q, anywhere) {
      const s = this.space;
      q.x = Math.random() * s.C;
      q.y = anywhere ? Math.random() * s.L : (Math.random() < 0.5 ? 0 : s.L);
      q.h = 0.6 + Math.random() * (s.R - 1.2);
      q.vy = (Math.random() - 0.5) * 0.6;
      q.vx = (Math.random() - 0.5) * 0.4;
    }

    update(dt, time, activity) {
      if (!this.space) return;
      const s = this.space, v = new THREE.Vector3();
      const speed = 0.4 + activity * 2.2, glow = 0.25 + activity * 0.9;
      for (let i = 0; i < this.count; i++) {
        const q = this.p[i];
        q.y += q.vy * speed * dt;
        q.x += (q.vx + Math.sin(time * 0.3 + q.tw) * 0.3) * speed * dt;
        q.h += Math.sin(time * 0.5 + q.tw * 2) * 0.1 * dt;
        if (!s.periodicY && (q.y < 0 || q.y > s.L)) this._respawn(q, true);
        else if (s.periodicY) q.y = ((q.y % s.L) + s.L) % s.L;
        s.point(q.x, q.y, clamp(q.h, 0.4, s.R - 0.4), v);
        this.pos[i * 3] = v.x; this.pos[i * 3 + 1] = v.y; this.pos[i * 3 + 2] = v.z;
        const tw = glow * (0.4 + 0.6 * Math.pow(0.5 + 0.5 * Math.sin(time * 1.3 + q.tw * 5), 3));
        this.col[i * 3] = this.color.r * tw; this.col[i * 3 + 1] = this.color.g * tw; this.col[i * 3 + 2] = this.color.b * tw;
      }
      this.points.geometry.attributes.position.needsUpdate = true;
      this.points.geometry.attributes.color.needsUpdate = true;
    }
  }

  // ---------- 湧き上がる光の粒 ----------
  class Bursts {
    constructor(scene, max = 700) {
      this.max = max;
      const g = new THREE.BufferGeometry();
      this.pos = new Float32Array(max * 3);
      this.col = new Float32Array(max * 3);
      g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
      g.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
      this.points = new THREE.Points(g, new THREE.PointsMaterial({ size: 0.32, map: dotTexture(), vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      this.points.frustumCulled = false;
      scene.add(this.points);
      this.parts = [];
      this.next = 0;
    }

    // pos から、法線 normal の向きを中心に n 個の粒を飛ばす
    emit(pos, normal, color, n = 40, speed = 3) {
      const c = new THREE.Color(color);
      for (let k = 0; k < n; k++) {
        const dir = normal.clone().multiplyScalar(0.6 + Math.random()).add(new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(1.4)).normalize();
        const i = this.next++ % this.max;
        this.parts[i] = { p: pos.clone(), v: dir.multiplyScalar(speed * (0.4 + Math.random())), life: 0, max: 1.2 + Math.random() * 1.6, c };
      }
    }

    update(dt) {
      for (let i = 0; i < this.max; i++) {
        const q = this.parts[i];
        if (!q || q.life >= q.max) { this.pos[i * 3 + 1] = 1e5; continue; }
        q.life += dt;
        q.v.multiplyScalar(Math.exp(-dt * 1.4));
        q.p.addScaledVector(q.v, dt);
        const a = 1 - q.life / q.max;
        this.pos[i * 3] = q.p.x; this.pos[i * 3 + 1] = q.p.y; this.pos[i * 3 + 2] = q.p.z;
        this.col[i * 3] = q.c.r * a * 1.5; this.col[i * 3 + 1] = q.c.g * a * 1.5; this.col[i * 3 + 2] = q.c.b * a * 1.5;
      }
      this.points.geometry.attributes.position.needsUpdate = true;
      this.points.geometry.attributes.color.needsUpdate = true;
    }
  }

  // ---------- 光の軌跡 ----------
  class Trails {
    constructor(scene, len = 48) {
      this.scene = scene;
      this.len = len;
      this.map = new Map(); // creature → trail
      this.pool = [];
    }

    _make() {
      const g = new THREE.BufferGeometry();
      const pos = new Float32Array(this.len * 3), col = new Float32Array(this.len * 3);
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      const line = new THREE.Line(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
      line.frustumCulled = false;
      this.scene.add(line);
      return { line, pos, col, pts: [], color: new THREE.Color(), fade: 1 };
    }

    update(creatures, dt) {
      const alive = new Set();
      for (const c of creatures) {
        if (!c.mesh.visible) continue;
        alive.add(c);
        let t = this.map.get(c);
        if (!t) { t = this.pool.pop() || this._make(); t.pts = []; t.fade = 1; t.line.visible = true; this.map.set(c, t); }
        t.color.copy(c.mat.emissive).lerp(c.mat.color, 0.4);
        const moving = c.phase === 'travel' || (c.phase && c.phase.startsWith('meta-'));
        if (moving) t.pts.unshift(c.mesh.position.clone());
        else if (t.pts.length) t.pts.pop();
        if (t.pts.length > this.len) t.pts.length = this.len;
      }
      for (const [c, t] of this.map) {
        if (!alive.has(c)) {
          t.fade -= dt * 1.5;
          if (t.pts.length) t.pts.pop();
          if (t.fade <= 0 || !t.pts.length) { t.line.visible = false; this.map.delete(c); this.pool.push(t); continue; }
        }
        const n = t.pts.length;
        for (let i = 0; i < this.len; i++) {
          const p = t.pts[Math.min(i, n - 1)] || new THREE.Vector3(0, 1e5, 0);
          t.pos[i * 3] = p.x; t.pos[i * 3 + 1] = p.y; t.pos[i * 3 + 2] = p.z;
          const a = i < n ? Math.pow(1 - i / this.len, 1.6) * t.fade : 0;
          t.col[i * 3] = t.color.r * a; t.col[i * 3 + 1] = t.color.g * a; t.col[i * 3 + 2] = t.color.b * a;
        }
        t.line.geometry.attributes.position.needsUpdate = true;
        t.line.geometry.attributes.color.needsUpdate = true;
      }
    }

    clear() { for (const [, t] of this.map) { t.line.visible = false; this.pool.push(t); } this.map.clear(); }
  }

  TL.GradeShader = GradeShader;
  TL.Motes = Motes;
  TL.Bursts = Bursts;
  TL.Trails = Trails;
})(window.TL = window.TL || {});
