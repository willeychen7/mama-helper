/**
 * contentRedactor.ownershipPipeline.test.mjs
 *
 * P0-C 的 Stage C：Redaction Precision ——「最后真正被保护的，
 * 是不是该保护的收件人 PII？」跑完整的 `buildTranslatablePayload`
 * 管线（Detection → Ownership → Redaction 三段都经过），不是只测
 * `classifyOwnership()` 本身（那是 Stage B，在 `piiOwnership.test.mjs`）。
 *
 * 三段 benchmark 的分工，方便以后看到漏项能定位到哪一段：
 *   Stage A Detection Recall   → `contentRedactor.recall.test.mjs`
 *                                 「真实存在的姓名/地址/电话，找到了吗」
 *   Stage B Ownership Accuracy → `piiOwnership.test.mjs`
 *                                 「找到以后，SENDER/RECIPIENT 判对了吗」
 *   Stage C Redaction Precision → 这份文件
 *                                 「最后真正放行的，有没有夹带不该放的」
 *
 * 这份文件重点测 SENDER 判定不能出现假阳性——机构信息被误判成
 * RECIPIENT/UNKNOWN 只是「少翻译一点」，但 RECIPIENT 信息被误判成
 * SENDER 会真的泄露，所以 precision 这里特指「放行的这些行里，
 * 有没有混进不该放的收件人信息」。
 */
import fs from 'fs';
const { buildTranslatablePayload } = await import('./contentRedactor.js');

let passed = 0;
let failed = 0;
const assert = (cond, label, detail) => {
  if (cond) passed += 1;
  else failed += 1;
  console.log(`  ${cond ? '✅' : '❌'} ${label}${cond ? '' : `\n      ${JSON.stringify(detail)}`}`);
};

console.log('=== att_bill（真实 OCR，bug 案例）：收件人公司名紧挨着，最终放行结果里不能有收件人地址 ===');
{
  const fixture = JSON.parse(
    fs.readFileSync('p1-results/fixture-regen-2026-08-29/fixture-regen-real.json', 'utf8')
  ).fixture;
  const doc = fixture.att_bill;
  const senderLineIndex = doc.lines.findIndex((l) => l.text === 'AT&T');

  const r = buildTranslatablePayload(doc.lines, {
    imageHeight: doc.height,
    senderLineIndex
  });
  const sentUpper = r.payloadText.toUpperCase();

  assert(
    !sentUpper.includes('WINDBELL'),
    'att_bill: 最终放行文本里不能出现收件人街道 WINDBELL',
    { coverage: r.stats.coverage }
  );
  assert(
    !sentUpper.includes('MESQUITE'),
    'att_bill: 最终放行文本里不能出现收件人城市 MESQUITE',
    { coverage: r.stats.coverage }
  );
  // precision 的另一面：不能矫枉过正，机构自己的账号说明不该跟着一起消失
  assert(
    r.stats.coverage > 20,
    'att_bill: 修 ownership bug 不该把覆盖率打崩（应该还能正常翻译大半页）',
    { coverage: r.stats.coverage }
  );
}

console.log('\n=== hoag（回归，非真实 fixture）：机构自己的地址/信箱必须继续放行，不能被 P0-C 误伤 ===');
{
  let L = 0;
  const mk = (t, top) => ({
    id: L++, text: t, confidence: 96,
    left: 100, top, right: 900, bottom: top + 26,
    width: 800, height: 26, centerX: 500, centerY: top + 13
  });
  const HOAG = [
    'HOAG ORTHOPEDIC INSTITUTE',
    '500 Superior Ave. Suite 250',
    'Newport Beach, CA 92663',
    'Questions about your bill? Call 949-764-8404',
    'or email PFS@hoag.org',
    'STATEMENT DATE  10/19/18',
    'ACCOUNT NUMBER: 00112233',
    'Online Biller ID: 22222222',
    'JANE DOE',
    '1234 MOCKINGBIRD LANE.',
    'ANYTOWN, CA 90210',
    'AMOUNT YOU OWE  $333.33',
    'Please detach and return the portion below with your payment',
    'HOAG ORTHOPEDIC INSTITUTE',
    'MAILSTOP: 14294131',
    'PO BOX 660064',
    'DALLAS, TX 75266-0064'
  ].map((t, i) => mk(t, 50 + i * 38));

  const r = buildTranslatablePayload(HOAG, { imageHeight: 1200, senderLineIndex: 0 });
  const sentUpper = r.payloadText.toUpperCase();

  assert(sentUpper.includes('500 SUPERIOR AVE'), 'hoag: 机构地址应该放行', { coverage: r.stats.coverage });
  assert(sentUpper.includes('PO BOX 660064'), 'hoag: 缴费信箱应该放行', { coverage: r.stats.coverage });
  assert(sentUpper.includes('AMOUNT YOU OWE'), 'hoag: 金额不能被连累误伤', { coverage: r.stats.coverage });
  assert(!sentUpper.includes('MOCKINGBIRD'), 'hoag: 收件人地址不能放行', { coverage: r.stats.coverage });
  assert(!sentUpper.includes('JANE DOE'), 'hoag: 收件人姓名不能放行', { coverage: r.stats.coverage });
}

console.log(`\n===== Redaction Precision: ${passed} 通过 / ${failed} 失败 =====`);
if (failed > 0) process.exitCode = 1;
