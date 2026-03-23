(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.PeakFitCore = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const SQRT_2PI = Math.sqrt(2 * Math.PI);
  const SQRT_PI = Math.sqrt(Math.PI);
  const LN2 = Math.log(2);
  const SQRT_LN2 = Math.sqrt(LN2);
  const SQRT_4LN2 = Math.sqrt(4 * LN2);
  const GAUSS_FWHM = 2.354820045;

  function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
  }

  function mean(arr) {
    if (!arr.length) return 0;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  }

  function trapz(x, y) {
    let area = 0;
    for (let i = 1; i < x.length; i++) {
      area += 0.5 * (y[i] + y[i - 1]) * (x[i] - x[i - 1]);
    }
    return area;
  }

  function parseXYText(text) {
    const rows = [];
    const lines = text.split(/\r?\n/);
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      const parts = line.split(/[\s,;]+/).filter(Boolean);
      if (parts.length < 2) continue;
      const x = Number(parts[0]);
      const y = Number(parts[1]);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        rows.push({ x, y });
      }
    }
    rows.sort((a, b) => a.x - b.x);
    return rows;
  }

  function selectRange(data, xMin, xMax) {
    const lo = Math.min(xMin, xMax);
    const hi = Math.max(xMin, xMax);
    return data.filter((p) => p.x >= lo && p.x <= hi);
  }

  function linearRegression(xs, ys) {
    const n = xs.length;
    if (n < 2) {
      return { slope: 0, intercept: ys[0] ?? 0 };
    }
    const xBar = mean(xs);
    const yBar = mean(ys);
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i++) {
      const dx = xs[i] - xBar;
      num += dx * (ys[i] - yBar);
      den += dx * dx;
    }
    const slope = den === 0 ? 0 : num / den;
    const intercept = yBar - slope * xBar;
    return { slope, intercept };
  }

  function estimateLinearBackground(points, edgeFraction) {
    const n = points.length;
    if (!n) {
      return { slope: 0, intercept: 0, bgY: [], correctedY: [] };
    }
    const edgeN = clamp(Math.floor(n * edgeFraction), 2, Math.max(2, Math.floor(n / 2)));
    const bgPts = points.slice(0, edgeN).concat(points.slice(Math.max(0, n - edgeN)));
    const xs = bgPts.map((p) => p.x);
    const ys = bgPts.map((p) => p.y);
    const { slope, intercept } = linearRegression(xs, ys);
    const bgY = points.map((p) => slope * p.x + intercept);
    const correctedY = points.map((p, i) => p.y - bgY[i]);
    return { slope, intercept, bgY, correctedY };
  }

  function gaussian(x, p) {
    const { amplitude, center, sigma } = p;
    return amplitude * Math.exp(-((x - center) ** 2) / (2 * sigma * sigma));
  }

  function lorentzian(x, p) {
    const { amplitude, center, gamma } = p;
    return amplitude * (gamma * gamma) / (((x - center) ** 2) + (gamma * gamma));
  }

  function integrateSimpson(fn, min, max, steps = 80) {
    const n = Math.max(2, steps + (steps % 2));
    const h = (max - min) / n;
    let sum = fn(min) + fn(max);
    for (let i = 1; i < n; i++) {
      const x = min + h * i;
      sum += fn(x) * (i % 2 === 0 ? 2 : 4);
    }
    return (sum * h) / 3;
  }

  function voigt(x, p) {
    const { amplitude, center, sigma, gamma } = p;
    const wG = Math.max(sigma, 1e-9);
    const wL = Math.max(gamma, 1e-9);
    const a = SQRT_LN2 * wL / wG;
    const b = SQRT_4LN2 * (x - center) / wG;
    const integral = integrateSimpson((t) => Math.exp(-(t * t)) / (a * a + (b - t) * (b - t)), -8, 8);
    return (amplitude * 2 * LN2 * wL * integral) / (Math.PI * SQRT_PI * wG * wG);
  }

  function bwf(x, p) {
    const { amplitude, center, gamma, q } = p;
    const width = Math.max(Math.abs(gamma), 1e-9);
    const qq = Math.abs(q) < 1e-6 ? (q < 0 ? -1e-6 : 1e-6) : q;
    const eps = (x - center) / width;
    return amplitude * ((1 + eps / qq) ** 2) / (1 + eps * eps);
  }

  function interpolateY(xs, ys, x) {
    if (!xs.length) return NaN;
    if (x <= xs[0]) return ys[0];
    if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
    for (let i = 1; i < xs.length; i++) {
      if (x <= xs[i]) {
        const dx = xs[i] - xs[i - 1];
        if (Math.abs(dx) < 1e-12) return ys[i];
        const t = (x - xs[i - 1]) / dx;
        return ys[i - 1] + t * (ys[i] - ys[i - 1]);
      }
    }
    return ys[ys.length - 1];
  }

  function estimateBwfQ(xs, ys, center, width, baseline) {
    const safeWidth = Math.max(Math.abs(width), 1e-9);
    const xlr = [center - safeWidth, center + safeWidth];
    const ylr = xlr.map((x) => interpolateY(xs, ys, x));
    const xlrh = [center - safeWidth / 2, center + safeWidth / 2];
    const ylrh = xlrh.map((x) => interpolateY(xs, ys, x));
    const denom = ylr[0] - baseline;
    let k = Math.abs(denom) < 1e-12 ? NaN : (ylr[1] - baseline) / denom;
    if (!Number.isFinite(k) || Math.abs(k - 1) < 1e-12) k = 10;
    const sqrtK = Math.sqrt(Math.max(k, 0));
    let q0 = (sqrtK + 1) / (sqrtK - 1);
    if (!Number.isFinite(q0) || Math.abs(q0) < 1e-6) q0 = -2;
    let q1 = 1 / q0;
    if (!Number.isFinite(q1) || Math.abs(q1) < 1e-6) q1 = -2;
    const k2Denom = ylrh[0] - baseline;
    const k2 = Math.abs(k2Denom) < 1e-12 ? NaN : (ylrh[1] - baseline) / k2Denom;
    const score = (candidate) => {
      if (!Number.isFinite(candidate) || Math.abs(candidate) < 1e-6) return Number.POSITIVE_INFINITY;
      const term = 1 / (2 * candidate);
      const expected = ((1 + term) / (1 - term)) ** 2;
      return Math.abs(k2 - expected);
    };
    const q = score(q0) <= score(q1) ? q0 : q1;
    return Number.isFinite(q) && Math.abs(q) >= 1e-6 ? q : -2;
  }

  function modelY(model, x, params) {
    switch (model) {
      case 'gaussian': return gaussian(x, params);
      case 'lorentzian': return lorentzian(x, params);
      case 'voigt': return voigt(x, params);
      case 'bwf': return bwf(x, params);
      default: throw new Error(`Unknown model: ${model}`);
    }
  }

  function modelKeys(model) {
    switch (model) {
      case 'gaussian': return ['amplitude', 'center', 'sigma'];
      case 'lorentzian': return ['amplitude', 'center', 'gamma'];
      case 'voigt': return ['amplitude', 'center', 'sigma', 'gamma'];
      case 'bwf': return ['amplitude', 'center', 'gamma', 'q'];
      default: throw new Error(`Unknown model: ${model}`);
    }
  }

  function normalizePeakCount(peakCount) {
    return clamp(Math.round(Number(peakCount) || 1), 1, 6);
  }

  function paramsToVector(model, peaks) {
    const keys = modelKeys(model);
    return peaks.flatMap((peak) => keys.map((k) => Number(peak[k])));
  }

  function vectorToPeakParams(model, vec, peakCount) {
    const keys = modelKeys(model);
    const normalizedCount = normalizePeakCount(peakCount);
    const peaks = [];
    for (let i = 0; i < normalizedCount; i++) {
      const peak = {};
      keys.forEach((key, keyIdx) => {
        peak[key] = vec[i * keys.length + keyIdx];
      });
      peaks.push(peak);
    }
    return peaks;
  }

  function halfMaxWidth(xs, ys, peakIdx, halfHeight) {
    let leftX = xs[0];
    let rightX = xs[xs.length - 1];
    for (let i = peakIdx; i > 0; i--) {
      if (ys[i] >= halfHeight && ys[i - 1] <= halfHeight) {
        const t = (halfHeight - ys[i - 1]) / ((ys[i] - ys[i - 1]) || 1);
        leftX = xs[i - 1] + t * (xs[i] - xs[i - 1]);
        break;
      }
    }
    for (let i = peakIdx; i < ys.length - 1; i++) {
      if (ys[i] >= halfHeight && ys[i + 1] <= halfHeight) {
        const t = (halfHeight - ys[i]) / ((ys[i + 1] - ys[i]) || 1);
        rightX = xs[i] + t * (xs[i + 1] - xs[i]);
        break;
      }
    }
    return Math.max(rightX - leftX, (xs[xs.length - 1] - xs[0]) / 12, 1e-6);
  }

  function findTopPeaks(xs, ys, peakCount) {
    const candidates = [];
    for (let i = 0; i < ys.length; i++) {
      const left = ys[i - 1] ?? -Infinity;
      const right = ys[i + 1] ?? -Infinity;
      if (ys[i] >= left && ys[i] >= right) candidates.push(i);
    }
    if (!candidates.length) candidates.push(ys.indexOf(Math.max(...ys)));
    candidates.sort((a, b) => ys[b] - ys[a]);
    const chosen = [];
    const minSpacing = Math.max(1, Math.floor(xs.length / (peakCount * 3)));
    for (const idx of candidates) {
      if (chosen.every((v) => Math.abs(v - idx) >= minSpacing)) chosen.push(idx);
      if (chosen.length >= peakCount) break;
    }
    for (let i = 0; chosen.length < peakCount && i < ys.length; i++) {
      const idx = candidates[i] ?? i;
      if (!chosen.includes(idx)) chosen.push(idx);
    }
    return chosen.sort((a, b) => xs[a] - xs[b]);
  }

  function autoInitialPeaks(data, options) {
    const { xMin, xMax, model, subtractBackground, edgeFraction, peakCount = 1 } = options;
    const points = selectRange(data, xMin, xMax);
    const normalizedCount = normalizePeakCount(peakCount);
    if (points.length < Math.max(5, normalizedCount * 4)) throw new Error('選択範囲内の点数が少なすぎます。');
    const xs = points.map((p) => p.x);
    const ysRaw = points.map((p) => p.y);
    const bg = subtractBackground
      ? estimateLinearBackground(points, edgeFraction)
      : { slope: 0, intercept: 0, bgY: new Array(points.length).fill(0), correctedY: ysRaw.slice() };
    const ys = bg.correctedY;
    const peakIdxs = findTopPeaks(xs, ys, normalizedCount);
    const peaks = peakIdxs.map((peakIdx) => {
      const peakHeight = Math.max(ys[peakIdx], 1e-3);
      const center = xs[peakIdx];
      const fwhm = halfMaxWidth(xs, ys, peakIdx, peakHeight / 2);
      const gaussianWidth = Math.max(fwhm * 0.85, 1e-4);
      const area = Math.max(Math.abs(trapz(xs, ys)), 1e-3);
      return {
        amplitude: peakHeight,
        center,
        sigma: gaussianWidth,
        gamma: gaussianWidth,
        area,
        fwhm,
        q: estimateBwfQ(xs, ys, center, gaussianWidth, 0),
      };
    });
    return peaks.map((peak) => {
      if (model === 'gaussian') return { amplitude: peak.amplitude, center: peak.center, sigma: Math.max(peak.fwhm / GAUSS_FWHM, 1e-4) };
      if (model === 'lorentzian') return { amplitude: peak.amplitude, center: peak.center, gamma: Math.max(peak.fwhm / 2, 1e-4) };
      if (model === 'voigt') return { amplitude: peak.area, center: peak.center, sigma: peak.sigma, gamma: peak.gamma };
      return { amplitude: peak.amplitude, center: peak.center, gamma: peak.gamma, q: peak.q };
    });
  }

  function autoInitialParams(data, options) {
    return autoInitialPeaks(data, { ...options, peakCount: 1 })[0];
  }

  function centroid(simplex) {
    const n = simplex[0].x.length;
    const c = new Array(n).fill(0);
    for (let i = 0; i < simplex.length - 1; i++) {
      for (let j = 0; j < n; j++) c[j] += simplex[i].x[j];
    }
    for (let j = 0; j < n; j++) c[j] /= (simplex.length - 1);
    return c;
  }

  function addVec(a, b, scale = 1) { return a.map((v, i) => v + scale * b[i]); }
  function subVec(a, b) { return a.map((v, i) => v - b[i]); }
  function mulVec(a, scale) { return a.map((v) => v * scale); }
  function simplexSpread(simplex) { return Math.abs(simplex[simplex.length - 1].f - simplex[0].f); }

  function nelderMead(fn, x0, steps, maxIter = 500, tol = 1e-9) {
    const n = x0.length;
    const simplex = [{ x: x0.slice(), f: fn(x0) }];
    for (let i = 0; i < n; i++) {
      const x = x0.slice();
      x[i] += steps[i] || 1;
      simplex.push({ x, f: fn(x) });
    }
    const alpha = 1, gamma = 2, rho = 0.5, sigma = 0.5;
    let iterations = 0;
    for (; iterations < maxIter; iterations++) {
      simplex.sort((a, b) => a.f - b.f);
      if (simplexSpread(simplex) < tol) break;
      const c = centroid(simplex);
      const worst = simplex[n];
      const reflectedX = addVec(c, subVec(c, worst.x), alpha);
      const reflected = { x: reflectedX, f: fn(reflectedX) };
      if (reflected.f < simplex[0].f) {
        const expandedX = addVec(c, subVec(reflected.x, c), gamma);
        const expanded = { x: expandedX, f: fn(expandedX) };
        simplex[n] = expanded.f < reflected.f ? expanded : reflected;
        continue;
      }
      if (reflected.f < simplex[n - 1].f) {
        simplex[n] = reflected;
        continue;
      }
      let contracted;
      if (reflected.f < worst.f) {
        const outsideX = addVec(c, subVec(reflected.x, c), rho);
        contracted = { x: outsideX, f: fn(outsideX) };
      } else {
        const insideX = addVec(c, subVec(worst.x, c), -rho);
        contracted = { x: insideX, f: fn(insideX) };
      }
      if (contracted.f < worst.f) {
        simplex[n] = contracted;
        continue;
      }
      const bestX = simplex[0].x;
      for (let i = 1; i < simplex.length; i++) {
        const shrunkX = addVec(bestX, mulVec(subVec(simplex[i].x, bestX), sigma));
        simplex[i] = { x: shrunkX, f: fn(shrunkX) };
      }
    }
    simplex.sort((a, b) => a.f - b.f);
    return { x: simplex[0].x.slice(), f: simplex[0].f, iterations, converged: iterations < maxIter };
  }

  function validatePeakParams(model, peak, domain) {
    const widthMax = Math.max(domain.width * 2, 1e-3);
    if (!Number.isFinite(peak.amplitude) || peak.amplitude <= 0) return false;
    if (!Number.isFinite(peak.center) || peak.center < domain.xMin || peak.center > domain.xMax) return false;
    if ('sigma' in peak && (!Number.isFinite(peak.sigma) || peak.sigma <= 0 || peak.sigma > widthMax)) return false;
    if ('gamma' in peak && (!Number.isFinite(peak.gamma) || peak.gamma <= 0 || peak.gamma > widthMax)) return false;
    if ('q' in peak && (!Number.isFinite(peak.q) || Math.abs(peak.q) < 1e-4 || Math.abs(peak.q) > 1e4)) return false;
    return true;
  }

  function validatePeaks(model, peaks, domain) {
    return peaks.every((peak) => validatePeakParams(model, peak, domain));
  }

  function derivePeakMetrics(model, peak, x) {
    const fitY = x.map((value) => modelY(model, value, peak));
    let fwhm = NaN;
    let area = trapz(x, fitY);
    if (model === 'gaussian') {
      fwhm = GAUSS_FWHM * peak.sigma;
      area = peak.amplitude * peak.sigma * SQRT_2PI;
    } else if (model === 'lorentzian') {
      fwhm = 2 * peak.gamma;
      area = Math.PI * peak.amplitude * peak.gamma;
    } else if (model === 'voigt') {
      const fG = peak.sigma;
      const fL = peak.gamma;
      fwhm = 0.5346 * fL + Math.sqrt(0.2166 * fL * fL + fG * fG);
      area = peak.amplitude;
    } else if (model === 'bwf') {
      fwhm = 2 * peak.gamma;
    }
    return { fwhm, area };
  }

  function fitSinglePeak(data, options) {
    return fitMultiPeak(data, { ...options, peakCount: 1, initialPeaks: options.initial ? [options.initial] : undefined });
  }

  function fitMultiPeak(data, options) {
    const { xMin, xMax, model, subtractBackground = true, edgeFraction = 0.15, maxIter = 800 } = options;
    const peakCount = normalizePeakCount(options.peakCount || options.initialPeaks?.length || 1);
    const points = selectRange(data, xMin, xMax);
    if (points.length < Math.max(8, peakCount * 5)) throw new Error('選択範囲内のデータ点が少なすぎます。');
    const xs = points.map((p) => p.x);
    const ysRaw = points.map((p) => p.y);
    const background = subtractBackground
      ? estimateLinearBackground(points, edgeFraction)
      : { slope: 0, intercept: 0, bgY: new Array(points.length).fill(0), correctedY: ysRaw.slice() };
    const ys = background.correctedY;
    const domain = { xMin: Math.min(xMin, xMax), xMax: Math.max(xMin, xMax), width: Math.max(Math.abs(xMax - xMin), 1e-6) };
    const startPeaks = (options.initialPeaks && options.initialPeaks.length)
      ? options.initialPeaks.slice(0, peakCount)
      : autoInitialPeaks(data, { xMin, xMax, model, subtractBackground, edgeFraction, peakCount });
    const keys = modelKeys(model);
    const normalizedPeaks = startPeaks.map((peak) => Object.fromEntries(keys.map((k) => [k, Number(peak[k])] )));
    const x0 = paramsToVector(model, normalizedPeaks);
    const steps = normalizedPeaks.flatMap((peak) => keys.map((key) => {
      if (key === 'amplitude') return Math.max((peak.amplitude || 1) * 0.15, 1e-3);
      if (key === 'center') return domain.width * 0.03;
      if (key === 'sigma') return Math.max((peak.sigma || domain.width / 20) * 0.2, domain.width * 1e-4);
      if (key === 'gamma') return Math.max((peak.gamma || domain.width / 20) * 0.2, domain.width * 1e-4);
      return Math.max(Math.abs(peak.q || 5) * 0.2, 0.25);
    }));
    const objective = (vec) => {
      const peaks = vectorToPeakParams(model, vec, peakCount);
      if (!validatePeaks(model, peaks, domain)) return 1e18;
      let sse = 0;
      for (let i = 0; i < xs.length; i++) {
        const pred = peaks.reduce((sum, peak) => sum + modelY(model, xs[i], peak), 0);
        const err = ys[i] - pred;
        sse += err * err;
      }
      return sse / xs.length;
    };
    const result = nelderMead(objective, x0, steps, maxIter, 1e-10);
    const peaks = vectorToPeakParams(model, result.x, peakCount).sort((a, b) => a.center - b.center);
    if (!validatePeaks(model, peaks, domain)) throw new Error('フィッティングが収束しませんでした。初期値や範囲を見直してください。');
    const componentY = peaks.map((peak) => xs.map((x) => modelY(model, x, peak)));
    const fitYSub = xs.map((_, i) => componentY.reduce((sum, ysPeak) => sum + ysPeak[i], 0));
    const fitYAbs = fitYSub.map((v, i) => v + background.bgY[i]);
    const residuals = ys.map((v, i) => v - fitYSub[i]);
    const mse = mean(residuals.map((v) => v * v));
    const rmse = Math.sqrt(mse);
    const yMean = mean(ys);
    const ssTot = ys.reduce((acc, v) => acc + (v - yMean) ** 2, 0);
    const ssRes = residuals.reduce((acc, v) => acc + v * v, 0);
    const r2 = ssTot > 0 ? 1 - ssRes / ssTot : NaN;
    const peakMetrics = peaks.map((peak) => derivePeakMetrics(model, peak, xs));
    const metrics = {
      rmse, r2, objective: result.f, iterations: result.iterations, converged: result.converged,
      peakCount,
      fwhm: peakMetrics.reduce((sum, item) => sum + (item.fwhm || 0), 0),
      area: peakMetrics.reduce((sum, item) => sum + (item.area || 0), 0),
    };
    return {
      model,
      peakCount,
      peaks,
      peakMetrics,
      params: peaks[0],
      metrics,
      selection: { xMin: domain.xMin, xMax: domain.xMax },
      background: { slope: background.slope, intercept: background.intercept },
      x: xs,
      yRaw: ysRaw,
      yCorrected: ys,
      yBackground: background.bgY,
      yFitSub: fitYSub,
      yFitAbs: fitYAbs,
      yComponentsAbs: componentY.map((series) => series.map((v, i) => v + background.bgY[i])),
      yComponentsSub: componentY,
    };
  }

  function csvEscape(v) {
    const s = String(v ?? '');
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  }


  function delimiterFromMode(mode) {
    if (mode === 'tab') return '\t';
    if (mode === 'space') return ' ';
    return ',';
  }

  function headerForDelimiter(columns, delimiter) {
    return columns.join(delimiter);
  }

  function rowForDelimiter(values, delimiter) {
    if (delimiter === ',') return values.map(csvEscape).join(delimiter);
    return values.join(delimiter);
  }

  function backgroundSubtractedToCSV(data, options) {
    const { xMin, xMax, edgeFraction = 0.15, columnMode = 'full', delimiterMode = 'comma' } = options;
    const points = selectRange(data, xMin, xMax);
    if (points.length < 4) throw new Error('背景差し引き範囲の点数が少なすぎます。');
    const background = estimateLinearBackground(points, edgeFraction);
    const normalizedColumnMode = columnMode === 'x_y_corrected' ? 'x_y_corrected' : 'full';
    const delimiter = delimiterFromMode(delimiterMode);
    const headerColumns = normalizedColumnMode === 'x_y_corrected'
      ? ['x', 'y_corrected']
      : ['x', 'y_raw', 'y_background', 'y_corrected'];
    const lines = [headerForDelimiter(headerColumns, delimiter)];
    points.forEach((point, index) => {
      lines.push(
        normalizedColumnMode === 'x_y_corrected'
          ? rowForDelimiter([point.x, background.correctedY[index]], delimiter)
          : rowForDelimiter([point.x, point.y, background.bgY[index], background.correctedY[index]], delimiter)
      );
    });
    return lines.join('\n');
  }

  function crc32(bytes) {
    let crc = -1;
    for (let i = 0; i < bytes.length; i++) {
      crc ^= bytes[i];
      for (let j = 0; j < 8; j++) {
        crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
      }
    }
    return (crc ^ -1) >>> 0;
  }

  function createZipFromTextFiles(files) {
    const encoder = new TextEncoder();
    const localParts = [];
    const centralParts = [];
    let offset = 0;
    for (const file of files) {
      const nameBytes = encoder.encode(file.name);
      const dataBytes = encoder.encode(file.content);
      const crc = crc32(dataBytes);
      const localHeader = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(localHeader.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(8, 0, true);
      lv.setUint16(10, 0, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, dataBytes.length, true);
      lv.setUint32(22, dataBytes.length, true);
      lv.setUint16(26, nameBytes.length, true);
      localHeader.set(nameBytes, 30);
      localParts.push(localHeader, dataBytes);

      const centralHeader = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(centralHeader.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, 0, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, dataBytes.length, true);
      cv.setUint32(24, dataBytes.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint32(42, offset, true);
      centralHeader.set(nameBytes, 46);
      centralParts.push(centralHeader);

      offset += localHeader.length + dataBytes.length;
    }
    const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);
    return new Blob([...localParts, ...centralParts, end], { type: 'application/zip' });
  }

  function resultsToCSV(results) {
    const maxPeaks = results.reduce((max, row) => Math.max(max, row.peakCount || row.peaks?.length || 1), 1);
    const header = ['file', 'model', 'peak_count', 'x_min', 'x_max'];
    for (let i = 0; i < maxPeaks; i++) {
      header.push(`peak${i + 1}_amplitude`, `peak${i + 1}_center`, `peak${i + 1}_sigma`, `peak${i + 1}_gamma`, `peak${i + 1}_q`, `peak${i + 1}_fwhm`, `peak${i + 1}_area`);
    }
    header.push('total_fwhm', 'total_area', 'rmse', 'r2', 'bg_slope', 'bg_intercept', 'iterations', 'converged');
    const lines = [header.join(',')];
    for (const row of results) {
      const values = [row.fileName, row.model, row.peakCount || row.peaks?.length || 1, row.selection?.xMin, row.selection?.xMax];
      for (let i = 0; i < maxPeaks; i++) {
        const peak = row.peaks?.[i] || {};
        const metric = row.peakMetrics?.[i] || {};
        values.push(peak.amplitude ?? '', peak.center ?? '', peak.sigma ?? '', peak.gamma ?? '', peak.q ?? '', metric.fwhm ?? '', metric.area ?? '');
      }
      values.push(row.metrics?.fwhm, row.metrics?.area, row.metrics?.rmse, row.metrics?.r2, row.background?.slope, row.background?.intercept, row.metrics?.iterations, row.metrics?.converged);
      lines.push(values.map(csvEscape).join(','));
    }
    return lines.join('\n');
  }

  function defaultSelection(data) {
    if (!data.length) return { xMin: 0, xMax: 1 };
    const xs = data.map((p) => p.x);
    const ys = data.map((p) => p.y);
    let maxIdx = 0;
    for (let i = 1; i < ys.length; i++) if (ys[i] > ys[maxIdx]) maxIdx = i;
    const span = xs[xs.length - 1] - xs[0];
    const center = xs[maxIdx];
    return { xMin: Math.max(xs[0], center - span * 0.08), xMax: Math.min(xs[xs.length - 1], center + span * 0.08) };
  }

  return {
    parseXYText,
    selectRange,
    estimateLinearBackground,
    autoInitialParams,
    autoInitialPeaks,
    fitSinglePeak,
    fitMultiPeak,
    resultsToCSV,
    backgroundSubtractedToCSV,
    createZipFromTextFiles,
    defaultSelection,
    modelKeys,
    modelY,
    normalizePeakCount,
  };
});
