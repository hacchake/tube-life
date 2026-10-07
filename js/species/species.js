// 生物の種類(Species)。輪郭は 2D の Shape(長さ 1、+X が頭)として定義し、
// 3D 化(押し出し)や動き方は表示側(render/creatures.js)が motion に応じて行う。
// 新しい種は TL.Species.register() で追加する(Bird / Lizard / 変態先など)。
(function (TL) {
  'use strict';

  const list = [];
  const byId = {};

  const Species = {
    register(def) { list.push(def); byId[def.id] = def; },
    get(id) { return byId[id] || byId.fish; },
    get all() { return list; },
  };

  // 魚: 頭が +X。尾びれは二股。
  Species.register({
    id: 'fish',
    name: 'Fish',
    ready: true,
    motion: 'swim',          // 泳ぐ(チューブの中を通って別のタイルへ)
    color: '#39c4ff',
    emissive: '#0b5cff',
    voice: 'fish',
    length: 1.9,             // ワールド単位での体長
    thickness: 0.17,         // 体長に対する厚み
    pose: 'side',            // 輪郭 = 横から見た形(背が +Y、体の横が Z)
    deform: 'tail',          // 尾を振る
    emergeTime: 2.0,
    speed: 4.2,              // 移動の速さ(単位/秒)
    range: [6, 22],          // 次のタイルまでの距離(長さ方向)
    outline(THREE) {
      const s = new THREE.Shape();
      s.moveTo(0.5, 0);
      s.bezierCurveTo(0.47, 0.15, 0.25, 0.25, 0.02, 0.22);   // 頭〜背
      s.bezierCurveTo(-0.08, 0.31, -0.16, 0.28, -0.2, 0.17);  // 背びれ
      s.bezierCurveTo(-0.26, 0.12, -0.3, 0.06, -0.33, 0.03);  // 尾の付け根
      s.lineTo(-0.5, 0.21);                                   // 尾びれ(上)
      s.quadraticCurveTo(-0.43, 0, -0.5, -0.21);              // 尾びれの切れ込み
      s.lineTo(-0.33, -0.03);
      s.bezierCurveTo(-0.28, -0.09, -0.15, -0.17, -0.02, -0.18); // 腹
      s.bezierCurveTo(0.12, -0.22, 0.45, -0.15, 0.5, 0);
      return s;
    },
    eyes: [[0.3, 0.05, 1], [0.3, 0.05, -1]], // [x, y, 表裏]
  });

  // 鳥: 翼を広げて上から見た形。頭が +X、翼が ±Y、背中が +Z。
  Species.register({
    id: 'bird',
    name: 'Bird',
    ready: true,
    motion: 'fly',           // 羽ばたいてチューブの奥へ飛ぶ
    color: '#ff7a1f',
    emissive: '#d63000',
    voice: 'bird',
    length: 1.5,
    thickness: 0.07,
    pose: 'top',             // 輪郭 = 上から見た形(背が Z)
    deform: 'wings',         // 翼を上下に振る
    emergeTime: 1.7,
    speed: 7.5,
    range: [16, 38],
    outline(THREE) {
      // 右半分(+Y)を描いて左右対称にする
      const half = [
        [0.5, 0], [0.42, 0.04], [0.34, 0.07], [0.22, 0.08],           // くちばし〜首
        [0.14, 0.1], [0.06, 0.32], [-0.02, 0.56], [-0.06, 0.74],     // 翼の前縁〜翼の先
        [-0.13, 0.72], [-0.12, 0.6], [-0.18, 0.62], [-0.17, 0.48],   // 風切り羽のぎざぎざ
        [-0.23, 0.5], [-0.21, 0.34], [-0.26, 0.33], [-0.2, 0.12],
        [-0.27, 0.08], [-0.48, 0.17], [-0.44, 0.07], [-0.5, 0.0],    // 尾羽
      ];
      const pts = half.concat(half.slice(1, -1).reverse().map(([x, y]) => [x, -y]));
      const s = new THREE.Shape();
      pts.forEach(([x, y], i) => (i ? s.lineTo(x, y) : s.moveTo(x, y)));
      s.closePath();
      return s;
    },
    eyes: [[0.36, 0.045, 1], [0.36, -0.045, 1]],
  });

  // 以降の段階で実装する種(メニューでは「準備中」として表示)
  Species.register({ id: 'lizard', name: 'Lizard', ready: false, motion: 'crawl', voice: 'lizard' });

  TL.Species = Species;
})(window.TL = window.TL || {});
