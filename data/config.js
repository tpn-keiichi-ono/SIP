// data/config.js — 既定の入力データと初期パラメータ。
// ブラウザで変更した値は localStorage に保存され、ここに書いた値より優先されます（「初期化」で戻せます）。
window.SIP_CONFIG = {
  title: '森林緩衝帯 消失シミュレーター',
  // 5 枚とも同じ範囲・同じ縮尺（地理院地図のスケールバー「100 m」= 51 px）で切り出されている前提
  scale: { barPx: 51, barMeters: 100 },
  // 共通の水域マスクを作るために使うカラー画像（海が青く写っているもの）と、海岸線から除外する帯の幅
  waterReference: ['3', '4'],
  coastBandM: 27,
  // 観測時期。year は撮影年（推定）。順序はここで決めず、year の昇順に並べ替えて使う。
  // ※ 年は画像の見た目（モノクロ／カラー、色調、解像度）から推定した仮の値。実際の撮影年に修正してください。
  // params.bias: 正で開放地と判定しやすく、負で森林と判定しやすくなる（判定パラメータ参照）
  scenes: [
    { id: '1', file: 'data/images/1.webp', year: 1965, label: '1960年代 モノクロ空中写真', estimated: true, params: {bias: -0.5} },
    { id: '2', file: 'data/images/2.webp', year: 1976, label: '1970年代後半 カラー', estimated: true, params: {} },
    { id: '5', file: 'data/images/5.webp', year: 1985, label: '1980年代 カラー', estimated: true, params: {} },
    { id: '3', file: 'data/images/3.webp', year: 2010, label: '2000年代後半以降', estimated: true, params: {bias: -0.5} },
    { id: '4', file: 'data/images/4.webp', year: 2020, label: '最新写真', estimated: true, params: {bias: 0} },
  ],
  // 教師サンプル（画像座標の円）。shared は全時期に共通、byScene は時期ごとの追加。
  // 森林 forest / 開放地 open / 人工物・裸地 built。画面上でクリックして追加・削除できる。
  samples: {
    shared: {
      forest: [{ x: 650, y: 650, r: 20 }, { x: 850, y: 560, r: 20 }, { x: 1000, y: 650, r: 20 }, { x: 500, y: 700, r: 15 }, { x: 1080, y: 450, r: 15 }, { x: 930, y: 720, r: 15 }],
      open: [{ x: 900, y: 290, r: 8 }, { x: 930, y: 250, r: 6 }, { x: 600, y: 300, r: 8 }, { x: 640, y: 325, r: 6 }, { x: 860, y: 300, r: 6 }],
      built: [],
    },
    byScene: {
      '4': { forest: [{ x: 700, y: 150, r: 18 }, { x: 620, y: 110, r: 14 }, { x: 770, y: 120, r: 12 }, { x: 560, y: 180, r: 10 }, { x: 1000, y: 500, r: 15 }, { x: 1060, y: 330, r: 12 }], built: [{ x: 515, y: 300, r: 4 }, { x: 385, y: 380, r: 5 }] },
      '3': { forest: [{ x: 1000, y: 350, r: 12 }, { x: 1120, y: 300, r: 12 }, { x: 1000, y: 500, r: 15 }, { x: 720, y: 600, r: 15 }, { x: 400, y: 620, r: 15 }, { x: 300, y: 560, r: 12 }, { x: 450, y: 650, r: 15 }, { x: 560, y: 700, r: 12 }, { x: 850, y: 120, r: 15 }, { x: 770, y: 180, r: 10 }, { x: 1120, y: 150, r: 12 }, { x: 1130, y: 400, r: 10 }, { x: 850, y: 470, r: 12 }, { x: 620, y: 480, r: 8 }] },
    },
  },
  display: { opacity: 0.45, showLost: true, showForest: false, showBuilt: false, showWater: false, crossfade: true, fixLatest: false },
  // 緩衝帯 = 陸域の開放地すべて（edgeBandM: 0）、解析範囲 = 画像全体（aoi: []）
  buffer: { edgeBandM: 0, aoi: [] },
  // 消失判定 = 最初の観測面積の 5 %、傾向モデル = 線形（推奨）
  simulation: { model: 'linear', thresholdPct: 5, startId: null, jitterM: 12, protectM: 0, seed: 1, manualRatePct: -2 },
};
