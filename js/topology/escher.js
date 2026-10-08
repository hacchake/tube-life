// Escher風テセレーション: 生物の輪郭そのものがタイルになり、隙間なく平面を埋める。
//
// 仕組み(並進タイリング): タイルの対辺に「同じ曲線」を平行移動して使う。
// ある辺を外へ膨らませると、隣のタイルの同じ辺は同じだけ内へ凹むので、輪郭を互いに共有して隙間ができない。
//   魚    : 正方形格子。右辺の膨らみ = 頭、それが左辺では凹み = 尾の切れ込み。上下の辺は背びれと腹。
//   鳥    : 正方形格子。上辺の膨らみ = 片方の翼、下辺の膨らみ = もう片方の翼。右辺の尖り = くちばし、左辺 = 二股の尾。
//   トカゲ: 六角形格子(3組の対辺)。6つの膨らみが 頭・尾・4本の脚 になる。
//
// 各セルには species(どの生物のタイルか)、tone(塗り分け)、decor(目などの模様の線)を持たせる。
// 生物が飛び出す時は、このタイルの輪郭をそのまま立体化する(TL.Escher.creatureOutline)。
(function (TL) {
  'use strict';

  const S3 = Math.sqrt(3);
  const bump = (t, c, w) => Math.exp(-(((t - c) / w) ** 2));
  const env = (t) => Math.sin(Math.PI * t); // 辺の両端では必ず 0(角を共有するため)

  // P → Q の辺を、左手側(多角形の外側)へ c(t) だけずらした点列(P を含み Q は含まない)
  function edge(P, Q, c, n) {
    const dx = Q[0] - P[0], dy = Q[1] - P[1];
    const len = Math.hypot(dx, dy);
    const nx = dy / len, ny = -dx / len; // 反時計回りの多角形で外向き
    const out = [];
    for (let k = 0; k < n; k++) {
      const t = k / n, o = c(t) * len;
      out.push([P[0] + dx * t + nx * o, P[1] + dy * t + ny * o]);
    }
    return out;
  }

  // 辺 e(P→Q)を平行移動 d して向きを逆にした点列(Q+d → P+d、Q+d を含み P+d は含まない)
  function opposite(P, Q, c, n, d) {
    const pts = edge(P, Q, c, n).map(([x, y]) => [x + d[0], y + d[1]]);
    pts.push([Q[0] + d[0], Q[1] + d[1]]);
    pts.reverse();
    pts.pop();
    return pts;
  }

  const circle = (cx, cy, r, n = 10) => {
    const out = [];
    for (let k = 0; k <= n; k++) { const t = (k / n) * 2 * Math.PI; out.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]); }
    return out;
  };

  // ---------- 原型(格子単位 1 の座標) ----------
  const PROTOS = {
    fish() {
      const N = 24;
      // 下辺: 尾の側が凹み(尾の付け根を細く)、頭の側が腹として膨らむ。尖った山 = 背びれ(下の魚では腹びれの凹み)
      const g = (t) => 0.13 * Math.sin(2 * Math.PI * t) + env(t) * 0.17 * bump(t, 0.36, 0.07);
      // 右辺: 尖った頭(左辺では V 字の尾の切れ込みになる)
      const f = (t) => env(t) * 0.44 * bump(t, 0.5, 0.17);
      // 下辺は (0,0)→(1,0)、右辺は (1,0)→(1,1)。上辺・左辺はそれぞれの平行移動。
      const bottom = edge([0, 0], [1, 0], (t) => -g(t), N);
      const right = edge([1, 0], [1, 1], (t) => f(t), N);
      const top = opposite([0, 0], [1, 0], (t) => -g(t), N, [0, 1]);
      const left = opposite([1, 0], [1, 1], (t) => f(t), N, [-1, 0]);
      return {
        lattice: 'square',
        poly: bottom.concat(right, top, left),
        decor: [
          circle(1.13, 0.58, 0.06),                       // 目
          [[0.9, 0.28], [0.97, 0.5], [0.9, 0.74]],        // えら
          [[0.25, 0.42], [0.45, 0.5], [0.25, 0.58]],      // うろこの筋
          [[0.45, 0.4], [0.65, 0.5], [0.45, 0.6]],
        ],
        head: 0,
      };
    },
    bird() {
      const N = 22;
      const g = (t) => env(t) * (0.42 * bump(t, 0.32, 0.11) - 0.42 * bump(t, 0.68, 0.11)); // 上辺で翼、下辺で反対の翼
      const f = (t) => env(t) * (0.24 * bump(t, 0.5, 0.08) - 0.09 * bump(t, 0.2, 0.07) - 0.09 * bump(t, 0.8, 0.07)); // くちばしと尾
      const bottom = edge([0, 0], [1, 0], (t) => -g(t), N);
      const right = edge([1, 0], [1, 1], (t) => f(t), N);
      const top = opposite([0, 0], [1, 0], (t) => -g(t), N, [0, 1]);
      const left = opposite([1, 0], [1, 1], (t) => f(t), N, [-1, 0]);
      return {
        lattice: 'square',
        poly: bottom.concat(right, top, left),
        decor: [circle(1.02, 0.56, 0.04), [[0.55, 0.3], [0.62, 0.5], [0.55, 0.7]]],
        head: 0,
      };
    },
    lizard() {
      // 頂点が上下を向く六角形(外接半径 1)。対辺: e0↔e3(-a)、e1↔e4(-b)、e2↔e5(a-b)
      const N = 16;
      const r = 1, w = S3 * r;
      const v = [[w / 2, r / 2], [0, r], [-w / 2, r / 2], [-w / 2, -r / 2], [0, -r], [w / 2, -r / 2]];
      const a = [w, 0], b = [w / 2, 1.5 * r];
      const head = (t) => env(t) * (0.5 * bump(t, 0.3, 0.1) - 0.72 * bump(t, 0.72, 0.055)); // 右辺: 頭、左辺では尾
      const leg = (t) => env(t) * (0.46 * bump(t, 0.3, 0.06) - 0.46 * bump(t, 0.7, 0.06));  // 斜めの辺: 脚
      const e0 = edge(v[5], v[0], head, N);
      const e1 = edge(v[0], v[1], leg, N);
      const e2 = edge(v[1], v[2], leg, N);
      const e3 = opposite(v[5], v[0], head, N, [-a[0], -a[1]]);
      const e4 = opposite(v[0], v[1], leg, N, [-b[0], -b[1]]);
      const e5 = opposite(v[1], v[2], leg, N, [a[0] - b[0], a[1] - b[1]]);
      // 頭は右辺の下寄り、尾は左辺の上寄り → 体の向きは右下を向く斜め
      const headPt = [w / 2 + 0.5, -0.2], tailPt = [-w / 2 - 0.72, 0.22];
      return {
        lattice: 'hex', a, b, w,
        poly: e0.concat(e1, e2, e3, e4, e5),
        decor: [
          circle(headPt[0] - 0.16, headPt[1] + 0.07, 0.05), circle(headPt[0] - 0.16, headPt[1] - 0.11, 0.05), // 目
          // 背骨: 尾から頭へゆるく S 字に
          [0, 1, 2, 3, 4, 5, 6, 7, 8].map((k) => {
            const t = k / 8;
            const x = tailPt[0] * 0.85 * (1 - t) + (headPt[0] - 0.3) * t, y = tailPt[1] * 0.85 * (1 - t) + headPt[1] * t;
            return [x + 0.08 * Math.sin(Math.PI * 2 * t), y + 0.1 * Math.sin(Math.PI * 2 * t)];
          }),
        ],
        head: Math.atan2(headPt[1] - tailPt[1], headPt[0] - tailPt[0]),
      };
    },
  };

  const cache = {};
  function proto(species) {
    if (!cache[species]) {
      const p = PROTOS[species]();
      // 重心を原点に
      let cx = 0, cy = 0;
      for (const [x, y] of p.poly) { cx += x; cy += y; }
      cx /= p.poly.length; cy /= p.poly.length;
      p.poly = p.poly.map(([x, y]) => [x - cx, y - cy]);
      p.decor = p.decor.map((d) => d.map(([x, y]) => [x - cx, y - cy]));
      cache[species] = p;
    }
    return cache[species];
  }

  // ---------- Topology として登録 ----------
  function build(species, Lx, Ly, around) {
    const p = proto(species);
    const T = new TL.Topology('escher-' + species, Lx, Ly);
    if (p.lattice === 'square') {
      const s = Lx / around;
      T.cellSize = s;
      const rows = Math.floor(Ly / s);
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < around; i++) {
          const x = (i + 0.5) * s, y = (j + 0.5) * s;
          T.add('creature', x, y, p.poly.map(([u, v]) => [u * s, v * s]), {
            species, tone: (i + j) % 2,
            decor: p.decor.map((d) => d.map(([u, v]) => [x + u * s, y + v * s])),
            proto: { scale: s, head: p.head },
          });
        }
      }
    } else {
      // 六角形格子: 周方向に around 個。行ごとに半個ずれる(格子ベクトル b)
      const s = Lx / (around * p.w);
      T.cellSize = s * p.w;
      const rowH = p.b[1] * s;
      const rows = Math.floor(Ly / rowH);
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < around; i++) {
          const x = (i * p.a[0] + j * p.b[0]) * s + p.w * s * 0.5, y = (j + 0.5) * rowH;
          T.add('creature', x, y, p.poly.map(([u, v]) => [u * s, v * s]), {
            species, tone: (((i - j) % 3) + 3) % 3,
            decor: p.decor.map((d) => d.map(([u, v]) => [x + u * s, y + v * s])),
            proto: { scale: s, head: p.head },
          });
        }
      }
      // 周方向の周期と行のずれが合うように、x は Topology.add で周期化される
    }
    // 角を共有するタイル同士が隣(正方形格子 = 8、六角形格子 = 6)
    T.linkByVertices(T.cellSize * 0.02);
    // decor の x も周期化(Topology.add は shape しか直さない)
    return T;
  }

  for (const [id, name] of [['fish', 'Escher: Fish'], ['bird', 'Escher: Bird'], ['lizard', 'Escher: Lizard']]) {
    TL.Topology.register('escher-' + id, name, (Lx, Ly, around) => build(id, Lx, Ly, Math.max(6, Math.round(around * (id === 'lizard' ? 0.62 : 0.8)))));
  }

  // タイルの輪郭を、生物の 3D 化に使える形にする(長さ 1、頭が +X)。
  // 壁に平たく置いた時に輪郭がタイルとぴったり重なるよう、頭の向き head だけ回し、Y を反転する
  // (平たい姿勢では生物の Y が壁の -長さ方向 を向くため)。
  function creatureOutline(cell) {
    const p = proto(cell.species);
    const c = Math.cos(-p.head), s = Math.sin(-p.head);
    const rot = ([x, y]) => [x * c - y * s, x * s + y * c];
    const pts = p.poly.map(rot);
    let x0 = Infinity, x1 = -Infinity;
    for (const [x] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); }
    const L = x1 - x0;
    const norm = ([x, y]) => [x / L, -y / L];
    const shape = new THREE.Shape();
    pts.map(norm).forEach(([x, y], i) => (i ? shape.lineTo(x, y) : shape.moveTo(x, y)));
    shape.closePath();
    // 目: 模様のうち閉じた丸の中心(魚は体の両面、鳥・トカゲは背中側)
    const top = TL.Species.get(cell.species).pose === 'top';
    const eyes = [];
    for (const d of p.decor) {
      const [fx, fy] = d[0], [lx, ly] = d[d.length - 1];
      if (Math.hypot(fx - lx, fy - ly) > 1e-6) continue;
      let ex = 0, ey = 0;
      for (const [x, y] of d) { ex += x; ey += y; }
      const [rx, ry] = norm(rot([ex / d.length, ey / d.length]));
      if (top) eyes.push([rx, ry, 1]);
      else eyes.push([rx, ry, 1], [rx, ry, -1]);
    }
    return { shape, key: 'escher-' + cell.species, length: L * cell.proto.scale, head: p.head, eyes };
  }

  TL.Escher = { proto, creatureOutline };
})(window.TL = window.TL || {});
