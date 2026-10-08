// 配色テーマ(見た目の世界観)。タイル・輪郭線・霧・ブルーム・画面の色調・粒子をまとめて切り替える。
//   tones: タイルの塗り分け(Escher の 2〜3 色、Flower の花びら / 曲線三角形)
//   ink  : true なら明るい紙に黒いインク(輪郭線・粒子は加算ではなく普通に重ねる)
(function (TL) {
  'use strict';

  const THEMES = {
    indigo: {
      name: 'インディゴ(夜の生命)',
      colors: { idle: '#1d2a66', activating: '#cfe6ff', born: '#1f4fff', growing: '#22e07a', mature: '#ffd23a', decay: '#ff3b2f', dead: '#000000' },
      tones: null, line: '#6f8cff', lineOpacity: 0.32, bg: '#020309', fog: 0.026,
      bloom: [0.6, 0.45, 0.32], tint: '#ffffff', shadow: '#000004', motes: '#8fb4ff', grain: 0.045, vignette: 1.1,
    },
    abyss: {
      name: '深海(生物発光)',
      colors: { idle: '#05303c', activating: '#e6fffb', born: '#00a8ff', growing: '#00ffb2', mature: '#d8ff4f', decay: '#ff4f8a', dead: '#000000' },
      tones: null, line: '#26d9c8', lineOpacity: 0.28, bg: '#00070a', fog: 0.032,
      bloom: [0.85, 0.6, 0.28], tint: '#d8fff8', shadow: '#000a10', motes: '#5fffe0', grain: 0.05, vignette: 1.25,
    },
    ember: {
      name: '残り火(溶けた金)',
      colors: { idle: '#2a0c07', activating: '#fff4d0', born: '#ff8a1f', growing: '#ffd23a', mature: '#fff3b0', decay: '#ff2a00', dead: '#000000' },
      tones: null, line: '#ff7a3d', lineOpacity: 0.3, bg: '#050100', fog: 0.03,
      bloom: [0.75, 0.5, 0.3], tint: '#fff0dc', shadow: '#0a0200', motes: '#ffb070', grain: 0.055, vignette: 1.2,
    },
    aurora: {
      name: 'オーロラ',
      colors: { idle: '#160830', activating: '#f2e8ff', born: '#2affc6', growing: '#7dff4d', mature: '#ff6cf0', decay: '#ff3b6b', dead: '#000000' },
      tones: null, line: '#b06cff', lineOpacity: 0.32, bg: '#03010a', fog: 0.024,
      bloom: [0.7, 0.55, 0.3], tint: '#f4ecff', shadow: '#05000c', motes: '#c2a6ff', grain: 0.045, vignette: 1.1,
    },
    escher: {
      name: '版画(紙とインク)',
      colors: { idle: '#e6dfcc', activating: '#ffffff', born: '#5b84b8', growing: '#6c9a68', mature: '#d8ad3f', decay: '#a43f2b', dead: '#0d0b09' },
      tones: ['#ebe4d2', '#24201b', '#8a8172'], line: '#14110d', lineOpacity: 0.85, bg: '#cdc5b1', fog: 0.022,
      bloom: [0.18, 0.3, 0.9], tint: '#fff6e2', shadow: '#2a241c', motes: '#2c2620', grain: 0.08, vignette: 1.35, ink: true,
    },
  };

  TL.VISUAL_THEMES = THEMES;
})(window.TL = window.TL || {});
