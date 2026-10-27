import * as G from './geometry.js';
import { sniffImage } from './imageinfo.js';
import { SCRIPT_SRI, verifyAsset, refreshFile, IntegrityError } from './integrity.js';

/* =====================================================================
   写り込み顔モザイク
   - 画像は端末内でのみ処理（外部送信なし。CSP でも通信を遮断）
   - 顔検出: face-api(SSD MobileNet v1) を同梱し、全体＋タイル分割で小さい顔まで検出
   - プレビューと書き出しは同じ「モザイク格子」を描画するため、見たままの結果になる
   - 安全側（fail-closed）の設計: 判定できない顔は「モザイクをかける」側に倒し、
     モザイクを適用できなかった場合は、モザイクなしの画像を書き出さずに中断する
   ===================================================================== */

// 他サイトの iframe 内では起動しない（guard.js が案内を表示する）
let framed = false;
try { framed = window.top !== window.self; } catch { framed = true; }
if (framed) throw new Error('framed');

const $ = (s) => document.querySelector(s);
const APP_VERSION = '1.2.0';                // package.json・sw.js と一致させる（テストで検査）
const MAX_FILE_BYTES = 100 * 1024 * 1024;   // 入力ファイルの上限
const MAX_SOURCE_PIXELS = 120e6;            // デコード前に弾く上限（画像爆弾対策）
const MAX_PIXELS = 16e6;                    // 処理用に縮小する上限（iOS Safari の canvas 上限を下回る）
const MAX_SIDE = 8192;
const MIN_CONF = 0.45;                      // 見逃しを避けるため低め
const KEEP_THRESHOLD = 0.5;                 // 顔枠の50%以上が「残す範囲」に入っていれば残す
const PREVIEW_SIDE = 1600;
const PARAMS = new URLSearchParams(location.search);
const LOCAL = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) || location.protocol === 'file:';
const DEBUG = PARAMS.has('debug') && LOCAL;   // テスト用フックは、手元の環境で ?debug を付けた時だけ

const TOOL_HINTS = {
  rect: '残したい人を四角で囲みます（複数可）。囲んだ外の顔にモザイクがかかります。',
  lasso: '残したい人を指でなぞって囲みます。離すと自動で閉じます（複数可）。',
  manual: '検出されなかった顔を四角で囲むとモザイクを追加（何個でも）。枠をタップで削除。'
};
const HINT_ORIGINAL = '元の画像を表示中です。四角・手描きを押すと編集に戻ります。保存するとモザイクが適用されます。';

const el = {
  app: $('#app'), layout: $('.layout'), clearManual: $('#btn-clear-manual'), oManual: $('#o-manual'), ver: $('#ver'), stage: $('#stage'), cv: $('#cv'), chip: $('#chip'), zoom: $('#zoom'), toast: $('#toast'),
  busy: $('#busy'), busyText: $('#busy-text'), hint: $('#hint'), settings: $('#settings'), boot: $('#boot-error'),
  file: $('#file'), fileZone: $('#file-zone'), undo: $('#undo'), save: $('#save'), reset: $('#btn-reset'), redetect: $('#btn-redetect'),
  original: $('#btn-original'), info: $('#info'), settingsBtn: $('#btn-settings'),
  modal: $('#modal'), mOpen: $('#m-open'), mImg: $('#m-img'), mNote: $('#m-note'), mShare: $('#m-share'), mDownload: $('#m-download'), mClose: $('#m-close')
};
const ctx = el.cv.getContext('2d');

const S = {
  img: null,            // { source, preview, W, H, name, scaled, origW, origH }
  view: { s: 1, tx: 0, ty: 0 }, fitted: true, minS: 0.05, maxS: 16,
  regions: [], faces: [], raw: [], history: [],
  manual: [],           // 手動で追加したモザイク枠 { x, y, w, h, manual:true, auto:'mosaic' }（画像座標・整数）
  exporting: false,
  tool: 'rect', showOriginal: false,
  params: { cells: 7, margin: 1.6, detail: 'standard' },
  detect: { state: 'idle', progress: 0, run: 0 },
  cssW: 0, cssH: 0, dpr: 1, loadSeq: 0,
  pointers: new Map(), gesture: null, drawing: null, spaceDown: false,
  dirty: false, resultUrl: null, resultBlob: null,
  seenZoomTip: false, seenDetailTip: false
};
const scratch = document.createElement('canvas');
const scratchCtx = scratch.getContext('2d', { willReadFrequently: true });

/* ---------- ユーティリティ ---------- */
const tick = () => new Promise((r) => setTimeout(r, 0));
let toastTimer;
function toast(msg, ms = 2800) {
  el.toast.textContent = msg; el.toast.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.toast.hidden = true; }, ms);
}
function setBusy(on, text = '処理中…') {
  el.busy.hidden = !on; el.busyText.textContent = text;
  if ('inert' in el.layout) el.layout.inert = on;   // 処理中は編集操作・設定変更を受け付けない（状態の食い違い防止）
}
const isMosaic = (f) => f.auto === 'mosaic';
const mosaicFaces = () => S.faces.filter(isMosaic);
const mosaicTargets = () => [...mosaicFaces(), ...S.manual];   // 書き出し・プレビューの対象

// 予期しないエラーを黙って握りつぶさず、利用者に知らせる（詳細は画面に出さない）
let lastErrToast = 0;
function reportUnexpected(e) {
  console.error(e);
  if (Date.now() - lastErrToast < 4000) return;
  lastErrToast = Date.now();
  toast('予期しないエラーが発生しました。もう一度お試しください。', 4000);
}
window.addEventListener('error', (e) => reportUnexpected(e.error || e.message));
window.addEventListener('unhandledrejection', (e) => reportUnexpected(e.reason));

// 安全でない接続（http）では、コードの改ざんを防げないため警告する
if (!window.isSecureContext && !LOCAL) {
  el.boot.textContent = '安全でない接続（http）で開かれています。第三者に改ざんされる恐れがあるため、HTTPS のアドレスで利用してください。';
  el.boot.hidden = false;
}

/* ---------- 画像の読み込み（入力は信用せず、中身を検査する） ---------- */
async function decodeImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const im = new Image();
    im.decoding = 'async'; im.src = url;
    await im.decode();
    return im;
  } finally { setTimeout(() => URL.revokeObjectURL(url), 30000); }
}

async function loadFile(file) {
  if (!file) return;
  const seq = ++S.loadSeq;
  if (file.size > MAX_FILE_BYTES) { toast('ファイルが大きすぎます（100MBまで）。', 5000); return; }
  setBusy(true, '写真を読み込み中…');
  try {
    // 拡張子・MIME は偽装できるため、先頭バイトで形式と画素数を確認してからデコードする
    const info = sniffImage(new Uint8Array(await file.slice(0, 1 << 20).arrayBuffer()));
    if (seq !== S.loadSeq) return;
    if (!info) { toast('対応していない形式です。JPEG・PNG・WebP・GIF・BMP の写真を選んでください。', 5000); return; }
    if (info.width * info.height > MAX_SOURCE_PIXELS) {
      toast(`画像が大きすぎます（${info.width}×${info.height}）。1億2千万画素以下の写真を選んでください。`, 6000); return;
    }
    const im = await decodeImage(file);
    if (seq !== S.loadSeq) return;
    const nw = im.naturalWidth, nh = im.naturalHeight;
    if (!nw || !nh || nw * nh > MAX_SOURCE_PIXELS) throw new Error('size');
    const { w, h, scaled } = G.limitSize(nw, nh, MAX_PIXELS, MAX_SIDE);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const cx = c.getContext('2d');
    if (!cx) throw new Error('canvas');
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(im, 0, 0, w, h);
    let source = c;
    try { source = await createImageBitmap(c); c.width = c.height = 0; } catch { /* canvas をそのまま使う */ }
    const k = Math.min(1, PREVIEW_SIDE / Math.max(w, h));
    const preview = document.createElement('canvas');
    preview.width = Math.max(1, Math.round(w * k)); preview.height = Math.max(1, Math.round(h * k));
    const pc = preview.getContext('2d'); pc.imageSmoothingQuality = 'high';
    pc.drawImage(source, 0, 0, preview.width, preview.height);
    if (seq !== S.loadSeq) return;

    cancelDetection();
    if (S.img && S.img.source.close) S.img.source.close();
    const base = (file.name || 'photo').replace(/\.[^.]+$/, '').replace(/[^\w\u3040-\u30ff\u3400-\u9fff-]+/g, '_').replace(/^[._-]+/, '').slice(0, 60) || 'photo';
    S.img = { source, preview, W: w, H: h, name: base, scaled, origW: nw, origH: nh };
    S.regions = []; S.faces = []; S.manual = []; S.raw = []; S.history = []; S.drawing = null; S.gesture = null; S.pointers.clear();
    el.app.classList.add('has-image'); el.stage.classList.add('has-image');
    el.zoom.hidden = false;
    closeResult();
    resizeCanvas(); fitToScreen();
    syncToolbar(false);
    updateUI();
    if (!S.seenZoomTip) { S.seenZoomTip = true; toast('2本指（ホイール）で拡大・移動できます', 3500); }
    el.info.textContent = `${nw}×${nh}px` + (scaled ? ` → ${w}×${h}pxに縮小して処理` : '');
    runDetection();
  } catch (e) {
    console.error(e);
    if (seq === S.loadSeq) toast('この画像は読み込めませんでした。別の写真でお試しください（HEIC は JPEG への変換が必要な場合があります）。', 5000);
  } finally { if (seq === S.loadSeq) setBusy(false); }
}

/* ---------- 顔検出エンジン ---------- */
const engine = { ready: false, loading: null, backend: '' };

function loadScript(src, integrity) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.integrity = integrity;       // 内容が記録値と違えば、ブラウザが実行を拒否する（SRI）
    s.onload = res; s.onerror = () => { s.remove(); rej(new Error('load ' + src)); };
    document.head.appendChild(s);
  });
}
async function ensureEngine() {
  if (engine.ready) return;
  if (!engine.loading) {
    engine.loading = (async () => {
      await verifyAsset('ssd_mobilenetv1_model-weights_manifest.json');
      await verifyAsset('ssd_mobilenetv1_model.bin');
      if (!window.faceapi) {
        try { await loadScript('face-api.js', SCRIPT_SRI['face-api.js']); }
        catch { await refreshFile('face-api.js'); await loadScript('face-api.js', SCRIPT_SRI['face-api.js']); }   // 古いキャッシュなら取り直して再試行
      }
      const tf = window.faceapi.tf;
      const q = PARAMS.get('backend');
      const order = q === 'cpu' ? ['cpu'] : q === 'webgl' ? ['webgl'] : ['webgl', 'cpu'];   // 許可リスト方式
      for (const b of order) {
        try { if (await tf.setBackend(b)) { await tf.ready(); engine.backend = b; break; } } catch { /* 次へ */ }
      }
      if (!engine.backend) throw new Error('no backend');
      await window.faceapi.nets.ssdMobilenetv1.loadFromUri('.');
      engine.ready = true;
    })().catch((e) => { engine.loading = null; throw e; });
  }
  return engine.loading;
}

async function detectCanvas(canvas) {
  const toBoxes = (r) => r.map((d) => ({ x: d.box.x, y: d.box.y, w: d.box.width, h: d.box.height, score: d.score }));
  const opt = new window.faceapi.SsdMobilenetv1Options({ minConfidence: MIN_CONF, maxResults: 100 });
  try {
    return toBoxes(await window.faceapi.detectAllFaces(canvas, opt));
  } catch (e) {
    // GPU が不安定な端末では CPU に切り替えて1回だけ再試行
    if (engine.backend === 'webgl') {
      console.warn('webgl failed, falling back to cpu', e);
      await window.faceapi.tf.setBackend('cpu'); await window.faceapi.tf.ready(); engine.backend = 'cpu';
      return toBoxes(await window.faceapi.detectAllFaces(canvas, opt));
    }
    throw e;
  }
}

function detectionLevels(W, H, detail) {
  const max = Math.max(W, H);
  const levels = [{ kind: 'whole' }];
  for (const T of detail === 'high' ? [1024, 640] : [1024]) {
    if (T <= max * 0.6) levels.push({ kind: 'tiles', T, tiles: G.tilePlan(W, H, T, 0.25) });
  }
  return levels;
}

function cancelDetection() { S.detect.run++; if (S.detect.state === 'running' || S.detect.state === 'loading') S.detect.state = 'idle'; }

async function runDetection() {
  const img = S.img; if (!img) return;
  const run = ++S.detect.run;
  const alive = () => run === S.detect.run && S.img === img;
  S.raw = [];
  S.detect.state = 'loading'; S.detect.progress = 0; updateUI();
  try { await ensureEngine(); }
  catch (e) {
    console.error(e);
    if (!alive()) return;
    S.detect.state = 'error'; updateUI();
    toast(e instanceof IntegrityError
      ? '検出に使うファイルが壊れているか、差し替えられています。ページを再読み込みしてください。直らない場合は配布元をご確認ください。'
      : '顔検出エンジンを読み込めませんでした。通信状況を確認し、「この設定で再検出」をお試しください。', 7000);
    return;
  }
  if (!alive()) return;

  const levels = detectionLevels(img.W, img.H, S.params.detail);
  const total = levels.reduce((a, l) => a + (l.tiles ? l.tiles.length : 1), 0);
  let done = 0;
  S.detect.state = 'running';
  const work = document.createElement('canvas');
  const wctx = work.getContext('2d');

  try {
    for (const lv of levels) {
      const jobs = lv.kind === 'whole'
        ? [{ x: 0, y: 0, w: img.W, h: img.H, k: Math.min(1, 1024 / Math.max(img.W, img.H)) }]
        : lv.tiles.map((t) => ({ ...t, k: 1 }));
      for (const t of jobs) {
        if (!alive()) return;
        work.width = Math.max(1, Math.round(t.w * t.k)); work.height = Math.max(1, Math.round(t.h * t.k));
        wctx.imageSmoothingQuality = 'high';
        wctx.drawImage(img.source, t.x, t.y, t.w, t.h, 0, 0, work.width, work.height);
        const found = await detectCanvas(work);
        if (!alive()) return;
        for (const d of found) {
          const b = { x: t.x + d.x / t.k, y: t.y + d.y / t.k, w: d.w / t.k, h: d.h / t.k, score: d.score };
          if (b.w < 10 || b.h < 10 || b.w / b.h > 2.2 || b.h / b.w > 2.2) continue;
          if (lv.kind === 'tiles' && G.touchesInnerEdge(b, t, img.W, img.H)) continue;
          S.raw.push(b);
        }
        done++;
        S.detect.progress = done / total;
        updateUI();
        await tick();
      }
      applyDetections();
    }
  } catch (e) {
    console.error(e);
    if (!alive()) return;
    S.detect.state = 'error'; updateUI();
    toast('顔の検出中にエラーが発生しました。もう一度「この設定で再検出」をお試しください。', 6000);
    return;
  }
  if (!alive()) return;
  S.detect.state = 'done'; updateUI();
  if (S.params.detail === 'standard' && Math.max(img.W, img.H) >= 2400 && !S.seenDetailTip) {
    S.seenDetailTip = true;
    toast('遠くの小さな顔は「設定」→「高精度」で再検出すると見つかる場合があります。', 6000);
  }
}

function applyDetections() {
  S.faces = G.mergeBoxes(S.raw).map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h, score: b.score, auto: 'mosaic' }));
  reclassify();
}

/* ---------- 「残す／モザイク」の判定（既定は「モザイク」＝安全側） ---------- */
function reclassify() {
  for (const f of S.faces) f.auto = G.coverage(f, S.regions) >= KEEP_THRESHOLD ? 'keep' : 'mosaic';
  updateUI(); requestRender();
}

/* ---------- モザイク格子（プレビューと書き出しで共通） ---------- */
function getCells(f) {
  const { W, H } = S.img;
  const key = `${f.x}|${f.y}|${f.w}|${f.h}|${S.params.margin}|${S.params.cells}`;
  if (f._ck === key) return f._cells;
  const r = G.expandFace(f, S.params.margin, W, H);
  if (r.w < 2 || r.h < 2) { f._ck = key; f._cells = null; return null; }   // 極小の顔のみ「対象なし」として記録
  const { nx, ny } = G.cellGrid(r.w, r.h, S.params.cells);
  scratch.width = r.w; scratch.height = r.h;
  scratchCtx.drawImage(S.img.source, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
  const px = scratchCtx.getImageData(0, 0, r.w, r.h).data;
  const col = new Uint16Array(r.w), row = new Uint16Array(r.h);
  for (let x = 0; x < r.w; x++) col[x] = Math.min(nx - 1, Math.floor(x * nx / r.w));
  for (let y = 0; y < r.h; y++) row[y] = Math.min(ny - 1, Math.floor(y * ny / r.h));
  const sum = new Float64Array(nx * ny * 3), cnt = new Uint32Array(nx * ny);
  for (let y = 0; y < r.h; y++) {
    const rb = row[y] * nx;
    for (let x = 0; x < r.w; x++) {
      const ci = rb + col[x], p = (y * r.w + x) * 4;
      sum[ci * 3] += px[p]; sum[ci * 3 + 1] += px[p + 1]; sum[ci * 3 + 2] += px[p + 2]; cnt[ci]++;
    }
  }
  const colors = new Array(nx * ny);
  for (let i = 0; i < nx * ny; i++) {
    const n = cnt[i] || 1;
    colors[i] = `rgb(${Math.round(sum[i * 3] / n)},${Math.round(sum[i * 3 + 1] / n)},${Math.round(sum[i * 3 + 2] / n)})`;
  }
  scratch.width = scratch.height = 1;
  f._cells = { r, nx, ny, colors };
  f._ck = key;                                   // 成功した時だけキャッシュ（途中で例外が出た結果を「済み」と誤認しない）
  return f._cells;
}
function drawCells(c, cells, s, tx, ty) {
  const { r, nx, ny, colors } = cells;
  for (let j = 0; j < ny; j++) {
    const y0 = Math.floor((r.y + j * r.h / ny) * s + ty), y1 = Math.ceil((r.y + (j + 1) * r.h / ny) * s + ty);
    for (let i = 0; i < nx; i++) {
      const x0 = Math.floor((r.x + i * r.w / nx) * s + tx), x1 = Math.ceil((r.x + (i + 1) * r.w / nx) * s + tx);
      c.fillStyle = colors[j * nx + i];
      c.fillRect(x0, y0, x1 - x0, y1 - y0);
    }
  }
}

/* ---------- 描画 ---------- */
function requestRender() {
  if (S.dirty) return;
  S.dirty = true;
  requestAnimationFrame(() => { S.dirty = false; render(); });
}
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

function render() {
  ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
  ctx.clearRect(0, 0, S.cssW, S.cssH);
  if (!S.img) return;
  const { source, preview, W, H } = S.img;
  const { s, tx, ty } = S.view;
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  const usePreview = W * s * S.dpr <= preview.width * 1.25;
  ctx.drawImage(usePreview ? preview : source, tx, ty, W * s, H * s);
  if (S.showOriginal) return;                 // 「モザイクなし」：元の画像だけを表示

  // モザイクのプレビュー（書き出しと同じ格子）
  for (const f of mosaicTargets()) { const c = getCells(f); if (c) drawCells(ctx, c, s, tx, ty); }

  const keep = cssVar('--keep') || '#1f9d55', mos = cssVar('--mosaic') || '#d6246e';
  ctx.lineJoin = 'round';
  const polys = S.regions.slice();
  const d = S.drawing;
  if (d && d.pts.length > 1 && d.type !== 'manual') polys.push(d.type === 'rect' ? G.rectPoly(d.pts[0], d.pts[d.pts.length - 1]) : d.pts);
  for (const p of polys) {
    ctx.beginPath();
    p.forEach((q, i) => (i ? ctx.lineTo(q.x * s + tx, q.y * s + ty) : ctx.moveTo(q.x * s + tx, q.y * s + ty)));
    ctx.closePath();
    ctx.fillStyle = hexA(keep, 0.16); ctx.fill();
    ctx.lineWidth = 2; ctx.setLineDash([7, 5]); ctx.strokeStyle = keep; ctx.stroke(); ctx.setLineDash([]);
  }
  for (const f of S.faces) {
    const k = f.auto === 'keep';
    ctx.lineWidth = 2; ctx.strokeStyle = k ? keep : mos; ctx.setLineDash(k ? [] : [5, 3]);
    ctx.strokeRect(f.x * s + tx, f.y * s + ty, f.w * s, f.h * s);
    ctx.setLineDash([]);
  }
  // 手動で追加した枠（実線・太め）と、ドラッグ中の枠
  ctx.lineWidth = 3; ctx.strokeStyle = mos;
  for (const m of S.manual) ctx.strokeRect(m.x * s + tx, m.y * s + ty, m.w * s, m.h * s);
  if (d && d.type === 'manual' && d.pts.length > 1) {
    const a = d.pts[0], b = d.pts[d.pts.length - 1];
    const x = Math.min(a.x, b.x) * s + tx, y = Math.min(a.y, b.y) * s + ty, w = Math.abs(a.x - b.x) * s, h = Math.abs(a.y - b.y) * s;
    ctx.fillStyle = hexA(mos, 0.18); ctx.fillRect(x, y, w, h);
    ctx.lineWidth = 2; ctx.setLineDash([6, 4]); ctx.strokeRect(x, y, w, h); ctx.setLineDash([]);
  }
}
function hexA(hex, a) {
  const h = hex.replace('#', ''); const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return `rgba(${parseInt(v.slice(0, 2), 16)},${parseInt(v.slice(2, 4), 16)},${parseInt(v.slice(4, 6), 16)},${a})`;
}

/* ---------- ビュー（拡大・移動） ---------- */
function resizeCanvas() {
  const r = el.stage.getBoundingClientRect();
  S.cssW = Math.max(1, Math.round(r.width)); S.cssH = Math.max(1, Math.round(r.height));
  S.dpr = Math.min(window.devicePixelRatio || 1, 3);
  el.cv.width = Math.round(S.cssW * S.dpr); el.cv.height = Math.round(S.cssH * S.dpr);
  if (S.img) {
    updateZoomLimits();
    if (S.fitted) S.view = G.fitView(S.img.W, S.img.H, S.cssW, S.cssH, 8);
    else S.view = G.clampView(S.view, S.img.W, S.img.H, S.cssW, S.cssH);
  }
  requestRender();
}
function updateZoomLimits() {
  const f = G.fitView(S.img.W, S.img.H, S.cssW, S.cssH, 8).s;
  S.minS = f * 0.5;
  S.maxS = Math.max(8 / S.dpr, f * 4);
}
function fitToScreen() { S.fitted = true; if (S.img) { updateZoomLimits(); S.view = G.fitView(S.img.W, S.img.H, S.cssW, S.cssH, 8); } requestRender(); }
function zoomBy(factor, cx = S.cssW / 2, cy = S.cssH / 2) {
  if (!S.img) return;
  S.fitted = false;
  S.view = G.clampView(G.zoomAt(S.view, factor, cx, cy, S.minS, S.maxS), S.img.W, S.img.H, S.cssW, S.cssH);
  requestRender();
}

/* ---------- 入力（マウス・タッチ・ペン共通） ---------- */
const local = (e) => { const r = el.cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
const imgPt = (p) => G.toImage(S.view, p.x, p.y);
const panMode = () => S.showOriginal || S.spaceDown;   // 元画像表示中は、1本指/ドラッグで移動

function updateCursor() {
  el.cv.style.cursor = panMode() ? (S.gesture && S.gesture.type === 'pan' ? 'grabbing' : 'grab') : 'crosshair';
}

el.cv.addEventListener('pointerdown', (e) => {
  if (!S.img) return;
  if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1) return;
  e.preventDefault();
  el.cv.setPointerCapture(e.pointerId);
  const p = local(e);
  S.pointers.set(e.pointerId, p);
  if (S.pointers.size >= 2) { startPinch(); return; }
  if (e.button === 1 || panMode()) { S.gesture = { type: 'pan', last: p }; updateCursor(); return; }
  S.drawing = { type: S.tool, pts: [imgPt(p)], start: p };
  S.gesture = { type: 'draw' };
});

el.cv.addEventListener('pointermove', (e) => {
  if (!S.pointers.has(e.pointerId)) return;
  e.preventDefault();
  const p = local(e);
  S.pointers.set(e.pointerId, p);
  const g = S.gesture; if (!g) return;
  if (g.type === 'pinch') { updatePinch(); return; }
  if (g.type === 'pan') {
    S.fitted = false;
    S.view = G.clampView({ ...S.view, tx: S.view.tx + p.x - g.last.x, ty: S.view.ty + p.y - g.last.y }, S.img.W, S.img.H, S.cssW, S.cssH);
    g.last = p; requestRender(); return;
  }
  if (g.type === 'draw' && S.drawing) {
    const d = S.drawing, q = imgPt(p);
    if (d.type === 'lasso') {
      const last = d.pts[d.pts.length - 1];
      if (Math.hypot((q.x - last.x) * S.view.s, (q.y - last.y) * S.view.s) >= 3) d.pts.push(q);
    } else d.pts[1] = q;
    requestRender();
  }
});

function endPointer(e, cancelled) {
  if (!S.pointers.has(e.pointerId)) return;
  const p = local(e);
  S.pointers.delete(e.pointerId);
  const g = S.gesture;
  if (g && g.type === 'pinch') {
    if (S.pointers.size < 2) {
      S.gesture = null;
      if (S.pointers.size === 1) { const [only] = S.pointers.values(); S.gesture = { type: 'pan', last: only }; }
    }
    return;
  }
  if (!g) return;
  S.gesture = null;
  if (g.type === 'pan') { updateCursor(); return; }
  if (cancelled) { S.drawing = null; requestRender(); return; }
  if (g.type === 'draw') finishDrawing(p);
}
el.cv.addEventListener('pointerup', (e) => endPointer(e, false));
el.cv.addEventListener('pointercancel', (e) => endPointer(e, true));
el.cv.addEventListener('lostpointercapture', (e) => { if (S.pointers.has(e.pointerId)) endPointer(e, true); });
el.cv.addEventListener('contextmenu', (e) => e.preventDefault());

function startPinch() {
  S.drawing = null;                                  // 描きかけは破棄（2本指は拡大・移動に専念）
  const [a, b] = [...S.pointers.values()];
  S.gesture = {
    type: 'pinch', d0: Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)),
    c0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, v0: { ...S.view }
  };
  requestRender();
}
function updatePinch() {
  const [a, b] = [...S.pointers.values()]; if (!a || !b) return;
  const g = S.gesture;
  const d = Math.max(10, Math.hypot(a.x - b.x, a.y - b.y));
  const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const s = G.clamp(g.v0.s * d / g.d0, S.minS, S.maxS), k = s / g.v0.s;
  S.fitted = false;
  S.view = G.clampView({ s, tx: c.x - (g.c0.x - g.v0.tx) * k, ty: c.y - (g.c0.y - g.v0.ty) * k }, S.img.W, S.img.H, S.cssW, S.cssH);
  requestRender();
}

el.cv.addEventListener('wheel', (e) => {
  if (!S.img) return;
  e.preventDefault();
  const p = local(e);
  const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
  zoomBy(Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015)), p.x, p.y);
}, { passive: false });

function finishDrawing(endP) {
  const d = S.drawing; S.drawing = null;
  if (!d) { requestRender(); return; }
  const minPx = 14;
  if (d.type === 'manual') { finishManual(d, endP); return; }
  const pts = d.type === 'rect' ? [d.pts[0], d.pts[1] || imgPt(endP)] : d.pts;
  const bb = G.bboxOf(pts);
  const tooSmall = !Number.isFinite(bb.w + bb.h) || bb.w * S.view.s < minPx || bb.h * S.view.s < minPx || (d.type === 'lasso' && pts.length < 3);
  if (tooSmall) { toast(d.type === 'rect' ? 'ドラッグして範囲を囲んでください。' : '囲みが小さすぎます。もう少し大きくなぞってください。'); requestRender(); return; }
  const poly = d.type === 'rect' ? G.rectPoly(pts[0], pts[1]) : pts;
  S.regions.push(poly);
  pushHistory(() => { S.regions = S.regions.filter((r) => r !== poly); reclassify(); });
  reclassify();
}

/* ---------- 手動モザイク（検出漏れの顔を、任意の数だけ追加） ---------- */
function finishManual(d, endP) {
  const a = d.pts[0], b = d.pts[1] || imgPt(endP);
  const bb = G.bboxOf([a, b]);
  const tap = !Number.isFinite(bb.w + bb.h) || bb.w * S.view.s < 14 || bb.h * S.view.s < 14;
  if (tap) {                                         // ほぼ動かさずに離した＝タップ：既存の枠を削除
    const i = G.hitRect(S.manual, d.start || endP, S.view);
    if (i < 0) { toast('ドラッグで、モザイクをかけたい顔を囲んでください。'); requestRender(); return; }
    const [box] = S.manual.splice(i, 1);
    pushHistory(() => { S.manual.splice(Math.min(i, S.manual.length), 0, box); refresh(); });
    toast('手動の枠を削除しました（「戻す」で復元できます）。');
    refresh(); return;
  }
  if (S.manual.length >= G.MAX_MANUAL) { toast(`手動で追加できるのは${G.MAX_MANUAL}件までです。`); requestRender(); return; }
  const r = G.normalizeRect(a, b, S.img.W, S.img.H, 8);   // 写真内に収め、整数化。不正値・極小・写真の外は却下
  if (!r) { toast('範囲が小さすぎるか、写真の外です。写真の上で囲んでください。'); requestRender(); return; }
  const box = { x: r.x, y: r.y, w: r.w, h: r.h, score: 1, manual: true, auto: 'mosaic' };
  S.manual.push(box);
  pushHistory(() => { S.manual = S.manual.filter((m) => m !== box); refresh(); });
  refresh();
}
function clearManual() {
  if (!S.manual.length) return;
  if (!confirm(`手動で追加したモザイク ${S.manual.length} 件を全て消します。よろしいですか？（「戻す」で復元できます）`)) return;
  const saved = S.manual;
  S.manual = [];
  pushHistory(() => { S.manual = saved; refresh(); });
  refresh();
}
const refresh = () => { updateUI(); requestRender(); };

/* ---------- 履歴 ---------- */
function pushHistory(undoFn) { S.history.push(undoFn); if (S.history.length > 200) S.history.shift(); }
function undo() { const u = S.history.pop(); if (u) u(); updateUI(); }
function resetAll() {
  if (!S.regions.length) return;
  if (!confirm('指定した「残す範囲」を全て消します。よろしいですか？')) return;
  S.regions = []; S.history = []; reclassify();
}

/* ---------- ツールバー・状態表示 ---------- */
function syncToolbar(original) {
  S.showOriginal = original; S.drawing = null;
  document.querySelectorAll('[data-tool]').forEach((x) => x.setAttribute('aria-pressed', String(!original && x.dataset.tool === S.tool)));
  el.original.setAttribute('aria-pressed', String(original));
  el.hint.textContent = original ? HINT_ORIGINAL : TOOL_HINTS[S.tool];
  updateCursor(); updateUI(); requestRender();
}
const setTool = (t) => { S.tool = t; syncToolbar(false); };
const toggleOriginal = () => { if (S.img) syncToolbar(!S.showOriginal); };

function setChip(text, warn = false) { el.chip.textContent = text; el.chip.hidden = !text; el.chip.classList.toggle('warn', warn); }
function updateUI() {
  const has = !!S.img;
  const n = S.faces.length, m = mosaicFaces().length;
  const st = S.detect.state;
  el.undo.disabled = !S.history.length;
  el.save.disabled = !has || st === 'loading';
  el.original.disabled = !has;
  el.redetect.disabled = !has || st === 'loading' || st === 'running';
  el.reset.disabled = !has || !S.regions.length;
  el.clearManual.disabled = !has || !S.manual.length;
  el.oManual.textContent = `${S.manual.length}件`;
  if (!has) { setChip(''); return; }
  if (S.showOriginal) { setChip('元の画像を表示中（保存するとモザイクが適用されます）', true); return; }
  if (st === 'running') setChip(`顔を検出中… ${Math.round(S.detect.progress * 100)}%｜現在 ${n}件（モザイク ${m}）`);
  else if (st === 'loading') setChip('顔検出エンジンを準備中…（初回のみ数秒）');
  else if (st === 'error') setChip('顔の検出に失敗しました（設定から再検出できます）', true);
  else if (n || S.manual.length) setChip(`顔 ${n}件｜モザイク ${m}｜残す ${n - m}` + (S.manual.length ? `｜手動 ${S.manual.length}` : ''));
  else setChip('顔は検出されませんでした（見落としがないか確認し、「手動追加」で補えます）');
}

/* ---------- 書き出し・共有（安全側：モザイクを適用できなければ書き出さない） ---------- */
async function exportBlob() {
  const { W, H, source } = S.img;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d');
  if (!x) throw new Error('canvas');
  x.fillStyle = '#fff'; x.fillRect(0, 0, W, H);
  x.drawImage(source, 0, 0);
  let applied = 0;
  for (const f of mosaicTargets()) {
    const cells = getCells(f);                     // 例外はそのまま上へ（書き出しを中断）
    if (cells) { drawCells(x, cells, 1, 0, 0); applied++; continue; }
    const r = G.expandFace(f, S.params.margin, W, H);
    if (r.w >= 2 && r.h >= 2) throw new Error('mosaic not applied');   // 適用できるはずの顔に適用できなかった
  }
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.93));
  c.width = c.height = 0;
  if (!blob) throw new Error('toBlob');
  return { blob, applied };
}

async function onSave() {
  if (!S.img || S.exporting) return;
  const st = S.detect.state;
  if (st !== 'done' &&
      !confirm(st === 'running'
        ? '顔の検出がまだ途中です。このまま保存すると、まだ見つかっていない顔にモザイクがかかりません。続けますか？'
        : '顔の検出が完了していません。このまま保存すると、検出されていない顔にモザイクがかかりません。続けますか？')) return;
  if (S.showOriginal) syncToolbar(false);          // 保存は常にモザイク適用後
  S.exporting = true;
  setBusy(true, '画像を書き出し中…');
  await tick();
  try {
    const { blob, applied } = await exportBlob();
    showResult(blob, applied);
  } catch (e) {
    console.error(e);
    toast('書き出しに失敗しました（モザイクを適用できなかった場合は、安全のため保存しません）。他のアプリを閉じて再試行してください。', 7000);
  } finally { S.exporting = false; setBusy(false); }
}

function resultFile() { return new File([S.resultBlob], `${S.img.name}_mosaic.jpg`, { type: 'image/jpeg' }); }
function showResult(blob, applied) {
  closeResult();
  S.resultBlob = blob; S.resultUrl = URL.createObjectURL(blob);
  el.mImg.src = S.resultUrl; el.mOpen.href = S.resultUrl;
  const total = S.faces.length + S.manual.length;
  const incomplete = S.detect.state !== 'done';
  let note = `モザイクを ${applied} 件に適用しました（自動検出 ${mosaicFaces().length} 件＋手動 ${S.manual.length} 件）。`;
  let warn = false;
  if (incomplete) { note = `顔の検出が完了していません。${note}`; warn = true; }
  else if (total === 0) { note = '顔が検出されなかったため、モザイクは適用されていません。写真をよく確認してください。'; warn = true; }
  el.mNote.textContent = note; el.mNote.classList.toggle('warn', warn);
  const canShare = !!(navigator.canShare && navigator.canShare({ files: [resultFile()] }));
  el.mShare.hidden = !canShare;
  el.mDownload.classList.toggle('primary', !canShare);
  el.modal.hidden = false;
  (canShare ? el.mShare : el.mDownload).focus();
}
function closeResult() {
  el.modal.hidden = true;
  if (S.resultUrl) URL.revokeObjectURL(S.resultUrl);
  S.resultUrl = null; S.resultBlob = null; el.mImg.removeAttribute('src'); el.mOpen.removeAttribute('href');
}
el.mDownload.addEventListener('click', () => {
  if (!S.resultBlob) return;
  const a = document.createElement('a');
  a.href = S.resultUrl; a.download = `${S.img.name}_mosaic.jpg`;
  document.body.appendChild(a); a.click(); a.remove();
});
el.mShare.addEventListener('click', async () => {
  if (!S.resultBlob) return;
  try { await navigator.share({ files: [resultFile()] }); } catch (e) { if (e && e.name !== 'AbortError') toast('共有できませんでした。ダウンロードをお試しください。'); }
});
el.mClose.addEventListener('click', closeResult);
el.modal.addEventListener('click', (e) => { if (e.target === el.modal) closeResult(); });
window.addEventListener('pagehide', closeResult);

/* ---------- 画面部品のイベント ---------- */
document.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
el.original.addEventListener('click', toggleOriginal);
document.querySelectorAll('[data-detail]').forEach((b) => b.addEventListener('click', () => {
  S.params.detail = b.dataset.detail;
  document.querySelectorAll('[data-detail]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  if (S.img) toast('「この設定で再検出」を押すと反映されます。');
}));
$('#r-cells').addEventListener('input', (e) => { S.params.cells = +e.target.value; $('#o-cells').textContent = `${S.params.cells}分割`; requestRender(); });
$('#r-margin').addEventListener('input', (e) => { S.params.margin = +e.target.value; $('#o-margin').textContent = `×${S.params.margin.toFixed(1)}`; requestRender(); });
$('#o-cells').textContent = `${S.params.cells}分割`; $('#o-margin').textContent = `×${S.params.margin.toFixed(1)}`;

el.settingsBtn.addEventListener('click', () => {
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  el.settings.scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: 'start' });
});
el.redetect.addEventListener('click', () => { if (S.img) runDetection(); });
el.reset.addEventListener('click', resetAll);
el.clearManual.addEventListener('click', clearManual);
el.undo.addEventListener('click', undo);
el.save.addEventListener('click', onSave);
$('#z-in').addEventListener('click', () => zoomBy(1.5));
$('#z-out').addEventListener('click', () => zoomBy(1 / 1.5));
$('#z-fit').addEventListener('click', fitToScreen);

$('#btn-open').addEventListener('click', () => el.file.click());
el.file.addEventListener('change', () => { const f = el.file.files[0]; el.file.value = ''; if (f) loadFile(f); });
for (const zone of [el.stage, el.fileZone]) {
  ['dragenter', 'dragover'].forEach((t) => zone.addEventListener(t, (e) => { e.preventDefault(); zone.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach((t) => zone.addEventListener(t, (e) => { e.preventDefault(); zone.classList.remove('dragover'); }));
  zone.addEventListener('drop', (e) => { const f = e.dataTransfer && e.dataTransfer.files[0]; if (f) loadFile(f); });
}
// 画面の外にドロップしたとき、ブラウザがファイルを開いて編集内容を失うのを防ぐ
['dragover', 'drop'].forEach((t) => window.addEventListener(t, (e) => e.preventDefault()));
document.addEventListener('paste', (e) => {
  const f = [...(e.clipboardData ? e.clipboardData.files : [])].find((x) => x.type.startsWith('image/'));
  if (f) loadFile(f);
});

document.addEventListener('keydown', (e) => {
  if (!el.modal.hidden) { if (e.key === 'Escape') closeResult(); return; }
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
  else if (e.key === ' ' && !S.spaceDown && e.target === document.body) { S.spaceDown = true; updateCursor(); e.preventDefault(); }
  else if (!mod && (e.key === '+' || e.key === '=')) zoomBy(1.4);
  else if (!mod && (e.key === '-' || e.key === '_')) zoomBy(1 / 1.4);
  else if (!mod && e.key === '0') fitToScreen();
  else if (!mod && e.key === '1') setTool('rect');
  else if (!mod && e.key === '2') setTool('lasso');
  else if (!mod && e.key === '3') toggleOriginal();
  else if (!mod && e.key === '4') setTool('manual');
});
document.addEventListener('keyup', (e) => { if (e.key === ' ') { S.spaceDown = false; updateCursor(); } });
window.addEventListener('blur', () => { S.spaceDown = false; updateCursor(); });
document.addEventListener('gesturestart', (e) => e.preventDefault());   // iOS: ページ全体のピンチ拡大を防ぐ

new ResizeObserver(() => resizeCanvas()).observe(el.stage);
window.addEventListener('orientationchange', () => setTimeout(resizeCanvas, 250));

el.ver.textContent = `v${APP_VERSION}`;
syncToolbar(false);

/* ---------- オフライン対応（PWA） ---------- */
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('sw', e));
}

// テスト用フック（手元の環境で ?debug を付けた時だけ公開。公開サイトでは無効）
if (DEBUG) window.__fm = { S, loadFile, runDetection, isMosaic, getCells, APP_VERSION };

document.documentElement.setAttribute('data-ready', '1');   // guard.js への「起動できた」合図
