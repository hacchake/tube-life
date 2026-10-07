// 生物(Creature)の 3D 表示と移動。CA とはイベントだけでつながる。
//
//   emerge : タイルの上に平たい生物が現れ、光り、浮き上がり、厚みを持つ(2D → 3D)
//   travel : 種ごとの動き方で別のタイルへ(魚 = 泳ぐ / 鳥 = 羽ばたいて奥へ飛ぶ)
//   land   : 目的のタイルに近づき、平たくなって壁に溶け込む → 'landed' を発行
//   fade   : 消えてプールへ戻る
//
// 種ごとの違いは Species の定義(pose / deform / motion / speed / range)で決まる。
// メッシュはプール(使い回し)で、大量に生まれても上限で止まる。
(function (TL) {
  'use strict';
  const { clamp, smooth } = TL.util;

  const POOL_MAX = 24;
  const tmpM = new THREE.Matrix4();

  // 体の変形(頂点シェーダー)。position は輪郭の座標(長さ 1、頭が +X)。
  const DEFORM = {
    // 尾を振る: 後ろほど大きく体の横(Z)へ
    tail: `float tailw = smoothstep(0.3, -0.5, position.x);
           transformed.z += sin(uTime * uFreq - position.x * 7.0) * uAmp * (0.2 + tailw);`,
    // 羽ばたき: 胴から離れるほど大きく背の方向(Z)へ。翼の先は少し遅れてしなる。
    wings: `float span = abs(position.y);
            float wing = smoothstep(0.1, 0.72, span);
            transformed.z += sin(uTime * uFreq - span * 2.2) * uAmp * wing * span * 1.8;`,
  };

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

  // 移動中の向き。どちらも背中をチューブの中心側へ向ける。
  //   side(魚): 輪郭の Y が背 → Y を中心へ
  //   top (鳥): 輪郭の Z が背 → Z を中心へ(翼は左右に広がる)
  function travelQuat(pose, fwd, pos, roll, out = new THREE.Quaternion()) {
    const x = fwd.clone().normalize();
    const up = new THREE.Vector3(-pos.x, -pos.y, 0);
    if (up.lengthSq() < 1e-6) up.set(0, 1, 0);
    up.addScaledVector(x, -up.dot(x)).normalize();
    if (roll) up.applyAxisAngle(x, roll);
    if (pose === 'top') return basisQuat(x, new THREE.Vector3().crossVectors(up, x), up, out);
    return basisQuat(x, up, new THREE.Vector3().crossVectors(x, up), out);
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

    _geometry(species) {
      if (this.geoms[species.id]) return this.geoms[species.id];
      const g = new THREE.ExtrudeGeometry(species.outline(THREE), {
        depth: species.thickness, bevelEnabled: true, bevelThickness: 0.02, bevelSize: 0.015, bevelSegments: 2, curveSegments: 14,
      });
      g.translate(0, 0, -species.thickness / 2);
      g.computeVertexNormals();
      this.geoms[species.id] = g;
      return g;
    }

    _make(species) {
      const mat = new THREE.MeshStandardMaterial({
        color: species.color, emissive: species.emissive, emissiveIntensity: 0.6,
        roughness: 0.35, metalness: 0.15, transparent: true, side: THREE.DoubleSide,
      });
      const uniforms = { uTime: { value: 0 }, uAmp: { value: 0 }, uFreq: { value: 9 } };
      mat.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, uniforms);
        shader.vertexShader = 'uniform float uTime;\nuniform float uAmp;\nuniform float uFreq;\n' +
          shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n' + DEFORM[species.deform]);
      };
      mat.customProgramCacheKey = () => 'creature-' + species.deform;
      const mesh = new THREE.Mesh(this._geometry(species), mat);
      const eyeG = new THREE.SphereGeometry(0.03, 10, 8);
      const eyeM = new THREE.MeshBasicMaterial({ color: 0x050812, transparent: true });
      for (const [x, y, side] of species.eyes) {
        const e = new THREE.Mesh(eyeG, eyeM);
        e.position.set(x, y, side * (species.thickness / 2 + 0.01));
        mesh.add(e);
      }
      mesh.visible = false;
      this.scene.add(mesh);
      return { mesh, mat, eyeM, uniforms, species };
    }

    get count() { return this.active.length; }

    countBy() {
      const out = {};
      for (const c of this.active) out[c.species.id] = (out[c.species.id] || 0) + 1;
      return out;
    }

    // 種ごとの通り道
    _path(sp, f0, f1) {
      const R = this.space.R, rng = this.rng;
      const S = f0.pos.clone().addScaledVector(f0.normal, sp.motion === 'fly' ? 1.4 : 0.9);
      const E = f1.pos.clone().addScaledVector(f1.normal, 0.9);
      const at = (u, r, swirl) => {
        const p = S.clone().lerp(E, u);
        const a = Math.atan2(p.y, p.x) + swirl;
        return new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, p.z + (rng() - 0.5) * 2);
      };
      let mids;
      if (sp.motion === 'fly') {
        // 鳥: 一気に中心近くまで舞い上がり、らせんを描きながら奥へ飛ぶ
        const turn = (rng() < 0.5 ? -1 : 1) * (0.8 + rng() * 1.2);
        mids = [0.2, 0.4, 0.6, 0.8].map((u) => at(u, R * (0.15 + 0.3 * rng()), turn * Math.sin(Math.PI * u)));
      } else {
        mids = [at(0.33, R * (0.35 + rng() * 0.3), (rng() - 0.5) * 0.9), at(0.66, R * (0.35 + rng() * 0.3), (rng() - 0.5) * 0.9)];
      }
      return new THREE.CatmullRomCurve3([f0.pos.clone().addScaledVector(f0.normal, 0.5), S, ...mids, E, f1.pos.clone().addScaledVector(f1.normal, 0.5)], false, 'centripetal');
    }

    // from / to: { id, x, y }(平面座標)
    spawn(from, to, { species = 'fish', chain = 0 } = {}) {
      if (this.active.length >= POOL_MAX) return null;
      const sp = TL.Species.get(species);
      if (!sp.ready) return null;
      let c = this.pool.find((p) => p.species === sp);
      if (c) this.pool.splice(this.pool.indexOf(c), 1);
      else c = this._make(sp);

      const f0 = this.space.frame(from.x, from.y), f1 = this.space.frame(to.x, to.y);
      const curve = this._path(sp, f0, f1);
      const t0 = curve.getTangentAt(0), t1 = curve.getTangentAt(1);
      Object.assign(c, {
        phase: 'emerge', t: 0, dur: sp.emergeTime, chain, from, to, curve, f0, f1,
        travelDur: clamp(curve.getLength() / sp.speed, 3, 9),
        qFlat0: flatQuat(f0.normal, t0),
        qFlat1: flatQuat(f1.normal, t1),
        qTravel0: travelQuat(sp.pose, t0, curve.getPointAt(0), 0),
        q: new THREE.Quaternion(),
        phaseOffset: this.rng() * 10,
      });
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
      const fly = c.species.motion === 'fly';
      if (phase === 'emerge') return fly ? [0.32 * smooth((u - 0.45) / 0.4), 13] : [0.1 * smooth((u - 0.6) / 0.4), 9];
      if (phase === 'travel') {
        if (!fly) return [0.13, 9];
        // 羽ばたきと滑空を繰り返す
        const glide = 0.5 + 0.5 * Math.sin(this.time * 1.1 + c.phaseOffset);
        return [0.08 + 0.26 * glide, 7 + 5 * glide];
      }
      return fly ? [0.18 * (1 - u), 10] : [0.13 * (1 - u), 9];
    }

    update(dt) {
      this.time += dt;
      for (const c of [...this.active]) {
        c.t += dt;
        c.uniforms.uTime.value = this.time + c.phaseOffset;
        if (c.phase === 'emerge') {
          // 1 光る → 2 浮く → 3 厚みを持つ → 4 起き上がって出発する
          const u = c.t / c.dur;
          const lift = 0.06 + smooth((u - 0.15) / 0.55) * 0.5;
          const pos = c.f0.pos.clone().addScaledVector(c.f0.normal, lift);
          const q = u < 0.7 ? c.qFlat0 : c.q.copy(c.qFlat0).slerp(c.qTravel0, smooth((u - 0.7) / 0.3));
          c.mesh.quaternion.copy(q);
          const [amp, freq] = this._motion(c, 'emerge', u);
          this._pose(c, pos, 0.03 + 0.97 * smooth((u - 0.3) / 0.5), 1.6 * (1 - u) + 0.5, amp, freq);
          if (u >= 1) { c.phase = 'travel'; c.t = 0; this.bus.emit('travel', { creature: c }); }
        } else if (c.phase === 'travel') {
          const u = clamp(c.t / c.travelDur, 0, 1);
          const s = 0.5 - 0.5 * Math.cos(Math.PI * u);
          const pos = c.curve.getPointAt(s);
          const tan = c.curve.getTangentAt(s);
          // 鳥は曲がる時に体を傾ける
          let roll = 0;
          if (c.species.motion === 'fly') {
            const ahead = c.curve.getTangentAt(Math.min(1, s + 0.04));
            const toAxis = new THREE.Vector3(-pos.x, -pos.y, 0).normalize();
            roll = clamp(new THREE.Vector3().crossVectors(tan, ahead).dot(toAxis) * 12, -0.7, 0.7);
          }
          travelQuat(c.species.pose, tan, pos, roll, c.q);
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
})(window.TL = window.TL || {});
