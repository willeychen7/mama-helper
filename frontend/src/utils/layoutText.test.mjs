/*
 * 版面还原的断言
 *
 * 这一层的价值只有一句话：**同一行的东西要留在同一行，不同栏的东西不要串行。**
 * 拼平之后再想恢复是不可能的，所以这几条必须钉死。
 */
import fs from 'fs';
const { layoutText } = await import('./layoutText.js');

let pass = 0, fail = 0;
const check = (label, ok, detail) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? '✅' : '❌'} ${label}${ok ? '' : '\n     ' + detail}`);
};

const mk = (text, left, top, right, h = 26) => ({
  text, left, top, right, bottom: top + h, height: h,
  width: right - left, centerX: (left + right) / 2, centerY: top + h / 2,
  confidence: 96
});

// ── 1 · 两栏不许串行 ──
/*
 * 真实反例：WM 账单上右栏的「07/02/2025: $92.05」
 * 在拼平之后插进了左栏「online tools ... / question? ...」两句之间。
 */
const twoCol = layoutText([
  mk('online tools for billing and more. Have a', 100, 140, 600),
  mk('07/02/2025: $ 92.05', 1090, 140, 1330),
  mk('question? Check our support center', 100, 178, 600),
  mk('If full payment of the invoiced amount', 650, 178, 970)
], 1600);

const rowsOf = twoCol.split('\n').filter((l) => l.trim());
check(
  '同一行的左右两栏留在同一行，不会串到别的行去',
  rowsOf[0].includes('online tools') && rowsOf[0].includes('92.05'),
  twoCol
);
check(
  '不同行的内容不会被并到一起',
  !rowsOf[0].includes('question?'),
  twoCol
);

// ── 2 · 表格：标签和它下面的数值要对齐在同一列 ──
const table = layoutText([
  mk('Previous Balance', 216, 374, 413),
  mk('Payments', 502, 367, 619),
  mk('Current Invoice', 976, 343, 1152),
  mk('Charges', 1016, 367, 1119),
  mk('0.00', 278, 422, 334),
  mk('0.00', 532, 413, 588),
  mk('87.05', 1039, 401, 1109)
], 1600);

const findRow = (needle) => table.split('\n').find((l) => l.includes(needle)) || '';
const colOf = (row, needle) => row.indexOf(needle);
check(
  '数值和它的表头对齐在同一列（列偏差在 3 个字符以内）',
  Math.abs(colOf(findRow('Charges'), 'Charges') - colOf(findRow('87.05'), '87.05')) <= 3,
  table
);

// ── 3 · 真实那封 WM 账单 ──
const doc = JSON.parse(fs.readFileSync('demo_ocr_photo.json', 'utf8')).wm_trash_bill;
const real = layoutText(doc.lines, doc.width);
const flat = doc.lines.map((l) => l.text).join('\n');

check(
  '真实账单：右栏的逾期金额不再插进左栏句子中间',
  !/online tools[^\n]*\n07\/02\/2025/.test(real),
  real.split('\n').slice(0, 6).join('\n')
);
check(
  '真实账单：两行叠着的表头留在了各自的列上',
  /Current Invoice[\s\S]{0,200}Total Account/.test(real) &&
    real.split('\n').some((l) => l.includes('Charges') && l.includes('Balance Due')),
  '表头没有正确分列'
);
check(
  '体积增幅在一倍以内（多出来的基本是空格）',
  real.length < flat.length * 2,
  `拼平 ${flat.length} → 二维 ${real.length}`
);

// ── 4 · 不炸 ──
check('空输入返回空字符串', layoutText([], 1000) === '' && layoutText(null, 1000) === '', '炸了');
check('没有页宽也不炸', typeof layoutText([mk('hello', 0, 0, 100)]) === 'string', '炸了');

console.log(`\n真实账单：拼平 ${flat.length} 字符 → 保留版面 ${real.length} 字符（+${Math.round((real.length / flat.length - 1) * 100)}%）`);
console.log(`===== 版面还原 ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
