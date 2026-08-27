#!/usr/bin/env node
/**
 * 从代码和测试里重新生成文档中的数字。
 *
 * 为什么要有这个：文档里手写的「准确率 6/6」「词典 47 条」会随代码悄悄过期，
 * 而过期的文档比没有文档更危险。所有这类数字都从源头算，不手写。
 *
 *   node scripts/update-docs.mjs           # 更新 docs/how-it-works.md
 *   node scripts/update-docs.mjs --check   # 只检查是否过期，CI 用（过期则退出码 1）
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UTILS = path.join(ROOT, 'frontend/src/utils');
const DOC = path.join(ROOT, 'docs/how-it-works.md');
const README = path.join(ROOT, 'README.md');
const CHECK = process.argv.includes('--check');

// ---------- 词典规模：从抽取器源码里数 ----------
const src = fs.readFileSync(path.join(UTILS, 'fieldExtractor.js'), 'utf8');
const between = (a, b) => {
  const i = src.indexOf(a);
  if (i < 0) return '';
  const j = src.indexOf(b, i + a.length);
  return src.slice(i, j < 0 ? undefined : j);
};
const countRe = (chunk) => (chunk.match(/re:\s*\//g) || []).length;

/*
 * 这些计数必须限定在对应的词典块里数，不能全文数。
 * 原来「已知机构」全文数 /kind: '/，而 buildLayer0 的 highlights 里
 * 每个 { kind: 'amount' } 也长这样 —— 于是 44 家机构被数成了 47。
 * 文档里那个数字错了整整一轮，而且是**文档自己在撒谎**，
 * 正好是这个脚本存在的理由。加发信日期高亮时数字跳到 48 才暴露。
 */
const dict = [
  ['已知机构', (between('KNOWN_ORGS', '\n];').match(/kind: '/g) || []).length],
  ['信件类别', (src.match(/baseUrgency: '/g) || []).length],
  ['信件子类型', (src.match(/notABill: /g) || []).length],
  ['金额锚点', countRe(between('AMOUNT_ANCHORS', '];'))],
  ['日期锚点', countRe(between('DATE_ANCHORS', '];')) + countRe(between('STATEMENT_DATE_ANCHORS', '];'))],
  ['句式词典', countRe(between('PHRASE_RULES', '\n];'))],
  ['诈骗特征', countRe(between('SCAM_SIGNALS', '];'))],
  ['交叉校验', (src.match(/addCheck\(/g) || []).length],
];

// ---------- 真值覆盖 ----------
const gt = JSON.parse(fs.readFileSync(path.join(UTILS, 'ground_truth.json'), 'utf8'));
const letters = Object.keys(gt);

// ---------- 跑测试拿真实分数 ----------
const run = (file) => {
  try {
    return execSync(`node ${file}`, { cwd: UTILS, encoding: 'utf8', timeout: 120000 });
  } catch (e) {
    return (e.stdout || '') + (e.stderr || '');
  }
};

const acc = run('accuracy.test.mjs');
/*
 * 必须匹配「类别 6/6 100%」这种带数字的汇总行。
 * 原来那条正则用的是通配符，加了「发信日期」这一列之后，
 * 表头「类别  金额  付款方式  到期日  发信日期」先被匹配上了，
 * 于是文档里的「当前分数」变成了一行表头。
 */
const scoreLine = (acc.match(/类别 \d+\/\d+[^\n]*到期日 \d+\/\d+[^\n]*/) ||
  ['（跑 accuracy.test.mjs 失败）'])[0].trim();

const suites = [
  ['合成信件', 'fieldExtractor.test.mjs'],
  ['官方原文', 'fieldExtractor.real.test.mjs'],
  ['类别拆分', 'fieldExtractor.split.test.mjs'],
  ['语句一致性', 'fieldExtractor.consistency.test.mjs'],
  ['脱敏断言', 'contentRedactor.hoag.test.mjs'],
  ['第一梯队真实信', 'fieldExtractor.tier1.test.mjs'],
];
const suiteRows = suites.map(([name, file]) => {
  const out = run(file);
  const m = out.match(/=====\s*(.+?)\s*=====/);
  return `| ${name} | \`${file}\` | ${m ? m[1] : '未通过'} |`;
});

// ---------- 拼生成块 ----------
const stamp = new Date().toISOString().slice(0, 10);
const block = `
## 当前分数

> 由 \`scripts/update-docs.mjs\` 于 ${stamp} 生成。**不要手改这一段。**

**真实账单（${letters.length} 封）** — ${scoreLine}

${letters.map((n) => `- \`${n}\` — ${gt[n].note || ''}`).join('\n')}

**其余测试**

| 层 | 文件 | 结果 |
|---|---|---|
${suiteRows.join('\n')}

### 词典规模

| 词典 | 条目 |
|---|---:|
${dict.map(([k, v]) => `| ${k} | ${v} |`).join('\n')}
`.trim();

// ---------- README 的分数块 ----------
/*
 * README 里也不许手写数字。
 * 之前「47 known organizations」错了整整一轮 —— 计数是全文数 /kind: '/，
 * 把 buildLayer0 里 { kind: 'amount' } 这类高亮标记也数进去了。真实是 40。
 */
const readmeBlock = `
| Suite | Result |
|---|---|
| **Real bills, hand-labeled ground truth** | ${letters.length} letters × 5 fields — ${scoreLine
  .replace(/类别/, 'category').replace(/金额/, 'amount')
  .replace(/付款方式/, 'payment').replace(/到期日/, 'due date')
  .replace(/发信日期/, 'statement date')} |
${suiteRows
  .map((r) => r.replace(/^\| [^|]+ \| /, '| '))
  .join('\n')}

Dictionary sizes: ${dict.map(([k, v]) => `${k} ${v}`).join(' · ')}.
`.trim();

// ---------- 写回 ----------
const doc = fs.readFileSync(DOC, 'utf8');
const BEGIN = '<!-- AUTO:BEGIN 以下内容由 scripts/update-docs.mjs 生成，不要手改 -->';
const END = '<!-- AUTO:END -->';
const i = doc.indexOf(BEGIN);
const j = doc.indexOf(END);
if (i < 0 || j < 0) {
  console.error('❌ docs/how-it-works.md 里找不到 AUTO 标记');
  process.exit(1);
}
const next = doc.slice(0, i + BEGIN.length) + '\n\n' + block + '\n\n' + doc.slice(j);

const readme = fs.readFileSync(README, 'utf8');
const R_BEGIN = '<!-- AUTO:BEGIN README 分数由 scripts/update-docs.mjs 生成，不要手改 -->';
const R_END = '<!-- AUTO:END -->';
const ri = readme.indexOf(R_BEGIN);
const rj = readme.indexOf(R_END, ri);
if (ri < 0 || rj < 0) {
  console.error('❌ README.md 里找不到 AUTO 标记');
  process.exit(1);
}
const nextReadme =
  readme.slice(0, ri + R_BEGIN.length) +
  '\n\n' +
  readmeBlock +
  '\n\n' +
  readme.slice(rj);

if (CHECK) {
  if (nextReadme.trim() !== readme.trim()) {
    console.error('❌ README.md 已过期，跑 node scripts/update-docs.mjs');
    process.exit(1);
  }
  if (next.trim() !== doc.trim()) {
    console.error('❌ docs/how-it-works.md 已过期，跑 node scripts/update-docs.mjs');
    process.exit(1);
  }
  console.log('✅ 文档与代码一致');
} else {
  fs.writeFileSync(DOC, next);
  fs.writeFileSync(README, nextReadme);
  console.log('✅ docs/how-it-works.md + README.md 已更新');
  console.log('   ' + scoreLine);
  console.log('   词典 ' + dict.map(([k, v]) => `${k}${v}`).join(' · '));
}
