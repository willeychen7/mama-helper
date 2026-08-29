/**
 * fixture-regen 工具：用当前真实 PaddleOCR + 当前真实预处理，重新跑一遍
 * 全部 demo 样本，输出一份新的 fixture，同时现场对比新旧结果——不是先改
 * 代码再验证，是先看真实基线长什么样，再决定 P1 要不要投入。
 *
 * 复用（不重写）：
 *   utils/imagePrep.js       enhanceDocumentImage —— 跟主应用一致的预处理
 *   utils/fieldExtractor.js  extractLetterFields —— 跟主应用一致的抽取逻辑
 *   utils/suspiciousGlue.js  scanDocumentForSuspiciousGlue
 *   utils/ground_truth.json  人工标注的真值，算金额/日期 recall 用
 *   fixtureRegen/readingOrder.js  从 App.jsx 搬来的行排序逻辑（详见该文件注释）
 */
import { PaddleOCR } from '@paddleocr/paddleocr-js';
import { enhanceDocumentImage } from '../utils/imagePrep.js';
import { extractLetterFields } from '../utils/fieldExtractor.js';
import { scanDocumentForSuspiciousGlue } from '../utils/suspiciousGlue.js';
import { buildSpatialReadingOrder } from './readingOrder.js';
import groundTruth from '../utils/ground_truth.json';
import oldFixture from '../utils/demo_ocr_pp.json';

const $ = (id) => document.getElementById(id);
const engineLogEl = $('engineLog');
const logEl = $('log');
const resultsSummaryEl = $('resultsSummary');
const resultsTableEl = $('resultsTable');
const btnDownload = $('btnDownload');

let ocrEngine = null;
let engineInfo = null;
const newFixture = {};
const perDocResults = [];

function log(el, text) {
  el.textContent += (el.textContent ? '\n' : '') + text;
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

/*
 * 已知的旧粘连字符串——用来在新 fixture 上检查"这次还粘不粘"。
 * 只覆盖有 PNG/webp/avif 可以直接跑的样本，IRS_cp503（只有 PDF）不在这里，
 * 需要用户自己转成图片、用文档名 "IRS_cp503" 单独上传再检查。
 */
const KNOWN_GLUE_STRINGS = {
  Medicare_Notice: ['JENNIFERWASHINGTON'],
  SoCalGas: ['JOHNBDOE'],
  Hospital_Bill: ['iJANEDOE', 'JANEDOE:']
};

$('btnInitEngine').addEventListener('click', async () => {
  $('btnInitEngine').disabled = true;
  log(engineLogEl, '开始初始化...');

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
      ocrEngine = await PaddleOCR.create({ ...buildConfig(attempt.version), worker: attempt.worker });
      engineInfo = { version: attempt.version, worker: attempt.worker, initMs: Math.round(performance.now() - t0) };
      break;
    } catch (err) {
      log(engineLogEl, `${attempt.version}/worker=${attempt.worker} 失败：${err.message}`);
    }
  }

  if (!ocrEngine) {
    log(engineLogEl, '❌ 引擎初始化失败');
    $('btnInitEngine').disabled = false;
    return;
  }

  log(engineLogEl, `✅ ${engineInfo.version}${engineInfo.worker ? ' (worker)' : ' (主线程)'}，耗时 ${engineInfo.initMs}ms`);
  $('fileInput').disabled = false;
  $('btnRun').disabled = false;
});

$('btnRun').addEventListener('click', async () => {
  const files = Array.from($('fileInput').files || []);
  if (!files.length) {
    alert('先选文件');
    return;
  }

  $('btnRun').disabled = true;
  logEl.textContent = '';
  resultsSummaryEl.textContent = '';
  resultsTableEl.textContent = '';

  for (const file of files) {
    const docName = file.name.replace(/\.[^.]+$/, '');
    log(logEl, `处理 ${docName} ...`);

    try {
      const prepared = await enhanceDocumentImage(file, { maxDimension: 2200 });

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

      const result = results?.[0];
      const items = Array.isArray(result?.items) ? result.items : [];

      const rawLines = items
        .map((item, index) => {
          const bbox = getPolygonBounds(item.poly);
          if (!bbox) return null;
          const text = (item.text || '').trim();
          if (!text) return null;
          return {
            id: index,
            text,
            confidence: typeof item.score === 'number' ? item.score * 100 : null,
            ...bbox
          };
        })
        .filter(Boolean);

      const orderedLines = buildSpatialReadingOrder(rawLines);

      newFixture[docName] = {
        lines: orderedLines,
        width: prepared.width,
        height: prepared.height
      };

      // --- 现场对比：金额/日期/类别（跟 ground_truth 比）---
      const truth = groundTruth[docName];
      let fieldCompare = null;
      if (truth) {
        const extraction = extractLetterFields(orderedLines, {
          imageWidth: prepared.width,
          imageHeight: prepared.height,
          today: new Date((truth.today || '2026-08-25') + 'T00:00:00Z')
        });
        const amtGot = extraction.fields.amount.trusted ? extraction.fields.amount.value : null;
        const amtOk =
          (amtGot == null && truth.amount_shown == null) ||
          (amtGot != null && truth.amount_shown != null && Math.abs(amtGot - truth.amount_shown) <= 0.005);
        const dateGot = extraction.fields.dueDate.trusted ? extraction.fields.dueDate.value : null;
        const dateOk = dateGot === truth.due_date;
        fieldCompare = { amtGot, amtWant: truth.amount_shown, amtOk, dateGot, dateWant: truth.due_date, dateOk };
      }

      // --- 现场对比：suspiciousGlue ---
      const glueScan = scanDocumentForSuspiciousGlue(orderedLines, { pageHeight: prepared.height });

      // --- 现场对比：已知粘连字符串这次还在不在 ---
      const knownStrings = KNOWN_GLUE_STRINGS[docName] || [];
      const glueStatus = knownStrings.map((s) => {
        const stillGlued = orderedLines.some((l) => l.text === s);
        return { string: s, stillGlued };
      });

      const avgConfidence = orderedLines.length
        ? orderedLines.reduce((sum, l) => sum + (l.confidence || 0), 0) / orderedLines.length
        : null;

      perDocResults.push({
        docName,
        lineCount: orderedLines.length,
        elapsedMs,
        avgConfidence,
        fieldCompare,
        glueScan: { total: glueScan.totalLines, suspicious: glueScan.suspiciousLines, rate: glueScan.suspiciousRate },
        glueStatus,
        oldLineCount: oldFixture[docName] ? oldFixture[docName].lines.length : null
      });

      log(logEl, `  ✅ ${docName}：${orderedLines.length} 行，耗时 ${elapsedMs}ms`);
    } catch (err) {
      log(logEl, `  ❌ ${docName} 失败：${err.message}`);
    }
  }

  renderResults();
  btnDownload.disabled = false;
  $('btnRun').disabled = false;
});

function renderResults() {
  const withTruth = perDocResults.filter((r) => r.fieldCompare);
  const amtOkCount = withTruth.filter((r) => r.fieldCompare.amtOk).length;
  const dateOkCount = withTruth.filter((r) => r.fieldCompare.dateOk).length;
  const glueChecks = perDocResults.flatMap((r) => r.glueStatus.map((g) => ({ doc: r.docName, ...g })));
  const stillGluedCount = glueChecks.filter((g) => g.stillGlued).length;

  resultsSummaryEl.innerHTML = `
    <p>处理了 <b>${perDocResults.length}</b> 份文档。</p>
    <p>跟 ground_truth 比对（${withTruth.length} 份有真值）：
       金额 <b>${amtOkCount}/${withTruth.length}</b>，
       到期日 <b>${dateOkCount}/${withTruth.length}</b></p>
    <p>已知粘连字符串复查（${glueChecks.length} 条）：
       这次仍然粘连 <b class="${stillGluedCount ? 'bad' : 'ok'}">${stillGluedCount}/${glueChecks.length}</b></p>
  `;

  resultsTableEl.innerHTML = `
    <table>
      <thead><tr>
        <th>文档</th><th>行数（新/旧）</th><th>耗时</th><th>平均confidence</th>
        <th>金额</th><th>到期日</th><th>suspicious</th><th>已知粘连字符串</th>
      </tr></thead>
      <tbody>
        ${perDocResults
          .map((r) => {
            const fc = r.fieldCompare;
            const glueStr = r.glueStatus.length
              ? r.glueStatus.map((g) => `${g.string}: ${g.stillGlued ? '<span class="bad">仍粘连</span>' : '<span class="ok">已拆开/未出现</span>'}`).join('<br>')
              : '-';
            return `<tr>
              <td>${r.docName}</td>
              <td>${r.lineCount} / ${r.oldLineCount ?? '-'}</td>
              <td>${r.elapsedMs}ms</td>
              <td>${r.avgConfidence != null ? r.avgConfidence.toFixed(1) : '-'}</td>
              <td>${fc ? `${fc.amtOk ? '<span class="ok">✅</span>' : '<span class="bad">❌</span>'} ${fc.amtGot ?? 'null'} (要 ${fc.amtWant ?? 'null'})` : '-'}</td>
              <td>${fc ? `${fc.dateOk ? '<span class="ok">✅</span>' : '<span class="bad">❌</span>'} ${fc.dateGot ?? 'null'} (要 ${fc.dateWant ?? 'null'})` : '-'}</td>
              <td>${r.glueScan.suspicious}/${r.glueScan.total} (${(r.glueScan.rate * 100).toFixed(1)}%)</td>
              <td>${glueStr}</td>
            </tr>`;
          })
          .join('')}
      </tbody>
    </table>
  `;
}

btnDownload.addEventListener('click', () => {
  const payload = {
    mode: 'REAL_FIXTURE_REGEN',
    note: '用 fixture-regen.html 在真实浏览器、真实 PaddleOCR 引擎上重新生成，不是 mock。',
    engineInfo,
    generatedAt: new Date().toISOString(),
    fixture: newFixture,
    comparisonSummary: perDocResults
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `fixture-regen-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
});
