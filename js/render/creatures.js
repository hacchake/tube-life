// 生物(Creature)の 3D 表示と移動。CA とはイベントだけでつながる。
//
//   emerge : タイルの上に平たい魚が現れ、光り、浮き上がり、厚みを持つ(2D → 3D)
//   swim   : チューブの中を通って別のタイルへ泳ぐ(尾を振る)
//   land   : 目的のタイルに近づき、平たくなって壁に溶け込む → 'landed' を発行
//   fade   : 消えてプールへ戻る
//
// メッシュはプール(使い回し)で、大量に生まれても上限で止まる。
(function (TL) {
  'use strict';
  const { clamp, smooth } = TL.util;

  const POOL_MAX = 24;
  const tmpM = new THREE.Matrix4();

  // 基底ベクトル(X = 頭の向き, Y = 背, Z = 体の横)から回転を作る
  function basisQuat(x, y, z, out) {
    tmpM.makeBasis(x, y, z);
    return out.setFromRotationMatrix(tmpM);
  }

  // 壁に平たく張り付いた向き: 頭 = 壁に沿った向き dir、体の横 = 壁の法線(内向き)
  function flatQuat(normal, dir, out = new THREE.Quaternion()) {
    const x = dir.clone().addScaledVector(normal, -dir.dot(normal)).normalize();
    const z = normal.clone();
    const y = new THREE.Vector3().crossVectors(z, x);
    return basisQuat(x, y, z, out);
  }

  // 泳いでいる向き: 頭 = 進行方向、背 = チューブの中心側
  function swimQuat(fwd, pos, out = new THREE.Quaternion()) {
    const x = fwd.clone().normalize();
    const toAxis = new THREE.Vector3(-pos.x, -pos.y, 0);
    if (toAxis.lengthSq() < 1e-6) toAxis.set(0, 1, 0);
    const z = new THREE.Vector3().crossVectors(x, toAxis).normalize();
    if (z.lengthSq() < 1e-6) z.set(0, 0, 1);
    const y = new THREE.Vector3().crossVectors(z, x);
    return basisQuat(x, y, z, out);
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
      this.speed = 4.2; // 泳ぐ速さ(単位/秒)
    }

    _geometry(species) {
      if (this.geoms[species.id]) return this.geoms[species.id];
      const g = new THREE.ExtrudeGeometry(species.outline(THREE), {
        depth: species.thickness, bevelEnabled: true, bevelThickness: 0.025, bevelSize: 0.02, bevelSegments: 2, curveSegments: 14,
      });
      g.translate(0, 0, -species.thickness / 2);
      g.computeVertexNormals();
      this.geoms[species.id] = g;
      return g;
    }

    _make(species) {
      const mat = new THREE.MeshStandardMaterial({
        color: species.color, emissive: species.emissive, emissiveIntensity: 0.6,
        roughness: 0.35, metalness: 0.15, transparent: true,
      });
      const uniforms = { uTime: { value: 0 }, uAmp: { value: 0 } };
      // 尾を振る: 後ろほど大きく体の横(Z)へ揺らす
      mat.onBeforeCompile = (shader) => {
        shader.uniforms.uTime = uniforms.uTime;
        shader.uniforms.uAmp = uniforms.uAmp;
        shader.vertexShader = 'uniform float uTime;\nuniform float uAmp;\n' + shader.vertexShader.replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           float tailw = smoothstep(0.3, -0.5, position.x);
           transformed.z += sin(uTime * 9.0 - position.x * 7.0) * uAmp * (0.2 + tailw);`
        );
      };
      const mesh = new THREE.Mesh(this._geometry(species), mat);
      const eyeG = new THREE.SphereGeometry(0.035, 10, 8);
      const eyeM = new THREE.MeshBasicMaterial({ color: 0x050812, transparent: true });
      for (const side of [1, -1]) {
        const e = new THREE.Mesh(eyeG, eyeM);
        e.position.set(species.eye[0], species.eye[1], side * (species.thickness / 2 + 0.01));
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

    // from: 出発タイル(平面座標と id)、to: 目的タイル
    spawn(from, to, { species = 'fish', chain = 0 } = {}) {
      if (this.active.length >= POOL_MAX) return null;
      const sp = TL.Species.get(species);
      if (!sp.ready) return null;
      let c = this.pool.find((p) => p.species === sp);
      if (c) this.pool.splice(this.pool.indexOf(c), 1);
      else c = this._make(sp);

      const space = this.space;
      const f0 = space.frame(from.x, from.y), f1 = space.frame(to.x, to.y);
      const S = f0.pos.clone().addScaledVector(f0.normal, 0.9);
      const E = f1.pos.clone().addScaledVector(f1.normal, 0.9);
      // 途中はチューブの中心寄りを通る
      const mid = (u, r) => {
        const p = S.clone().lerp(E, u);
        const len = Math.hypot(p.x, p.y) || 1;
        const a = Math.atan2(p.y, p.x) + (this.rng() - 0.5) * 0.9;
        return new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, p.z + (this.rng() - 0.5) * 3);
      };
      const R = space.R;
      const curve = new THREE.CatmullRomCurve3([
        f0.pos.clone().addScaledVector(f0.normal, 0.5), S,
        mid(0.33, R * (0.35 + this.rng() * 0.3)), mid(0.66, R * (0.35 + this.rng() * 0.3)),
        E, f1.pos.clone().addScaledVector(f1.normal, 0.5),
      ], false, 'centripetal');

      const t0 = curve.getTangentAt(0), t1 = curve.getTangentAt(1);
      Object.assign(c, {
        phase: 'emerge', t: 0, dur: 2.0, chain, from, to, curve,
        f0, f1,
        swimDur: clamp(curve.getLength() / this.speed, 3, 7.5),
        qFlat0: flatQuat(f0.normal, t0),
        qFlat1: flatQuat(f1.normal, t1),
        qSwim0: swimQuat(t0, curve.getPointAt(0)),
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

    _pose(c, pos, depth, emissive, amp) {
      const L = c.species.length;
      c.mesh.position.copy(pos);
      c.mesh.scale.set(L, L, L * clamp(depth, 0.03, 1));
      c.mat.emissiveIntensity = emissive;
      c.uniforms.uAmp.value = amp;
    }

    update(dt) {
      this.time += dt;
      for (const c of [...this.active]) {
        c.t += dt;
        c.uniforms.uTime.value = this.time + c.phaseOffset;
        if (c.phase === 'emerge') {
          // 1 光る → 2 浮く → 3 厚みを持つ → 4 起き上がって泳ぎ出す
          const u = c.t / c.dur;
          const lift = 0.06 + smooth((u - 0.15) / 0.55) * 0.5;
          const pos = c.f0.pos.clone().addScaledVector(c.f0.normal, lift);
          const q = u < 0.7 ? c.qFlat0 : c.q.copy(c.qFlat0).slerp(c.qSwim0, smooth((u - 0.7) / 0.3));
          c.mesh.quaternion.copy(q);
          this._pose(c, pos, 0.03 + 0.97 * smooth((u - 0.3) / 0.5), 1.6 * (1 - u) + 0.5, 0.1 * smooth((u - 0.6) / 0.4));
          if (u >= 1) { c.phase = 'swim'; c.t = 0; this.bus.emit('swim', { creature: c }); }
        } else if (c.phase === 'swim') {
          const u = clamp(c.t / c.swimDur, 0, 1);
          const s = 0.5 - 0.5 * Math.cos(Math.PI * u);
          const pos = c.curve.getPointAt(s);
          const tan = c.curve.getTangentAt(s);
          swimQuat(tan, pos, c.q);
          c.mesh.quaternion.slerp(c.q, 1 - Math.exp(-dt * 8));
          this._pose(c, pos, 1, 0.5, 0.13);
          if (u >= 1) { c.phase = 'land'; c.t = 0; c.qLand = c.mesh.quaternion.clone(); c.landFrom = pos.clone(); }
        } else if (c.phase === 'land') {
          // 目的のタイルへ近づき、平たくなって壁に溶け込む
          const u = c.t / 1.4;
          const target = c.f1.pos.clone().addScaledVector(c.f1.normal, 0.05);
          const pos = c.landFrom.clone().lerp(target, smooth(u));
          c.mesh.quaternion.copy(c.qLand).slerp(c.qFlat1, smooth(u));
          this._pose(c, pos, 1 - 0.97 * smooth((u - 0.35) / 0.65), 0.5 + 1.4 * smooth(u), 0.13 * (1 - u));
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

    // 今いる位置(カメラの注目・デバッグ用)
    positions() { return this.active.map((c) => c.mesh.position); }
  }

  TL.CreatureSystem = CreatureSystem;
})(window.TL = window.TL || {});
