/*
 * 佐证不能被「一堆数字」骗到
 *
 * 起因：为了让 WM 那封垃圾账单的 87.05 能被采信，
 * 我把「整行只有一个数」也算进「页面上重复出现」这条佐证里。
 *
 * 但这条口子开得不小 —— PURE_MONEY_RE 要求正好两位小数，
 * 整数（水表读数、账号、邮编、年份）和四位小数（电价 0.2106）都进不来，
 * 可是「正好两位小数、独占一行」的非金额数字确实存在：
 *   AT&T 账单上的流量 3.46（Data Used GB）
 *   费率 0.21 · 税率 8.75 · 工时 1.50
 *
 * 所以规则收紧成：**至少要有一次带 $，裸数字只能当追加证据。**
 * 这个文件就是钉住这条。
 */
import fs from 'fs';
const { extractLetterFields } = await import('./fieldExtractor.js');

let L = 0;
const mk = (t, l, top, r) => ({
  id: L++, text: t, confidence: 96,
  left: l, top, right: r, bottom: top + 26,
  width: r - l, height: 26, centerX: (l + r) / 2, centerY: top + 13
});
const page = (rows) => {
  L = 0;
  return rows.flatMap((row, i) => {
    const top = 50 + i * 38;
    if (Array.isArray(row))
      return [mk(row[0], 100, top, 100 + row[0].length * 9), mk(row[1], 830, top, 940)];
    return [mk(row, 100, top, Math.min(940, 100 + row.length * 9))];
  });
};
const TODAY = new Date('2026-08-27T00:00:00Z');
const run = (rows) =>
  extractLetterFields(page(rows), { imageWidth: 1000, imageHeight: 1000, today: TODAY });

let pass = 0, fail = 0;
const check = (label, ok, detail) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? '✅' : '❌'} ${label}${ok ? '' : '\n     ' + detail}`);
};

// ── 1 · 弱锚点 + 全页无美元号，两位小数重复出现 —— 不算佐证 ──
/*
 * 必须用**弱锚点**才测得到佐证逻辑。
 * 「Amount Due」权重 100，满足 anchorWeight >= 92 会直接采信，
 * 根本走不到佐证这一步 —— 那样测的是别的东西。
 * 这里用通用的「Total」（权重 35）。
 */
const noDollar = run([
  'WIRELESS STATEMENT',
  'Group 1 - Data Summary',
  ['Total', '3.46'],
  'Data Used (GB)',
  '3.46',
  '3.46',
  'Thank you for your business'
]);
check(
  '弱锚点 + 全页无美元号：两位小数重复出现不构成佐证',
  !noDollar.fields.amount.trusted,
  `采信了 ${noDollar.fields.amount.value}`
);

// ── 2 · 真实的 WM 账单：带 $ 一次 + 表格裸数字追加 —— 构成佐证 ──
const doc = JSON.parse(fs.readFileSync('demo_ocr_photo.json', 'utf8')).wm_trash_bill;
const wm = extractLetterFields(doc.lines, {
  imageWidth: doc.width,
  imageHeight: doc.height,
  today: new Date('2025-06-20T00:00:00Z')
});
/*
 * WM 这封现在是靠**锚点**过关的，不是靠佐证 ——
 * 两行表头合并后匹配到 total account balance due（95 分），超过 92 门槛。
 *
 * 留在这里当反向对照：它证明「不放松佐证」也能把该读的读出来，
 * 前提是把信息读全，而不是把标准放低。
 */
check(
  '真实 WM 账单：靠 95 分锚点采信，不依赖裸数字佐证',
  wm.fields.amount.trusted && Math.abs(wm.fields.amount.value - 87.05) < 0.005,
  `trusted=${wm.fields.amount.trusted} value=${wm.fields.amount.value}`
);

// ── 3 · 整数不能被当成金额 ──
const integers = run([
  'WATER BILLING STATEMENT',
  ['Total', '772'],
  'Meter Read',
  '772',
  '782',
  'Account 92663',
  'Service year 2025'
]);
check(
  '整数（水表读数/账号/邮编/年份）不会被当成金额',
  !integers.fields.amount.trusted,
  `采信了 ${integers.fields.amount.value}`
);

// ── 4 · 四位小数的费率不能被当成金额 ──
const rates = run([
  'ELECTRIC BILL DETAIL',
  ['Total', '0.2106'],
  'Rate schedule',
  '0.2106',
  '0.2106',
  'kWh usage 161.14'
]);
check(
  '四位小数的费率不会被当成金额',
  !rates.fields.amount.trusted,
  `采信了 ${rates.fields.amount.value}`
);

console.log(`\n===== 金额佐证 ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
