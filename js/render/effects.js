// 演出: 壁面に広がる波紋(リング)。種まき・着地の場所で静かに広がる。
(function (TL) {
  'use strict';

  class Ripples {
    constructor(scene, space) {
      this.scene = scene;
      this.space = space;
      this.items = [];
      const geo = new THREE.RingGeometry(0.92, 1, 64);
      for (let i = 0; i < 10; i++) {
        const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
          color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
        }));
        m.visible = false;
        scene.add(m);
        this.items.push({ m, t: 0, dur: 1, size: 1 });
      }
    }

    spawn(x, y, color = 0x9fd8ff, size = 5, dur = 1.6) {
      const it = this.items.find((r) => !r.m.visible) || this.items[0];
      const f = this.space.frame(x, y);
      it.m.position.copy(f.pos).addScaledVector(f.normal, 0.08);
      it.m.lookAt(f.pos.clone().addScaledVector(f.normal, 2));
      it.m.material.color.set(color);
      it.m.visible = true;
      Object.assign(it, { t: 0, dur, size });
    }

    clear() { for (const it of this.items) it.m.visible = false; }

    update(dt) {
      for (const it of this.items) {
        if (!it.m.visible) continue;
        it.t += dt;
        const u = it.t / it.dur;
        if (u >= 1) { it.m.visible = false; continue; }
        const s = 0.3 + it.size * (1 - Math.pow(1 - u, 2));
        it.m.scale.set(s, s, s);
        it.m.material.opacity = 0.9 * (1 - u);
      }
    }
  }

  TL.Ripples = Ripples;
})(window.TL = window.TL || {});
