/**
 * piiSyntheticBenchmark.test.mjs
 *
 * P0-A（用户在 2026-08-29 定的顺序）：PHONE / EMAIL / SSN / DOB 这四类
 * 语料库里现在一个真实正样本都没有（见 journal 同日的诊断记录），
 * 但又不能像 P1 那次一样，在没有证据的情况下先动检测规则。
 *
 * 折中方案（用户拍板）：先用**手写的合成样本**（跟
 * `contentRedactor.hoag.test.mjs` 同一个方法——假姓名假号码，但版式、
 * 位置、措辞尽量贴近真实信件）测"现有检测器认不认得这些形状"。
 *
 * **这份测试的结论边界必须写清楚**：
 *   - 能回答：现有正则形状匹配得对不对、常见的措辞变体漏不漏。
 *   - 不能回答：真实 OCR 把这些号码识别错/拆断之后还认不认得——
 *     P1 那次教训就是「合成/过时样本 ≠ 真实 OCR 行为」，这份合成
 *     benchmark 同样受这条限制，不能当成"已经验证过真实场景"。
 *   - 每类只写了 5 个合成案例，不是统计意义上的大样本，只是先把
 *     "有没有明显漏洞"这个问题的答案摸出来。
 *
 * PHONE/EMAIL/SSN 用的正则是从 `App.jsx` 的 `PII_PATTERNS` 原样抄过来的
 * （逐字复制，不是重新设计）——那边是 JSX 文件不能直接 import，所以
 * 这里镜像一份只用于测试判断，不修改 App.jsx 本身。如果以后
 * `PII_PATTERNS` 改了，这里要跟着同步，不然会跟真实行为脱节。
 */
import { buildTranslatablePayload, looksLikeName } from './contentRedactor.js';

let passed = 0;
let failed = 0;
const results = [];
const assert = (cond, label, detail) => {
  if (cond) passed += 1;
  else failed += 1;
  results.push({ pass: cond, label, detail });
};

// ============================================================
// 镜像 App.jsx 的 PII_PATTERNS（只取 SSN/EMAIL/PHONE，其余类型跟这次
// 测试无关）——见文件头注释，逐字复制，不是重新设计。
// ============================================================
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE_RE = /(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]\d{3}[\s.-]\d{4}\b/g;

const detectStructuredPII = (text) => {
  SSN_RE.lastIndex = 0;
  EMAIL_RE.lastIndex = 0;
  PHONE_RE.lastIndex = 0;
  return {
    ssn: SSN_RE.test(text),
    email: EMAIL_RE.test(text),
    phone: PHONE_RE.test(text)
  };
};

/*
 * `contentRedactor.js` 本身不认识 PHONE/SSN——`buildTranslatablePayload`
 * 靠调用方注入的 `detectPII` 回调来接入这些结构化 PII 类型
 * （真实 `App.jsx` 传的是 `detectLocalPII`）。这次不 import App.jsx
 * （JSX 文件），用上面镜像的三条正则拼一个形状一致的 mock 回调，
 * 保证测的是"跟生产环境同样接线方式"下的整行判定结果，不是孤立测
 * 正则本身对不对——正则对不对和整行会不会被挡，是两个不同的问题，
 * 之前不小心把两者混在一起量过一次，这次分开测、分开记。
 */
const mockDetectPII = (text) => {
  const detections = [];
  if (detectStructuredPII(text).ssn) detections.push({ type: 'SSN' });
  if (detectStructuredPII(text).email) detections.push({ type: 'EMAIL' });
  if (detectStructuredPII(text).phone) detections.push({ type: 'PHONE' });
  return { detections };
};

// ============================================================
// 造一个假的、只有一行的"文档"，跑一遍 buildTranslatablePayload，
// 看这一行会不会被判定成「不能外发」——
// 用的是跟 contentRedactor.hoag.test.mjs 一样的最小 OCR 行结构。
// ============================================================
let L = 0;
const mk = (t, top = 100) => ({
  id: L++, text: t, confidence: 96,
  left: 100, top, right: 900, bottom: top + 26,
  width: 800, height: 26, centerX: 500, centerY: top + 13
});

/**
 * 把一行放进一封"合成信"的上下文里跑（前后各垫几行普通账单文字，
 * 不是孤零零一行——真实信件里 PII 总是嵌在别的文字中间）。
 */
const runInContext = (targetText) => {
  L = 0;
  const lines = [
    mk('ACME UTILITY COMPANY', 40),
    mk('Account Summary', 70),
    mk(targetText, 300),
    mk('Please contact us with any questions.', 340),
    mk('Total Amount Due: $45.00', 400)
  ];
  const targetIndex = 2;
  const payload = buildTranslatablePayload(lines, { imageHeight: 900, detectPII: mockDetectPII });
  const withheld = payload.withheld.some((w) => w.index === targetIndex);
  const structured = detectStructuredPII(targetText);
  return { withheld, structured };
};


console.log('=== PHONE（个人电话，应该被挡住）===');
const phoneCases = [
  'Home Phone: (562) 555-0134',
  'Contact number: 562-555-0134',
  'Cell: 562.555.0134',
  'Phone: 5625550134',
  'You can reach me at 562-555-0134'
];
phoneCases.forEach((c) => {
  const { withheld, structured } = runInContext(c);
  console.log(`  ${structured.phone ? '✅ 正则认出来了' : '❌ 正则没认出来'} | ${withheld ? '✅ 整行被挡' : '❌ 整行没挡'} | ${JSON.stringify(c)}`);
  assert(structured.phone, `PHONE 正则应识别: ${c}`, structured);
  /*
   * 2026-08-29 发现的回归点：正则认出来了不代表整行真的被挡——
   * isOrgContactLine 之前只看「离机构名够不够近」，不看内容本身，
   * runInContext 的合成信里电话行离信头「ACME UTILITY COMPANY」只有
   * 2 行，于是被误判成机构联系方式、整行放行。这条断言就是防止它
   * 再犯。
   */
  assert(withheld, `PHONE 整行应被挡（不能因为离信头近就被当成机构号码）: ${c}`, { withheld, structured });
});

console.log('\n=== EMAIL（个人邮箱，应该被挡住）===');
const emailCases = [
  'Email: johnsmith82@gmail.com',
  'E-mail address: j.smith@yahoo.com',
  'Contact email: jsmith1945@aol.com',
  'johnsmith82@gmail.com',
  'My email is john.smith82@outlook.com'
];
emailCases.forEach((c) => {
  const { withheld, structured } = runInContext(c);
  console.log(`  ${structured.email ? '✅ 正则认出来了' : '❌ 正则没认出来'} | ${withheld ? '✅ 整行被挡' : '❌ 整行没挡'} | ${JSON.stringify(c)}`);
  assert(structured.email, `EMAIL 正则应识别: ${c}`, structured);
});

console.log('\n=== SSN（含常见的部分打码写法）===');
const ssnCases = [
  { text: 'SSN: 123-45-6789', note: '完整格式，标准写法' },
  { text: 'Social Security Number: 123-45-6789', note: '完整格式，带标签' },
  { text: 'SSN: XXX-XX-6789', note: '真实信件最常见的部分打码写法——只印后 4 位' },
  { text: 'SSN ending in 6789', note: '另一种常见部分打码写法' },
  { text: 'Social Security #: 123456789', note: '完整号码但没有分隔符' }
];
ssnCases.forEach(({ text: c, note }) => {
  const { withheld, structured } = runInContext(c);
  console.log(`  ${structured.ssn ? '✅ 正则认出来了' : '❌ 正则没认出来'} | ${withheld ? '✅ 整行被挡' : '❌ 整行没挡'} | ${JSON.stringify(c)} —— ${note}`);
  // 这里不 assert 全部通过——故意保留失败，用真实数字暴露正则形状覆盖不到的写法，
  // 这正是这份 benchmark 要回答的问题。
  results.push({ pass: structured.ssn, label: `SSN 正则: ${c}`, detail: note, informational: true });
});

console.log('\n=== DOB（出生日期——项目里现在没有这类检测器，预期全部漏检）===');
const dobCases = [
  'Date of Birth: 03/15/1945',
  'DOB: 03/15/1945',
  'Born: March 15, 1945',
  'D.O.B. 03-15-1945',
  'Birthdate: 1945-03-15'
];
let dobCaught = 0;
dobCases.forEach((c) => {
  const { withheld } = runInContext(c);
  if (withheld) dobCaught += 1;
  console.log(`  ${withheld ? '⚠️ 被挡了（意外，查一下是不是撞上了别的规则）' : '❌ 没挡住（预期内——没有 DOB 检测器）'} | ${JSON.stringify(c)}`);
});
console.log(`  DOB 整体：${dobCaught}/${dobCases.length} 被挡住——${dobCaught === 0 ? '确认是完全空白，不是部分漏检' : '⚠️ 有意外命中，需要查是撞上了哪条现有规则'}`);


// ============================================================
// 负样本：机构自己的联系方式不应该被挡（复查一下这次新造的合成
// 上下文有没有意外把该放行的内容也挡住）
// ============================================================
console.log('\n=== 负样本：机构联系方式不应该被误挡 ===');
const orgCases = [
  { text: 'Customer Service: (800) 555-0100', note: '机构客服电话' },
  { text: 'billing@acmeutility.com', note: '机构账单邮箱' }
];
orgCases.forEach(({ text: c, note }) => {
  L = 0;
  const lines = [
    mk('ACME UTILITY COMPANY', 40),
    mk('For billing questions, contact us:', 70),
    mk(c, 100),
    mk('Total Amount Due: $45.00', 400)
  ];
  const payload = buildTranslatablePayload(lines, { imageHeight: 900, detectPII: mockDetectPII });
  const withheld = payload.withheld.some((w) => w.index === 2);
  console.log(`  ${withheld ? '❌ 被误挡了' : '✅ 正确放行'} | ${JSON.stringify(c)} —— ${note}`);
  assert(!withheld, `机构联系方式不应被挡: ${c}`, note);
});


console.log(`\n===== PII 合成 benchmark：${passed} 通过 / ${failed} 失败 =====`);
console.log('（SSN 那一段的失败没有计入上面的通过/失败统计，是故意的——见代码注释，那部分本身就是要暴露缺口）');

if (failed > 0) process.exitCode = 1;
