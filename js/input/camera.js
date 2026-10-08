// カメラ操作: ドラッグで見回す / WASD・矢印で移動 / Q・E で上下 / ホイールで前後。
// mode = 'free'(自由)または 'drift'(ゆっくりチューブの奥へ漂う)。
// 生命が生まれた場所へ、操作していない時だけ一瞬視線を寄せる(attract)。
(function (TL) {
  'use strict';
  const { clamp } = TL.util;

  class CameraControls {
    constructor(camera, dom, space) {
      this.camera = camera;
      this.dom = dom;
      this.space = space;
      this.yaw = Math.PI;   // +Z(チューブの奥)を向く
      this.pitch = 0;
      this.vel = new THREE.Vector3();
      this.keys = new Set();
      this.mode = 'free';
      this.lastInput = performance.now();
      this.dragging = false;
      this.driftDir = 1;
      this.attractT = 0;
      camera.rotation.order = 'YXZ';
      this._bind();
    }

    get idleFor() { return (performance.now() - this.lastInput) / 1000; }

    _bind() {
      const dom = this.dom;
      let px = 0, py = 0;
      dom.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 && e.button !== 2) return;
        this.dragging = true;
        this.moved = 0;
        px = e.clientX; py = e.clientY;
      });
      window.addEventListener('pointermove', (e) => {
        if (!this.dragging) return;
        const dx = e.clientX - px, dy = e.clientY - py;
        px = e.clientX; py = e.clientY;
        this.moved += Math.abs(dx) + Math.abs(dy);
        if (this.moved < 4) return; // 小さな動きはクリック扱い
        this.yaw -= dx * 0.0035;
        this.pitch = clamp(this.pitch - dy * 0.0035, -1.45, 1.45);
        this.touch();
      });
      window.addEventListener('pointerup', () => { this.dragging = false; });
      dom.addEventListener('wheel', (e) => {
        e.preventDefault();
        const f = this.forward();
        this.vel.addScaledVector(f, -Math.sign(e.deltaY) * 6);
        this.touch();
      }, { passive: false });
      window.addEventListener('keydown', (e) => {
        if (e.target.closest && e.target.closest('input, select, textarea')) return;
        this.keys.add(e.code);
        if (/^(Key[WASDQE]|Arrow)/.test(e.code)) this.touch();
      });
      window.addEventListener('keyup', (e) => this.keys.delete(e.code));
      window.addEventListener('blur', () => this.keys.clear());
      dom.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    touch() { this.lastInput = performance.now(); this.attractT = 0; }

    // 位置と向き(dir)を設定する
    setPose({ pos, dir }) {
      this.camera.position.copy(pos);
      this.yaw = Math.atan2(-dir.x, -dir.z);
      this.pitch = Math.asin(clamp(dir.y, -1, 1));
      this.vel.set(0, 0, 0);
      this.camera.rotation.set(this.pitch, this.yaw, 0);
    }

    forward(out = new THREE.Vector3()) {
      return out.set(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));
    }

    // 視線を寄せる(操作中・最近操作した時はしない)
    attract(point, strength = 0.35) {
      if (this.dragging || this.idleFor < 2.5) return;
      const p = this.camera.position;
      const d = point.clone().sub(p);
      const dist = d.length();
      if (dist > 32) return;
      d.normalize();
      if (d.dot(this.forward()) < 0.5) return; // 視界の外(60度以上離れた所)には振り向かない
      this.attractYaw = Math.atan2(-d.x, -d.z);
      this.attractPitch = Math.asin(clamp(d.y, -1, 1));
      this.attractStrength = strength;
      this.attractT = 1.2;
    }

    update(dt) {
      const k = this.keys;
      const f = this.forward();
      const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
      const acc = new THREE.Vector3();
      const sp = k.has('ShiftLeft') || k.has('ShiftRight') ? 26 : 13;
      if (k.has('KeyW') || k.has('ArrowUp')) acc.add(f);
      if (k.has('KeyS') || k.has('ArrowDown')) acc.sub(f);
      if (k.has('KeyD') || k.has('ArrowRight')) acc.add(right);
      if (k.has('KeyA') || k.has('ArrowLeft')) acc.sub(right);
      if (k.has('KeyE')) acc.y += 1;
      if (k.has('KeyQ')) acc.y -= 1;
      if (acc.lengthSq()) this.vel.addScaledVector(acc.normalize(), sp * dt * 4);

      // シネマ: 操作が無い間、生物を後ろ斜めから追い、時々別の生物に乗り換える
      let filmed = false;
      if (this.mode === 'cinema' && this.idleFor > 3 && this.getTargets) {
        const list = this.getTargets().filter((c) => c.mesh.visible && c.phase !== 'fade');
        this.followT = (this.followT || 0) + dt;
        if (!this.follow || !list.includes(this.follow) || this.followT > 13) {
          this.follow = list.length ? list[Math.floor(Math.random() * list.length)] : null;
          this.followT = 0;
          this.side = Math.random() < 0.5 ? -1 : 1;
        }
        if (this.follow) {
          filmed = true;
          const p = this.follow.mesh.position;
          const fwd = new THREE.Vector3(1, 0, 0).applyQuaternion(this.follow.mesh.quaternion);
          const up = this.space.toAxis(p);
          const sideV = new THREE.Vector3().crossVectors(fwd, up).normalize();
          const t = performance.now() / 1000;
          const want = p.clone().addScaledVector(fwd, -6.5).addScaledVector(up, 2.2 + Math.sin(t * 0.3)).addScaledVector(sideV, this.side * (2.5 + Math.sin(t * 0.21) * 1.5));
          this.space.clampInside(want, 1.4);
          this.camera.position.lerp(want, 1 - Math.exp(-dt * 0.9));
          const d = p.clone().sub(this.camera.position).normalize();
          let dy = Math.atan2(-d.x, -d.z) - this.yaw;
          dy = Math.atan2(Math.sin(dy), Math.cos(dy));
          this.yaw += dy * (1 - Math.exp(-dt * 2.2));
          this.pitch += (Math.asin(clamp(d.y, -1, 1)) - this.pitch) * (1 - Math.exp(-dt * 2.2));
          this.vel.set(0, 0, 0);
        }
      }

      // 漂うモード: 操作が無い間、チューブの中心線に沿ってゆっくり進み、少しだけ見回す
      if ((this.mode === 'drift' || (this.mode === 'cinema' && !filmed)) && this.idleFor > 3) {
        const y = this.space.toPlane(this.camera.position).y;
        if (!this.space.periodicY) {
          const b = this.space.driftBounds ? this.space.driftBounds(y) : { lo: 12, hi: this.space.L - 12 };
          if (y > b.hi) this.driftDir = -1;
          if (y < b.lo) this.driftDir = 1;
        }
        const tan = this.space.tangentAt(y).multiplyScalar(this.driftDir);
        this.vel.lerp(tan.clone().multiplyScalar(2.4), Math.min(1, dt * 4)); // 減衰と釣り合って秒速 1.3 ほど
        const t = performance.now() / 1000;
        let dy = Math.atan2(-tan.x, -tan.z) + Math.sin(t * 0.13) * 0.35 - this.yaw;
        dy = Math.atan2(Math.sin(dy), Math.cos(dy));
        this.yaw += dy * dt * 0.25;
        this.pitch += (Math.asin(clamp(tan.y, -1, 1)) + Math.sin(t * 0.09) * 0.15 - this.pitch) * dt * 0.25;
      }

      if (this.attractT > 0) {
        this.attractT -= dt;
        const s = this.attractStrength * dt * 2.2;
        let dy = this.attractYaw - this.yaw;
        dy = Math.atan2(Math.sin(dy), Math.cos(dy));
        this.yaw += dy * s;
        this.pitch += (this.attractPitch - this.pitch) * s;
      }

      this.vel.multiplyScalar(Math.exp(-dt * 3.2));
      const pos = this.camera.position.addScaledVector(this.vel, dt);
      this.space.clampInside(pos);
      this.camera.rotation.set(this.pitch, this.yaw, 0);
    }
  }

  TL.CameraControls = CameraControls;
})(window.TL = window.TL || {});
