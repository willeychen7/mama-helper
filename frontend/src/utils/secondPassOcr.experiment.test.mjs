/**
 * secondPassOcr.experiment.test.mjs
 *
 * P1（决定 12）的实验记录，不是 accuracy proof——18 封信只够支撑
 * feasibility test，不足以证明"二次 OCR 提升了多少准确率"（那需要
 * 对每个目标字段建 ground truth，还没做）。
 *
 * 分两部分，标签必须分清楚，不能混着看：
 *
 *   P1-A（真实结果）：suspiciousGlue 检测器跑在全部 18 封 demo 信上，
 *     统计 total lines / suspicious lines / suspicious rate /
 *     已知粘连案例 recall。这是真数据，检测逻辑真的跑过。
 *
 *   P1-B（MOCK 结果）：用手工构造的假 OCR 引擎验证
 *     runSecondPassOnLine / compareCandidates 这套编排代码本身没 bug，
 *     不代表"真实 PaddleOCR 二次识别真的能拆开粘连词"——那是 P1-C，
 *     必须在本地浏览器里用真实引擎跑，这个文件只留好了怎么接的说明
 *     （见 secondPassOcr.js 文件末尾）。
 *
 * 结果落盘到 p1-results/，每个文件都在顶层写 mode 字段，防止以后
 * MOCK 和 REAL 的数据被误当成一回事分析。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { scanDocumentForSuspiciousGlue, detectSuspiciousGlue } from './suspiciousGlue.js';
import { runSecondPassOnLine, compareCandidates, VARIANTS } from './secondPassOcr.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(__dirname, 'p1-results');
fs.mkdirSync(RESULTS_DIR, { recursive: true });

let passed = 0;
let failed = 0;
const assert = (cond, label) => {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.log(`  ❌ ${label}`);
  }
};

// ============================================================
// P1-A：suspiciousGlue 在全部 18 封 demo 信上的真实统计
// ============================================================

const pp = JSON.parse(fs.readFileSync(path.join(__dirname, 'demo_ocr_pp.json'), 'utf8'));
const photo = JSON.parse(fs.readFileSync(path.join(__dirname, 'demo_ocr_photo.json'), 'utf8'));
const docs = { ...pp, ...photo };

const KNOWN_GLUE_CASES = [
  { document: 'Medicare_Notice', text: 'JENNIFERWASHINGTON' },
  { document: 'SoCalGas', text: 'JOHNBDOE' },
  { document: 'Hospital_Bill', text: 'iJANEDOE' },
  { document: 'Hospital_Bill', text: 'JANEDOE:' },
  { document: 'IRS_cp503', text: 'JAMES&KARENQ.HINDS' }
];

let totalLines = 0;
let totalSuspicious = 0;
const perDocument = [];
const suspiciousLines = [];

for (const [name, doc] of Object.entries(docs)) {
  const r = scanDocumentForSuspiciousGlue(doc.lines);
  totalLines += r.totalLines;
  totalSuspicious += r.suspiciousLines;

  perDocument.push({
    document: name,
    totalLines: r.totalLines,
    suspiciousLines: r.suspiciousLines,
    suspiciousRate: r.suspiciousLines / (r.totalLines || 1)
  });

  r.suspiciousResults.forEach((res) => {
    suspiciousLines.push({
      document: name,
      lineIndex: res.index,
      text: res.text,
      score: res.score,
      reasons: res.reasons
    });
  });
}

let knownCaught = 0;
const knownCaseResults = KNOWN_GLUE_CASES.map((c) => {
  const hit = suspiciousLines.some((s) => s.document === c.document && s.text === c.text);
  if (hit) knownCaught += 1;
  return { ...c, caught: hit };
});

console.log('=== P1-A · suspiciousGlue 检测器（真实结果，18 封信）===');
console.log(`total lines: ${totalLines}`);
console.log(`suspicious lines: ${totalSuspicious}`);
console.log(`suspicious rate: ${((totalSuspicious / totalLines) * 100).toFixed(1)}%`);
console.log(`known glue case recall: ${knownCaught}/${KNOWN_GLUE_CASES.length}`);
knownCaseResults.forEach((c) => {
  console.log(`  ${c.caught ? '✅' : '❌'} ${c.document}: ${JSON.stringify(c.text)}`);
});

/*
 * 门槛：已知案例必须全部抓到（这是回归测试，不是"检测器很准"的证明）。
 * suspicious rate 不设断言门槛——它是一个成本指标，用来判断"这套规则
 * 会让多少行排队去做二次 OCR"，值本身没有对错，只用于人工判断划不划算。
 */
assert(knownCaught === KNOWN_GLUE_CASES.length, `已知粘连案例应该全部抓到，实际 ${knownCaught}/${KNOWN_GLUE_CASES.length}`);

fs.writeFileSync(
  path.join(RESULTS_DIR, 'suspicious-lines.json'),
  JSON.stringify(
    {
      mode: 'REAL_DETECTOR_NO_OCR',
      note: '这是 suspiciousGlue 检测逻辑在真实 demo 信 OCR 文本上的真实输出，不涉及任何 OCR 引擎调用（检测器本身不需要 OCR，只读取已有的 OCR 结果）。',
      generatedAt: new Date().toISOString(),
      totalLines,
      totalSuspicious,
      suspiciousRate: totalSuspicious / totalLines,
      knownGlueCaseRecall: `${knownCaught}/${KNOWN_GLUE_CASES.length}`,
      knownCaseResults,
      perDocument,
      suspiciousLines
    },
    null,
    2
  )
);


// ============================================================
// P1-B：用 MOCK 引擎验证 runSecondPassOnLine / compareCandidates
// 编排逻辑本身没 bug —— 不代表真实 PaddleOCR 的二次识别能力
// ============================================================

console.log('\n=== P1-B · 编排逻辑测试（MOCK 引擎，不代表真实 OCR 能力）===');

/**
 * 每个场景构造一个假 engine：不管传进来什么 crop variant，
 * 都按场景预先写好的脚本依次返回结果——用来覆盖几种不同的
 * "二次识别到底发生了什么"的可能性，而不是只测"恢复了空格"这一种。
 */
function makeMockEngine(scriptByVariant) {
  return {
    async predict(blob) {
      const variantId = blob.__variantId;
      const scripted = scriptByVariant[variantId];
      if (!scripted) return { items: [] };
      return { items: [{ text: scripted.text, score: scripted.confidence / 100 }] };
    }
  };
}

function makeMockCropAndPreprocess() {
  // 不做真实像素操作，直接返回 4 个 variant 占位符，
  // blob 上挂一个 __variantId 供 mock engine 识别该返回什么。
  return async () => VARIANTS.map((v) => ({ variantId: v.id, blob: { __variantId: v.id } }));
}

const mockScenarios = [
  {
    name: 'JENNIFERWASHINGTON -> 放大后成功拆开（典型正面案例）',
    document: 'Medicare_Notice(mock)',
    line: { index: 4, text: 'JENNIFERWASHINGTON', confidence: 99.94, left: 102, top: 194, right: 296, bottom: 211 },
    // pageHeight 取自 Medicare_Notice 真实文档高度，让 trigger 跟 P1-A
    // 真实扫描时的判定一致（P1-A 是按整份文档跑 scanDocumentForSuspiciousGlue
    // 的，这里单独调 detectSuspiciousGlue 必须补上同样的 context，
    // 不然"位于页面上方"这条弱信号会缺失，trigger.suspicious 就会跟
    // P1-A 报告的结果对不上）。
    trigger: detectSuspiciousGlue(
      { text: 'JENNIFERWASHINGTON', left: 102, top: 194, right: 296, bottom: 211 },
      { pageHeight: 1108 }
    ),
    script: {
      A_original_crop: { text: 'JENNIFERWASHINGTON', confidence: 99 },
      B_upscale2x: { text: 'JENNIFERWASHINGTON', confidence: 98 },
      C_upscale3x_gray: { text: 'JENNIFER WASHINGTON', confidence: 88 },
      D_upscale3x_contrast: { text: 'JENNIFER WASHINGTON', confidence: 91 }
    },
    expectVariant: 'C_upscale3x_gray',
    expectChangeType: 'added_space'
  },
  {
    name: 'JOHNBDOE -> 全部 variant 都没变化（典型负面案例，二次 OCR 没用）',
    document: 'SoCalGas(mock)',
    line: { index: 4, text: 'JOHNBDOE', confidence: 99.93, left: 438, top: 45, right: 574, bottom: 68 },
    trigger: detectSuspiciousGlue(
      { text: 'JOHNBDOE', left: 438, top: 45, right: 574, bottom: 68 },
      { pageHeight: 1286 }
    ),
    script: {
      A_original_crop: { text: 'JOHNBDOE', confidence: 99 },
      B_upscale2x: { text: 'JOHNBDOE', confidence: 97 },
      C_upscale3x_gray: { text: 'JOHNBDOE', confidence: 95 },
      D_upscale3x_contrast: { text: 'JOHNBDOE', confidence: 96 }
    },
    expectVariant: 'A_original_crop',
    expectChangeType: 'no_change'
  },
  {
    name: 'JAMES&KARENQ.HINDS -> retry 加了空格但 confidence 反而更低（用户点名的风险场景）',
    document: 'IRS_cp503(mock)',
    line: { index: 17, text: 'JAMES&KARENQ.HINDS', confidence: 99.19, left: 238, top: 395, right: 592, bottom: 424 },
    trigger: detectSuspiciousGlue(
      { text: 'JAMES&KARENQ.HINDS', left: 238, top: 395, right: 592, bottom: 424 },
      { pageHeight: 2200 }
    ),
    script: {
      A_original_crop: { text: 'JAMES&KARENQ.HINDS', confidence: 99 },
      B_upscale2x: { text: 'JAMES & KAREN Q. HINDS', confidence: 62 },
      C_upscale3x_gray: { text: 'JAMES&KARENQ.HINDS', confidence: 90 },
      D_upscale3x_contrast: { text: 'JAMES&KARENQ.HINDS', confidence: 88 }
    },
    expectVariant: 'B_upscale2x',
    expectChangeType: 'added_space',
    expectLowerConfidenceFlag: true
  },
  {
    name: 'JOHNBDOE -> 一个 variant 把字符读错了（误读，不是简单重新分词）',
    document: 'SoCalGas(mock-misread)',
    line: { index: 4, text: 'JOHNBDOE', confidence: 99.93, left: 438, top: 45, right: 574, bottom: 68 },
    trigger: detectSuspiciousGlue(
      { text: 'JOHNBDOE', left: 438, top: 45, right: 574, bottom: 68 },
      { pageHeight: 1286 }
    ),
    script: {
      A_original_crop: { text: 'JOHNBDOE', confidence: 99 },
      B_upscale2x: { text: 'JOHNBDOE', confidence: 97 },
      C_upscale3x_gray: { text: 'JOHNB0OE', confidence: 80 },
      D_upscale3x_contrast: { text: 'JOHNBDOE', confidence: 96 }
    },
    expectVariant: 'C_upscale3x_gray',
    expectChangeType: 'different_chars'
  }
];

const candidateComparisons = [];

for (const scenario of mockScenarios) {
  const engine = makeMockEngine(scenario.script);
  const cropAndPreprocess = makeMockCropAndPreprocess();

  const result = await runSecondPassOnLine({
    documentName: scenario.document,
    line: scenario.line,
    trigger: scenario.trigger,
    cropAndPreprocess,
    engine,
    engineMode: 'MOCK'
  });

  candidateComparisons.push(result);

  const expected = result.retries.find((r) => r.variantId === scenario.expectVariant);

  console.log(`  ${scenario.name}`);
  assert(
    scenario.trigger.suspicious,
    `${scenario.name}: 这几个都是 P1-A 已确认的已知粘连案例，trigger.suspicious 应该是 true`
  );
  assert(!!expected, `${scenario.name}: 应该产出 ${scenario.expectVariant} 这个 variant 的记录`);
  assert(
    expected && expected.comparison.change_type === scenario.expectChangeType,
    `${scenario.name}: change_type 应为 ${scenario.expectChangeType}，实际 ${expected && expected.comparison.change_type}`
  );

  // 不覆盖原始结果：original 字段必须还是原始文本，不管 retry 结果怎样
  assert(
    result.original.text === scenario.line.text,
    `${scenario.name}: original.text 不应该被 retry 结果覆盖`
  );

  if (scenario.expectLowerConfidenceFlag) {
    assert(
      expected.comparison.reasons.some((r) => r.includes('confidence')),
      `${scenario.name}: candidate confidence 更低时，reasons 里应该有提示`
    );
  }

  /*
   * 单位一致性回归断言：mock engine 按 PaddleOCR-js 的原始约定传 0-1
   * 区间的 score（脚本里写的 confidence/100），runSecondPassOnLine 必须
   * 把它换算回跟 line.confidence 一样的 0-100 区间——第一版没换算，
   * 导致 99.94 vs 0.99 被误判成"confidence 掉了 99 个点"，所有 retry
   * 都会被污染成"看起来更差"。这里验证换算回去之后数值该在同一量级。
   */
  const scriptedConfidence = scenario.script[scenario.expectVariant].confidence;
  assert(
    expected && Math.abs(expected.confidence - scriptedConfidence) < 1,
    `${scenario.name}: candidate confidence 单位应该跟 line.confidence 一致（0-100），期望约 ${scriptedConfidence}，实际 ${expected && expected.confidence}`
  );

  // compareCandidates 本身不选 winner —— 同一条 result 里，
  // 所有 variant 的 comparison 都应该原样保留，不因为某个"看起来更像
  // 恢复成功"就丢掉别的 variant。
  assert(
    result.retries.length === VARIANTS.length,
    `${scenario.name}: 应该保留全部 ${VARIANTS.length} 个 variant 的 retry 记录，不做筛选`
  );
}

fs.writeFileSync(
  path.join(RESULTS_DIR, 'candidate-comparisons.mock.json'),
  JSON.stringify(
    {
      mode: 'MOCK',
      note: '这些记录全部来自手工构造的 mock OCR 引擎，只用来验证 runSecondPassOnLine/compareCandidates 的编排逻辑没有 bug——不代表真实 PaddleOCR 二次识别真的能拆开粘连词。真实结果见 P1-C，需要在本地浏览器用真实引擎跑，见 secondPassOcr.js 文件末尾的接入说明。',
      generatedAt: new Date().toISOString(),
      scenarioCount: mockScenarios.length,
      results: candidateComparisons
    },
    null,
    2
  )
);


// ============================================================
// experiment-summary.json —— 汇总 + P1-C 占位说明
// ============================================================

fs.writeFileSync(
  path.join(RESULTS_DIR, 'experiment-summary.json'),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      p1a_suspiciousGlueDetector: {
        mode: 'REAL_DETECTOR_NO_OCR',
        totalLines,
        totalSuspicious,
        suspiciousRate: totalSuspicious / totalLines,
        knownGlueCaseRecall: `${knownCaught}/${KNOWN_GLUE_CASES.length}`,
        interpretation:
          '这是 P1-A 的真实结果：检测规则本身跑在真实 OCR 文本上，不涉及重跑 OCR。' +
          'suspicious rate 是成本指标（多少行会被送去二次 OCR），不是准确率指标。'
      },
      p1b_pipelineLogicTest: {
        mode: 'MOCK',
        scenarioCount: mockScenarios.length,
        passed,
        failed,
        interpretation:
          '验证的是编排代码（裁切/放大/预处理调用顺序、比较逻辑、不覆盖原始结果）没有 bug，' +
          '用的是手工编好的假 OCR 输出，不是真实 PaddleOCR 的能力测试。'
      },
      p1c_realityTest: {
        mode: 'NOT_RUN',
        reason:
          '这个沙箱环境的出站网络策略挡住了 PaddleOCR-js（以及作为替代尝试过的 tesseract.js）' +
          '需要下载的模型文件所在域名，无法在这里初始化任何 OCR 引擎。' +
          '真正回答"二次 OCR 能不能把粘连词拆开"，需要在能连外网的本地浏览器里，' +
          '用 secondPassOcr.js 文件末尾说明的方式接入真实 getOCREngine()，' +
          '对着 4-5 个已知案例（JENNIFERWASHINGTON / JOHNBDOE / iJANEDOE / JAMES&KARENQ.HINDS）' +
          '实际跑一遍，并且要跟 ground_truth 比较（是不是真的读对了，不是"看起来更合理"）。',
        howToRun: 'frontend/src/utils/secondPassOcr.js 文件末尾"如何在浏览器里接真实引擎"注释'
      }
    },
    null,
    2
  )
);

console.log(`\n===== P1 实验 ${passed} 通过 / ${failed} 失败 =====`);
console.log(`结果已写入 ${path.relative(process.cwd(), RESULTS_DIR)}/`);

if (failed > 0) {
  process.exitCode = 1;
}
