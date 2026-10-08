// 変態(Metamorphosis): 1 匹の生物が一生のうちに姿を変える。
//
//   Fish(タイルから現れる)→ 泳ぎながら Bird へ → Bird として飛ぶ
//   → 壁へ降りながら Lizard へ → Lizard として壁を這う → タイルへ戻る
//
// 形は単純に切り替えず、輪郭(同じ点数に揃えて補間)・姿勢(横向き ⇄ 上向き)・
// 体の動き(尾 / 翼 / くねり の重み)・色・大きさをすべて滑らかに混ぜる。
// CreatureSystem に spawnMeta() を足し、update で 'meta-*' の段階を進める。
(function (TL) {
  'use strict';
  const { clamp, smooth, lerp } = TL.util;
  const { flatQuat, travelQuat, WallPath } = TL.CreatureMath;

  const N = 120; // 輪郭の点数(全種で揃える)
  const outlines = {};
  // 種の輪郭を鼻先から反時計回りに、等間隔の N 点へ
  function resampled(sp) {
    if (outlines[sp.id]) return outlines[sp.id];
    const pts = sp.outline(THREE).getSpacedPoints(N);
    if (pts[0].distanceTo(pts[pts.length - 1]) < 1e-6) pts.pop();
    if (THREE.ShapeUtils.isClockWise(pts)) { const first = pts.shift(); pts.reverse(); pts.unshift(first); }
    outlines[sp.id] = pts.slice(0, N);
    return outlines[sp.id];
  }

  const WEIGHTS = { tail: [1, 0, 0], wings: [0, 1, 0], body: [0, 0, 1] };
  const tmpA = new THREE.Color(), tmpB = new THREE.Color();

  const P = TL.CreatureSystem.prototype;

  // A → B を w (0..1) で混ぜた姿にする
  P._morphTo = function (c, A, B, w) {
    w = clamp(w, 0, 1);
    // 形は変化が見える時だけ作り直す(負荷を抑える)
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
    c.uniforms.wTail.value = lerp(wa[0], wb[0], w);
    c.uniforms.wWing.value = lerp(wa[1], wb[1], w);
    c.uniforms.wBody.value = lerp(wa[2], wb[2], w);
    c.mat.color.copy(tmpA.set(A.color)).lerp(tmpB.set(B.color), w);
    c.mat.emissive.copy(tmpA.set(A.emissive)).lerp(tmpB.set(B.emissive), w);
    c.length = lerp(A.length, B.length, w);
    c.poseW = (A.pose === 'top' ? 1 : 0) * (1 - w) + (B.pose === 'top' ? 1 : 0) * w; // 0 = 横向き, 1 = 上向き
    // 目は姿が定まっている時だけ(変化の途中は隠す)
    const settled = w < 0.02 ? A : w > 0.98 ? B : null;
    if (settled !== c.eyeOwner) {
      this._setEyes(c, settled ? settled.eyes : [], settled ? settled.thickness : 0.1);
      c.eyeOwner = settled;
    }
    c.shown = w < 0.5 ? A : B; // 今どの種に見えるか(デバッグ・音用)
  };

  // 横向き(魚)と上向き(鳥・トカゲ)の姿勢を混ぜる
  P._metaQuat = function (c, fwd, up, roll) {
    const qs = travelQuat('side', fwd, up, roll), qt = travelQuat('top', fwd, up, roll);
    return c.q.copy(qs).slerp(qt, c.poseW);
  };

  // from: 出発タイル、mid: 鳥が降りる壁の位置、to: トカゲが最後に戻るタイル
  P.spawnMeta = function (from, mid, to, { chain = 0 } = {}) {
    if (this.active.length >= 24) return null;
    const fish = TL.Species.get('fish'), bird = TL.Species.get('bird'), lizard = TL.Species.get('lizard');
    let c = this.pool.find((p) => p.key === 'meta');
    if (c) this.pool.splice(this.pool.indexOf(c), 1);
    else { c = this._make(fish, null, 'meta'); c.key = 'meta'; }
    c.species = fish;
    c.morphKey = null;
    c.eyeOwner = undefined;
    this._morphTo(c, fish, bird, 0);

    const space = this.space;
    const f0 = space.frame(from.x, from.y), fm = space.frame(mid.x, mid.y), f1 = space.frame(to.x, to.y);
    const curve = this._path(bird, from, mid);       // 泳ぎ〜飛行は鳥の通り道(中心寄りのらせん)
    const crawl = new WallPath(space, mid.x, mid.y, to.x, to.y, 0.14, this.rng);
    const t0 = curve.getTangentAt(0);
    Object.assign(c, {
      meta: true, phase: 'meta-emerge', t: 0, chain, from, mid, to, curve, crawl, f0, fm, f1,
      travelDur: clamp(curve.getLength() / 5.5, 4.5, 9),
      crawlDur: clamp(crawl.getLength() / lizard.speed, 2.5, 6),
      qFlat0: flatQuat(f0.normal, t0),
      qFlat1: flatQuat(f1.normal, crawl.getTangentAt(1)),
      qTravel0: travelQuat('side', t0, space.toAxis(curve.getPointAt(0)), 0),
      q: new THREE.Quaternion(),
      phaseOffset: this.rng() * 10,
      crawlT: 0,
      morphed: {},
    });
    c.mesh.visible = true;
    c.mesh.quaternion.copy(c.qFlat0);
    c.mat.opacity = 1;
    c.eyeM.opacity = 1;
    this.active.push(c);
    this.bus.emit('emerge', { creature: c, cell: from });
    return c;
  };

  // 変態の 1 フレーム。通常の生物と同じ _pose / _motion の考え方で、種の重みを混ぜて動かす。
  P._updateMeta = function (c, dt) {
    const space = this.space;
    const fish = TL.Species.get('fish'), bird = TL.Species.get('bird'), lizard = TL.Species.get('lizard');
    const once = (name, payload) => { if (!c.morphed[name]) { c.morphed[name] = true; this.bus.emit('morph', Object.assign({ creature: c, stage: name }, payload)); } };

    if (c.phase === 'meta-emerge') {
      // 魚としてタイルから現れる
      const u = c.t / fish.emergeTime;
      const pos = c.f0.pos.clone().addScaledVector(c.f0.normal, 0.06 + smooth((u - 0.15) / 0.55) * 0.5);
      c.mesh.quaternion.copy(u < 0.7 ? c.qFlat0 : c.q.copy(c.qFlat0).slerp(c.qTravel0, smooth((u - 0.7) / 0.3)));
      this._pose(c, pos, 0.03 + 0.97 * smooth((u - 0.3) / 0.5), 1.6 * (1 - u) + 0.5, 0.1 * smooth((u - 0.6) / 0.4), 9);
      if (u >= 1) { c.phase = 'meta-travel'; c.t = 0; }
    } else if (c.phase === 'meta-travel') {
      // 泳ぎ始め → 途中で鳥へ変わり、羽ばたいて飛ぶ
      const u = clamp(c.t / c.travelDur, 0, 1);
      const s = 0.5 - 0.5 * Math.cos(Math.PI * u);
      const w = smooth((u - 0.18) / 0.3);
      if (w > 0) once('fish-bird', { from: 'fish', to: 'bird', pos: c.mesh.position.clone() });
      this._morphTo(c, fish, bird, w);
      const pos = c.curve.getPointAt(s), tan = c.curve.getTangentAt(s);
      const up = space.toAxis(pos);
      const ahead = c.curve.getTangentAt(Math.min(1, s + 0.04));
      const roll = w * clamp(new THREE.Vector3().crossVectors(tan, ahead).dot(up) * 12, -0.7, 0.7);
      c.mesh.quaternion.slerp(this._metaQuat(c, tan, up, roll), 1 - Math.exp(-dt * 8));
      const glide = 0.5 + 0.5 * Math.sin(this.time * 1.1 + c.phaseOffset);
      const amp = lerp(0.13, 0.08 + 0.26 * glide, w), freq = lerp(9, 7 + 5 * glide, w);
      // 変化の瞬間は少し光る
      this._pose(c, pos, 1, 0.5 + 1.2 * Math.sin(Math.PI * clamp((u - 0.18) / 0.3, 0, 1)), amp, freq);
      if (u >= 1) { c.phase = 'meta-descend'; c.t = 0; c.qFrom = c.mesh.quaternion.clone(); c.descFrom = pos.clone(); }
    } else if (c.phase === 'meta-descend') {
      // 壁へ降りながらトカゲへ変わる
      const u = clamp(c.t / 1.8, 0, 1);
      if (u > 0) once('bird-lizard', { from: 'bird', to: 'lizard', pos: c.mesh.position.clone() });
      this._morphTo(c, bird, lizard, smooth(u / 0.85));
      const target = c.crawl.getPointAt(0);
      const pos = c.descFrom.clone().lerp(target, smooth(u));
      const qCrawl = flatQuat(c.fm.normal, c.crawl.getTangentAt(0));
      c.mesh.quaternion.copy(c.qFrom).slerp(qCrawl, smooth(u));
      this._pose(c, pos, 1, 0.5 + 1.2 * Math.sin(Math.PI * u), lerp(0.25, 0.15, u), lerp(10, 7, u));
      if (u >= 1) { c.phase = 'meta-crawl'; c.t = 0; this.bus.emit('touch', { creature: c, x: c.mid.x, y: c.mid.y }); }
    } else if (c.phase === 'meta-crawl') {
      // トカゲとして壁を這う
      const u = clamp(c.t / c.crawlDur, 0, 1);
      const pos = c.crawl.getPointAt(u), tan = c.crawl.getTangentAt(u);
      const [px, py] = c.crawl.plane(u);
      flatQuat(space.frame(px, py).normal, tan, c.q);
      c.mesh.quaternion.slerp(c.q, 1 - Math.exp(-dt * 8));
      this._pose(c, pos, 1, 0.5, 0.22, 8);
      c.crawlT -= dt;
      if (c.crawlT <= 0) { c.crawlT = 0.18; this.bus.emit('crawl', { creature: c, x: px, y: py }); }
      if (u >= 1) { c.phase = 'land'; c.t = 0; c.qLand = c.mesh.quaternion.clone(); c.landFrom = pos.clone(); c.species = lizard; }
    }
  };
})(window.TL = window.TL || {});
