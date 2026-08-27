/*
 * 朗读文本的安全断言
 *
 * 念错东西是隐私事故，不是体验问题 —— 老人多半不是一个人在房间里用这个 app。
 * 所以这里断言的核心是一条：
 *
 *     **朗读只念模板拼出来的中文，绝不念 OCR 原文。**
 *
 * 模板里永远不会出现姓名和地址（它们根本没被放进 layer0），
 * 所以只要 buildSpeechText 只从 layer0 取字段，就结构上不可能念出 PII。
 * 这个测试就是钉住「只从 layer0 取」这件事。
 */
import fs from 'fs';
const { buildSpeechText } = await import('./speech.js');
const { extractLetterFields } = await import('./fieldExtractor.js');

let pass = 0, fail = 0;
const check = (label, ok, detail) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? '✅' : '❌'} ${label}${ok ? '' : '\n     ' + detail}`);
};

// ── 1 · 真实账单：念出来的东西必须干净 ──
const ocr = JSON.parse(fs.readFileSync('demo_ocr_pp.json', 'utf8'));
const gt = JSON.parse(fs.readFileSync('ground_truth.json', 'utf8'));

for (const [name, doc] of Object.entries(ocr)) {
  const truth = gt[name];
  if (!truth) continue;
  const r = extractLetterFields(doc.lines, {
    imageWidth: doc.width,
    imageHeight: doc.height,
    today: new Date((truth.today || '2026-08-27') + 'T00:00:00Z')
  });
  const spoken = buildSpeechText(r.layer0);

  // 这几个是测试图里的（编造的）姓名和地址，一个都不许出现在朗读文本里
  const forbidden = [
    'BAKER', 'NATE', 'JANE DOE', 'SMITH', 'BRENDA', 'John Smith',
    'MOCKINGBIRD', 'FIRST AVE', 'SIMI VALLEY', 'ANYTOWN',
    '8012345678', '00112233', '123 A St'
  ];
  const leaked = forbidden.filter((w) => spoken.toUpperCase().includes(w.toUpperCase()));
  check(`${name}：朗读文本里没有姓名/地址/账号`, leaked.length === 0, '泄露了：' + leaked.join(', '));

  // 不该整段照抄 OCR 原文
  const looksLikeRawOcr = /[A-Za-z]{25,}/.test(spoken.replace(/\s/g, ''));
  check(`${name}：没有夹带 OCR 原文`, !looksLikeRawOcr, spoken.slice(0, 90));
}

// ── 2 · 内容顺序：先说要紧的 ──
const l0 = {
  scamWarning: { reasons: ['信里要求用礼品卡付款。'] },
  whatIsIt: '这是一封电费账单。',
  whoSentIt: '寄件的是 SCE。',
  gist: '账单大意。',
  howMuch: '要交 99.36 美元。',
  whenDue: '请在 2024年5月1日 之前处理。',
  sentOn: '这封信写于 2024年4月1日。',
  retakeHints: [{ field: 'amount', reason: 'label-missing', cn: '请重拍顶部。' }],
  advice: '拿不准就问家里人。'
};
const t = buildSpeechText(l0);
check('诈骗警告念在最前面', t.startsWith('注意，这封信有可疑的地方。'), t.slice(0, 40));
check('金额念在截止日期之前', t.indexOf('要交 99.36') < t.indexOf('2024年5月1日'), t);
check('重拍提示也会念出来', t.includes('请重拍顶部'), t);
check('空输入不炸', buildSpeechText(null) === '' && buildSpeechText({}) === '', '返回了非空');

console.log(`\n===== 朗读 ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
