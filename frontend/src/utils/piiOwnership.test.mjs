/**
 * piiOwnership.test.mjs
 *
 * P0-C 的 Stage B：Ownership Accuracy ——「找到候选之后，判断
 * SENDER/RECIPIENT 判对了吗」。这份测试只测 `classifyOwnership()`
 * 本身，不跑完整的 `buildTranslatablePayload` 管线（Stage C 在
 * `contentRedactor.ownershipPipeline.test.mjs` 里测，那份测的是
 * 「最后真正被保护的是不是该保护的」——Detection Recall 在
 * `contentRedactor.recall.test.mjs`，三份合起来是完整的三段式
 * benchmark，具体分工写在 ownershipPipeline 那份文件头）。
 *
 * 按用户要求先写这份测试，确认复现了两个真实 bug（对着旧逻辑跑，
 * 这份测试里断言的是"正确答案"，所以在旧 isOrgContactLine 逻辑下
 * 会失败），再动 contentRedactor.js 把这套逻辑接进管线。
 *
 * 每条断言都记录了用到了哪些 evidence，方便以后分析哪类证据最有效
 * （用户明确要求的一点）。
 */
import fs from 'fs';
const { classifyOwnership } = await import('./piiOwnership.js');
// buildContextMap 没有导出，这里复刻一份最小实现只用于测试组装 ctx——
// 跟 contentRedactor.js 里那份保持同步（不 import 是因为那边没导出）。
const { buildTranslatablePayload } = await import('./contentRedactor.js');

let passed = 0;
let failed = 0;
const results = [];
const assert = (cond, label, detail) => {
  if (cond) passed += 1;
  else failed += 1;
  results.push({ pass: cond, label, detail });
  console.log(`  ${cond ? '✅' : '❌'} ${label}${cond ? '' : `\n      ${JSON.stringify(detail)}`}`);
};

/*
 * classifyOwnership 需要 ctx（nearOrg/nearPerson/domainMatchesOrg），
 * 这些是 contentRedactor.js 内部私有的 buildContextMap 产物，没有导出。
 * 用真实管线跑一遍 buildTranslatablePayload 拿不到 ctx 本身，所以这里
 * 用一个足够用的最小实现——只覆盖这份测试需要的两个信号，不追求跟
 * 生产实现字节对字节一致（生产实现的行为由 Stage C 的端到端测试保证）。
 */
const STRONG_ORG_HINTS_LOCAL =
  /\b(inc|llc|llp|ltd|plc|corp|corporation|company|association|institute|hospital|clinic|infirmary|bank|credit\s*union|university|college|district|bureau|agency|administration|court|authority|foundation|mutual|insurance|assurance|permanente|kaiser|edison|alliance|associates|physicians|orthopedic|cardiology|radiology|laboratory|pharmacy|department\s*of|board\s*of|office\s*of|city\s*of|county\s*of|state\s*of)\b/i;

const buildMinimalCtx = (lines) => {
  const orgAnchors = [];
  lines.forEach((l, i) => {
    if (STRONG_ORG_HINTS_LOCAL.test(String(l.text || ''))) orgAnchors.push(i);
  });
  const within = (list, index, span) => list.some((i) => Math.abs(i - index) <= span);
  return {
    domainMatchesOrg: () => false,
    nearOrg: (index, span = 3) => within(orgAnchors, index, span),
    nearPerson: () => false
  };
};

console.log('=== A. 真实案例：att_bill（bug 案例——收件人公司名紧挨着，收件人地址不该被当机构地址）===');
{
  const fixturePath = 'p1-results/fixture-regen-2026-08-29/fixture-regen-real.json';
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')).fixture;
  const doc = fixture.att_bill;
  const lines = doc.lines;
  const ctx = buildMinimalCtx(lines);

  const senderIdx = lines.findIndex((l) => l.text === 'AT&T');
  const windbellIdx = lines.findIndex((l) => l.text === '924 WINDBELL CIR');
  const mesquiteIdx = lines.findIndex((l) => /^MESQUITE/.test(l.text));

  console.log(`  senderLineIndex(AT&T)=${senderIdx} windbellIdx=${windbellIdx} mesquiteIdx=${mesquiteIdx}`);

  const r1 = classifyOwnership({ index: windbellIdx, lines, ctx, senderLineIndex: senderIdx });
  console.log(`  WINDBELL CIR -> role=${r1.role} score=${r1.score} evidence=${JSON.stringify(r1.evidence)}`);
  assert(r1.role !== 'SENDER', 'att_bill: 收件人地址「924 WINDBELL CIR」不该被判成 SENDER', r1);

  const r2 = classifyOwnership({ index: mesquiteIdx, lines, ctx, senderLineIndex: senderIdx });
  console.log(`  MESQUITE... -> role=${r2.role} score=${r2.score} evidence=${JSON.stringify(r2.evidence)}`);
  assert(r2.role !== 'SENDER', 'att_bill: 收件人城市「MESQUITE...」不该被判成 SENDER', r2);
}

console.log('\n=== B. 真实案例：hoag（回归——机构自己的地址/信箱必须继续判成 SENDER，不能因为这次改动被误伤）===');
{
  let L = 0;
  const mk = (t, top, left = 100) => ({
    id: L++, text: t, confidence: 96,
    left, top, right: left + 800, bottom: top + 26,
    width: 800, height: 26, centerX: left + 400, centerY: top + 13
  });
  const lines = [
    mk('HOAG ORTHOPEDIC INSTITUTE', 50),
    mk('500 Superior Ave. Suite 250', 88),
    mk('Newport Beach, CA 92663', 126),
    mk('Questions about your bill? Call 949-764-8404', 164),
    mk('JANE DOE', 240),
    mk('1234 MOCKINGBIRD LANE.', 278),
    mk('ANYTOWN, CA 90210', 316),
    mk('Please detach and return the portion below with your payment', 392),
    mk('HOAG ORTHOPEDIC INSTITUTE', 430),
    mk('MAILSTOP: 14294131', 468),
    mk('PO BOX 660064', 506),
    mk('DALLAS, TX 75266-0064', 544)
  ];
  const ctx = buildMinimalCtx(lines);
  const senderIdx = 0;

  const check = (idx, label, expectRole) => {
    const r = classifyOwnership({ index: idx, lines, ctx, senderLineIndex: senderIdx });
    console.log(`  ${label} -> role=${r.role} score=${r.score} evidence=${JSON.stringify(r.evidence)}`);
    assert(r.role === expectRole, `hoag: ${label} 应判成 ${expectRole}`, r);
  };

  check(1, '500 Superior Ave（机构地址）', 'SENDER');
  check(2, 'Newport Beach, CA（机构城市）', 'SENDER');
  check(10, 'PO BOX 660064（缴费信箱）', 'SENDER');
  check(11, 'DALLAS, TX（信箱所在城市）', 'SENDER');

  /*
   * 这两条不断言严格等于 RECIPIENT——这份测试用的 buildMinimalCtx
   * 没有实现 personAnchors/addresseeBlock（那是 findAddresseeBlock 的
   * 职责，真实管线里由它给出决定性的 recipient_block 证据）。这里只
   * 断言最关键的不变式：收件人自己的地址不能被判成 SENDER 而放行。
   * RECIPIENT vs UNKNOWN 的精确区分留给 Stage C 的端到端管线测试
   * （那边有真实的 addresseeBlock）。
   */
  const r5 = classifyOwnership({ index: 5, lines, ctx, senderLineIndex: senderIdx });
  console.log(`  1234 MOCKINGBIRD LANE（收件人地址） -> role=${r5.role} score=${r5.score} evidence=${JSON.stringify(r5.evidence)}`);
  assert(r5.role !== 'SENDER', 'hoag: 收件人地址不该被判成 SENDER', r5);

  const r6 = classifyOwnership({ index: 6, lines, ctx, senderLineIndex: senderIdx });
  console.log(`  ANYTOWN, CA（收件人城市） -> role=${r6.role} score=${r6.score} evidence=${JSON.stringify(r6.evidence)}`);
  assert(r6.role !== 'SENDER', 'hoag: 收件人城市不该被判成 SENDER', r6);
}

/*
 * 证据使用频率统计——用户明确要求的一点：以后要能分析「哪类证据
 * 最有效」，不能只看最终 pass/fail。这里只统计出现次数，不是有效性
 * 打分（样本量太小，8 条断言撑不起有效性结论），先把统计口径搭起来，
 * 等真实样本更多之后再看某类证据是不是经常出现在判错的案例里。
 */
const evidenceFreq = {};
results.forEach((r) => {
  const ev = (r.detail && r.detail.evidence) || [];
  ev.forEach((e) => {
    evidenceFreq[e] = evidenceFreq[e] || { total: 0, inFailedCase: 0 };
    evidenceFreq[e].total += 1;
    if (!r.pass) evidenceFreq[e].inFailedCase += 1;
  });
});
console.log('\n证据使用频率（这次跑的 8 条断言里）：');
Object.entries(evidenceFreq)
  .sort((a, b) => b[1].total - a[1].total)
  .forEach(([name, stat]) => {
    console.log(`  ${name}: 出现 ${stat.total} 次${stat.inFailedCase ? `（其中 ${stat.inFailedCase} 次在判错的案例里）` : ''}`);
  });

console.log(`\n===== Ownership Accuracy: ${passed} 通过 / ${failed} 失败 =====`);
if (failed > 0) process.exitCode = 1;
