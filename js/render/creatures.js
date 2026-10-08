// 生物(Creature)の 3D 表示と移動。CA とはイベントだけでつながる。
//
// 生物の一生は「区間(leg)」の列としてできている:
//   emerge : タイルの上に平たい生物が現れ、光り、浮き上がり、厚みを持つ(2D → 3D)
//   travel : 区間を順に進む。区間には 2 種類ある
//              air  : チューブの中を通る(魚 = 泳ぐ / 鳥 = 羽ばたいて飛ぶ)
//              wall : 壁面に沿って進む(トカゲ = 這う / カエル = 跳ねる / 獣 = 駆ける)
//   land   : 目的のタイルに近づき、平たくなって壁に溶け込む → 'landed' を発行
//   fade   : 消えてプールへ戻る
//
// ふつうの生物は区間 1 つ。変態(Metamorphosis)は 魚 → 両生類 → 爬虫類 → 鳥 → 哺乳類 の 5 区間で、
// 各区間の始めに前の種から次の種へ、輪郭・姿勢・体の動き・色・大きさを滑らかに混ぜて姿を変える。
// 経路は Topology の平面座標と Space で作るので、円筒以外の空間でも同じように動く。
(function (TL) {
  'use strict';
  const { clamp, smooth, lerp } = TL.util;

  const POOL_MAX = 48;
  const WALL = { crawl: true, hop: true, run: true };
  const tmpM = new THREE.Matrix4();

  // 体の変形(頂点シェーダー)。position は輪郭の座標(長さ 1、頭が +X)。5 種類の動きを重みで混ぜる。
  const DEFORM = `
    // 尾を振る(魚): 後ろほど大きく体の横(Z)へ
    float tailw = smoothstep(0.3, -0.5, position.x);
    transformed.z += sin(uTime * uFreq - position.x * 7.0) * uAmp * (0.2 + tailw) * wTail;
    // 羽ばたき(鳥): 胴から離れるほど大きく背の方向(Z)へ。翼の先は少し遅れてしなる
    float span = abs(position.y);
    float wing = smoothstep(0.1, 0.72, span);
    transformed.z += sin(uTime * uFreq - span * 2.2) * uAmp * wing * span * 1.8 * wWing;
    // くねり(トカゲ): 体を左右(Y)へ波打たせる。尾ほど大きい
    float bodyw = 0.35 + smoothstep(0.0, -0.5, position.x) * 1.3;
    transformed.y += sin(uTime * uFreq - position.x * 9.0) * uAmp * bodyw * 0.3 * wBody;
    // 跳躍(カエル): 空中で後脚を後ろへ蹴り伸ばす(uAmp = 蹴りの強さ)
    float legm = smoothstep(0.12, 0.32, abs(position.y)) * (1.0 - smoothstep(-0.25, 0.05, position.x));
    transformed.x -= uAmp * legm * 0.32 * wHop;
    transformed.y += sign(position.y) * uAmp * legm * 0.1 * wHop;
    // 駆け足(獣): 前脚と後脚を交互に前後へ振る
    float leg = smoothstep(-0.1, -0.28, position.y);
    float ph = position.x > 0.0 ? 0.0 : 3.14159;
    transformed.x += sin(uTime * uFreq + ph) * uAmp * leg * 0.55 * wRun;
    transformed.y += max(0.0, sin(uTime * uFreq + ph)) * uAmp * leg * 0.08 * wRun;
  `;
  const WEIGHTS = { tail: [1, 0, 0, 0, 0], wings: [0, 1, 0, 0, 0], body: [0, 0, 1, 0, 0], hop: [0, 0, 0, 1, 0], run: [0, 0, 0, 0, 1] };
  const W_NAMES = ['wTail', 'wWing', 'wBody', 'wHop', 'wRun'];

  function basisQuat(x, y, z, out) {
    tmpM.makeBasis(x, y, z);
    return out.setFromRotationMatrix(tmpM);
  }

  // 壁に平たく張り付いた向き: 頭 = 壁に沿った向き dir、輪郭の面 = 壁の面(Z = 内向きの法線)
  function flatQuat(normal, dir, out = new THREE.Quaternion()) {
    const x = dir.clone().addScaledVector(normal, -dir.dot(normal)).normalize();
    const z = normal.clone();
    const y = new THREE.Vector3().crossVectors(z, x);
    return basisQuat(x, y, z, out);
  }

  // 移動中の向き。背中を up(チューブの中心側・壁の法線)へ向ける。
  //   side(魚・獣): 輪郭の Y が背   top(カエル・トカゲ・鳥): 輪郭の Z が背
  function travelQuat(pose, fwd, up0, roll, out = new THREE.Quaternion()) {
    const x = fwd.clone().normalize();
    const up = up0.clone().addScaledVector(x, -up0.dot(x)).normalize();
    if (roll) up.applyAxisAngle(x, roll);
    if (pose === 'top') return basisQuat(x, new THREE.Vector3().crossVectors(up, x), up, out);
    return basisQuat(x, up, new THREE.Vector3().crossVectors(x, up), out);
  }

  // 壁面上の経路。高さ h(s) は動き方で変わる(這う = 低く一定、跳ねる = 弧、駆ける = 脚の長さ)。
  class WallPath {
    constructor(space, x0, y0, x1, y1, rng, heightFn) {
      this.space = space;
      this.heightFn = heightFn;
      const C = space.C;
      let dx = x1 - x0;
      dx -= C * Math.round(dx / C); // 周方向は近い方へ
      let dy = y1 - y0;
      if (space.periodicY) dy -= space.L * Math.round(dy / space.L); // トーラスでは長さ方向も近い方へ
      this.a = [x0, y0];
      this.d = [dx, dy];
      const len = Math.hypot(dx, dy) || 1;
      this.n = [-this.d[1] / len, this.d[0] / len];
      this.wiggle = (0.6 + rng() * 0.8) * (rng() < 0.5 ? -1 : 1);
      this.waves = 1 + Math.floor(rng() * 2);
      this.length = len * 1.15;
    }
    plane(s) {
      const m = this.wiggle * Math.sin(Math.PI * s) * Math.sin(2 * Math.PI * this.waves * s);
      return [this.a[0] + this.d[0] * s + this.n[0] * m, this.a[1] + this.d[1] * s + this.n[1] * m];
    }
    getPointAt(s, out = new THREE.Vector3()) {
      s = clamp(s, 0, 1);
      const [x, y] = this.plane(s);
      return this.space.point(x, y, this.heightFn(s), out);
    }
    getTangentAt(s) {
      const e = 0.002;
      const [x0, y0] = this.plane(clamp(s - e, 0, 1)), [x1, y1] = this.plane(clamp(s + e, 0, 1));
      const a = this.space.point(x0, y0, 0.2), b = this.space.point(x1, y1, 0.2); // 跳ねる高さに引きずられない向き
      return b.sub(a).normalize();
    }
    getLength() { return this.length; }
  }

  // 変態用: 種の輪郭を鼻先から反時計回りに、等間隔の N 点へ
  const N = 120;
  const outlines = {};
  function resampled(sp) {
    if (outlines[sp.id]) return outlines[sp.id];
    const pts = sp.outline(THREE).getSpacedPoints(N);
    if (pts[0].distanceTo(pts[pts.length - 1]) < 1e-6) pts.pop();
    if (THREE.ShapeUtils.isClockWise(pts)) { const first = pts.shift(); pts.reverse(); pts.unshift(first); }
    outlines[sp.id] = pts.slice(0, N);
    return outlines[sp.id];
  }
  const tmpA = new THREE.Color(), tmpB = new THREE.Color();

  class CreatureSystem {
    constructor(scene, space, rng) {
      this.scene = scene;
      this.space = space;
      this.rng = rng || Math.random;
      this.bus = new TL.EventBus();
      this.geoms = {};
      this.pool = [];
      this.active = [];
      this.time = 0;
    }

    // outline: THREE.Shape(省略時は種の輪郭)。key はキャッシュ用の名前。
    _geometry(species, outline, key) {
      if (this.geoms[key]) return this.geoms[key];
      const g = new THREE.ExtrudeGeometry(outline || species.outline(THREE), {
        depth: species.thickness, bevelEnabled: true, bevelThickness: 0.02, bevelSize: 0.015, bevelSegments: 2, curveSegments: 14,
      });
      g.translate(0, 0, -species.thickness / 2);
      g.computeVertexNormals();
      this.geoms[key] = g;
      return g;
    }

    _make(species, outline, key) {
      const mat = new THREE.MeshStandardMaterial({
        color: species.color, emissive: species.emissive, emissiveIntensity: 0.6,
        roughness: 0.35, metalness: 0.15, transparent: true, side: THREE.DoubleSide,
      });
      const uniforms = { uTime: { value: 0 }, uAmp: { value: 0 }, uFreq: { value: 9 } };
      for (const n of W_NAMES) uniforms[n] = { value: 0 };
      mat.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, uniforms);
        shader.vertexShader = 'uniform float uTime, uAmp, uFreq, ' + W_NAMES.join(', ') + ';\n' +
          shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n' + DEFORM);
        // 縁の光(フレネル): 体の輪郭が見る角度で発光し、闇の中に形が浮かぶ
        shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          float rimF = pow(1.0 - clamp(abs(dot(normalize(normal), normalize(vViewPosition))), 0.0, 1.0), 2.2);
          totalEmissiveRadiance += (emissive + diffuseColor.rgb * 0.5) * rimF * 2.2;`);
      };
      mat.customProgramCacheKey = () => 'creature5';
      const mesh = new THREE.Mesh(this._geometry(species, outline, key), mat);
      const eyeM = new THREE.MeshBasicMaterial({ color: 0x050812, transparent: true });
      const c = { mesh, mat, eyeM, uniforms, species, key, eyes: [] };
      this._setEyes(c, species.eyes, species.thickness);
      mesh.visible = false;
      this.scene.add(mesh);
      return c;
    }

    _setEyes(c, eyes, thickness) {
      for (const e of c.eyes) c.mesh.remove(e);
      c.eyes = [];
      const eyeG = this._eyeG || (this._eyeG = new THREE.SphereGeometry(0.03, 10, 8));
      for (const [x, y, side] of eyes || []) {
        const e = new THREE.Mesh(eyeG, c.eyeM);
        e.position.set(x, y, side * (thickness / 2 + 0.01));
        c.mesh.add(e);
        c.eyes.push(e);
      }
    }

    _setWeights(c, sp) {
      const w = WEIGHTS[sp.deform];
      W_NAMES.forEach((n, i) => { c.uniforms[n].value = w[i]; });
    }

    get count() { return this.active.length; }

    countBy() {
      const out = {};
      for (const c of this.active) {
        const id = (c.meta ? 'meta:' : '') + (c.shown || c.species).id;
        out[id] = (out[id] || 0) + 1;
      }
      return out;
    }

    // 平面上で a → b へ(周方向は近い方)
    _planeLerp(a, b, u) {
      const C = this.space.C;
      let dx = b.x - a.x;
      dx -= C * Math.round(dx / C);
      let dy = b.y - a.y;
      if (this.space.periodicY) dy -= this.space.L * Math.round(dy / this.space.L);
      return { x: a.x + dx * u, y: a.y + dy * u };
    }

    // 壁の上での高さ(脚の長さ)。獣は脚で立つので高い
    standHeight(sp, length) { return sp.motion === 'run' ? length * 0.32 : WALL[sp.motion] ? 0.14 : 0.5; }

    // チューブの中を通る区間: from の高さ h0 から、to の高さ h1 へ
    _airPath(sp, from, to, h0, h1) {
      const space = this.space, R = space.R, rng = this.rng;
      const f0 = space.frame(from.x, from.y), f1 = space.frame(to.x, to.y);
      const at = (u, r, swirl) => {
        const p = this._planeLerp(from, to, u);
        return space.point(p.x + (swirl * space.C) / (2 * Math.PI), p.y + (rng() - 0.5) * 2, R - r);
      };
      let mids;
      const routed = space.route && space.route(from, to, rng); // 分岐をまたぐ時は分かれ目を通る
      if (routed) mids = routed;
      else if (sp.motion === 'fly') {
        // 鳥: 一気に中心近くまで舞い上がり、らせんを描きながら奥へ飛ぶ
        const turn = (rng() < 0.5 ? -1 : 1) * (0.8 + rng() * 1.2);
        mids = [0.2, 0.4, 0.6, 0.8].map((u) => at(u, R * (0.15 + 0.3 * rng()), turn * Math.sin(Math.PI * u)));
      } else {
        mids = [at(0.33, R * (0.35 + rng() * 0.3), (rng() - 0.5) * 0.9), at(0.66, R * (0.35 + rng() * 0.3), (rng() - 0.5) * 0.9)];
      }
      const lift0 = sp.motion === 'fly' ? 1.4 : 0.9;
      return new THREE.CatmullRomCurve3([
        f0.pos.clone().addScaledVector(f0.normal, h0), f0.pos.clone().addScaledVector(f0.normal, Math.max(h0, lift0)),
        ...mids,
        f1.pos.clone().addScaledVector(f1.normal, Math.max(h1, 0.9)), f1.pos.clone().addScaledVector(f1.normal, h1),
      ], false, 'centripetal');
    }

    // 壁に沿う区間。跳ねる = 何度も弧を描く、駆ける = 脚の長さで少し上下する
    _wallPath(sp, from, to, length) {
      const base = this.standHeight(sp, length);
      let hFn;
      const path = new WallPath(this.space, from.x, from.y, to.x, to.y, this.rng, (s) => hFn(s));
      if (sp.motion === 'hop') {
        const hops = Math.max(2, Math.round(path.getLength() / 2.4));
        path.hops = hops;
        hFn = (s) => base + 1.1 * Math.abs(Math.sin(Math.PI * hops * s));
      } else if (sp.motion === 'run') {
        hFn = (s) => base + 0.08 * Math.abs(Math.sin(Math.PI * 9 * s));
      } else hFn = () => base;
      return path;
    }

    // 区間を作る。prev は 1 つ前の区間の種(変態の時に姿を変える元)
    _leg(sp, from, to, length, prev, h0) {
      const wall = !!WALL[sp.motion];
      const path = wall ? this._wallPath(sp, from, to, length) : this._airPath(sp, from, to, h0 ?? 0.5, 0.5);
      const dur = clamp(path.getLength() / sp.speed, wall ? 2.2 : 3, 9);
      return { sp, prev: prev || sp, wall, path, dur, from, to };
    }

    _take(key, sp, outline) {
      if (this.active.length >= POOL_MAX) return null;
      let c = this.pool.find((p) => p.key === key);
      if (c) this.pool.splice(this.pool.indexOf(c), 1);
      else c = this._make(sp, outline, key);
      return c;
    }

    _begin(c, legs, { chain, tile }) {
      const space = this.space;
      const first = legs[0], last = legs[legs.length - 1];
      const from = first.from, to = last.to;
      const f0 = space.frame(from.x, from.y), f1 = space.frame(to.x, to.y);
      const t0 = first.path.getTangentAt(0), t1 = last.path.getTangentAt(1);
      const sp = first.sp;
      const tileDir = (f) => f.tu.clone().multiplyScalar(Math.cos(tile.head)).addScaledVector(f.tv, Math.sin(tile.head));
      const p0 = first.path.getPointAt(0);
      const up0 = first.wall ? f0.normal : space.toAxis(p0);
      Object.assign(c, {
        phase: 'emerge', t: 0, dur: sp.emergeTime, chain, from, to, legs, li: 0, f0, f1,
        qFlat0: flatQuat(f0.normal, tile ? tileDir(f0) : t0),
        qFlat1: flatQuat(f1.normal, tile ? tileDir(f1) : t1),
        qTravel0: travelQuat(sp.pose, t0, up0, 0),
        q: new THREE.Quaternion(),
        phaseOffset: this.rng() * 10,
        stepT: 0,
        shown: sp,
        poseW: sp.pose === 'top' ? 1 : 0,
        emergeLift: first.wall ? this.standHeight(sp, c.length) : 0.5,
      });
      this._setWeights(c, sp);
      c.mat.color.set(sp.color);
      c.mat.emissive.set(sp.emissive);
      c.mesh.visible = true;
      c.mesh.quaternion.copy(c.qFlat0);
      c.mat.opacity = 1;
      c.eyeM.opacity = 1;
      this.active.push(c);
      this.bus.emit('emerge', { creature: c, cell: from });
      return c;
    }

    // ふつうの生物: from / to は { id, x, y }(平面座標)
    // opts.tile: Escher のタイルから出る時の { shape, key, length, head, eyes }。タイルの輪郭そのものを立体化する。
    spawn(from, to, { species = 'fish', chain = 0, tile = null } = {}) {
      const sp = TL.Species.get(species);
      if (!sp.ready) return null;
      const c = this._take(tile ? tile.key : sp.id, sp, tile && tile.shape);
      if (!c) return null;
      if (tile) this._setEyes(c, tile.eyes, sp.thickness);
      c.species = sp;
      c.meta = false;
      c.length = tile ? tile.length : sp.length;
      const leg = this._leg(sp, from, to, c.length, sp, WALL[sp.motion] ? this.standHeight(sp, c.length) : 0.5);
      return this._begin(c, [leg], { chain, tile });
    }

    // 変態: points = [出発, 区間の境目…, 到着]、species = 区間ごとの種(進化の順)
    spawnJourney(points, species, { chain = 0 } = {}) {
      const sps = species.map((s) => TL.Species.get(s));
      const c = this._take('meta', sps[0], null);
      if (!c) return null;
      c.key = 'meta';
      c.meta = true;
      c.species = sps[0];
      c.morphKey = null;
      c.eyeOwner = undefined;
      c.length = sps[0].length;
      this._morphTo(c, sps[0], sps[0], 0);
      const legs = [];
      for (let i = 0; i < sps.length; i++) {
        const sp = sps[i], prev = sps[i - 1] || sp;
        // 区間のつなぎ目の高さ: 前の区間の終わり = 次の区間の始め
        const h0 = i === 0 ? 0.5 : (WALL[prev.motion] ? this.standHeight(prev, prev.length) : 0.5);
        const leg = this._leg(sp, points[i], points[i + 1], sp.length, prev, h0);
        // 空中の区間が壁の区間へ続く時は、次の種の立つ高さで終わる
        const next = sps[i + 1];
        if (!leg.wall && next && WALL[next.motion]) leg.path = this._airPath(sp, points[i], points[i + 1], h0, this.standHeight(next, next.length));
        legs.push(leg);
      }
      return this._begin(c, legs, { chain, tile: null });
    }

    // 変態: A → B を w (0..1) で混ぜた姿にする
    _morphTo(c, A, B, w) {
      w = clamp(w, 0, 1);
      if (c.morphKey !== A.id + B.id || Math.abs(c.morphW - w) > 0.04 || (w === 1 && c.morphW !== 1) || (w === 0 && c.morphW !== 0)) {
        const a = resampled(A), b = resampled(B);
        const shape = new THREE.Shape(a.map((p, i) => new THREE.Vector2(lerp(p.x, b[i].x, w), lerp(p.y, b[i].y, w))));
        const depth = lerp(A.thickness, B.thickness, w);
        const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 1 });
        g.translate(0, 0, -depth / 2);
        g.computeVertexNormals();
        if (c.ownGeometry) c.mesh.geometry.dispose();
        c.mesh.geometry = g;
        c.ownGeometry = true;
        c.morphKey = A.id + B.id;
        c.morphW = w;
      }
      const wa = WEIGHTS[A.deform], wb = WEIGHTS[B.deform];
      W_NAMES.forEach((n, i) => { c.uniforms[n].value = lerp(wa[i], wb[i], w); });
      c.mat.color.copy(tmpA.set(A.color)).lerp(tmpB.set(B.color), w);
      c.mat.emissive.copy(tmpA.set(A.emissive)).lerp(tmpB.set(B.emissive), w);
      c.length = lerp(A.length, B.length, w);
      c.poseW = lerp(A.pose === 'top' ? 1 : 0, B.pose === 'top' ? 1 : 0, w);
      // 目は姿が定まっている時だけ(変化の途中は隠す)
      const settled = w < 0.02 ? A : w > 0.98 ? B : null;
      if (settled !== c.eyeOwner) {
        this._setEyes(c, settled ? settled.eyes : [], settled ? settled.thickness : 0.1);
        c.eyeOwner = settled;
      }
      c.shown = w < 0.5 ? A : B;
      c.species = c.shown;
    }

    _pose(c, pos, depth, emissive, amp, freq) {
      const L = c.length;
      c.mesh.position.copy(pos);
      c.mesh.scale.set(L, L, L * clamp(depth, 0.03, 1));
      c.mat.emissiveIntensity = emissive;
      c.uniforms.uAmp.value = amp;
      c.uniforms.uFreq.value = freq;
    }

    // 種ごとの動き [振れ幅, 速さ]。u は区間の進み具合、leg は区間
    _motion(sp, phase, u, c, leg) {
      const m = sp.motion;
      if (phase === 'emerge') {
        if (m === 'fly') return [0.32 * smooth((u - 0.45) / 0.4), 13];
        if (m === 'crawl') return [0.15 * smooth((u - 0.5) / 0.5), 7];
        if (m === 'run') return [0.3 * smooth((u - 0.6) / 0.4), 9];
        if (m === 'hop') return [0, 0];
        return [0.1 * smooth((u - 0.6) / 0.4), 9];
      }
      if (phase === 'travel') {
        if (m === 'fly') {
          // 羽ばたきと滑空を繰り返す
          const glide = 0.5 + 0.5 * Math.sin(this.time * 1.1 + c.phaseOffset);
          return [0.08 + 0.26 * glide, 7 + 5 * glide];
        }
        if (m === 'crawl') return [0.22, 8];
        if (m === 'run') return [0.5, 14];
        if (m === 'hop') {
          // 跳んでいる間(弧の頂上付近)は後脚を伸ばし、着地で縮める
          const hops = (leg && leg.path.hops) || 3;
          return [Math.pow(Math.abs(Math.sin(Math.PI * hops * u)), 0.6), 0];
        }
        return [0.13, 9];
      }
      if (m === 'fly') return [0.18 * (1 - u), 10];
      if (m === 'crawl') return [0.2 * (1 - u), 6];
      if (m === 'run') return [0.4 * (1 - u), 12];
      if (m === 'hop') return [0, 0];
      return [0.13 * (1 - u), 9];
    }

    update(dt) {
      this.time += dt;
      const space = this.space;
      for (const c of [...this.active]) {
        c.t += dt;
        c.uniforms.uTime.value = this.time + c.phaseOffset;
        if (c.phase === 'emerge') {
          // 1 光る → 2 浮く → 3 厚みを持つ → 4 出発の姿勢へ(魚・獣は起き上がり、壁を進む種は向きを変える)
          const u = c.t / c.dur;
          const lift = 0.06 + smooth((u - 0.15) / 0.55) * (c.emergeLift - 0.06);
          const pos = c.f0.pos.clone().addScaledVector(c.f0.normal, Math.max(0.06, lift));
          const q = u < 0.7 ? c.qFlat0 : c.q.copy(c.qFlat0).slerp(c.qTravel0, smooth((u - 0.7) / 0.3));
          c.mesh.quaternion.copy(q);
          const [amp, freq] = this._motion(c.species, 'emerge', u, c);
          this._pose(c, pos, 0.03 + 0.97 * smooth((u - 0.3) / 0.5), 1.6 * (1 - u) + 0.5, amp, freq);
          if (u >= 1) { c.phase = 'travel'; c.t = 0; this.bus.emit('travel', { creature: c }); }
        } else if (c.phase === 'travel') {
          const leg = c.legs[c.li];
          const u = clamp(c.t / leg.dur, 0, 1);
          const s = leg.wall ? u : 0.5 - 0.5 * Math.cos(Math.PI * u);
          // 変態: 区間の始めに、前の種から次の種へ姿を変える
          let glow = 0.5;
          if (c.meta && leg.prev !== leg.sp) {
            const w = smooth(u / 0.35);
            this._morphTo(c, leg.prev, leg.sp, w);
            if (!leg.morphed && u > 0) { leg.morphed = true; this.bus.emit('morph', { creature: c, from: leg.prev.id, to: leg.sp.id, pos: c.mesh.position.clone() }); }
            glow += 1.2 * Math.sin(Math.PI * clamp(u / 0.35, 0, 1));
          }
          const pos = leg.path.getPointAt(s);
          const tan = leg.path.getTangentAt(s);
          let up, roll = 0;
          if (leg.wall) {
            const [px, py] = leg.path.plane(s);
            up = space.frame(px, py).normal;
            // 壁を進む種は足音(通った所のタイルもかすかに光る)
            c.stepT -= dt;
            if (c.stepT <= 0) { c.stepT = leg.sp.motion === 'run' ? 0.12 : 0.18; this.bus.emit('crawl', { creature: c, x: px, y: py }); }
          } else {
            up = space.toAxis(pos);
            if (leg.sp.motion === 'fly') {
              const ahead = leg.path.getTangentAt(Math.min(1, s + 0.04));
              roll = clamp(new THREE.Vector3().crossVectors(tan, ahead).dot(up) * 12, -0.7, 0.7);
            }
          }
          if (c.meta) this._blendQuat(c, tan, up, roll);
          else travelQuat(c.species.pose, tan, up, roll, c.q);
          c.mesh.quaternion.slerp(c.q, 1 - Math.exp(-dt * 8));
          const [amp, freq] = this._motion(leg.sp, 'travel', u, c, leg);
          this._pose(c, pos, 1, glow, amp, freq);
          if (u >= 1) {
            c.li++;
            c.t = 0;
            if (c.li >= c.legs.length) { c.phase = 'land'; c.qLand = c.mesh.quaternion.clone(); c.landFrom = pos.clone(); }
            else if (c.legs[c.li].wall && !leg.wall) this.bus.emit('touch', { creature: c, x: c.legs[c.li].from.x, y: c.legs[c.li].from.y });
          }
        } else if (c.phase === 'land') {
          // 目的のタイルへ近づき、平たくなって壁に溶け込む
          const u = c.t / 1.4;
          const target = c.f1.pos.clone().addScaledVector(c.f1.normal, 0.05);
          const pos = c.landFrom.clone().lerp(target, smooth(u));
          c.mesh.quaternion.copy(c.qLand).slerp(c.qFlat1, smooth(u));
          const [amp, freq] = this._motion(c.species, 'land', u, c);
          this._pose(c, pos, 1 - 0.97 * smooth((u - 0.35) / 0.65), 0.5 + 1.4 * smooth(u), amp, freq);
          if (u >= 1) { c.phase = 'fade'; c.t = 0; this.bus.emit('landed', { creature: c, cell: c.to, chain: c.chain }); }
        } else if (c.phase === 'fade') {
          const u = c.t / 0.7;
          c.mat.opacity = 1 - u;
          c.eyeM.opacity = 1 - u;
          if (u >= 1) this._release(c);
        }
      }
    }

    // 横向き(魚・獣)と上向き(カエル・トカゲ・鳥)の姿勢を、変態の進み具合で混ぜる
    _blendQuat(c, fwd, up, roll) {
      const qs = travelQuat('side', fwd, up, roll), qt = travelQuat('top', fwd, up, roll);
      return c.q.copy(qs).slerp(qt, c.poseW);
    }

    _release(c) {
      c.mesh.visible = false;
      this.active.splice(this.active.indexOf(c), 1);
      this.pool.push(c);
    }

    clear() { for (const c of [...this.active]) this._release(c); }

    positions() { return this.active.map((c) => c.mesh.position); }
  }

  TL.CreatureSystem = CreatureSystem;
  TL.CreatureMath = { flatQuat, travelQuat, WallPath };
})(window.TL = window.TL || {});
