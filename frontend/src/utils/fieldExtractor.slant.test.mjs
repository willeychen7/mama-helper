/*
 * 斜着拍的纸 —— 上下两行的框会互相重叠
 *
 * 这些坐标是从浏览器里跑真实 PaddleOCR 抓下来的（WM 垃圾账单，
 * PP-OCRv5，1740px 宽），不是手写的假数据。
 *
 * 为什么单独立一个测试：
 * demo_ocr_photo.json 那份 fixture 分辨率低、框瘦，行与行不重叠，
 * 所以它一直是绿的 —— 而浏览器里同一张照片是红的。
 * 差别只有一个：真实分辨率下框更胖，斜纸让上一行的「底」
 * 压到了下一行的「顶」下面。
 *
 * 三处按扫描件的正矩形排版写死的容差，全被这一点点重叠卡住：
 *   1. 两行表头合并要求 cand.bottom <= line.top
 *      「Total Account」bottom=435 vs「Balance Due」top=422 → 合不起来
 *      → 只剩弱锚点，87.05 抽得出来却不敢采信
 *   2. 「正下方」要求 line.top >= anchor.bottom - unit*0.2
 *      「If payment is received after」bottom=192 vs「07/02/2025」top=183
 *      → 差 1.6 像素，截止日期整个丢掉
 *
 * 这个测试就是钉死这两条容差，别再改回去。
 */
import { extractLetterFields } from './fieldExtractor.js';

const L = (id, text, left, top, right, bottom, confidence = 99) => ({
  id, text, confidence,
  left, top, right, bottom,
  width: right - left, height: bottom - top,
  centerX: (left + right) / 2, centerY: (top + bottom) / 2
});

// 只保留跟这两条容差有关的行，坐标一律照抄浏览器输出
const lines = [
  L(0, 'Access Your Account', 243, 0, 537, 35),
  L(2, 'Jul 02, 2025', 727, 64, 999, 129),
  L(3, '$87.05', 1234, 67, 1417, 130),

  // ── 罚金句：下一行的顶(183) 比上一行的底(192) 还高 ──
  L(6, 'If payment is received after', 1146, 152, 1487, 192),
  L(9, '07/02/2025: $ 92.05', 1175, 183, 1449, 221),

  // ── 两行表头：上一行的底(435) 比下一行的顶(422) 还低 ──
  L(17, 'Current Invoice', 1020, 397, 1222, 432),
  L(18, 'Total Account', 1304, 395, 1488, 435),
  L(19, 'Previous Balance', 191, 415, 412, 447),
  L(25, 'Charges', 1065, 423, 1181, 458),
  L(26, 'Balance Due', 1316, 422, 1480, 457),
  L(27, '0.00', 258, 459, 326, 494),
  L(30, '87.05', 1085, 457, 1166, 491),
  L(31, '87.05', 1360, 458, 1444, 492)
];

const r = extractLetterFields(lines, { imageWidth: 1740, imageHeight: 1010 });
const f = r.fields;

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass += 1; console.log(`✅ ${name}`); }
  else { fail += 1; console.log(`❌ ${name}`); if (detail) console.log(`     ${detail}`); }
};

console.log('===== 斜着拍的纸：框重叠也要抽得出来 =====\n');

check(
  '两行表头合并成功，87.05 被采信',
  f.amount.trusted && Math.abs(f.amount.value - 87.05) < 0.005,
  `value=${f.amount.value} trusted=${f.amount.trusted} anchor=${f.amount.anchorText}`
);

check(
  '罚金句反推出截止日期 2025-07-02',
  f.dueDate.value === '2025-07-02',
  `报了 ${f.dueDate.value}`
);

check(
  '92.05 是逾期价，绝不能当成要交的钱',
  Math.abs(f.amount.value - 92.05) > 0.005,
  `金额报成了 ${f.amount.value}`
);

check(
  '顶上那个孤立日期没有被当成发信日期',
  !f.statementDate.trusted,
  `发信日期报了 ${f.statementDate.value}`
);

console.log(`\n===== 斜纸 ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
