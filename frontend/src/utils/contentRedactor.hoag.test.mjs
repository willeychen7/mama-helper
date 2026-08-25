/*
 * 脱敏断言 —— Hoag 医院账单缴费联
 *
 * 为什么单独为一封信写一个测试文件：
 * 脱敏是整个系统里唯一一个「漏了没有任何人会发现」的模块。
 * 金额错了有分项求和能拦，人名漏了没有任何校验和能验证它。
 * 所以这一层必须写成断言，不能只靠肉眼看输出。
 *
 * 这封信同时覆盖了两个方向的错误：
 *   放行过头 —— 收件人姓名/地址/账号被发出去（真实泄露）
 *   拦过头   —— 机构抬头、缴费信箱、医院电话被挡（翻译少了最实用的一半）
 *
 * 姓名地址是编的（JANE DOE / MOCKINGBIRD LANE），金额和版面照抄真实账单。
 */
const { buildTranslatablePayload } = await import('./contentRedactor.js');

let L = 0;
const mk = (t, top) => ({
  id: L++, text: t, confidence: 96,
  left: 100, top, right: 900, bottom: top + 26,
  width: 800, height: 26, centerX: 500, centerY: top + 13
});
const page = (rows) => { L = 0; return rows.map((t, i) => mk(t, 50 + i * 38)); };

const HOAG = page([
  // ── 页眉：医院抬头 + 医院地址 + 联系方式
  'HOAG ORTHOPEDIC INSTITUTE',
  '500 Superior Ave. Suite 250',
  'Newport Beach, CA 92663',
  'Questions about your bill? Call 949-764-8404',
  'or email PFS@hoag.org',
  // ── 账户栏
  'STATEMENT DATE  10/19/18',
  'ACCOUNT NUMBER: 00112233',
  'Online Biller ID: 22222222',
  // ── 信封窗口位置：收件人（老人）
  'JANE DOE',
  '1234 MOCKINGBIRD LANE.',
  'ANYTOWN, CA 90210',
  // ── 金额
  'AMOUNT YOU OWE  $333.33',
  // ── 撕下来寄回的缴费联：机构名再印一次，下面是缴费信箱
  'Please detach and return the portion below with your payment',
  'HOAG ORTHOPEDIC INSTITUTE',
  'MAILSTOP: 14294131',
  'PO BOX 660064',
  'DALLAS, TX 75266-0064'
]);

const r = buildTranslatablePayload(HOAG, { imageHeight: 1200 });
const withheldIdx = new Set(r.withheld.map((w) => w.index));
const textAt = (i) => HOAG[i].text;
const find = (frag) => HOAG.findIndex((l) => l.text.includes(frag));

let pass = 0;
let fail = 0;
const check = (label, frag, shouldWithhold) => {
  const i = find(frag);
  if (i < 0) { fail++; console.log(`❌ ${label} —— 测试数据里找不到「${frag}」`); return; }
  const got = withheldIdx.has(i);
  if (got === shouldWithhold) {
    pass++;
    console.log(`✅ ${shouldWithhold ? '拦下' : '放行'}  ${textAt(i).slice(0, 44)}`);
  } else {
    fail++;
    const reason = r.withheld.find((w) => w.index === i);
    console.log(
      `❌ ${label}\n     应该${shouldWithhold ? '拦下' : '放行'}，实际${got ? '拦下了' : '放行了'}` +
      `\n     行内容: ${textAt(i)}` +
      (reason ? `\n     拦下理由: ${reason.reasons[0]}` : '')
    );
  }
};

console.log('\n───── 应当放行：机构信息，挡了反而有害 ─────');
check('机构抬头', 'HOAG ORTHOPEDIC INSTITUTE', false);
check('机构地址', '500 Superior Ave', false);
check('机构城市', 'Newport Beach', false);
check('投递标签 MAILSTOP', 'MAILSTOP', false);
check('缴费信箱', 'PO BOX 660064', false);
check('信箱所在城市', 'DALLAS, TX', false);
check('缴费联抬头', 'Please detach', false);
check('金额（最不能误伤）', 'AMOUNT YOU OWE', false);
check('医院电话', '949-764-8404', false);
check('医院邮箱', 'PFS@hoag.org', false);

console.log('\n───── 应当拦下：收件人身份，漏了就是泄露 ─────');
check('收件人姓名', 'JANE DOE', true);
check('收件人地址', 'MOCKINGBIRD', true);
check('收件人城市', 'ANYTOWN', true);
check('账号', 'ACCOUNT NUMBER', true);
check('账户标识', 'Online Biller ID', true);

console.log(`\n覆盖率 ${r.stats.coverage}% ｜ 可外发 ${r.stats.sendableCount} 行 ｜ 拦下 ${r.stats.withheldCount} 行`);
console.log(`\n===== ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
