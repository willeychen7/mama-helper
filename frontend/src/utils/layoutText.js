/*
 * 把 OCR 行按坐标摆回二维，拼成一张「文字画」。
 *
 * ── 为什么需要这个 ──
 *
 * 一封美国账单是**二维**的：左边一栏正文、右边一栏金额、中间一张表。
 * 把它按行拼成一段文字，二维信息在那一刻就没了 —— 再怎么排序都补不回来。
 *
 * 真实例子（WM 垃圾账单，拼平之后）：
 *
 *     online tools for billing and more. Have a
 *     07/02/2025: $ 92.05                        ← 右栏的金额插进了左栏的句子中间
 *     question? Check our support center or start
 *
 *     Previous Balance / Payments / Adjustments / Current Invoice / Total Account
 *     + / + / + / Charges / Balance Due
 *     0.00 / 0.00 / 0.00 / 87.05 / 87.05         ← 哪个数字属于哪一栏，全丢了
 *
 * 人看原图一眼就懂，因为人看的是版面。所以别拼平 —— 把版面留着。
 *
 * ── 这个函数不做什么 ──
 *
 * 不排序、不猜阅读顺序、不合并栏目。只做一件事：按坐标摆回去。
 * 「谁该读在谁前面」这个判断留给看到版面的那一方（人或模型），
 * 我们自己猜反而会猜错 —— 早期那套 buildSpatialReadingOrder 就是教训。
 *
 * ── 隐私 ──
 *
 * 传进来的必须是**已经脱敏过**的行。这个函数只管排版，不认识 PII。
 */

/**
 * @param {Array} lines OCR 行（要 left/top/bottom/text）
 * @param {number} pageWidth 页宽，用来把 x 归一化成字符列
 * @param {object} options
 *   cols      输出多少字符宽（默认 110，够放下常见账单的三栏）
 *   overlap   两行算「同一行」需要的垂直重叠比例（默认 0.5）
 * @returns {string}
 */
export const layoutText = (lines, pageWidth, options = {}) => {
  const { cols = 110, overlap = 0.5 } = options;

  const safe = (Array.isArray(lines) ? lines : []).filter(
    (l) => l && typeof l.text === 'string' && l.text.trim()
  );
  if (!safe.length) return '';

  const width = pageWidth || safe.reduce((m, l) => Math.max(m, l.right || 0), 1) || 1;

  const rest = [...safe].sort((a, b) => a.top - b.top);
  const rows = [];

  /*
   * 行带**不随成员扩张** —— 这一条是被反例逼出来的。
   *
   * 让行带跟着成员一起长的话，一行会吃掉下一行、再吃下下一行，
   * 整段正文被链成一条（实测 WM 那封的正文全挤成了一行）。
   * 所以以最靠上那条为准，只有跟**它**重叠够多的才算同一行。
   */
  while (rest.length) {
    const seed = rest.shift();
    const seedH = Math.max(1, seed.bottom - seed.top);
    const row = { top: seed.top, bottom: seed.bottom, items: [seed] };

    for (let i = rest.length - 1; i >= 0; i -= 1) {
      const l = rest[i];
      const lh = Math.max(1, l.bottom - l.top);
      const o = Math.min(seed.bottom, l.bottom) - Math.max(seed.top, l.top);
      if (o > 0 && o / Math.min(seedH, lh) >= overlap) {
        row.items.push(l);
        row.bottom = Math.max(row.bottom, l.bottom);
        rest.splice(i, 1);
      }
    }
    rows.push(row);
  }

  rows.sort((a, b) => a.top - b.top);

  const heights = safe
    .map((l) => l.bottom - l.top)
    .filter(Boolean)
    .sort((a, b) => a - b);
  const medianH = heights[Math.floor(heights.length / 2)] || 20;

  const out = [];
  let prevBottom = null;

  for (const row of rows) {
    // 段落之间留一个空行，模型和人都靠它分块
    if (prevBottom !== null && row.top - prevBottom > medianH * 1.1) out.push('');
    prevBottom = row.bottom;

    let line = '';
    for (const item of row.items.sort((a, b) => a.left - b.left)) {
      const col = Math.round((item.left / width) * cols);
      if (col > line.length) line += ' '.repeat(col - line.length);
      line += item.text + ' ';
    }
    out.push(line.trimEnd());
  }

  return out.join('\n');
};

export default layoutText;
