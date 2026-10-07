// 生物(Creature)の 3D 表示と移動。CA とはイベントだけでつながる。
//
//   emerge : タイルの上に平たい生物が現れ、光り、浮き上がり、厚みを持つ(2D → 3D)
//   travel : 種ごとの動き方で別のタイルへ(魚 = 泳ぐ / 鳥 = 羽ばたいて奥へ飛ぶ / トカゲ = 壁を這う)
//   land   : 目的のタイルに近づき、平たくなって壁に溶け込む → 'landed' を発行
//   fade   : 消えてプールへ戻る
//
// 種ごとの違いは Species の定義(pose / deform / motion / speed / range)で決まる。
// 経路は Topology の平面座標と Space で作るので、円筒以外の空間でも同じように動く。
// メッシュはプール(使い回し)で、大量に生まれても上限で止まる。
(function (TL) {
  'use strict';
  const { clamp, smooth, lerp } = TL.util;

  const POOL_MAX = 24;
  const tmpM = new THREE.Matrix4();

  // 体の変形(頂点シェーダー)。position は輪郭の座標(長さ 1、頭が +X)。
  // 3 種類の動きを重みで混ぜられるようにしてある(変態の時に滑らかに切り替える)。
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
  `;
  const WEIGHTS = { tail: [1, 0, 0], wings: [0, 1, 0], body: [0, 0, 1] };

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

  // 移動中の向き。背中をチューブの中心側(up)へ向ける。
  //   side(魚): 輪郭の Y が背   top(鳥・トカゲ): 輪郭の Z が背(翼・脚は左右に広がる)
  function travelQuat(pose, fwd, up0, roll, out = new THREE.Quaternion()) {
    const x = fwd.clone().normalize();
    const up = up0.clone().addScaledVector(x, -up0.dot(x)).normalize();
    if (roll) up.applyAxisAngle(x, roll);
    if (pose === 'top') return basisQuat(x, new THREE.Vector3().crossVectors(up, x), up, out);
    return basisQuat(x, up, new THREE.Vector3().crossVectors(x, up), out);
  }

  // 壁面上の経路(トカゲ用)。CatmullRomCurve3 と同じ getPointAt / getTangentAt を持つ。
  class WallPath {
    constructor(space, x0, y0, x1, y1, h, rng) {
      this.space = space;
      this.h = h;
      const C = space.C;
      let dx = x1 - x0;
      dx -= C * Math.round(dx / C); // 周方向は近い方へ
      this.a = [x0, y0];
      this.d = [dx, y1 - y0];
      const len = Math.hypot(dx, y1 - y0) || 1;
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
      const [x, y] = this.plane(clamp(s, 0, 1));
      return this.space.point(x, y, this.h, out);
    }
    getTangentAt(s) {
      const e = 0.002;
      const a = this.getPointAt(clamp(s - e, 0, 1)), b = this.getPointAt(clamp(s + e, 0, 1));
      return b.sub(a).normalize();
    }
    getLength() { return this.length; }
  }

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
      const uniforms = {
        uTime: { value: 0 }, uAmp: { value: 0 }, uFreq: { value: 9 },
        wTail: { value: 0 }, wWing: { value: 0 }, wBody: { value: 0 },
      };
      mat.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, uniforms);
        shader.vertexShader = 'uniform float uTime, uAmp, uFreq, wTail, wWing, wBody;\n' +
          shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n' + DEFORM);
      };
      mat.customProgramCacheKey = () => 'creature';
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

    get count() { return this.active.length; }

    countBy() {
      const out = {};
      for (const c of this.active) out[c.species.id] = (out[c.species.id] || 0) + 1;
      return out;
    }

    // 平面上で a → b へ(周方向は近い方)
    _planeLerp(a, b, u) {
      const C = this.space.C;
      let dx = b.x - a.x;
      dx -= C * Math.round(dx / C);
      return { x: a.x + dx * u, y: lerp(a.y, b.y, u) };
    }

    // 種ごとの通り道
    _path(sp, from, to) {
      const space = this.space, R = space.R, rng = this.rng;
      if (sp.motion === 'crawl') return new WallPath(space, from.x, from.y, to.x, to.y, 0.14, rng);
      const f0 = space.frame(from.x, from.y), f1 = space.frame(to.x, to.y);
      // 平面上の位置 u・中心からの半径 r・周方向のずれ swirl(ラジアン)で、チューブ内部の点を作る
      const at = (u, r, swirl) => {
        const p = this._planeLerp(from, to, u);
        return space.point(p.x + (swirl * space.C) / (2 * Math.PI), p.y + (rng() - 0.5) * 2, R - r);
      };
      let mids;
      if (sp.motion === 'fly') {
        // 鳥: 一気に中心近くまで舞い上がり、らせんを描きながら奥へ飛ぶ
        const turn = (rng() < 0.5 ? -1 : 1) * (0.8 + rng() * 1.2);
        mids = [0.2, 0.4, 0.6, 0.8].map((u) => at(u, R * (0.15 + 0.3 * rng()), turn * Math.sin(Math.PI * u)));
      } else {
        mids = [at(0.33, R * (0.35 + rng() * 0.3), (rng() - 0.5) * 0.9), at(0.66, R * (0.35 + rng() * 0.3), (rng() - 0.5) * 0.9)];
      }
      const lift0 = sp.motion === 'fly' ? 1.4 : 0.9;
      return new THREE.CatmullRomCurve3([
        f0.pos.clone().addScaledVector(f0.normal, 0.5), f0.pos.clone().addScaledVector(f0.normal, lift0),
        ...mids,
        f1.pos.clone().addScaledVector(f1.normal, 0.9), f1.pos.clone().addScaledVector(f1.normal, 0.5),
      ], false, 'centripetal');
    }

    // from / to: { id, x, y }(平面座標)
    // opts.outline: タイルの輪郭そのものを立体化する時の形(Escher)、opts.align: タイルの向きに合わせる
    spawn(from, to, { species = 'fish', chain = 0, outline = null, outlineKey = null, eyes = null, align = false } = {}) {
      if (this.active.length >= POOL_MAX) return null;
      const sp = TL.Species.get(species);
      if (!sp.ready) return null;
      const key = outlineKey || sp.id;
      let c = this.pool.find((p) => p.key === key);
      if (c) this.pool.splice(this.pool.indexOf(c), 1);
      else c = this._make(sp, outline, key);
      if (eyes) this._setEyes(c, eyes, sp.thickness);

      const space = this.space;
      const f0 = space.frame(from.x, from.y), f1 = space.frame(to.x, to.y);
      const curve = this._path(sp, from, to);
      const t0 = curve.getTangentAt(0), t1 = curve.getTangentAt(1);
      const p0 = curve.getPointAt(0);
      const w = WEIGHTS[sp.deform];
      Object.assign(c, {
        phase: 'emerge', t: 0, dur: sp.emergeTime, chain, from, to, curve, f0, f1,
        travelDur: clamp(curve.getLength() / sp.speed, 3, 9),
        // Escher のタイルから出る時・戻る時は、タイルと同じ向きにぴったり重ねる
        qFlat0: flatQuat(f0.normal, align ? f0.tu : t0),
        qFlat1: flatQuat(f1.normal, align ? f1.tu : t1),
        qTravel0: sp.motion === 'crawl' ? flatQuat(f0.normal, t0) : travelQuat(sp.pose, t0, space.toAxis(p0), 0),
        q: new THREE.Quaternion(),
        phaseOffset: this.rng() * 10,
        crawlT: 0,
      });
      c.uniforms.wTail.value = w[0]; c.uniforms.wWing.value = w[1]; c.uniforms.wBody.value = w[2];
      c.mesh.visible = true;
      c.mesh.quaternion.copy(c.qFlat0);
      c.mat.opacity = 1;
      c.eyeM.opacity = 1;
      this.active.push(c);
      this.bus.emit('emerge', { creature: c, cell: from });
      return c;
    }

    _pose(c, pos, depth, emissive, amp, freq) {
      const L = c.species.length;
      c.mesh.position.copy(pos);
      c.mesh.scale.set(L, L, L * clamp(depth, 0.03, 1));
      c.mat.emissiveIntensity = emissive;
      c.uniforms.uAmp.value = amp;
      c.uniforms.uFreq.value = freq;
    }

    // 種ごとの動き [振れ幅, 速さ]
    _motion(c, phase, u) {
      const m = c.species.motion;
      if (phase === 'emerge') {
        if (m === 'fly') return [0.32 * smooth((u - 0.45) / 0.4), 13];
        if (m === 'crawl') return [0.15 * smooth((u - 0.5) / 0.5), 7];
        return [0.1 * smooth((u - 0.6) / 0.4), 9];
      }
      if (phase === 'travel') {
        if (m === 'fly') {
          // 羽ばたきと滑空を繰り返す
          const glide = 0.5 + 0.5 * Math.sin(this.time * 1.1 + c.phaseOffset);
          return [0.08 + 0.26 * glide, 7 + 5 * glide];
        }
        if (m === 'crawl') return [0.22, 8];
        return [0.13, 9];
      }
      if (m === 'fly') return [0.18 * (1 - u), 10];
      if (m === 'crawl') return [0.2 * (1 - u), 6];
      return [0.13 * (1 - u), 9];
    }

    update(dt) {
      this.time += dt;
      const space = this.space;
      for (const c of [...this.active]) {
        c.t += dt;
        c.uniforms.uTime.value = this.time + c.phaseOffset;
        const crawl = c.species.motion === 'crawl';
        if (c.phase === 'emerge') {
          // 1 光る → 2 浮く → 3 厚みを持つ → 4 起き上がって出発する(トカゲは壁に沿ったまま向きを変える)
          const u = c.t / c.dur;
          const lift = 0.06 + smooth((u - 0.15) / 0.55) * (crawl ? 0.08 : 0.5);
          const pos = c.f0.pos.clone().addScaledVector(c.f0.normal, lift);
          const q = u < 0.7 ? c.qFlat0 : c.q.copy(c.qFlat0).slerp(c.qTravel0, smooth((u - 0.7) / 0.3));
          c.mesh.quaternion.copy(q);
          const [amp, freq] = this._motion(c, 'emerge', u);
          this._pose(c, pos, 0.03 + 0.97 * smooth((u - 0.3) / 0.5), 1.6 * (1 - u) + 0.5, amp, freq);
          if (u >= 1) { c.phase = 'travel'; c.t = 0; this.bus.emit('travel', { creature: c }); }
        } else if (c.phase === 'travel') {
          const u = clamp(c.t / c.travelDur, 0, 1);
          const s = crawl ? u : 0.5 - 0.5 * Math.cos(Math.PI * u);
          const pos = c.curve.getPointAt(s);
          const tan = c.curve.getTangentAt(s);
          if (crawl) {
            // 壁面に沿ったまま進む。通った所のタイルをかすかに光らせる
            const [px, py] = c.curve.plane(s);
            flatQuat(space.frame(px, py).normal, tan, c.q);
            c.crawlT -= dt;
            if (c.crawlT <= 0) { c.crawlT = 0.18; this.bus.emit('crawl', { creature: c, x: px, y: py }); }
          } else {
            // 鳥は曲がる時に体を傾ける
            let roll = 0;
            const up = space.toAxis(pos);
            if (c.species.motion === 'fly') {
              const ahead = c.curve.getTangentAt(Math.min(1, s + 0.04));
              roll = clamp(new THREE.Vector3().crossVectors(tan, ahead).dot(up) * 12, -0.7, 0.7);
            }
            travelQuat(c.species.pose, tan, up, roll, c.q);
          }
          c.mesh.quaternion.slerp(c.q, 1 - Math.exp(-dt * 8));
          const [amp, freq] = this._motion(c, 'travel', u);
          this._pose(c, pos, 1, 0.5, amp, freq);
          if (u >= 1) { c.phase = 'land'; c.t = 0; c.qLand = c.mesh.quaternion.clone(); c.landFrom = pos.clone(); }
        } else if (c.phase === 'land') {
          // 目的のタイルへ近づき、平たくなって壁に溶け込む
          const u = c.t / 1.4;
          const target = c.f1.pos.clone().addScaledVector(c.f1.normal, 0.05);
          const pos = c.landFrom.clone().lerp(target, smooth(u));
          c.mesh.quaternion.copy(c.qLand).slerp(c.qFlat1, smooth(u));
          const [amp, freq] = this._motion(c, 'land', u);
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
