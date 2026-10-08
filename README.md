# Tube of Life

Flower of Life × Escher風テセレーション × Cellular Automaton × 3D Tube × 生命体 の、ブラウザだけで動く実験作品。

巨大なチューブの内壁に、セル・オートマトン(CA)のセルとしてのタイルが敷き詰められている。
タイルに触れると生命が植えられ、色の波が壁を伝わり、タイルから生物が立体化して飛び出す。
生物が別のタイルに着くと、そこが新しい生命の発生源になる。
「Cellular Automaton を操作する」のではなく「Cellular Automaton が生きている世界に入り込む」作品。

## 起動

`index.html` をブラウザで開く(ダブルクリックで可)。Three.js は CDN(jsdelivr)から読み込むので、ネット接続が必要。

公開ページ: https://hacchake.github.io/tube-life/

| 操作 | 内容 |
|---|---|
| クリック / タップ | タイルに生命を植える |
| ドラッグ | 見回す |
| WASD / 矢印 | 移動(Shift で速く、Q / E で上下) |
| ホイール | 前後 |
| M | 設定メニュー(右下のボタンでも開く) |
| I | Debug 表示(FPS・世代・活動セル数・生物の数・カメラ位置・選択セルと近傍数) |

## 設定メニュー

| 項目 | 内容 |
|---|---|
| CA | CA の計算の ON/OFF(生物は止めずに動く) |
| Reset / Random Seed | 全部消す / 新しい乱数の種で始め直していくつか生命を植える |
| Grid Type | Flower of Life / Flower of Life(重層)/ Hex / Triangle / Escher: Fish / Bird / Lizard |
| Space | 円筒 / 曲がったチューブ / トーラス / 分岐(Y字) |
| Species | Fish / Bird / Lizard / 順番(魚→鳥→トカゲ)/ Metamorphosis(変態)/ Ecosystem(複数生物) |
| Speed / Sound / Volume | CA の速さ、音の ON/OFF と音量 |
| Camera | Free(自由)/ Drift(チューブに沿ってゆっくり漂う) |
| 自動で生命 | 静かな時に、見えている所で時々生命が生まれる |
| MIDI(実験的) | Launchpad Mini MK3 などの 8×8 パッドで、見ている画面の 8×8 区画を叩ける(未検証) |

## 段階ごとにできたこと

1. **最小版** — 円筒チューブの内壁に Flower of Life のセル(円の中心=三角格子点から花びらと曲線三角形を生成、近傍 6)。
   クリックで IDLE → ACTIVATING → BORN → GROWING → MATURE → DECAY → DEAD → 休眠 → IDLE の波が広がり、
   タイルから魚が立体化して泳ぎ出し、別のタイルで溶け込み、そこから CA が再開して次の生物が生まれる。音・Reset・Debug。
2. **鳥** — 翼を広げた輪郭から立体化し、羽ばたきと滑空を繰り返してらせんを描きながら奥へ飛ぶ。旋回で体を傾ける。
3. **トカゲ** — 脚と長い尾の輪郭。壁から離れずに体をくねらせて這い、通った跡のタイルが光る。
4. **Escher風テセレーション** — タイルの対辺に同じ曲線を平行移動して使う並進タイリングで、生物の輪郭そのものがタイルになる
   (魚・鳥は正方形格子、トカゲは六角形格子)。タイルを押すとその輪郭がそのまま立体化し、着地先の同じ形のタイルへ向きまでぴったり戻る。
5. **変態(モーフィング)** — 魚として現れ、泳ぎながら鳥に、壁へ降りながらトカゲになって這い、タイルへ戻る。
   輪郭(点数を揃えて補間)・姿勢・体の動き・色・大きさを滑らかに混ぜる。
6. **複数生物** — 3 種と変態する個体がいっしょに暮らし、1 つの波から別の種が 2 匹生まれることも。移動中の 2 匹が出会うと真下に新しい生命が生まれる。
7. **Triangle** — 三角格子の三角形がセル(近傍 12)。
8. **複雑な Flower 構造** — 花びらを 2 つ、曲線三角形を 3 つに分けた重層の Flower of Life。向きごとに塗り分けて星形の模様が浮かぶ。
9. **空間の拡張** — 曲がったチューブ・トーラス(長さ方向も一周してつながる)・分岐(幹と 2 本の枝。分かれ目は開口になり、波も生物も枝へ渡る)。

## 構成

```
CA Engine            js/ca/engine.js          表示に依存しない状態遷移と伝播(どの格子でも同じ)
 ↓
Topology             js/topology/topology.js  セルの形と neighbor graph(Flower / 重層 Flower / Hex / Triangle、register で追加)
                     js/topology/escher.js    Escher風テセレーション(魚・鳥・トカゲ)
 ↓
Species              js/species/species.js    生物の 2D 輪郭・姿勢・体の動き・速さ・飛距離・音色
 ↓
Animation/Event      js/app.js                CA・生物・音・演出をイベントでつなぐ(連鎖・出会い・自動発生)
 ↓
Space                js/world/space.js        平面 → 3D の巻き付け(円筒 / スパイン空間 = 曲がったチューブ・トーラス)
                     js/world/branch.js       分岐(3 本のスパイン空間を 1 枚の盤面にまとめる)
 ↓
3D Renderer          js/render/tiles.js       壁タイル(1 メッシュ、変化したセルだけ更新)
                     js/render/creatures.js   生物(プール、頂点シェーダーで尾・翼・くねりを重みで混ぜる)
                     js/render/metamorph.js   変態
                     js/render/effects.js     波紋 / js/render/stage.js シーン・ブルーム
 ↓
Audio System         js/audio/audio.js        CA の各状態・生物ごとの音色・変態・出会い
 ↓
Input System         js/input/input.js        VirtualPointerInput(マウス)/ MidiPadInput(Launchpad Mini MK3、未検証)
                     js/input/camera.js       カメラ操作(Free / Drift、出来事への視線の引き寄せ)
```

- セル: Topology が `{ id, position, kind, shape, neighbors }`、CA が `{ id, state, species, generation, timer, energy, origin, chain }` を持つ。
- 入力装置は「セルを活性化する」(`activate { cellId, source }`)を出すだけ。マウスでも MIDI パッドでも同じ経路。
- Space は `point / frame / toPlane / raycastWall / clampInside / toAxis / tangentAt` を実装すれば差し替えられる。
  タイル・生物の経路・クリック判定・カメラはすべてこのインターフェース越しに動く。
- 開発用に `TL.app.advance(秒)` で描画ループと関係なく時間を進められる(自動テスト・検証用)。
