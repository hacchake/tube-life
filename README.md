# Tube of Life

Flower of Life × Escher風テセレーション × Cellular Automaton × 3D Tube × 生命体 の、ブラウザだけで動く実験作品。

巨大なチューブの内壁に、セル・オートマトン(CA)のセルとしてのタイルが敷き詰められている。
タイルに触れると生命が植えられ、色の波が壁を伝わり、タイルから魚が立体化して泳ぎ出す。
魚が別のタイルに着くと、そこが新しい生命の発生源になる。

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
| I | Debug 表示 |

## 第1段階で完成しているもの

1. 3D 円筒チューブ(内側にカメラ、霧で奥が溶ける)
2. 内壁に Flower of Life のタイル(円の中心 = 三角格子点から、花びらと曲線三角形のセルを生成)
3. タイルのクリック(視線と円筒の交点を数式で解き、平面上でセルを引く)
4. クリックしたタイルの発光・浮き上がり・波紋
5. CA の伝播(IDLE → ACTIVATING → BORN → GROWING → MATURE → DECAY → DEAD → 休眠 → IDLE)
6. 魚の立体化(平たい魚がタイル上に現れ → 光り → 浮き → 厚みを持ち → 起き上がる)
7. 魚がチューブ内を泳ぐ(尾を振る)→ 別のタイルで平たくなって溶け込む
8. 着地点から CA が再開し、成熟すると次の魚が生まれる(連鎖。深くなるほど続きにくい)
9. Web Audio の音(Birth / Growth / Mature / Decay / Death、魚の出現・着地)
10. Reset / Random Seed / CA ON/OFF / Grid Type(Flower・Hex)/ Speed / Sound / Camera(Free・Drift)/ 自動で生命 / Debug

## 構成

```
CA Engine            js/ca/engine.js        表示に依存しない状態遷移と伝播
 ↓
Topology             js/topology/topology.js セルの形と neighbor graph(Flower / Hex、register で追加)
 ↓
Species              js/species/species.js   生物の 2D 輪郭・姿勢・変形・動き方・音色(Fish / Bird。Lizard は登録済みで未実装)
 ↓
Animation/Event      js/app.js               CA・生物・音・演出をイベントでつなぐ
 ↓
3D Renderer          js/render/*.js          壁タイル(1メッシュ)・生物(プール)・波紋・ブルーム
 ↓                   js/world/space.js       平面 → 3D の巻き付け(円筒。曲がったチューブ等へ差し替え可能)
Audio System         js/audio/audio.js
 ↓
Input System         js/input/input.js       VirtualPointerInput(マウス)/ MidiPadInput(Launchpad Mini MK3、未検証)
                     js/input/camera.js      カメラ操作
```

- セル: Topology が `{ id, position, kind, shape, neighbors }`、CA が `{ id, state, species, generation, timer, energy, origin, chain }` を持つ。
- 入力装置は「セルを活性化する」(`activate { cellId, source }`)を出すだけ。マウスでも MIDI パッドでも同じ経路。
- 壁のタイルは全セルを 1 つの BufferGeometry にまとめ、状態が変わったセルだけ色と高さを更新する。
- 生物はオブジェクトプール(上限 24)。CA の計算とは独立に毎フレーム動く。

## 第2段階: 鳥

- 鳥は「翼を広げて上から見た形」の輪郭。タイルの上で翼を広げた姿で光り、浮き上がって羽ばたき、らせんを描きながらチューブの奥へ遠く(16〜38)飛ぶ。
- 羽ばたきと滑空を繰り返し、曲がる時は体を傾ける(頂点シェーダーで翼をしならせる)。着地では翼を広げたまま平たくなって壁に溶け込む。
- Species の「Fish ⇄ Bird(交互)」(初期設定)では、魚の着地点の波の中から鳥が生まれ、鳥の着地点からは魚が生まれる。
  次の生物は種そのものではなく、波が 2 リング以上広がった所の成熟したセルから生まれる。
- 音: 鳥は飛び立つ時に羽音とさえずり、着地で二声のさえずり。
- 種ごとの違いは Species の定義(pose = 輪郭の向き / deform = 変形 / motion / speed / range)にまとめてあり、生物の層は共通。

## 次の段階(予定)

トカゲ(壁面を這う)→ Escher風テセレーション(魚・鳥・トカゲの輪郭そのものがタイル)→
変態(Fish → Bird → Lizard のモーフィング)→ 複数生物 → Triangle → より複雑な Flower 構造 → 曲がったチューブ・分岐・トーラス
