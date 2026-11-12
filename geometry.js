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

/** 顔検出枠を、髪・耳・あご周りまで隠せるよう拡張した矩形（画像内にクリップ、整数化）。ナンバープレート枠は周囲を適度に拡張。 */
export function expandFace(f, factor, W, H) {
  if (f.manual) return clipRect(f.x, f.y, f.w, f.h, W, H);
  if (f.kind === 'plate') {
    const mw = 1 + Math.max(0.06, (factor - 1) * 0.25);
    const mh = 1 + Math.max(0.08, (factor - 1) * 0.3);
    const w = f.w * mw, h = f.h * mh;
    const cx = f.x + f.w / 2, cy = f.y + f.h / 2;
    return clipRect(cx - w / 2, cy - h / 2, w, h, W, H);
  }
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
    const minIou = nf.kind === 'plate' ? Math.min(thr, 0.35) : thr;
    let best = null, bi = minIou;
    for (const of of oldFaces) {
      if (nf.kind && of.kind && nf.kind !== of.kind) continue;
      const v = iou(nf, of);
      if (v > bi) { bi = v; best = of; }
    }
    if (best) nf.override = best.override ?? null;
  }
  return newFaces;
}

/** 長辺・総画素数の上限に収まる縮小後サイズ */
export function limitSize(w, h, maxPixels, maxSide) {
  const k = Math.min(1, Math.sqrt(maxPixels / (w * h)), maxSide / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)), scaled: k < 1 };
}

/* ---------- ナンバープレート自動検出（端末内・純粋計算） ---------- */
function downsample2x(data, W, H) {
  const w2 = W >> 1, h2 = H >> 1;
  const out = new Uint8ClampedArray(w2 * h2 * 4);
  for (let y = 0; y < h2; y++) {
    const r0 = (y * 2) * W * 4, r1 = (y * 2 + 1) * W * 4, dstRow = y * w2 * 4;
    for (let x = 0; x < w2; x++) {
      const p00 = r0 + x * 8, p01 = p00 + 4, p10 = r1 + x * 8, p11 = p10 + 4, d = dstRow + x * 4;
      out[d] = (data[p00] + data[p01] + data[p10] + data[p11] + 2) >> 2;
      out[d + 1] = (data[p00 + 1] + data[p01 + 1] + data[p10 + 1] + data[p11 + 1] + 2) >> 2;
      out[d + 2] = (data[p00 + 2] + data[p01 + 2] + data[p10 + 2] + data[p11 + 2] + 2) >> 2;
      out[d + 3] = 255;
    }
  }
  return { data: out, width: w2, height: h2 };
}

function detectPlatesAtScale(data, W, H, minScore = 0.5) {
  if (W < 24 || H < 14) return [];
  const N = W * H, stride = W + 1, N1 = stride * (H + 1);
  const Y = new Uint8Array(N);
  const Gx = new Uint8Array(N);
  const iY = new Float64Array(N1);
  const iY2 = new Float64Array(N1);
  const iGx = new Int32Array(N1);
  const iGy = new Int32Array(N1);
  const iWhite = new Int32Array(N1);
  const iYellow = new Int32Array(N1);
  const iGreen = new Int32Array(N1);
  const iBad = new Int32Array(N1);

  for (let i = 0; i < N; i++) {
    const p = i * 4, r = data[p], g = data[p + 1], b = data[p + 2];
    Y[i] = (77 * r + 150 * g + 29 * b) >> 8;
  }

  for (let y = 0; y < H; y++) {
    let rY = 0, rY2 = 0, rGx = 0, rGy = 0, rW = 0, rYel = 0, rGr = 0, rBad = 0;
    const rowOff = y * W, iRow = (y + 1) * stride, iPrev = y * stride;
    for (let x = 0; x < W; x++) {
      const idx = rowOff + x, p = idx * 4;
      const r = data[p], g = data[p + 1], b = data[p + 2], lum = Y[idx];
      const maxC = r > g ? (r > b ? r : b) : (g > b ? g : b);
      const minC = r < g ? (r < b ? r : b) : (g < b ? g : b);
      const chroma = maxC - minC;
      const isSkin = r >= 105 && g >= 55 && b >= 35 && r > g + 10 && g > b + 8 && (r - b) >= 28 && (r - g) <= 85;
      const isRed = r >= 115 && (r - g) >= 42 && (r - b) >= 42;
      const isBlue = b >= 125 && (b - r) >= 40 && (b - g) >= 20;
      const bad = (isSkin || isRed || isBlue) ? 1 : 0;
      const white = !bad && ((lum >= 122 && chroma <= Math.max(42, lum * 0.26)) || (lum >= 90 && chroma <= 22)) ? 1 : 0;
      const yellow = !bad && (r >= 110 && g >= 85 && (r - b) >= 35 && (g - b) >= 20 && Math.abs(r - g) <= 80) ? 1 : 0;
      const green = !bad && (g >= 30 && g <= 175 && (g - r) >= 8 && (g - b) >= 6 && lum >= 20 && lum <= 155) ? 1 : 0;
      const gx = (x > 0 && x < W - 1) ? Math.abs(Y[idx + 1] - Y[idx - 1]) : 0;
      const gy = (y > 0 && y < H - 1) ? Math.abs(Y[idx + W] - Y[idx - W]) : 0;
      Gx[idx] = gx;
      rY += lum; rY2 += lum * lum; rGx += gx; rGy += gy;
      rW += white; rYel += yellow; rGr += green; rBad += bad;
      const k = iRow + x + 1, kp = iPrev + x + 1;
      iY[k] = iY[kp] + rY;
      iY2[k] = iY2[kp] + rY2;
      iGx[k] = iGx[kp] + rGx;
      iGy[k] = iGy[kp] + rGy;
      iWhite[k] = iWhite[kp] + rW;
      iYellow[k] = iYellow[kp] + rYel;
      iGreen[k] = iGreen[kp] + rGr;
      iBad[k] = iBad[kp] + rBad;
    }
  }

  const boxSum = (arr, x0, y0, x1, y1) =>
    arr[y1 * stride + x1] - arr[y0 * stride + x1] - arr[y1 * stride + x0] + arr[y0 * stride + x0];

  const HEIGHTS = [12, 15, 18, 22, 27, 33, 40, 48];
  const ASPECTS = [1.55, 1.85, 2.05, 2.4, 2.9, 3.5];
  const maxWinH = Math.min(54, Math.floor(H * 0.65));
  const maxWinW = Math.floor(W * 0.78);
  const out = [];

  for (const h of HEIGHTS) {
    if (h > maxWinH) continue;
    const stepY = Math.max(2, Math.round(h * 0.14));
    for (const ar of ASPECTS) {
      const w = Math.round(h * ar);
      if (w < 22 || w > maxWinW) continue;
      const stepX = Math.max(2, Math.round(w * 0.12));
      const padX = Math.max(1, Math.round(w * 0.09));
      const padY0 = Math.max(1, Math.round(h * 0.15));
      const padY1 = Math.max(1, Math.round(h * 0.11));
      const iw = w - padX * 2, ih = h - padY0 - padY1;
      if (iw < 14 || ih < 8) continue;
      const iArea = iw * ih, area = w * h;
      const thirdW = Math.max(3, Math.floor(iw / 3));

      for (let y = 0; y <= H - h; y += stepY) {
        const iy0 = y + padY0, iy1 = y + h - padY1;
        for (let x = 0; x <= W - w; x += stepX) {
          const ix0 = x + padX, ix1 = x + w - padX;
          const gxInner = boxSum(iGx, ix0, iy0, ix1, iy1) / iArea;
          if (gxInner < 14) continue;
          const gyInner = boxSum(iGy, ix0, iy0, ix1, iy1) / iArea;
          if (gxInner < gyInner * 0.65 || gxInner > (gyInner + 5) * 4.2) continue;

          if (boxSum(iBad, x, y, x + w, y + h) / area > 0.22) continue;
          const wRat = boxSum(iWhite, x, y, x + w, y + h) / area;
          const yRat = boxSum(iYellow, x, y, x + w, y + h) / area;
          const gRat = boxSum(iGreen, x, y, x + w, y + h) / area;
          let pType = '';
          let bgRat = 0;
          if (yRat >= 0.28 && yRat <= 0.94 && yRat >= wRat * 0.8) { pType = 'yellow'; bgRat = yRat; }
          else if (gRat >= 0.28 && gRat <= 0.92 && gRat >= wRat * 0.8) { pType = 'green'; bgRat = gRat; }
          else if (wRat >= 0.35 && wRat <= 0.94) { pType = 'white'; bgRat = wRat; }
          if (!pType) continue;

          const sumY = boxSum(iY, ix0, iy0, ix1, iy1);
          const meanY = sumY / iArea;
          const varY = boxSum(iY2, ix0, iy0, ix1, iy1) / iArea - meanY * meanY;
          if (varY < 240) continue;
          const stdY = Math.sqrt(varY);

          // プレートの左・右・上・下の各領域にプレート背景色が存在すること（バンパーの端を跨ぐ半端な枠を除外）
          const iBg = pType === 'yellow' ? iYellow : pType === 'green' ? iGreen : iWhite;
          const qW = Math.max(2, w >> 2), hH = Math.max(2, h >> 1);
          if (boxSum(iBg, x, y, x + qW, y + h) / (qW * h) < 0.32) continue;
          if (boxSum(iBg, x + w - qW, y, x + w, y + h) / (qW * h) < 0.32) continue;
          if (boxSum(iBg, x, y, x + w, y + hH) / (w * hH) < 0.32) continue;
          if (boxSum(iBg, x, y + h - hH, x + w, y + h) / (w * hH) < 0.32) continue;

          // 左・中央・右の3区画すべてに文字の縦エッジが存在し、左右の背景輝度が揃っていること
          const gx1 = boxSum(iGx, ix0, iy0, ix0 + thirdW, iy1) / (thirdW * ih);
          const gx2 = boxSum(iGx, ix0 + thirdW, iy0, ix1 - thirdW, iy1) / (Math.max(1, iw - thirdW * 2) * ih);
          const gx3 = boxSum(iGx, ix1 - thirdW, iy0, ix1, iy1) / (thirdW * ih);
          if (gx1 < 8 || gx3 < 8 || Math.min(gx1, gx3) < Math.max(gx1, gx2, gx3) * 0.22) continue;

          const mx = (ix0 + ix1) >> 1, my = (iy0 + iy1) >> 1;
          const meanYL = boxSum(iY, ix0, iy0, mx, iy1) / ((mx - ix0) * ih);
          const meanYR = boxSum(iY, mx, iy0, ix1, iy1) / ((ix1 - mx) * ih);
          if (Math.abs(meanYL - meanYR) > 40) continue;
          const meanYT = boxSum(iY, ix0, iy0, ix1, my) / (iw * (my - iy0));
          const meanYB = boxSum(iY, ix0, my, ix1, iy1) / (iw * (iy1 - my));
          if (Math.abs(meanYT - meanYB) > 42) continue;

          // 2段プレートの上段だけ・下段だけを誤って切り出さないよう、直下・直上に同色の文字領域が続いていないか確認
          const subH = Math.min(H - (y + h), Math.round(h * 0.75));
          if (subH >= 6) {
            const subArea = w * subH;
            const subBg = boxSum(iBg, x, y + h, x + w, y + h + subH) / subArea;
            const subGx = boxSum(iGx, ix0, y + h, ix1, y + h + subH) / (iw * subH);
            if (subBg >= 0.48 && subGx >= 10) continue;
          }
          const supH = Math.min(y, Math.round(h * 0.65));
          if (supH >= 6) {
            const supArea = w * supH;
            const supBg = boxSum(iBg, x, y - supH, x + w, y) / supArea;
            const supGx = boxSum(iGx, ix0, y - supH, ix1, y) / (iw * supH);
            if (supBg >= 0.48 && supGx >= 10) continue;
          }
          const lx0 = Math.max(0, x - Math.ceil(w * 0.3)), rx1 = Math.min(W, x + w + Math.ceil(w * 0.3));
          const ty0 = Math.max(0, y - Math.ceil(h * 0.45)), by1 = Math.min(H, y + h + Math.ceil(h * 0.45));
          const sArea = (rx1 - lx0) * (by1 - ty0) - area;
          let surroundBoost = 0.5;
          if (sArea > area * 0.3) {
            const gxSur = (boxSum(iGx, lx0, ty0, rx1, by1) - boxSum(iGx, x, y, x + w, y + h)) / sArea;
            const ySur = (boxSum(iY, lx0, ty0, rx1, by1) - boxSum(iY, x, y, x + w, y + h)) / sArea;
            const bgSur = (boxSum(iBg, lx0, ty0, rx1, by1) - boxSum(iBg, x, y, x + w, y + h)) / sArea;
            const gxRatio = gxInner / (gxSur + 4);
            const yDiff = Math.abs(meanY - ySur);
            const bgDiff = bgRat - bgSur;
            if (gxRatio < 1.32 && yDiff < 18 && bgDiff < 0.22) continue;
            surroundBoost = clamp((gxRatio - 1) * 0.25 + yDiff / 120 + Math.max(0, bgDiff) * 0.6, 0, 1);
          }

          // 水平走査線による文字ストローク検証（枠端と接しない内部の文字・数字ストロークの交互反転）
          const darkChars = pType !== 'green';
          const nRows = 7;
          let validLines = 0;
          for (let r = 0; r < nRows; r++) {
            const sy = Math.min(H - 1, Math.floor(y + h * (0.20 + r * 0.105)));
            const rowOff = sy * W;
            const rMean = boxSum(iY, ix0, sy, ix1, sy + 1) / iw;
            const thr = darkChars ? (rMean - Math.max(11, stdY * 0.30)) : (rMean + Math.max(11, stdY * 0.30));
            let inStroke = false, runStart = ix0, runLen = 0, validRuns = 0, trans = 0, tooWide = false;
            let firstX = -1, lastX = -1;
            const maxRun = Math.max(3, Math.ceil(w * 0.24));
            for (let sx = ix0; sx < ix1; sx++) {
              const lum = Y[rowOff + sx];
              const hit = darkChars ? (lum < thr) : (lum > thr);
              if (hit) {
                if (!inStroke) { inStroke = true; runStart = sx; runLen = 1; trans++; }
                else runLen++;
              } else if (inStroke) {
                inStroke = false; trans++;
                if (runStart > ix0) { // 左端に張り付いたバンパー境界は文字として数えない
                  if (runLen > Math.ceil(w * 0.38)) { tooWide = true; break; }
                  if (runLen >= 1 && runLen <= maxRun) {
                    validRuns++;
                    if (firstX < 0) firstX = runStart;
                    lastX = sx;
                  }
                }
                runLen = 0;
              }
            }
            if (!tooWide && validRuns >= 3 && validRuns <= 11 && trans >= 6 && trans <= 26 && (lastX - firstX) >= iw * 0.38) {
              validLines++;
            }
          }
          if (validLines < 2) continue;

          // 垂直方向の反転数チェック（ブラインドやグリルのような細かい横縞・縦縞を除外）
          let vTransSum = 0;
          const vThr = darkChars ? (meanY - Math.max(11, stdY * 0.30)) : (meanY + Math.max(11, stdY * 0.30));
          for (let c = 1; c <= 5; c++) {
            const sx = Math.min(W - 1, Math.floor(ix0 + iw * (c / 6)));
            let prevHit = darkChars ? (Y[iy0 * W + sx] < vThr) : (Y[iy0 * W + sx] > vThr);
            let vt = 0;
            for (let sy = iy0 + 1; sy < iy1; sy++) {
              const hit = darkChars ? (Y[sy * W + sx] < vThr) : (Y[sy * W + sx] > vThr);
              if (hit !== prevHit) { vt++; prevHit = hit; }
            }
            vTransSum += vt;
          }
          const avgVTrans = vTransSum / 5;
          if (avgVTrans < 1.2 || avgVTrans > 12) continue;

          // 1) プレート背景色（白・黄・緑）の境界に合わせて外枠のはみ出しをトリミング
          let px0 = x, px1 = x + w, py0 = y, py1 = y + h;
          while (px0 < mx - 4 && boxSum(iBg, px0, y, px0 + 1, y + h) < h * 0.38) px0++;
          while (px1 > mx + 4 && boxSum(iBg, px1 - 1, y, px1, y + h) < h * 0.38) px1--;
          while (py0 < my - 3 && boxSum(iBg, px0, py0, px1, py0 + 1) < (px1 - px0) * 0.38) py0++;
          while (py1 > my + 3 && boxSum(iBg, px0, py1 - 1, px1, py1) < (px1 - px0) * 0.38) py1--;

          // 2) 白い車体等で背景が続く場合に備え、内部文字エッジの存在範囲＋余白でも上限を抑える
          let cMin = px0, cMax = px1, rMin = py0, rMax = py1;
          const colEdgeThr = Math.max(4, gxInner * 0.14) * (py1 - py0);
          while (cMin < mx - 4 && boxSum(iGx, cMin, py0, cMin + 1, py1) < colEdgeThr) cMin++;
          while (cMax > mx + 4 && boxSum(iGx, cMax - 1, py0, cMax, py1) < colEdgeThr) cMax--;
          const rowEdgeThr = Math.max(4, gxInner * 0.12) * (cMax - cMin);
          while (rMin < my - 3 && boxSum(iGx, cMin, rMin, cMax, rMin + 1) < rowEdgeThr) rMin++;
          while (rMax > my + 3 && boxSum(iGx, cMin, rMax - 1, cMax, rMax) < rowEdgeThr) rMax--;

          const charW = cMax - cMin, charH = rMax - rMin;
          if (charW < w * 0.42 || charH < h * 0.32) continue;
          const rx = Math.max(px0, Math.round(cMin - charW * 0.14));
          const ry = Math.max(py0, Math.round(rMin - charH * 0.22));
          const rx1b = Math.min(px1, Math.round(cMax + charW * 0.14));
          const ry1b = Math.min(py1, Math.round(rMax + charH * 0.22));
          const rw = rx1b - rx, rh = ry1b - ry;
          if (rw < 18 || rh < 10) continue;
          const rAr = rw / rh;
          if (rAr < 1.3 || rAr > 4.2) continue;

          const lineScore = Math.min(1, validLines / 4);
          const arScore = 1 - Math.min(0.35, Math.abs(rAr - 2.0) * 0.18);
          const contrastScore = clamp(stdY / 65, 0.3, 1);
          const fillScore = clamp((rw * rh) / area, 0.5, 1);
          const score = clamp(
            lineScore * 0.34 + clamp(bgRat, 0.3, 0.9) * 0.20 + contrastScore * 0.16 + surroundBoost * 0.14 + arScore * 0.08 + fillScore * 0.08,
            0, 0.99
          );
          if (score >= minScore) out.push({ x: rx, y: ry, w: rw, h: rh, score, kind: 'plate' });
        }
      }
    }
  }
  return mergePlateBoxes(out);
}

/** プレート候補の統合：1行だけの部分枠よりプレート全体を覆う枠を優先して統合する */
function mergePlateBoxes(boxes) {
  const sorted = boxes.slice().sort((a, b) => {
    const ds = (b.score ?? 0) - (a.score ?? 0);
    if (Math.abs(ds) > 0.14) return ds;
    return (b.w * b.h) - (a.w * a.h) || ds;
  });
  const kept = [];
  for (const b of sorted) {
    const idx = kept.findIndex((k) => iou(b, k) > 0.28 || containment(b, k) > 0.55);
    if (idx < 0) kept.push(b);
    else if (b.w * b.h > kept[idx].w * kept[idx].h * 1.25 && (b.score ?? 0) >= (kept[idx].score ?? 0) - 0.14) {
      kept[idx] = { ...b, score: Math.max(b.score ?? 0, kept[idx].score ?? 0) };
    }
  }
  return kept.sort((a, b) => a.y - b.y || a.x - b.x);
}

/**
 * RGBA 画像データ ({ data, width, height }) から車のナンバープレート候補をマルチスケール検出する。
 * 白ナンバー・黄色（軽）・緑（事業用）・海外横長プレートに対応。
 */
export function detectPlates(imgData, { minScore = 0.52, maxScaleLevels = 3 } = {}) {
  if (!imgData || !imgData.data || !(imgData.width > 0) || !(imgData.height > 0)) return [];
  const W = imgData.width | 0, H = imgData.height | 0;
  if (W < 24 || H < 14 || imgData.data.length < W * H * 4) return [];

  const all = [];
  let cur = { data: imgData.data, width: W, height: H };
  let scale = 1;
  for (let lv = 0; lv < maxScaleLevels; lv++) {
    if (cur.width < 32 || cur.height < 18) break;
    const found = detectPlatesAtScale(cur.data, cur.width, cur.height, minScore);
    for (const b of found) {
      all.push({
        x: Math.round(b.x * scale),
        y: Math.round(b.y * scale),
        w: Math.round(b.w * scale),
        h: Math.round(b.h * scale),
        score: b.score,
        kind: 'plate'
      });
    }
    if (Math.min(cur.width, cur.height) < 96) break;
    cur = downsample2x(cur.data, cur.width, cur.height);
    scale *= 2;
  }
  return mergePlateBoxes(all);
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
