(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.PeakFitCore = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const SQRT_2PI = Math.sqrt(2 * Math.PI);
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
      return {
        slope: 0,
        intercept: 0,
        bgY: [],
        correctedY: [],
      };
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

  function pseudoVoigt(x, p) {
    const { amplitude, center, sigma, gamma } = p;
    const fG = GAUSS_FWHM * sigma;
    const fL = 2 * gamma;
    const f = Math.pow(
      Math.pow(fG, 5) +
        2.69269 * Math.pow(fG, 4) * fL +
        2.42843 * Math.pow(fG, 3) * Math.pow(fL, 2) +
        4.47163 * Math.pow(fG, 2) * Math.pow(fL, 3) +
        0.07842 * fG * Math.pow(fL, 4) +
        Math.pow(fL, 5),
      1 / 5
    );
    const ratio = f === 0 ? 0 : fL / f;
    const eta = clamp(
      1.36603 * ratio - 0.47719 * ratio * ratio + 0.11116 * ratio * ratio * ratio,
      0,
      1
    );
    const sigmaEff = Math.max(f / GAUSS_FWHM, 1e-9);
    const gammaEff = Math.max(f / 2, 1e-9);
    return amplitude * (
      eta * lorentzian(x, { amplitude: 1, center, gamma: gammaEff }) +
      (1 - eta) * gaussian(x, { amplitude: 1, center, sigma: sigmaEff })
    );
  }

  function bwf(x, p) {
    const { amplitude, center, gamma, q } = p;
    const qq = Math.abs(q) < 1e-6 ? (q < 0 ? -1e-6 : 1e-6) : q;
    const eps = (x - center) / gamma;
    return amplitude * ((1 + eps / qq) ** 2) / (1 + eps * eps);
  }

  function modelY(model, x, params) {
    switch (model) {
      case 'gaussian':
        return gaussian(x, params);
      case 'lorentzian':
        return lorentzian(x, params);
      case 'voigt':
        return pseudoVoigt(x, params);
      case 'bwf':
        return bwf(x, params);
      default:
        throw new Error(`Unknown model: ${model}`);
    }
  }

  function modelKeys(model) {
    switch (model) {
      case 'gaussian':
        return ['amplitude', 'center', 'sigma'];
      case 'lorentzian':
        return ['amplitude', 'center', 'gamma'];
      case 'voigt':
        return ['amplitude', 'center', 'sigma', 'gamma'];
      case 'bwf':
        return ['amplitude', 'center', 'gamma', 'q'];
      default:
        throw new Error(`Unknown model: ${model}`);
    }
  }

  function vectorToParams(model, vec) {
    const keys = modelKeys(model);
    const out = {};
    keys.forEach((k, i) => {
      out[k] = vec[i];
    });
    return out;
  }

  function paramsToVector(model, params) {
    return modelKeys(model).map((k) => Number(params[k]));
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

  function autoInitialParams(data, options) {
    const { xMin, xMax, model, subtractBackground, edgeFraction } = options;
    const points = selectRange(data, xMin, xMax);
    if (points.length < 5) {
      throw new Error('選択範囲内の点数が少なすぎます。');
    }
    const xs = points.map((p) => p.x);
    const ysRaw = points.map((p) => p.y);
    const bg = subtractBackground
      ? estimateLinearBackground(points, edgeFraction)
      : {
          slope: 0,
          intercept: 0,
          bgY: new Array(points.length).fill(0),
          correctedY: ysRaw.slice(),
        };
    const ys = bg.correctedY;

    let peakIdx = 0;
    let peakY = ys[0];
    for (let i = 1; i < ys.length; i++) {
      if (ys[i] > peakY) {
        peakY = ys[i];
        peakIdx = i;
      }
    }

    const amplitude = Math.max(peakY, 1e-3);
    const center = xs[peakIdx];
    const halfHeight = amplitude / 2;
    const fwhm = halfMaxWidth(xs, ys, peakIdx, halfHeight);

    const init = {
      amplitude,
      center,
      sigma: Math.max(fwhm / GAUSS_FWHM, 1e-4),
      gamma: Math.max(fwhm / 2, 1e-4),
      q: -5,
    };

    if (model === 'gaussian') {
      return { amplitude: init.amplitude, center: init.center, sigma: init.sigma };
    }
    if (model === 'lorentzian') {
      return { amplitude: init.amplitude, center: init.center, gamma: init.gamma };
    }
    if (model === 'voigt') {
      return { amplitude: init.amplitude, center: init.center, sigma: init.sigma, gamma: init.gamma };
    }
    return { amplitude: init.amplitude, center: init.center, gamma: init.gamma, q: init.q };
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

  function addVec(a, b, scale = 1) {
    return a.map((v, i) => v + scale * b[i]);
  }

  function subVec(a, b) {
    return a.map((v, i) => v - b[i]);
  }

  function mulVec(a, scale) {
    return a.map((v) => v * scale);
  }

  function simplexSpread(simplex) {
    const best = simplex[0].f;
    const worst = simplex[simplex.length - 1].f;
    return Math.abs(worst - best);
  }

  function nelderMead(fn, x0, steps, maxIter = 500, tol = 1e-9) {
    const n = x0.length;
    const simplex = [{ x: x0.slice(), f: fn(x0) }];
    for (let i = 0; i < n; i++) {
      const x = x0.slice();
      x[i] += steps[i] || 1;
      simplex.push({ x, f: fn(x) });
    }

    const alpha = 1;
    const gamma = 2;
    const rho = 0.5;
    const sigma = 0.5;

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

  function validateParams(model, params, domain) {
    const widthMax = Math.max(domain.width * 2, 1e-3);
    if (!Number.isFinite(params.amplitude) || params.amplitude <= 0) return false;
    if (!Number.isFinite(params.center) || params.center < domain.xMin || params.center > domain.xMax) return false;
    if ('sigma' in params && (!Number.isFinite(params.sigma) || params.sigma <= 0 || params.sigma > widthMax)) return false;
    if ('gamma' in params && (!Number.isFinite(params.gamma) || params.gamma <= 0 || params.gamma > widthMax)) return false;
    if ('q' in params && (!Number.isFinite(params.q) || Math.abs(params.q) < 1e-4 || Math.abs(params.q) > 1e4)) return false;
    return true;
  }

  function deriveMetrics(model, params, x, fitY) {
    let fwhm = NaN;
    let area = trapz(x, fitY);

    if (model === 'gaussian') {
      fwhm = GAUSS_FWHM * params.sigma;
      area = params.amplitude * params.sigma * SQRT_2PI;
    } else if (model === 'lorentzian') {
      fwhm = 2 * params.gamma;
      area = Math.PI * params.amplitude * params.gamma;
    } else if (model === 'voigt') {
      const fG = GAUSS_FWHM * params.sigma;
      const fL = 2 * params.gamma;
      fwhm = 0.5346 * fL + Math.sqrt(0.2166 * fL * fL + fG * fG);
    } else if (model === 'bwf') {
      fwhm = 2 * params.gamma;
    }

    return { fwhm, area };
  }

  function fitSinglePeak(data, options) {
    const {
      xMin,
      xMax,
      model,
      subtractBackground = true,
      edgeFraction = 0.15,
      initial,
      maxIter = 600,
    } = options;

    const points = selectRange(data, xMin, xMax);
    if (points.length < 8) {
      throw new Error('選択範囲内のデータ点が少なすぎます。');
    }

    const xs = points.map((p) => p.x);
    const ysRaw = points.map((p) => p.y);
    const background = subtractBackground
      ? estimateLinearBackground(points, edgeFraction)
      : {
          slope: 0,
          intercept: 0,
          bgY: new Array(points.length).fill(0),
          correctedY: ysRaw.slice(),
        };
    const ys = background.correctedY;

    const domain = {
      xMin: Math.min(xMin, xMax),
      xMax: Math.max(xMin, xMax),
      width: Math.max(Math.abs(xMax - xMin), 1e-6),
    };

    const startParams = initial || autoInitialParams(data, { xMin, xMax, model, subtractBackground, edgeFraction });
    const x0 = paramsToVector(model, startParams);
    const stepBase = {
      amplitude: Math.max((startParams.amplitude || 1) * 0.15, 1e-3),
      center: domain.width * 0.03,
      sigma: Math.max((startParams.sigma || domain.width / 20) * 0.2, domain.width * 1e-4),
      gamma: Math.max((startParams.gamma || domain.width / 20) * 0.2, domain.width * 1e-4),
      q: Math.max(Math.abs(startParams.q || 5) * 0.2, 0.25),
    };
    const steps = modelKeys(model).map((k) => stepBase[k]);

    const objective = (vec) => {
      const params = vectorToParams(model, vec);
      if (!validateParams(model, params, domain)) return 1e18;
      let sse = 0;
      for (let i = 0; i < xs.length; i++) {
        const pred = modelY(model, xs[i], params);
        const err = ys[i] - pred;
        sse += err * err;
      }
      return sse / xs.length;
    };

    const result = nelderMead(objective, x0, steps, maxIter, 1e-10);
    const params = vectorToParams(model, result.x);
    if (!validateParams(model, params, domain)) {
      throw new Error('フィッティングが収束しませんでした。初期値や範囲を見直してください。');
    }

    const fitYSub = xs.map((x) => modelY(model, x, params));
    const fitYAbs = fitYSub.map((v, i) => v + background.bgY[i]);
    const residuals = ys.map((v, i) => v - fitYSub[i]);
    const mse = mean(residuals.map((v) => v * v));
    const rmse = Math.sqrt(mse);
    const yMean = mean(ys);
    const ssTot = ys.reduce((acc, v) => acc + (v - yMean) ** 2, 0);
    const ssRes = residuals.reduce((acc, v) => acc + v * v, 0);
    const r2 = ssTot > 0 ? 1 - ssRes / ssTot : NaN;
    const derived = deriveMetrics(model, params, xs, fitYSub);

    return {
      model,
      params,
      metrics: {
        rmse,
        r2,
        objective: result.f,
        iterations: result.iterations,
        converged: result.converged,
        ...derived,
      },
      selection: {
        xMin: domain.xMin,
        xMax: domain.xMax,
      },
      background: {
        slope: background.slope,
        intercept: background.intercept,
      },
      x: xs,
      yRaw: ysRaw,
      yCorrected: ys,
      yBackground: background.bgY,
      yFitSub: fitYSub,
      yFitAbs: fitYAbs,
    };
  }

  function csvEscape(v) {
    const s = String(v ?? '');
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  }

  function resultsToCSV(results) {
    const header = [
      'file', 'model', 'x_min', 'x_max', 'amplitude', 'center', 'sigma', 'gamma', 'q',
      'fwhm', 'area', 'rmse', 'r2', 'bg_slope', 'bg_intercept', 'iterations', 'converged'
    ];
    const lines = [header.join(',')];
    for (const row of results) {
      lines.push([
        row.fileName,
        row.model,
        row.selection?.xMin,
        row.selection?.xMax,
        row.params?.amplitude,
        row.params?.center,
        row.params?.sigma ?? '',
        row.params?.gamma ?? '',
        row.params?.q ?? '',
        row.metrics?.fwhm,
        row.metrics?.area,
        row.metrics?.rmse,
        row.metrics?.r2,
        row.background?.slope,
        row.background?.intercept,
        row.metrics?.iterations,
        row.metrics?.converged,
      ].map(csvEscape).join(','));
    }
    return lines.join('\n');
  }

  function defaultSelection(data) {
    if (!data.length) return { xMin: 0, xMax: 1 };
    const xs = data.map((p) => p.x);
    const ys = data.map((p) => p.y);
    let maxIdx = 0;
    for (let i = 1; i < ys.length; i++) {
      if (ys[i] > ys[maxIdx]) maxIdx = i;
    }
    const span = xs[xs.length - 1] - xs[0];
    const center = xs[maxIdx];
    return {
      xMin: Math.max(xs[0], center - span * 0.08),
      xMax: Math.min(xs[xs.length - 1], center + span * 0.08),
    };
  }

  return {
    parseXYText,
    selectRange,
    estimateLinearBackground,
    autoInitialParams,
    fitSinglePeak,
    resultsToCSV,
    defaultSelection,
    modelKeys,
    modelY,
  };
});
