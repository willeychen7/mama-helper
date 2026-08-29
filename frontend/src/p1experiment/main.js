/**
 * P1-C 实验入口（决定 12）。
 *
 * 故意跟主应用（src/App.jsx）完全分开：不 import App.jsx，不共享任何
 * React 状态，只复用已经写好、已经在 Node 里测过编排逻辑的
 * utils/suspiciousGlue.js 和 utils/secondPassOcr.js，再加上一份最小化
 * 重写的 PaddleOCR 引擎初始化（跟 App.jsx 的 getOCREngine 配置一致，
 * 但不从 App.jsx import——那个文件是个 React 组件，不适合在这种独立
 * 页面里引入）。
 *
 * 目的只有一个：回答"二次 OCR 能不能把 JENNIFERWASHINGTON 这类粘连词
 * 拆开"，这个问题沙箱环境回答不了，必须在能连外网的真实浏览器里跑。
 */
import { PaddleOCR } from '@paddleocr/paddleocr-js';
import { enhanceDocumentImage } from '../utils/imagePrep.js';
import { scanDocumentForSuspiciousGlue } from '../utils/suspiciousGlue.js';
import {
  cropCanvas,
  buildPreprocessVariants,
  runSecondPassOnLine
} from '../utils/secondPassOcr.js';

const $ = (id) => document.getElementById(id);
const engineLogEl = $('engineLog');
const timingLogEl = $('timingLog');
const firstPassSummaryEl = $('firstPassSummary');
const suspiciousListEl = $('suspiciousList');
const btnDownload = $('btnDownload');

let ocrEngine = null;
let engineInfo = null;
let currentDisplayCanvas = null; // 跟 OCR 坐标系一致的那张彩色图，二次 OCR 裁切用它
let currentLines = [];
let currentDocumentName = '';
const allSecondPassResults = [];

function log(el, text) {
  el.textContent = (el.textContent === '（还没初始化）' || el.textContent === '' ? '' : el.textContent + '\n') + text;
}

function getPolygonBounds(poly) {
  if (!Array.isArray(poly) || poly.length === 0) return null;
  const points = poly
    .map((p) => (Array.isArray(p) ? { x: Number(p[0]), y: Number(p[1]) } : null))
    .filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y));
  if (!points.length) return null;
  const left = Math.min(...points.map((p) => p.x));
  const right = Math.max(...points.map((p) => p.x));
  const top = Math.min(...points.map((p) => p.y));
  const bottom = Math.max(...points.map((p) => p.y));
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

// ============================================================
// 1 · 引擎初始化 —— 跟 App.jsx 的 getOCREngine 用同一组配置尝试顺序，
//     这样这个实验的"第一次 OCR"结果才跟主应用真实用户看到的一致。
// ============================================================
$('btnInitEngine').addEventListener('click', async () => {
  $('btnInitEngine').disabled = true;
  log(engineLogEl, '开始初始化...（如果卡在这里超过一两分钟，多半是网络连不到模型托管服务）');

  const buildConfig = (ocrVersion) => ({
    lang: 'en',
    ocrVersion,
    ortOptions: { backend: 'auto', numThreads: 2, simd: true }
  });

  const attempts = [
    { version: 'PP-OCRv6', worker: true },
    { version: 'PP-OCRv6', worker: false },
    { version: 'PP-OCRv5', worker: true },
    { version: 'PP-OCRv5', worker: false }
  ];

  const t0 = performance.now();
  for (const attempt of attempts) {
    try {
      log(engineLogEl, `尝试 ${attempt.version} / worker=${attempt.worker} ...`);
      ocrEngine = await PaddleOCR.create({ ...buildConfig(attempt.version), worker: attempt.worker });
      engineInfo = { version: attempt.version, worker: attempt.worker, initMs: Math.round(performance.now() - t0) };
      break;
    } catch (err) {
      log(engineLogEl, `  失败：${err.message}`);
    }
  }

  if (!ocrEngine) {
    log(engineLogEl, '❌ 全部尝试失败，引擎没有初始化成功。');
    $('btnInitEngine').disabled = false;
    return;
  }

  log(
    engineLogEl,
    `✅ 引擎就绪：${engineInfo.version}${engineInfo.worker ? ' (worker)' : ' (主线程)'}，` +
      `耗时 ${engineInfo.initMs}ms —— 这个耗时本身就是"这是真引擎不是 mock"的证据，` +
      `mock 不会有这种下模型/编译 WASM 的真实延迟。也可以打开浏览器开发者工具的 Network 面板，` +
      `确认确实有到 paddle-model-ecology.bj.bcebos.com 的请求。`
  );
  $('btnInitEngine').disabled = false;
  $('fileInput').disabled = false;
});

// ============================================================
// 2 · 第一次 OCR（整页），复用跟主应用一致的预处理 + predict 参数
// ============================================================
$('fileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file || !ocrEngine) {
    if (!ocrEngine) alert('请先点上面的"初始化引擎"按钮');
    return;
  }

  currentDocumentName = file.name;
  timingLogEl.textContent = '';
  firstPassSummaryEl.textContent = '正在预处理图片（透视矫正/去斜/去阴影）...';

  const prepared = await enhanceDocumentImage(file, { maxDimension: 2200 });

  // displayBlob 跟 ocrBlob 几何坐标一致（imagePrep.js 自己的注释也是这么保证的），
  // 用 displayBlob 画出彩色 canvas，供第二步裁切用。
  const displayBitmap = await createImageBitmap(prepared.displayBlob);
  const canvas = document.createElement('canvas');
  canvas.width = displayBitmap.width;
  canvas.height = displayBitmap.height;
  canvas.getContext('2d').drawImage(displayBitmap, 0, 0);
  currentDisplayCanvas = canvas;

  const t0 = performance.now();
  const results = await ocrEngine.predict(prepared.ocrBlob, {
    textDetLimitSideLen: 2200,
    textDetLimitType: 'max',
    textDetThresh: 0.28,
    textDetBoxThresh: 0.5,
    textDetUnclipRatio: 2.2,
    textRecScoreThresh: 0.2
  });
  const elapsedMs = Math.round(performance.now() - t0);
  log(timingLogEl, `第一次 OCR（整页）耗时 ${elapsedMs}ms —— 真实 OCR 通常是几百毫秒到几秒，瞬间返回就该怀疑是不是真的在跑。`);

  const result = results?.[0];
  const items = Array.isArray(result?.items) ? result.items : [];

  currentLines = items.map((item, index) => {
    const bbox = getPolygonBounds(item.poly) || { left: 0, top: 0, right: 0, bottom: 0 };
    return {
      index,
      text: (item.text || '').trim(),
      confidence: typeof item.score === 'number' ? item.score * 100 : null,
      ...bbox
    };
  }).filter((l) => l.text);

  firstPassSummaryEl.innerHTML = `
    <p>第一次 OCR 识别到 <b>${currentLines.length}</b> 行。</p>
    <details>
      <summary>查看全部 ${currentLines.length} 行原始识别结果（调试用，判断 suspicious=0 是因为这次真没粘连，还是判定逻辑有问题）</summary>
      <table>
        <thead><tr><th>#</th><th>text</th><th>confidence</th></tr></thead>
        <tbody>
          ${currentLines.map((l) => `<tr><td>${l.index}</td><td>${escapeHtml(l.text)}</td><td>${l.confidence != null ? l.confidence.toFixed(1) : '-'}</td></tr>`).join('')}
        </tbody>
      </table>
    </details>
  `;

  // 也挂到 window 上，方便直接在 DevTools 控制台里查（比如
  // window.__p1.currentLines.filter(l => l.text.includes('WASHINGTON'))）。
  window.__p1 = { currentLines, engineInfo };

  renderSuspiciousList();
});

// ============================================================
// 3 · 可疑粘连行列表 + 逐行二次 OCR
// ============================================================
function renderSuspiciousList() {
  const scan = scanDocumentForSuspiciousGlue(currentLines);

  if (!scan.suspiciousResults.length) {
    suspiciousListEl.innerHTML = `<p>这张图没有被 suspiciousGlue 标出可疑行（total ${scan.totalLines}，suspicious 0）。</p>`;
    return;
  }

  const rows = scan.suspiciousResults
    .map(
      (r) => `
    <tr class="suspicious-row" data-line-index="${r.index}">
      <td>${r.index}</td>
      <td>${escapeHtml(r.text)}</td>
      <td>${r.score}</td>
      <td>${r.reasons.join('；')}</td>
      <td><button class="btn-retry" data-line-index="${r.index}">跑二次 OCR</button></td>
    </tr>
    <tr class="result-row" id="result-${r.index}"><td colspan="5"></td></tr>
  `
    )
    .join('');

  suspiciousListEl.innerHTML = `
    <p>total lines: ${scan.totalLines}，suspicious: ${scan.suspiciousLines}（${(scan.suspiciousRate * 100).toFixed(1)}%）</p>
    <table>
      <thead><tr><th>#</th><th>原始识别文字</th><th>score</th><th>原因</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  suspiciousListEl.querySelectorAll('.btn-retry').forEach((btn) => {
    btn.addEventListener('click', () => runRetryForLine(Number(btn.dataset.lineIndex)));
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function cropAndPreprocessReal(bbox) {
  const { canvas: cropped } = cropCanvas(currentDisplayCanvas, bbox);
  const variants = buildPreprocessVariants(cropped);
  return Promise.all(
    variants.map(
      (v) =>
        new Promise((resolve) => {
          v.canvas.toBlob((blob) => resolve({ variantId: v.variantId, blob }), 'image/png');
        })
    )
  );
}

async function runRetryForLine(lineIndex) {
  const line = currentLines.find((l) => l.index === lineIndex);
  const scan = scanDocumentForSuspiciousGlue(currentLines);
  const trigger = scan.results.find((r) => r.index === lineIndex);

  const resultCell = document.querySelector(`#result-${lineIndex} td`);
  resultCell.textContent = '跑二次 OCR 中...';

  // 真实引擎适配：ocr.predict() 返回一个数组，取 [0]；
  // secondPassOcr.js 的编排逻辑只认 {items:[...]} 这个形状。
  const engineAdapter = {
    async predict(blob, opts) {
      const r = await ocrEngine.predict(blob, opts);
      return r?.[0] || { items: [] };
    }
  };

  const t0 = performance.now();
  const record = await runSecondPassOnLine({
    documentName: currentDocumentName,
    line,
    trigger,
    cropAndPreprocess: cropAndPreprocessReal,
    engine: engineAdapter,
    engineMode: 'REAL'
  });
  const elapsedMs = Math.round(performance.now() - t0);
  log(timingLogEl, `第二次 OCR（行 #${lineIndex}，4 个 variant）耗时 ${elapsedMs}ms`);

  allSecondPassResults.push(record);
  btnDownload.disabled = false;

  resultCell.innerHTML = `
    <table>
      <thead><tr><th>variant</th><th>retry 文字</th><th>confidence</th><th>change_type</th><th>reasons</th></tr></thead>
      <tbody>
        ${record.retries
          .map(
            (r) => `<tr>
              <td>${r.variantId}</td>
              <td>${escapeHtml(r.text)}</td>
              <td>${r.confidence != null ? r.confidence.toFixed(1) : '-'}</td>
              <td>${r.comparison.change_type}</td>
              <td>${r.comparison.reasons.join('；')}</td>
            </tr>`
          )
          .join('')}
      </tbody>
    </table>
  `;
}

// ============================================================
// 4 · 导出
// ============================================================
btnDownload.addEventListener('click', () => {
  const payload = {
    mode: 'REAL',
    note: '本文件由 p1-experiment.html 在真实浏览器、真实 PaddleOCR 引擎上生成，不是 mock。',
    engineInfo,
    generatedAt: new Date().toISOString(),
    results: allSecondPassResults
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `p1c-real-results-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
});
