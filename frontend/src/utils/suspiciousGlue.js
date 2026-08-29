/**
 * utils/suspiciousGlue.js
 *
 * P1-A（决定 12）：检测「这一行可能被 OCR 粘连了，值得做局部二次 OCR」。
 *
 * 跟 contentRedactor.js 的姓名判定是两件不同的事——那边回答「这是不是
 * 姓名，要不要挡住」，这里回答「这一行的形状像不像被粘连了，值不值得
 * 花一次二次 OCR 的算力去重跑」。这个模块完全不关心隐私，一个粘连的
 * 金额、粘连的机构名，只要形状像，也会被标成 suspicious。
 *
 * 诊断过（见 2026-08-29 的纯诊断任务）：JENNIFERWASHINGTON / JOHNBDOE /
 * iJANEDOE / JAMES&KARENQ.HINDS 这四个反复出现的失败样本，粘连发生在
 * PaddleOCR 检测/识别阶段本身，不是本项目行重建逻辑的锅。这个探测器
 * 就是准备接在那一步之后：识别出「这个框长得可疑」，再决定要不要对
 * 这个 bbox 单独裁切、放大、重跑识别。
 *
 * 每条信号都只是弱信号，加权累加成一个分数——不能靠单条规则（尤其是
 * bbox 宽度）就下判定，字体、字号、数字、地址、长单词都会产生宽 bbox。
 */

const clean = (text) => String(text || '').trim();

/**
 * 纯大写字母 token（允许中间出现 & . , : 这类连接符，但不允许空格）。
 * 首尾的标点（比如 Hospital_Bill 里 "JANEDOE:" 的冒号）先剥掉再判形状，
 * 不然 "JANEDOE:" 会因为结尾多了个冒号而被漏判。
 */
const ALL_CAPS_NO_SPACE_RE = /^[A-Z][A-Z&.,':-]*[A-Z]$/;

const stripEdgePunctuation = (text) => text.replace(/^[^A-Za-z0-9]+/, '').replace(/[^A-Za-z0-9]+$/, '');

/**
 * 「两个专名靠 & 连起来」的形状：JAMES&KARENQ.HINDS 这种。
 * 至少出现一次 & ，且没有空格。
 */
const JOINT_NAME_GLUE_RE = /^[A-Z][A-Z.]*&[A-Z][A-Z.]*$/;

/**
 * 常见文档词/机构后缀——出现这些词的行，即使形状可疑也降权。
 * 故意开一份很短的本地清单，不依赖 contentRedactor.js 的 DOC_WORDS——
 * 这个模块要保持独立，不跟脱敏判定共享状态。
 */
const COMMON_LONG_WORDS = new Set([
  'INFORMATION', 'INSTITUTE', 'INSURANCE', 'CORPORATION', 'DEPARTMENT',
  'ADMINISTRATION', 'REPRESENTATIVE', 'CONFIDENTIAL', 'STATEMENT',
  'REGISTRATION', 'AUTHORIZATION', 'NOTIFICATION', 'CONSOLIDATED'
]);

/**
 * 给一整份文档的行算「同一份文档里，一个字符大概占多宽」的参照值，
 * 用来判断某一行是不是「宽度相对字符数明显偏宽」——这条本身是弱信号，
 * 只用页面内其它行的中位数当基线，不用绝对阈值（不同信件字号差很多）。
 */
function computeCharWidthBaseline(lines) {
  const ratios = [];
  lines.forEach((line) => {
    const text = clean(line.text);
    const charCount = text.replace(/\s+/g, '').length;
    const width = line.right != null && line.left != null ? line.right - line.left : null;
    if (charCount >= 4 && width && width > 0) {
      ratios.push(width / charCount);
    }
  });
  if (!ratios.length) return null;
  ratios.sort((a, b) => a - b);
  return ratios[Math.floor(ratios.length / 2)]; // median
}

/**
 * @param {object} line       单行 OCR 结果 {text, left, top, right, bottom, ...}
 * @param {object} context
 *   pageHeight            用于「是否在页面上方」这条弱信号
 *   charWidthBaseline     computeCharWidthBaseline() 算出来的同页参照值
 * @returns {{ suspicious: boolean, score: number, reasons: string[] }}
 */
export function detectSuspiciousGlue(line, context = {}) {
  const text = clean(line && line.text);
  const reasons = [];
  let score = 0;

  if (!text || text.length < 6) {
    return { suspicious: false, score: 0, reasons: [] };
  }

  const noSpace = !/\s/.test(text);
  const core = stripEdgePunctuation(text);
  const lettersOnly = core.replace(/[^A-Za-z]/g, '');
  /*
   * 允许最多 1 个杂散小写字符（比如 "iJANEDOE" 开头那个多认出来的 "i"，
   * OCR 偶尔会把竖线/污点认成一个字母混进大写串里）——超过 1 个就不算
   * "基本上是大写"，避免真的是正常大小写文本时也被判进来。
   */
  const lowerCount = (lettersOnly.match(/[a-z]/g) || []).length;
  const isMostlyUpper = lettersOnly.length >= 5 && lowerCount <= 1;

  // --- 信号 1：纯大写、无空格、长度在「两个词粘连」的常见区间 ---
  if (noSpace && isMostlyUpper && ALL_CAPS_NO_SPACE_RE.test(core.toUpperCase()) && core.length >= 6 && core.length <= 30) {
    if (!COMMON_LONG_WORDS.has(core.toUpperCase().replace(/[^A-Z]/g, ''))) {
      score += 40;
      reasons.push('纯大写（容许 1 个杂散小写字符）无空格，长度像两个词被粘在一起');
    }
  }

  // --- 信号 2：「A&B」型联名粘连（JAMES&KARENQ.HINDS 这种）---
  if (noSpace && JOINT_NAME_GLUE_RE.test(core.toUpperCase())) {
    score += 25;
    reasons.push('形如「A&B」的联名粘连');
  }

  // --- 信号 3（弱）：bbox 宽度相对同页字符宽度基线明显偏宽 ---
  // 这条故意压低权重——字体、字号、数字都会让宽度偏离基线，
  // 单独这一条永远不足以判定 suspicious。
  const baseline = context.charWidthBaseline;
  if (baseline && line.left != null && line.right != null) {
    const charCount = text.replace(/\s+/g, '').length;
    if (charCount >= 6) {
      const ratio = (line.right - line.left) / charCount;
      if (ratio > baseline * 1.35) {
        score += 10;
        reasons.push('bbox 宽度相对同页字符基线偏宽（弱信号）');
      }
    }
  }

  // --- 信号 4（弱）：位于页面上方，收件人信息常见区域 ---
  if (context.pageHeight && line.top != null && line.top <= context.pageHeight * 0.45) {
    score += 10;
    reasons.push('位于页面上方（弱信号）');
  }

  // --- 降权：含数字的一般是账号/编号，不是本模块要抓的姓名粘连类型 ---
  if (/\d/.test(text)) {
    score -= 15;
  }

  return {
    suspicious: score >= 50,
    score,
    reasons
  };
}

/**
 * 对一整份文档的 lines 跑一遍，返回每一行的判定 + 文档级统计。
 * 统计口径按用户要求的格式：total lines / suspicious lines / suspicious rate。
 */
export function scanDocumentForSuspiciousGlue(lines, options = {}) {
  const safeLines = Array.isArray(lines) ? lines : [];
  const pageHeight = options.pageHeight || safeLines.reduce((m, l) => Math.max(m, l.bottom || 0), 1);
  const charWidthBaseline = computeCharWidthBaseline(safeLines);

  const results = safeLines.map((line, index) => ({
    index,
    text: line.text,
    ...detectSuspiciousGlue(line, { pageHeight, charWidthBaseline })
  }));

  const suspiciousResults = results.filter((r) => r.suspicious);

  return {
    totalLines: safeLines.length,
    suspiciousLines: suspiciousResults.length,
    suspiciousRate: safeLines.length ? suspiciousResults.length / safeLines.length : 0,
    charWidthBaseline,
    results,
    suspiciousResults
  };
}

export default detectSuspiciousGlue;
