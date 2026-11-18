import type { DebugOverlayMode, MediumId, PresetId } from './core/types';
import { ThreeViewAdapter } from './view/ThreeViewAdapter';
import type { SandboxUiState } from './viewmodel/SandboxUiState';
import { SandboxViewModel } from './viewmodel/SandboxViewModel';

const container = document.getElementById('canvas-container') as HTMLElement;
const viewModel = new SandboxViewModel();
const viewAdapter = new ThreeViewAdapter(container, viewModel);

// HUD要素
const elScale = document.getElementById('m-scale')!;
const elDomains = document.getElementById('m-domains')!;
const elPackets = document.getElementById('m-packets')!;
const elSleep = document.getElementById('m-sleep')!;
const elDt = document.getElementById('m-dt')!;
const elDischarge = document.getElementById('m-discharge')!;
const elEnergy = document.getElementById('m-energy')!;
const elSelected = document.getElementById('m-selected')!;
const lblScaleVal = document.getElementById('lbl-scale-val')!;

const btnToggle = document.getElementById('btn-toggle') as HTMLButtonElement;
const btnReset = document.getElementById('btn-reset') as HTMLButtonElement;
const selPreset = document.getElementById('sel-preset') as HTMLSelectElement;
const selMedium = document.getElementById('sel-medium') as HTMLSelectElement;
const selOverlay = document.getElementById('sel-overlay') as HTMLSelectElement;
const rngScale = document.getElementById('rng-scale') as HTMLInputElement;

// 相似性インスペクター & スポナー要素
const simRegime = document.getElementById('sim-regime')!;
const simDom = document.getElementById('sim-dom')!;
const simMicro = document.getElementById('sim-micro')!;
const simMacro = document.getElementById('sim-macro')!;
const simEq = document.getElementById('sim-eq')!;

const spMat = document.getElementById('sp-mat') as HTMLSelectElement;
const spCharge = document.getElementById('sp-charge') as HTMLInputElement;
const spRadius = document.getElementById('sp-radius') as HTMLInputElement;
const spGrav = document.getElementById('sp-grav') as HTMLInputElement;
const btnSpawn = document.getElementById('btn-spawn') as HTMLButtonElement;

function updateHud(state: SandboxUiState): void {
  elScale.textContent = state.perceptualScaleLog10.toFixed(2);
  elDomains.textContent = `${state.domainCounts.visible} / ${state.domainCounts.projected} / ${state.domainCounts.absorbed}`;
  elPackets.textContent = `${state.activePacketCount} / ${viewModel.core.grid.count}`;
  elSleep.textContent = `${(state.sleepingPacketRatio * 100).toFixed(1)}%`;
  elDt.textContent = `${state.dtEffective.toFixed(4)}s`;
  elDischarge.textContent = `${state.activeDischargeCount}`;
  elEnergy.textContent = state.totalEnergy.toFixed(3);
  btnToggle.textContent = state.isRunning ? '一時停止' : '再開';
  lblScaleVal.textContent =
    state.manualScaleLog10 !== null ? `${state.manualScaleLog10.toFixed(2)}` : '自動/固定';

  simRegime.textContent = state.similarity.scaleRegimeLabel;
  simDom.textContent = state.similarity.dominantPhenomenon;
  simMicro.textContent = state.similarity.microAnalogy;
  simMacro.textContent = state.similarity.macroAnalogy;
  simEq.textContent = state.similarity.sharedEquation;

  if (state.selectedEntityMetrics) {
    const m = state.selectedEntityMetrics;
    elSelected.textContent = `${m.name} (q=${m.charge.toFixed(2)}, v=${m.velocityMag.toFixed(2)}${m.isSleeping ? ' 静止' : ''})`;
  } else {
    elSelected.textContent = 'なし';
  }
}

viewModel.subscribe((state) => {
  updateHud(state);
  viewAdapter.render(state);
});

btnToggle.addEventListener('click', () => viewModel.togglePlay());
btnReset.addEventListener('click', () => viewModel.reset());
selPreset.addEventListener('change', () => {
  viewModel.loadPreset(selPreset.value as PresetId);
});
selMedium.addEventListener('change', () => {
  viewModel.setMedium(selMedium.value as MediumId);
});
selOverlay.addEventListener('change', () => {
  viewModel.setDebugOverlayMode(selOverlay.value as DebugOverlayMode);
});
rngScale.addEventListener('input', () => {
  viewModel.setManualScaleLog10(parseFloat(rngScale.value));
});
btnSpawn.addEventListener('click', () => {
  viewModel.spawnCustomEntity({
    materialId: spMat.value,
    charge: parseFloat(spCharge.value) || 0,
    radius: parseFloat(spRadius.value) || 0.2,
    gravityStrength: parseFloat(spGrav.value) || 0,
  });
});

// メインループ
let lastTime = performance.now();
function animate(now: number): void {
  const rawDt = Math.min((now - lastTime) / 1000, 0.05);
  lastTime = now;
  viewModel.step(rawDt);
  requestAnimationFrame(animate);
}
requestAnimationFrame(animate);
