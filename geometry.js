// 純粋な幾何・判定ロジック（DOM非依存。Node でテスト可能）

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** 画像 W×H を一辺 T の正方タイルで overlap(0-1) 重ねて覆う配置。T>=長辺なら全体1枚。 */
export function tilePlan(W, H, T, overlap = 0.25) {
  if (T >= Math.max(W, H)) return [{ x: 0, y: 0, w: W, h: H }];
  const tw = Math.min(T, W), th = Math.min(T, H);
  const step = T * (1 - overlap);
  const nx = W <= T ? 1 : Math.ceil((W - tw) / step) + 1;
  const ny = H <= T ? 1 : Math.ceil((H - th) / step) + 1;
  const out = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    out.push({
      x: nx > 1 ? Math.round(i * (W - tw) / (nx - 1)) : 0,
      y: ny > 1 ? Math.round(j * (H - th) / (ny - 1)) : 0,
      w: tw, h: th
    });
  }
  return out;
}

/** 検出枠がタイルの「内側の境界」に接していれば true（顔が途中で切れている可能性）。画像端への接触は除外。 */
export function touchesInnerEdge(b, t, W, H, eps = 2) {
  return (t.x > 0 && b.x - t.x <= eps) ||
         (t.y > 0 && b.y - t.y <= eps) ||
         (t.x + t.w < W && t.x + t.w - (b.x + b.w) <= eps) ||
         (t.y + t.h < H && t.y + t.h - (b.y + b.h) <= eps);
}

export function interArea(a, b) {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return ix * iy;
}
export function iou(a, b) {
  const i = interArea(a, b);
  return i / (a.w * a.h + b.w * b.h - i || 1);
}
/** 小さい方の枠のうち、重なっている割合 */
export function containment(a, b) {
  return interArea(a, b) / (Math.min(a.w * a.h, b.w * b.h) || 1);
}

/** スコア優先の貪欲マージ。同一の顔を複数スケールで検出した重複を1つにする。 */
export function mergeBoxes(boxes, { iouThr = 0.4, containThr = 0.65 } = {}) {
  const sorted = boxes.slice().sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || b.w * b.h - a.w * a.h);
  const kept = [];
  for (const b of sorted) {
    if (!kept.some((k) => iou(b, k) > iouThr || containment(b, k) > containThr)) kept.push(b);
  }
  return kept.sort((a, b) => a.y - b.y || a.x - b.x);
}

/** 顔検出枠を、髪・耳・あご周りまで隠せるよう拡張した矩形（画像内にクリップ、整数化）。 */
export function expandFace(f, factor, W, H) {
  if (f.manual) return clipRect(f.x, f.y, f.w, f.h, W, H);
  const w = f.w * factor, h = f.h * factor * 1.1;
  const cx = f.x + f.w / 2, cy = f.y + f.h / 2 - f.h * 0.08;
  return clipRect(cx - w / 2, cy - h / 2, w, h, W, H);
}
export function clipRect(x, y, w, h, W, H) {
  const x0 = clamp(Math.floor(x), 0, W), y0 = clamp(Math.floor(y), 0, H);
  const x1 = clamp(Math.ceil(x + w), 0, W), y1 = clamp(Math.ceil(y + h), 0, H);
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

/** モザイクの格子数。顔が小さくても最低限は粗くし、極小領域では格子を減らす。 */
export function cellGrid(w, h, cellsAcross) {
  const nx = clamp(Math.min(cellsAcross, Math.floor(w / 3)), 2, 64);
  const ny = clamp(Math.round(nx * h / w), 2, 96);
  return { nx, ny };
}

/** 巻き数法による多角形内外判定（キャンバスの nonzero 塗りと一致） */
export function pointInPolygon(x, y, poly) {
  let wn = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    if (a.y <= y) {
      if (b.y > y && (b.x - a.x) * (y - a.y) - (x - a.x) * (b.y - a.y) > 0) wn++;
    } else if (b.y <= y && (b.x - a.x) * (y - a.y) - (x - a.x) * (b.y - a.y) < 0) wn--;
  }
  return wn !== 0;
}

/** 矩形のうち、いずれかの多角形に含まれる割合（格子サンプリング。0〜1） */
export function coverage(rect, polys, n = 16) {
  if (!polys.length || rect.w <= 0 || rect.h <= 0) return 0;
  let hit = 0;
  for (let j = 0; j < n; j++) {
    const y = rect.y + (j + 0.5) / n * rect.h;
    for (let i = 0; i < n; i++) {
      const x = rect.x + (i + 0.5) / n * rect.w;
      if (polys.some((p) => pointInPolygon(x, y, p))) hit++;
    }
  }
  return hit / (n * n);
}

export const rectPoly = (a, b) => [
  { x: a.x, y: a.y }, { x: b.x, y: a.y }, { x: b.x, y: b.y }, { x: a.x, y: b.y }
];

export function bboxOf(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** 画面座標 ⇄ 画像座標。view = { s, tx, ty } */
export const toImage = (v, px, py) => ({ x: (px - v.tx) / v.s, y: (py - v.ty) / v.s });
export const toScreen = (v, x, y) => ({ x: x * v.s + v.tx, y: y * v.s + v.ty });

export function fitView(W, H, cw, ch, pad = 8) {
  const s = Math.min((cw - pad * 2) / W, (ch - pad * 2) / H);
  return { s, tx: (cw - W * s) / 2, ty: (ch - H * s) / 2 };
}
export function zoomAt(v, factor, cx, cy, minS, maxS) {
  const s = clamp(v.s * factor, minS, maxS), k = s / v.s;
  return { s, tx: cx - (cx - v.tx) * k, ty: cy - (cy - v.ty) * k };
}
/** 画像が画面外へ消えないよう、少なくとも keep px は見える位置に収める */
export function clampView(v, W, H, cw, ch, keep = 64) {
  const iw = W * v.s, ih = H * v.s;
  return {
    s: v.s,
    tx: clamp(v.tx, keep - iw, cw - keep),
    ty: clamp(v.ty, keep - ih, ch - keep)
  };
}

/** 再検出時に、ユーザーが付けた「残す/モザイク」の手動設定を引き継ぐ */
export function carryOverrides(oldFaces, newFaces, thr = 0.5) {
  for (const nf of newFaces) {
    let best = null, bi = thr;
    for (const of of oldFaces) { const v = iou(nf, of); if (v > bi) { bi = v; best = of; } }
    if (best) nf.override = best.override ?? null;
  }
  return newFaces;
}

/** 長辺・総画素数の上限に収まる縮小後サイズ */
export function limitSize(w, h, maxPixels, maxSide) {
  const k = Math.min(1, Math.sqrt(maxPixels / (w * h)), maxSide / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)), scaled: k < 1 };
}

/* ---------- 手動モザイク枠 ---------- */
export const MAX_MANUAL = 300;   // 手動で追加できる枠の上限（暴走・メモリ枯渇の防止）

/** ドラッグした2点（画像座標）→ 画像内に収めた整数矩形。不正値・小さすぎる・写真の外は null */
export function normalizeRect(a, b, W, H, minSize = 8) {
  if (!a || !b || ![a.x, a.y, b.x, b.y, W, H].every(Number.isFinite) || W <= 0 || H <= 0) return null;
  const r = clipRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(a.x - b.x), Math.abs(a.y - b.y), W, H);
  return r.w >= minSize && r.h >= minSize ? r : null;
}

/** 画面座標 p が当たる矩形の添字（重なる場合は面積が小さい方）。小さい枠も最低 minHalf*2 px の当たり判定にする。なければ -1 */
export function hitRect(rects, p, view, minHalf = 22) {
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return -1;
  let best = -1, bestArea = Infinity;
  rects.forEach((r, i) => {
    const cx = (r.x + r.w / 2) * view.s + view.tx, cy = (r.y + r.h / 2) * view.s + view.ty;
    const hw = Math.max(r.w * view.s / 2, minHalf), hh = Math.max(r.h * view.s / 2, minHalf);
    if (Math.abs(p.x - cx) <= hw && Math.abs(p.y - cy) <= hh && r.w * r.h < bestArea) { best = i; bestArea = r.w * r.h; }
  });
  return best;
}
