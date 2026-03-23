const state = {
  datasets: [],
  activeIndex: 0,
  selection: null,
  currentFit: null,
  batchResults: [],
  drag: null,
  trialFit: null,
};

const els = {};

window.addEventListener('DOMContentLoaded', () => {
  bindElements();
  bindEvents();
  registerServiceWorker();
  renderPeakInputs();
  renderTrialStatus();
  syncBackgroundDelimiterAvailability();
  resizeCanvas();
  draw();
});

function bindElements() {
  els.fileInput = document.getElementById('fileInput');
  els.datasetSelect = document.getElementById('datasetSelect');
  els.model = document.getElementById('model');
  els.peakCount = document.getElementById('peakCount');
  els.subtractBg = document.getElementById('subtractBg');
  els.bgEdgeFraction = document.getElementById('bgEdgeFraction');
  els.bgZipExtension = document.getElementById('bgZipExtension');
  els.bgZipColumns = document.getElementById('bgZipColumns');
  els.bgZipDelimiter = document.getElementById('bgZipDelimiter');
  els.peakInputs = document.getElementById('peakInputs');
  els.autoInitBtn = document.getElementById('autoInitBtn');
  els.fitCurrentBtn = document.getElementById('fitCurrentBtn');
  els.acceptTrialBtn = document.getElementById('acceptTrialBtn');
  els.restoreTrialBtn = document.getElementById('restoreTrialBtn');
  els.trialStatus = document.getElementById('trialStatus');
  els.sequentialFit = document.getElementById('sequentialFit');
  els.fitAllBtn = document.getElementById('fitAllBtn');
  els.subtractAllBtn = document.getElementById('subtractAllBtn');
  els.exportCsvBtn = document.getElementById('exportCsvBtn');
  els.clearBtn = document.getElementById('clearBtn');
  els.selectionText = document.getElementById('selectionText');
  els.fitInfo = document.getElementById('fitInfo');
  els.resultsBody = document.getElementById('resultsBody');
  els.canvas = document.getElementById('plotCanvas');
  els.ctx = els.canvas.getContext('2d');
  els.toast = document.getElementById('toast');
}

function bindEvents() {
  els.fileInput.addEventListener('change', onFilesSelected);
  els.datasetSelect.addEventListener('change', () => {
    state.activeIndex = Number(els.datasetSelect.value) || 0;
    state.currentFit = null;
    state.trialFit = null;
    if (!state.selection && currentDataset()) state.selection = PeakFitCore.defaultSelection(currentDataset().data);
    syncInitialInputsForActiveDataset();
    renderTrialStatus();
    renderResultsTable();
    draw();
  });
  els.model.addEventListener('change', () => {
    state.trialFit = null;
    renderPeakInputs();
    syncInitialInputsForActiveDataset();
    renderTrialStatus();
    draw();
  });
  els.peakCount.addEventListener('change', () => {
    els.peakCount.value = String(PeakFitCore.normalizePeakCount(els.peakCount.value));
    state.trialFit = null;
    renderPeakInputs();
    syncInitialInputsForActiveDataset();
    renderTrialStatus();
    draw();
  });
  els.bgZipExtension.addEventListener('change', syncBackgroundDelimiterAvailability);
  els.sequentialFit?.addEventListener('change', () => { state.trialFit = null; syncInitialInputsForActiveDataset(); renderTrialStatus(); });
  els.autoInitBtn.addEventListener('click', () => { state.trialFit = null; syncInitialInputsFromSelectionEstimate(true); renderTrialStatus(); });
  els.fitCurrentBtn.addEventListener('click', () => runCurrentFit());
  els.acceptTrialBtn?.addEventListener('click', () => acceptCurrentTrial());
  els.restoreTrialBtn?.addEventListener('click', () => restoreTrialSetup());
  els.fitAllBtn.addEventListener('click', () => runBatchFit());
  els.subtractAllBtn.addEventListener('click', () => exportBackgroundSubtractedZip());
  els.exportCsvBtn.addEventListener('click', exportCsv);
  els.clearBtn.addEventListener('click', clearAll);
  window.addEventListener('resize', () => { resizeCanvas(); draw(); });
  bindCanvasSelection();
}

function renderPeakInputs() {
  const peakCount = PeakFitCore.normalizePeakCount(els.peakCount?.value || 1);
  const model = els.model?.value || 'gaussian';
  const keys = PeakFitCore.modelKeys(model);
  const existing = collectInitialPeaksSafe();
  const existingConstraints = collectParameterConstraintsSafe();
  const amplitudeLabel = model === 'voigt' ? 'Area (A)' : 'Amplitude';
  const sigmaLabel = model === 'voigt' ? 'wG' : 'σ';
  const gammaLabel = model === 'bwf' ? 'w' : (model === 'voigt' ? 'wL' : 'γ');
  els.peakInputs.innerHTML = '';
  for (let i = 0; i < peakCount; i++) {
    const peak = existing[i] || {};
    const card = document.createElement('div');
    card.className = 'peak-card';
    card.innerHTML = `
      <div class="peak-card-title">Peak ${i + 1}</div>
      <div class="grid2 peak-grid">
        ${buildPeakInput('amplitude', amplitudeLabel, i, peak.amplitude ?? '')}
        ${buildPeakInput('center', 'Center', i, peak.center ?? '')}
        ${keys.includes('sigma') ? buildPeakInput('sigma', sigmaLabel, i, peak.sigma ?? '') : ''}
        ${keys.includes('gamma') ? buildPeakInput('gamma', gammaLabel, i, peak.gamma ?? '') : ''}
        ${keys.includes('q') ? buildPeakInput('q', 'q', i, peak.q ?? -2) : ''}
      </div>
    `;
    els.peakInputs.appendChild(card);
  }
  applyConstraintsToInputs(existingConstraints);
}

function buildPeakInput(key, label, index, value) {
  return `<label data-param="${key}" class="param-field"><span>${label}</span><input data-peak-index="${index}" data-param-key="${key}" type="number" step="any" value="${escapeHtml(String(value))}" /><span class="constraint-row"><label class="constraint-check"><input data-peak-index="${index}" data-param-key="${key}" data-constraint-kind="fixed" type="checkbox" />固定</label><input data-peak-index="${index}" data-param-key="${key}" data-constraint-kind="sharedGroup" type="text" placeholder="共有ID" /></span></label>`;
}

function bindCanvasSelection() {
  const canvas = els.canvas;
  const startDrag = (clientX) => {
    const plot = getPlotRect();
    const x = clientX - canvas.getBoundingClientRect().left;
    if (!state.datasets.length || !plot) return;
    if (x < plot.left || x > plot.right) return;
    state.drag = { startPx: x, currentPx: x };
    draw();
  };
  canvas.addEventListener('mousedown', (e) => startDrag(e.clientX));
  canvas.addEventListener('mousemove', (e) => { if (state.drag) { state.drag.currentPx = e.clientX - canvas.getBoundingClientRect().left; draw(); } });
  window.addEventListener('mouseup', () => finalizeDrag());
  canvas.addEventListener('touchstart', (e) => { if (e.touches[0]) startDrag(e.touches[0].clientX); }, { passive: true });
  canvas.addEventListener('touchmove', (e) => { if (state.drag && e.touches[0]) { state.drag.currentPx = e.touches[0].clientX - canvas.getBoundingClientRect().left; draw(); } }, { passive: true });
  window.addEventListener('touchend', () => finalizeDrag());
}

function finalizeDrag() {
  if (!state.drag || !currentDataset()) return;
  const { startPx, currentPx } = state.drag;
  const plot = getPlotRect();
  const ds = currentDataset();
  const bounds = dataBounds(ds.data);
  const p1 = clamp(startPx, plot.left, plot.right);
  const p2 = clamp(currentPx, plot.left, plot.right);
  const x1 = pxToX(Math.min(p1, p2), bounds, plot);
  const x2 = pxToX(Math.max(p1, p2), bounds, plot);
  state.drag = null;
  if (Math.abs(x2 - x1) > 1e-9) {
    state.selection = { xMin: x1, xMax: x2 };
    state.currentFit = null;
    state.trialFit = null;
    syncInitialInputsFromSelectionEstimate();
  }
  draw();
}

async function onFilesSelected(event) {
  const files = Array.from(event.target.files || []);
  if (!files.length) return;
  const loaded = [];
  for (const file of files) {
    const text = await file.text();
    const data = PeakFitCore.parseXYText(text);
    if (data.length >= 10) loaded.push({ name: file.name, data });
  }
  if (!loaded.length) return toast('数値2列のデータを読み込めませんでした。', true);
  state.datasets = loaded;
  state.activeIndex = 0;
  state.selection = PeakFitCore.defaultSelection(loaded[0].data);
  state.currentFit = null;
  state.batchResults = [];
  state.trialFit = null;
  refreshDatasetSelect();
  syncInitialInputsForActiveDataset();
  renderFitInfo(null);
  renderTrialStatus();
  renderResultsTable();
  draw();
  toast(`${loaded.length}件のファイルを読み込みました。`);
}

function refreshDatasetSelect() {
  els.datasetSelect.innerHTML = '';
  state.datasets.forEach((ds, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = ds.name;
    els.datasetSelect.appendChild(opt);
  });
  els.datasetSelect.value = String(state.activeIndex);
}

function currentDataset() { return state.datasets[state.activeIndex] || null; }
function ensureReady(ds) {
  if (!ds) throw new Error('先にファイルを読み込んでください。');
  if (!state.selection) throw new Error('グラフ上でフィット範囲をドラッグ選択してください。');
}

function buildFitOptions() {
  return {
    xMin: state.selection.xMin,
    xMax: state.selection.xMax,
    model: els.model.value,
    peakCount: PeakFitCore.normalizePeakCount(els.peakCount.value),
    subtractBackground: els.subtractBg.checked,
    edgeFraction: Number(els.bgEdgeFraction.value),
    initialPeaks: collectInitialPeaks(),
    parameterConstraints: collectParameterConstraints(),
  };
}

function collectInitialPeaksSafe() {
  try { return collectInitialPeaks(); } catch { return []; }
}

function collectParameterConstraintsSafe() {
  try { return collectParameterConstraints(); } catch { return { perPeak: [] }; }
}

function collectParameterConstraints() {
  const peakCount = PeakFitCore.normalizePeakCount(els.peakCount.value);
  const model = els.model.value;
  const keys = PeakFitCore.modelKeys(model);
  const perPeak = [];
  for (let i = 0; i < peakCount; i++) {
    const peakConstraints = {};
    for (const key of keys) {
      const fixed = els.peakInputs.querySelector(`[data-peak-index="${i}"][data-param-key="${key}"][data-constraint-kind="fixed"]`)?.checked || false;
      const sharedGroup = (els.peakInputs.querySelector(`[data-peak-index="${i}"][data-param-key="${key}"][data-constraint-kind="sharedGroup"]`)?.value || '').trim();
      peakConstraints[key] = { fixed, sharedGroup };
    }
    perPeak.push(peakConstraints);
  }
  return PeakFitCore.normalizeParameterConstraints(model, peakCount, { perPeak });
}

function collectInitialPeaks() {
  const peakCount = PeakFitCore.normalizePeakCount(els.peakCount.value);
  const keys = PeakFitCore.modelKeys(els.model.value);
  const peaks = [];
  for (let i = 0; i < peakCount; i++) {
    const peak = {};
    for (const key of keys) {
      const input = els.peakInputs.querySelector(`[data-peak-index="${i}"][data-param-key="${key}"]`);
      const value = Number(input?.value);
      if (!Number.isFinite(value)) throw new Error(`Peak ${i + 1} の ${key} を入力してください。`);
      peak[key] = value;
    }
    peaks.push(peak);
  }
  return peaks;
}

function getSequentialSeedPeaksForDataset(datasetIndex) {
  if (!els.sequentialFit?.checked || datasetIndex <= 0) return null;
  const previousName = state.datasets[datasetIndex - 1]?.name;
  if (!previousName) return null;
  const previousResult = state.batchResults.find((result) => result.fileName === previousName);
  if (!previousResult || previousResult.model !== els.model.value) return null;
  const peakCount = PeakFitCore.normalizePeakCount(els.peakCount.value);
  if (!Array.isArray(previousResult.peaks) || previousResult.peaks.length !== peakCount) return null;
  return previousResult.peaks.map((peak) => ({ ...peak }));
}

function applyConstraintsToInputs(parameterConstraints) {
  const normalized = PeakFitCore.normalizeParameterConstraints(els.model.value, PeakFitCore.normalizePeakCount(els.peakCount.value), parameterConstraints);
  normalized.perPeak.forEach((peakConstraints, i) => {
    Object.entries(peakConstraints).forEach(([key, constraint]) => {
      const fixed = els.peakInputs.querySelector(`[data-peak-index="${i}"][data-param-key="${key}"][data-constraint-kind="fixed"]`);
      const sharedGroup = els.peakInputs.querySelector(`[data-peak-index="${i}"][data-param-key="${key}"][data-constraint-kind="sharedGroup"]`);
      if (fixed) fixed.checked = Boolean(constraint.fixed);
      if (sharedGroup) sharedGroup.value = constraint.sharedGroup || '';
    });
  });
}

function applyPeaksToInputs(peaks) {
  peaks.forEach((peak, i) => {
    Object.entries(peak).forEach(([key, value]) => {
      const input = els.peakInputs.querySelector(`[data-peak-index="${i}"][data-param-key="${key}"]`);
      if (input) input.value = formatNumber(value);
    });
  });
}

function syncInitialInputsForActiveDataset(forceToast = false) {
  const seedPeaks = getSequentialSeedPeaksForDataset(state.activeIndex);
  if (seedPeaks) {
    applyPeaksToInputs(seedPeaks);
    if (forceToast) toast('直前ファイルのフィット結果を初期値として引き継ぎました。');
    return;
  }
  syncInitialInputsFromSelectionEstimate(forceToast);
}

function syncInitialInputsFromSelectionEstimate(forceToast = false) {
  const ds = currentDataset();
  if (!ds || !state.selection) return;
  try {
    const estimated = PeakFitCore.autoInitialPeaks(ds.data, {
      xMin: state.selection.xMin,
      xMax: state.selection.xMax,
      model: els.model.value,
      peakCount: PeakFitCore.normalizePeakCount(els.peakCount.value),
      subtractBackground: els.subtractBg.checked,
      edgeFraction: Number(els.bgEdgeFraction.value),
    });
    applyPeaksToInputs(estimated);
    if (forceToast) toast('選択範囲から初期値を再推定しました。');
  } catch (err) {
    if (forceToast) toast(err.message || '初期値推定に失敗しました。', true);
  }
}

function captureCurrentSetup() {
  return {
    model: els.model.value,
    peakCount: PeakFitCore.normalizePeakCount(els.peakCount.value),
    subtractBackground: Boolean(els.subtractBg.checked),
    edgeFraction: Number(els.bgEdgeFraction.value),
    selection: state.selection ? { ...state.selection } : null,
    initialPeaks: collectInitialPeaks().map((peak) => ({ ...peak })),
    parameterConstraints: collectParameterConstraints(),
  };
}

function applySetupSnapshot(snapshot) {
  if (!snapshot) return;
  els.model.value = snapshot.model;
  els.peakCount.value = String(PeakFitCore.normalizePeakCount(snapshot.peakCount));
  els.subtractBg.checked = Boolean(snapshot.subtractBackground);
  els.bgEdgeFraction.value = String(snapshot.edgeFraction);
  state.selection = snapshot.selection ? { ...snapshot.selection } : state.selection;
  renderPeakInputs();
  applyPeaksToInputs(snapshot.initialPeaks || []);
  applyConstraintsToInputs(snapshot.parameterConstraints);
}

function renderTrialStatus() {
  if (!els.trialStatus) return;
  const ds = currentDataset();
  const trial = state.trialFit;
  if (!ds || !trial || trial.fileName !== ds.name) {
    els.trialStatus.innerHTML = '<div class="muted">試しフィット待ちです。初期条件を決めたら「試しフィット」を押してください。</div>';
    if (els.acceptTrialBtn) els.acceptTrialBtn.disabled = true;
    if (els.restoreTrialBtn) els.restoreTrialBtn.disabled = true;
    return;
  }
  const metric = trial.result?.metrics || {};
  const nextLabel = state.activeIndex < state.datasets.length - 1 ? '採用して次へ' : '採用して終了';
  els.trialStatus.innerHTML = `
    <div><strong>試しフィット済み:</strong> ${escapeHtml(trial.fileName)}</div>
    <div>R²: ${formatNumber(metric.r2)} / RMSE: ${formatNumber(metric.rmse)}</div>
    <div class="hint">結果が良ければ「${nextLabel}」、悪ければ「初期条件に戻す」で再調整できます。</div>
  `;
  if (els.acceptTrialBtn) {
    els.acceptTrialBtn.disabled = false;
    els.acceptTrialBtn.textContent = nextLabel;
  }
  if (els.restoreTrialBtn) els.restoreTrialBtn.disabled = false;
}

function runCurrentFit() {
  try {
    const ds = currentDataset();
    ensureReady(ds);
    const setupSnapshot = captureCurrentSetup();
    const result = PeakFitCore.fitMultiPeak(ds.data, buildFitOptions());
    state.currentFit = { ...result, fileName: ds.name };
    state.trialFit = { fileName: ds.name, setupSnapshot, result: state.currentFit };
    applyPeaksToInputs(state.currentFit.peaks);
    applyConstraintsToInputs(state.currentFit.parameterConstraints);
    renderFitInfo(state.currentFit);
    renderTrialStatus();
    renderResultsTable();
    draw();
    toast('試しフィットが完了しました。良ければ採用、悪ければ初期条件に戻せます。');
  } catch (err) {
    toast(err.message || 'フィットに失敗しました。', true);
  }
}

function acceptCurrentTrial() {
  const ds = currentDataset();
  const trial = state.trialFit;
  if (!ds || !trial || trial.fileName !== ds.name || !trial.result) return toast('先に試しフィットを実行してください。', true);
  upsertBatchResult(trial.result);
  state.currentFit = trial.result;
  const acceptedPeaks = trial.result.peaks.map((peak) => ({ ...peak }));
  const acceptedConstraints = trial.result.parameterConstraints;
  const acceptedSelection = trial.setupSnapshot?.selection ? { ...trial.setupSnapshot.selection } : (state.selection ? { ...state.selection } : null);
  const hasNext = state.activeIndex < state.datasets.length - 1;
  state.trialFit = null;
  if (hasNext) {
    state.activeIndex += 1;
    els.datasetSelect.value = String(state.activeIndex);
    state.currentFit = null;
    state.selection = acceptedSelection;
    renderPeakInputs();
    applyPeaksToInputs(acceptedPeaks);
    applyConstraintsToInputs(acceptedConstraints);
    renderFitInfo(null);
    renderTrialStatus();
    renderResultsTable();
    draw();
    toast('現在の結果を採用し、次のファイルへ進みました。必要なら初期条件を調整して再度試しフィットしてください。');
    return;
  }
  applyPeaksToInputs(acceptedPeaks);
  applyConstraintsToInputs(acceptedConstraints);
  renderFitInfo(state.currentFit);
  renderTrialStatus();
  renderResultsTable();
  draw();
  toast('結果を採用しました。必要ならCSVを書き出して完了してください。');
}

function restoreTrialSetup() {
  const ds = currentDataset();
  const trial = state.trialFit;
  if (!ds || !trial || trial.fileName !== ds.name) return toast('戻すための試しフィット履歴がありません。', true);
  applySetupSnapshot(trial.setupSnapshot);
  state.currentFit = null;
  state.trialFit = null;
  renderFitInfo(null);
  renderTrialStatus();
  renderResultsTable();
  draw();
  toast('フィット前の初期条件に戻しました。数値を調整して再度試しフィットしてください。');
}

async function runBatchFit() {
  try {
    if (!state.datasets.length) throw new Error('先にファイルを読み込んでください。');
    if (!state.selection) throw new Error('先にグラフ上でフィット範囲を選択してください。');
    const baseOptions = buildFitOptions();
    const sequentialFit = Boolean(els.sequentialFit?.checked);
    const results = [];
    let nextInitialPeaks = baseOptions.initialPeaks.map((peak) => ({ ...peak }));
    for (const ds of state.datasets) {
      const fitOptions = { ...baseOptions, initialPeaks: nextInitialPeaks.map((peak) => ({ ...peak })) };
      const result = PeakFitCore.fitMultiPeak(ds.data, fitOptions);
      const fullResult = { ...result, fileName: ds.name };
      results.push(fullResult);
      if (sequentialFit) nextInitialPeaks = fullResult.peaks.map((peak) => ({ ...peak }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    state.batchResults = results;
    state.currentFit = results.find((r) => r.fileName === currentDataset()?.name) || results[0] || null;
    state.trialFit = null;
    renderFitInfo(state.currentFit);
    renderTrialStatus();
    renderResultsTable();
    draw();
    if (state.currentFit?.peaks?.length) {
      applyPeaksToInputs(state.currentFit.peaks);
      applyConstraintsToInputs(state.currentFit.parameterConstraints);
    }
    toast(sequentialFit
      ? `${results.length}件のファイルを順次、直前のフィット結果を引き継いで一括フィットしました。`
      : `${results.length}件のファイルを同一初期条件で一括フィットしました。`);
  } catch (err) {
    toast(err.message || '一括フィットに失敗しました。', true);
  }
}


async function exportBackgroundSubtractedZip() {
  try {
    if (!state.datasets.length) throw new Error('先にファイルを読み込んでください。');
    if (!state.selection) throw new Error('先にグラフ上で処理範囲を選択してください。');
    const edgeFraction = Number(els.bgEdgeFraction.value);
    const outputExtension = normalizeBackgroundZipExtension(els.bgZipExtension.value);
    const columnMode = normalizeBackgroundZipColumnMode(els.bgZipColumns.value);
    const delimiterMode = normalizeBackgroundZipDelimiter(els.bgZipDelimiter.value, outputExtension);
    const files = state.datasets.map((ds) => ({
      name: buildBackgroundOutputName(ds.name, outputExtension),
      content: PeakFitCore.backgroundSubtractedToCSV(ds.data, {
        xMin: state.selection.xMin,
        xMax: state.selection.xMax,
        edgeFraction,
        columnMode,
        delimiterMode,
      }),
    }));
    const readme = [
      'Peak Fitting PWA background subtraction export',
      `selection_x_min,${state.selection.xMin}`,
      `selection_x_max,${state.selection.xMax}`,
      `edge_fraction,${edgeFraction}`,
      `file_extension,${outputExtension}`,
      `column_mode,${columnMode}`,
      `delimiter_mode,${delimiterMode}`,
      `generated_at,${new Date().toISOString()}`,
    ].join('\n');
    files.unshift({ name: 'README.txt', content: readme });
    const zipBlob = PeakFitCore.createZipFromTextFiles(files);
    downloadBlob(zipBlob, 'background_subtracted.zip', 'application/zip');
    const previewPoints = PeakFitCore.selectRange(currentDataset().data, state.selection.xMin, state.selection.xMax);
    const preview = PeakFitCore.estimateLinearBackground(previewPoints, edgeFraction);
    state.currentFit = {
      ...(state.currentFit && state.currentFit.fileName === currentDataset().name ? state.currentFit : {}),
      fileName: currentDataset().name,
      background: { slope: preview.slope, intercept: preview.intercept },
      x: previewPoints.map((p) => p.x),
      yRaw: previewPoints.map((p) => p.y),
      yBackground: preview.bgY,
      yCorrected: preview.correctedY,
    };
    renderFitInfo(state.currentFit);
    renderTrialStatus();
    draw();
    toast(`${state.datasets.length}件の背景差し引き結果をZIPで出力しました。`);
  } catch (err) {
    toast(err.message || '背景差し引きZIPの作成に失敗しました。', true);
  }
}

function exportCsv() {
  if (!state.batchResults.length) return toast('先にフィット結果を作成してください。', true);
  const csv = PeakFitCore.resultsToCSV(state.batchResults);
  downloadBlob(csv, 'peakfit_results.csv', 'text/csv;charset=utf-8');
}

function clearAll() {
  state.datasets = [];
  state.activeIndex = 0;
  state.selection = null;
  state.currentFit = null;
  state.batchResults = [];
  state.trialFit = null;
  els.fileInput.value = '';
  refreshDatasetSelect();
  renderFitInfo(null);
  renderTrialStatus();
  renderResultsTable();
  draw();
}

function renderFitInfo(result) {
  if (!result) {
    els.fitInfo.innerHTML = '<div class="muted">まだフィットしていません。</div>';
    return;
  }
  const bg = result.background || { slope: NaN, intercept: NaN };
  if (!Array.isArray(result.peaks) || !Array.isArray(result.peakMetrics)) {
    els.fitInfo.innerHTML = `
      <div><strong>${escapeHtml(result.fileName)}</strong></div>
      <div>モード: 背景差し引きのみ</div>
      <div>点数: ${result.x?.length ?? 0}</div>
      <div>背景傾き: ${formatNumber(bg.slope)}</div>
      <div>背景切片: ${formatNumber(bg.intercept)}</div>
    `;
    return;
  }
  const peaksHtml = result.peaks.map((peak, index) => {
    const metrics = result.peakMetrics[index];
    const constraints = result.parameterConstraints?.perPeak?.[index] || {};
    const constraintLabel = (key) => {
      const spec = constraints[key];
      if (!spec) return '';
      if (spec.fixed && spec.sharedGroup) return `固定 / 共有:${escapeHtml(spec.sharedGroup)}`;
      if (spec.fixed) return '固定';
      if (spec.sharedGroup) return `共有:${escapeHtml(spec.sharedGroup)}`;
      return '';
    };
    return `
      <div class="peak-result">
        <div><strong>Peak ${index + 1}</strong></div>
        <div>中心: ${formatNumber(peak.center)}${constraintLabel('center') ? ` <span class="constraint-pill">${constraintLabel('center')}</span>` : ''}</div>
        <div>${result.model === 'voigt' ? '面積 A' : '振幅'}: ${formatNumber(peak.amplitude)}${constraintLabel('amplitude') ? ` <span class="constraint-pill">${constraintLabel('amplitude')}</span>` : ''}</div>
        ${peak.sigma != null ? `<div>${result.model === 'voigt' ? 'wG' : 'σ'}: ${formatNumber(peak.sigma)}${constraintLabel('sigma') ? ` <span class="constraint-pill">${constraintLabel('sigma')}</span>` : ''}</div>` : ''}
        ${peak.gamma != null ? `<div>${result.model === 'bwf' ? 'w' : (result.model === 'voigt' ? 'wL' : 'γ')}: ${formatNumber(peak.gamma)}${constraintLabel('gamma') ? ` <span class="constraint-pill">${constraintLabel('gamma')}</span>` : ''}</div>` : ''}
        ${peak.q != null ? `<div>q: ${formatNumber(peak.q)}${constraintLabel('q') ? ` <span class="constraint-pill">${constraintLabel('q')}</span>` : ''}</div>` : ''}
        <div>FWHM: ${formatNumber(metrics.fwhm)}</div>
        <div>面積: ${formatNumber(metrics.area)}</div>
      </div>`;
  }).join('');
  els.fitInfo.innerHTML = `
    <div><strong>${escapeHtml(result.fileName)}</strong></div>
    <div>モデル: ${escapeHtml(labelForModel(result.model))}</div>
    <div>ピーク数: ${result.peakCount}</div>
    <div class="peak-results">${peaksHtml}</div>
    <div>合計FWHM: ${formatNumber(result.metrics.fwhm)}</div>
    <div>合計面積: ${formatNumber(result.metrics.area)}</div>
    <div>RMSE: ${formatNumber(result.metrics.rmse)}</div>
    <div>R²: ${formatNumber(result.metrics.r2)}</div>
    <div>背景傾き: ${formatNumber(bg.slope)}</div>
    <div>背景切片: ${formatNumber(bg.intercept)}</div>
  `;
}

function upsertBatchResult(result) {
  const idx = state.batchResults.findIndex((r) => r.fileName === result.fileName);
  if (idx >= 0) state.batchResults[idx] = result;
  else state.batchResults.push(result);
}

function renderResultsTable() {
  const rows = state.batchResults;
  els.resultsBody.innerHTML = '';
  if (!rows.length) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td colspan="9" class="muted">結果はまだありません。</td>';
    els.resultsBody.appendChild(tr);
    return;
  }
  rows.forEach((row) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(row.fileName)}</td>
      <td>${escapeHtml(labelForModel(row.model))}</td>
      <td>${row.peakCount}</td>
      <td>${formatNumber(row.peaks[0]?.center)}</td>
      <td>${formatNumber(row.metrics.fwhm)}</td>
      <td>${formatNumber(row.metrics.area)}</td>
      <td>${formatNumber(row.metrics.rmse)}</td>
      <td>${formatNumber(row.metrics.r2)}</td>
      <td>${formatNumber(row.background.slope)}</td>`;
    tr.addEventListener('click', () => {
      const idx = state.datasets.findIndex((ds) => ds.name === row.fileName);
      if (idx >= 0) {
        state.activeIndex = idx;
        els.datasetSelect.value = String(idx);
      }
      state.currentFit = row;
      renderFitInfo(row);
      draw();
    });
    els.resultsBody.appendChild(tr);
  });
}

function draw() {
  const ctx = els.ctx;
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, els.canvas.width / dpr, els.canvas.height / dpr);
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, els.canvas.width / dpr, els.canvas.height / dpr);
  const ds = currentDataset();
  if (!ds) {
    ctx.fillStyle = '#cbd5e1';
    ctx.font = '16px system-ui, sans-serif';
    ctx.fillText('TXTファイルを読み込むとここにグラフが表示されます。', 24, 40);
    ctx.restore();
    els.selectionText.textContent = '未選択';
    return;
  }
  const plot = getPlotRect();
  const bounds = dataBounds(ds.data, state.currentFit);
  drawAxes(ctx, plot, bounds);
  drawSeries(ctx, plot, bounds, ds.data.map((p) => p.x), ds.data.map((p) => p.y), '#60a5fa', 1.2);
  if (state.selection) {
    drawSelection(ctx, plot, bounds, state.selection, 'rgba(251, 191, 36, 0.16)', '#fbbf24');
    els.selectionText.textContent = `${formatNumber(state.selection.xMin)} – ${formatNumber(state.selection.xMax)}`;
  } else {
    els.selectionText.textContent = '未選択';
  }
  if (state.drag) {
    const x1 = Math.min(state.drag.startPx, state.drag.currentPx);
    const x2 = Math.max(state.drag.startPx, state.drag.currentPx);
    ctx.fillStyle = 'rgba(56, 189, 248, 0.16)';
    ctx.fillRect(x1, plot.top, x2 - x1, plot.bottom - plot.top);
  }
  if (state.currentFit && state.currentFit.fileName === ds.name) {
    if (state.currentFit.yBackground?.length) drawSeries(ctx, plot, bounds, state.currentFit.x, state.currentFit.yBackground, '#94a3b8', 1);
    if (state.currentFit.yCorrected?.length) drawSeries(ctx, plot, bounds, state.currentFit.x, state.currentFit.yCorrected, '#34d399', 1.4);
    const componentColors = ['#fb7185', '#f59e0b', '#34d399', '#a78bfa', '#f472b6', '#22d3ee'];
    (state.currentFit.yComponentsAbs || []).forEach((series, index) => drawSeries(ctx, plot, bounds, state.currentFit.x, series, componentColors[index % componentColors.length], 1.2));
    if (state.currentFit.yFitAbs?.length) drawSeries(ctx, plot, bounds, state.currentFit.x, state.currentFit.yFitAbs, '#f43f5e', 2.4);
  }
  ctx.restore();
}

function drawAxes(ctx, plot, bounds) {
  ctx.strokeStyle = '#334155';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(plot.left, plot.bottom);
  ctx.lineTo(plot.right, plot.bottom);
  ctx.lineTo(plot.right, plot.top);
  ctx.stroke();
  ctx.fillStyle = '#cbd5e1';
  ctx.font = '12px system-ui, sans-serif';
  const ticks = 6;
  for (let i = 0; i <= ticks; i++) {
    const tx = plot.left + (plot.width * i) / ticks;
    const xVal = bounds.xMin + ((bounds.xMax - bounds.xMin) * i) / ticks;
    ctx.strokeStyle = '#1e293b';
    ctx.beginPath();
    ctx.moveTo(tx, plot.top);
    ctx.lineTo(tx, plot.bottom);
    ctx.stroke();
    ctx.fillText(formatNumber(xVal), tx - 14, plot.bottom + 18);
  }
  for (let i = 0; i <= ticks; i++) {
    const ty = plot.bottom - (plot.height * i) / ticks;
    const yVal = bounds.yMin + ((bounds.yMax - bounds.yMin) * i) / ticks;
    ctx.strokeStyle = '#1e293b';
    ctx.beginPath();
    ctx.moveTo(plot.left, ty);
    ctx.lineTo(plot.right, ty);
    ctx.stroke();
    ctx.fillText(formatNumber(yVal), 8, ty + 4);
  }
}

function drawSeries(ctx, plot, bounds, xs, ys, color, width) {
  if (!xs.length) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  xs.forEach((x, i) => {
    const px = xToPx(x, bounds, plot);
    const py = yToPx(ys[i], bounds, plot);
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  });
  ctx.stroke();
}

function drawSelection(ctx, plot, bounds, selection, fill, stroke) {
  const x1 = xToPx(Math.min(selection.xMin, selection.xMax), bounds, plot);
  const x2 = xToPx(Math.max(selection.xMin, selection.xMax), bounds, plot);
  ctx.fillStyle = fill;
  ctx.fillRect(x1, plot.top, x2 - x1, plot.height);
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1.2;
  ctx.strokeRect(x1, plot.top, x2 - x1, plot.height);
}

function dataBounds(data, fit = null) {
  const xs = data.map((p) => p.x);
  const ys = data.map((p) => p.y);
  let yMin = Math.min(...ys);
  let yMax = Math.max(...ys);
  if (fit) {
    const extra = [
      ...(fit.yFitAbs || []),
      ...(fit.yBackground || []),
      ...(fit.yCorrected || []),
      ...((fit.yComponentsAbs || []).flat()),
    ];
    if (extra.length) {
      yMin = Math.min(yMin, ...extra);
      yMax = Math.max(yMax, ...extra);
    }
  }
  const pad = Math.max((yMax - yMin) * 0.08, 1);
  return { xMin: Math.min(...xs), xMax: Math.max(...xs), yMin: yMin - pad, yMax: yMax + pad };
}

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const rect = els.canvas.getBoundingClientRect();
  els.canvas.width = Math.round(rect.width * dpr);
  els.canvas.height = Math.round(rect.height * dpr);
}

function getPlotRect() {
  const w = els.canvas.clientWidth;
  const h = els.canvas.clientHeight;
  return { left: 56, right: w - 18, top: 18, bottom: h - 34, width: w - 74, height: h - 52 };
}
function xToPx(x, bounds, plot) { return plot.left + ((x - bounds.xMin) / (bounds.xMax - bounds.xMin || 1)) * plot.width; }
function pxToX(px, bounds, plot) { return bounds.xMin + ((px - plot.left) / (plot.width || 1)) * (bounds.xMax - bounds.xMin); }
function yToPx(y, bounds, plot) { return plot.bottom - ((y - bounds.yMin) / (bounds.yMax - bounds.yMin || 1)) * plot.height; }
function labelForModel(model) { return { gaussian: 'Gaussian', lorentzian: 'Lorentzian', voigt: 'Voigt', bwf: 'BWF' }[model] || model; }
function formatNumber(v) {
  if (!Number.isFinite(Number(v))) return '—';
  const n = Number(v);
  if (Math.abs(n) >= 1000 || (Math.abs(n) > 0 && Math.abs(n) < 1e-3)) return n.toExponential(3);
  return n.toFixed(4).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}
function escapeHtml(str) {
  return String(str).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }
function downloadBlob(content, filename, type) {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
function toast(message, isError = false) {
  els.toast.textContent = message;
  els.toast.classList.toggle('error', isError);
  els.toast.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => els.toast.classList.remove('show'), 2600);
}
function registerServiceWorker() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
}


function normalizeBackgroundZipExtension(value) {
  const normalized = String(value || '').toLowerCase();
  return ['csv', 'txt', 'dat'].includes(normalized) ? normalized : 'csv';
}

function normalizeBackgroundZipColumnMode(value) {
  return value === 'x_y_corrected' ? 'x_y_corrected' : 'full';
}

function normalizeBackgroundZipDelimiter(value, extension = 'csv') {
  if (normalizeBackgroundZipExtension(extension) === 'csv') return 'comma';
  return ['comma', 'tab', 'space'].includes(value) ? value : 'comma';
}

function buildBackgroundOutputName(fileName, extension = 'csv') {
  const normalizedExtension = normalizeBackgroundZipExtension(extension);
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0) return `${fileName}_bgsub.${normalizedExtension}`;
  return `${fileName.slice(0, dot)}_bgsub.${normalizedExtension}`;
}

function syncBackgroundDelimiterAvailability() {
  if (!els.bgZipDelimiter || !els.bgZipExtension) return;
  const isCsv = normalizeBackgroundZipExtension(els.bgZipExtension.value) === 'csv';
  els.bgZipDelimiter.disabled = isCsv;
  if (isCsv) els.bgZipDelimiter.value = 'comma';
}
