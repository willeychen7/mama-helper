/*
 * 知识库的防线
 *
 * 这个文件只做一件事：**钉住「知识库里不许有事实」。**
 *
 * 知识库存的是「这类信是什么」，事实（金额、日期、机构）永远来自 OCR。
 * 一旦有人图省事把一个具体金额或年份写进 knowledge.json，
 * 它就从「知识」变成了「可能过期的谎话」—— 而且没有任何办法验算。
 *
 * 这条规则光靠 code review 守不住（词条会越来越多，谁都可能顺手写一个数字），
 * 所以必须机械地检查。
 */
import fs from 'fs';
const KB = JSON.parse(fs.readFileSync('./knowledge.json', 'utf8'));
const m = await import('./knowledge.js');

let pass = 0, fail = 0;
const check = (label, ok, detail) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? '✅' : '❌'} ${label}${ok ? '' : '\n     ' + detail}`);
};

const PROSE = ['whatItIs', 'purpose', 'typicalAction', 'risks'];
const deadlineText = (e) => (e.deadlineRule && e.deadlineRule.text) || '';

// ── 1 · 不许有金额 ──
const withMoney = [];
for (const e of KB.entries) {
  for (const f of PROSE) {
    const t = e[f] || '';
    if (/\$\s*[\d,]+/.test(t) || /[\d,]+\s*(美元|dollars?)\b/.test(t)) {
      withMoney.push(`${e.id}.${f}`);
    }
  }
  if (/\$\s*[\d,]+/.test(deadlineText(e))) withMoney.push(`${e.id}.deadlineRule`);
}
check('知识库里没有任何具体金额', withMoney.length === 0, withMoney.join(', '));

// ── 2 · 不许有年份 ──
/*
 * 月日可以（「11 月 1 日到期」是年年重复的法定规律，属于知识），
 * 带年份就不行（「2026 年 11 月 1 日」是某一封信上的事实）。
 */
const withYear = [];
for (const e of KB.entries) {
  for (const f of [...PROSE, '__deadline']) {
    const t = f === '__deadline' ? deadlineText(e) : (e[f] || '');
    if (/\b(19|20)\d{2}\b/.test(t)) withYear.push(`${e.id}.${f} → ${t.match(/\b(19|20)\d{2}\b/)[0]}`);
  }
}
check('知识库里没有任何年份（月日可以，那是年年重复的规律）', withYear.length === 0, withYear.join(', '));

// ── 3 · 字段完整 ──
const REQUIRED = ['id', 'group', 'cn', 'en', ...PROSE, 'signals', 'baseUrgency'];
const incomplete = KB.entries
  .map((e) => {
    const miss = REQUIRED.filter((f) => !e[f] || (typeof e[f] === 'string' && !e[f].trim()));
    return miss.length ? `${e.id}: 缺 ${miss.join(',')}` : null;
  })
  .filter(Boolean);
check('每条词条的必填字段都齐全', incomplete.length === 0, incomplete.join(' | '));

// ── 4 · id 唯一 ──
const ids = KB.entries.map((e) => e.id);
check('id 没有重复', new Set(ids).size === ids.length, '有重复');

// ── 5 · 所有识别信号都能编译 ──
const badRe = [];
for (const e of KB.entries) {
  for (const kind of ['strong', 'weak']) {
    for (const src of (e.signals && e.signals[kind]) || []) {
      try { new RegExp(src, 'i'); } catch (err) { badRe.push(`${e.id}.${kind}: ${src}`); }
    }
  }
}
check('所有识别信号都是合法正则', badRe.length === 0, badRe.join(', '));

// ── 6 · 认不出来时不猜 ──
const junk = m.resolveDocumentTypes(
  m.matchDocumentTypes('Dear neighbor, our annual block party is this weekend. Bring a dish!')
);
check('认不出的信返回 unknown，不硬猜', junk.status === 'unknown', `猜成了 ${junk.primary && junk.primary.cn}`);

// ── 7 · 多标签：一封信同时是两类，要两个都说 ──
const both = m.resolveDocumentTypes(
  m.matchDocumentTypes(
    'HOA NOTICE OF VIOLATION — your account is also PAST DUE. ' +
    'Homeowners Association monthly dues remain unpaid. Please remit payment. ' +
    'Cure the violation within 30 days or a fine will be assessed.'
  )
);
check(
  '同时命中两类时如实说两个，不假装只有一个',
  both.status === 'ambiguous' && both.also.length >= 1,
  `status=${both.status} 头名=${both.primary && both.primary.cn} 其余=${both.also.map(a=>a.cn).join(',')}`
);

// ── 8 · 组合出来的「常识」句里，同样不许有事实 ──
const g = m.composeGuidance(
  m.resolveDocumentTypes(m.matchDocumentTypes('ANNUAL SECURED PROPERTY TAX BILL treasurer-tax collector first installment')),
  {}
);
const knowledgeLines = g.lines.filter((l) => l.source === 'knowledge');
const leaked = knowledgeLines.filter((l) => /\$\s*[\d,]+|\b(19|20)\d{2}\b/.test(l.text));
check('组合输出里「常识」那一档没有金额和年份', leaked.length === 0, leaked.map(l=>l.text).join(' | '));

// ── 9 · 没有本地事实时，不许冒出「信上」那一档 ──
check(
  'fields 为空时不会凭空冒出「信上写的」句子',
  g.lines.every((l) => l.source === 'knowledge'),
  g.lines.filter(l=>l.source==='letter').map(l=>l.text).join(' | ')
);

// ── 10 · 有本地事实时才引用，而且原样引用 ──
const g2 = m.composeGuidance(
  m.resolveDocumentTypes(m.matchDocumentTypes('ANNUAL SECURED PROPERTY TAX BILL treasurer-tax collector first installment')),
  {
    amount: { trusted: true, value: 4281.1, isPaymentDemand: true },
    dueDate: { trusted: true, value: '2024-11-01' }
  }
);
const letterLines = g2.lines.filter((l) => l.source === 'letter');
check(
  '有本地验证过的金额和日期时，如实引用并标成「信上」',
  letterLines.some((l) => l.text.includes('4281.1')) &&
    letterLines.some((l) => l.text.includes('2024-11-01')),
  letterLines.map(l=>l.text).join(' | ')
);
check(
  '读到确切期限时，不再讲「这类信通常……」的规律',
  !g2.lines.some((l) => l.kind === 'deadlineNorm'),
  '同时讲了确切期限和规律，会让人分不清哪个才是自己的期限'
);


/*
 * 有 deadlineRule 的，必须是真的法定规则 —— 必须写明依据。
 * 没有法定规则的词条**根本不该有这个字段** ——
 * 存一句「以信上为准」存 32 遍不是设计，是官僚主义，
 * 而且那句话本来就该由界面在读不到期限时自己说。
 */
const noBasis = KB.entries.filter(
  (e) => e.deadlineRule && !String(e.deadlineRule.legalBasis || '').trim()
);
check('有法定期限的词条都写明了法律依据', noBasis.length === 0, noBasis.map((e) => e.id).join(', '));

// ── 如实报告审核进度 ──
const reviewed = KB.entries.filter((e) => e.reviewed).length;
const withSources = KB.entries.filter((e) => (e.sources || []).length).length;
const statutory = KB.entries.filter((e) => e.deadlineRule).length;
console.log(`\n词条 ${KB.entries.length} 条 ｜ 已人工核实 ${reviewed} 条 ｜ 有官方来源链接 ${withSources} 条`);
console.log(`其中 ${statutory} 条有法定期限规则可讲，其余 ${KB.entries.length - statutory} 条不讲期限（以信上印的为准）`);
console.log(`===== 知识库 ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
