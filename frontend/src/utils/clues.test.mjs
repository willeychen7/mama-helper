/*
 * 线索层：没见过的说法也要认得出
 *
 * 这个测试的意义不在于「这几句话能过」，而在于
 * **这几句话在锚点表里一条都没有**。
 * 它们是靠零件组合认出来的 —— 付款词 + 之后词 + 后果词。
 *
 * 所以只要有人把某条组合规则改窄了，这里立刻会红。
 */
import { findClues } from './clues.js';
import { extractLetterFields } from './fieldExtractor.js';

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass += 1; console.log(`✅ ${name}`); }
  else { fail += 1; console.log(`❌ ${name}`); if (detail) console.log(`     ${detail}`); }
};

console.log('===== 线索层：零件组合 =====\n');

/* ---------- 1. 表里没有的写法，零件认得出 ---------- */

const UNSEEN = [
  ['payments received after the due date will incur a late charge', '付款 + 之后 + 后果'],
  ['a penalty of 10% will be added after November 1, 2024', '后果 + 之后'],
  ['Failure to remit by the date shown above may result in service interruption', '付款 + 之前 + 后果'],
  ['Please pay by March 15, 2025 to avoid a $25 late fee', '付款 + 之前 + 后果'],
  ['Your response must be received no later than 30 days from this notice', '回应 + 之前 + 期限']
];

UNSEEN.forEach(([text, why]) => {
  const clues = findClues(text);
  check(
    `认出「${text.slice(0, 40)}…」`,
    clues.some((c) => c.field === 'dueDate'),
    `一个线索都没凑出来（预期 ${why}）`
  );
});

/* ---------- 2. 普通句子不能乱响 ---------- */

const INNOCENT = [
  'Create a My WM profile for easy access to',
  'your pickup schedule, service alerts and',
  'Visit wm.com/MyWM',
  'Thank you for being a valued customer',
  'Previous Balance'
];

INNOCENT.forEach((text) => {
  check(
    `不对「${text.slice(0, 34)}…」乱响`,
    findClues(text).length === 0,
    JSON.stringify(findClues(text))
  );
});

/* ---------- 3. 线索层永远抢不走明确锚点 ---------- */

const L = (id, text, left, top, right, bottom) => ({
  id, text, confidence: 99,
  left, top, right, bottom,
  width: right - left, height: bottom - top,
  centerX: (left + right) / 2, centerY: (top + bottom) / 2
});

/*
 * 同一封信里两个日期打架：
 *   明确锚点「Payment Due Date」（100 分）配 03/15/2026
 *   线索兜底「...after 01/10/2026 a late fee」（≤78 分）配 01/10/2026
 * 必须信前者。线索层是兜底，不是竞争者。
 */
const conflict = extractLetterFields([
  L(0, 'ACME Water District', 100, 40, 500, 80),
  L(1, 'Payment Due Date', 100, 200, 400, 240),
  L(2, '03/15/2026', 450, 200, 700, 240),
  L(3, 'Amount Due', 100, 300, 300, 340),
  L(4, '$120.00', 450, 300, 650, 340),
  L(5, 'payments received after 01/10/2026 will incur a late charge', 100, 400, 900, 440)
], { imageWidth: 1000, imageHeight: 600, today: new Date('2026-01-01T00:00:00Z') });

check(
  '明确锚点在，就不用线索兜底的日期',
  conflict.fields.dueDate.value === '2026-03-15',
  `报了 ${conflict.fields.dueDate.value}`
);

/*
 * 把明确锚点那一行拿掉 —— 只剩线索。
 * 这就是真实世界里「这家公司写法我们没见过」的情形：
 * 日期还是要抽得出来，而且照样指得回 OCR 的哪一行。
 */
const clueOnly = extractLetterFields([
  L(0, 'ACME Water District', 100, 40, 500, 80),
  L(3, 'Amount Due', 100, 300, 300, 340),
  L(4, '$120.00', 450, 300, 650, 340),
  L(5, 'payments received after 01/10/2026 will incur a late charge', 100, 400, 900, 440)
], { imageWidth: 1000, imageHeight: 600, today: new Date('2026-01-01T00:00:00Z') });

check(
  '没有明确锚点时，线索兜底抽出 2026-01-10',
  clueOnly.fields.dueDate.value === '2026-01-10',
  `报了 ${clueOnly.fields.dueDate.value}`
);

check(
  '兜底抽出来的日期照样有出处（指得回某一行）',
  Boolean(clueOnly.fields.dueDate.box && clueOnly.fields.dueDate.box.text),
  '没有 box，说明值不是从 OCR 行里来的'
);

console.log(`\n===== 线索层 ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
