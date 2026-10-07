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
    eye: [0.3, 0.05],
  });

  // 以降の段階で実装する種(メニューでは「準備中」として表示)
  Species.register({ id: 'bird', name: 'Bird', ready: false, motion: 'fly', voice: 'bird' });
  Species.register({ id: 'lizard', name: 'Lizard', ready: false, motion: 'crawl', voice: 'lizard' });

  TL.Species = Species;
})(window.TL = window.TL || {});
