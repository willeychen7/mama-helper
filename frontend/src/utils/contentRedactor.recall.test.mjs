/*
 * 脱敏召回率 —— 这个项目里唯一一把量「漏没漏」的尺子
 *
 * ── 为什么必须有 ──
 *
 * 脱敏是整个系统里**唯一一个漏了没有任何人会发现**的模块。
 * 金额错了有分项求和能拦、日期错了有陈旧判定能拦，
 * 而一个人名漏出去，没有任何校验和会响。
 *
 * 之前只有一封 Hoag 信上的 15 条断言，等于只测了一个点。
 * 30 秒的临时诊断就发现两封信在漏 —— 说明我们一直不知道自己有多差。
 *
 * ── 按 HIPAA Safe Harbor 的 18 类分组 ──
 *
 * 不是为了合规（我们目前**不声称**符合 Safe Harbor），
 * 是因为那 18 类是一份现成的、行业公认的、有边界的清单。
 * 自己拍脑袋列「要挡什么」一定会漏，用别人验证过的清单不会。
 *
 * 将来真要向机构声称什么，也得先能逐类拿出数字。
 *
 * ── 标注规则 ──
 *
 * 每一项都是**照着原图**列的，不是照 OCR 结果列的。
 * OCR 认错的（比如把 S 认成 $）按 OCR 实际输出写，并在后面标注。
 */
import fs from 'fs';
const { buildTranslatablePayload } = await import('./contentRedactor.js');

/*
 * 2026-08-30：换成真实 OCR 引擎（PP-OCRv6）重新跑过的 fixture——
 * 旧的 demo_ocr_pp.json/demo_ocr_photo.json 是 P1 那次诊断之前的
 * 老版本，很多姓名/地址漏检其实是「旧 OCR 把它们粘连成一个词」
 * 导致的，跟今天的真实 OCR 输出已经不是同一回事（见 P1 结论：
 * 那几个粘连案例用当前引擎重跑后全部不再复现）。用旧 fixture 打
 * 出来的召回率数字，测的是过时的 OCR 行为，不是正则/语境判断今天
 * 真实的表现。
 *
 * 新 fixture 分两批：
 *   fixture-regen-2026-08-29  头一批 15 封（不含 IRS_cp503 / SCE_Bill_Letter）
 *   fixture-regen-2026-08-30  补跑 SCE_Bill_Letter + IRS_cp503（IRS 由 PDF
 *                             用 qlmanage 渲染成 300dpi PNG 后再跑）
 * 后一批 merge 在前一批之上。还没上真实 fixture 的信（hoag-invoice-mychart）
 * 继续用旧 fixture 兜底，缺口在下面输出里会标出来。
 */
const FRESH_FIXTURE_PATHS = [
  'p1-results/fixture-regen-2026-08-29/fixture-regen-real.json',
  'p1-results/fixture-regen-2026-08-30/fixture-regen-real.json'
];
const oldDocs = {
  ...JSON.parse(fs.readFileSync('demo_ocr_pp.json', 'utf8')),
  ...JSON.parse(fs.readFileSync('demo_ocr_photo.json', 'utf8'))
};
let freshDocs = {};
for (const p of FRESH_FIXTURE_PATHS) {
  try {
    freshDocs = { ...freshDocs, ...(JSON.parse(fs.readFileSync(p, 'utf8')).fixture || {}) };
  } catch (err) {
    console.log(`⚠️ 读不到新 fixture（${p}）：${err.message}`);
  }
}
const docs = { ...oldDocs, ...freshDocs };
const freshNames = new Set(Object.keys(freshDocs));

/*
 * hipaa: Safe Harbor 18 类里的第几类（用来分组统计）
 *   1 姓名 · 2 比州小的地理信息 · 5 电话 · 7 邮箱
 *   10 保险会员号 · 11 账号 · 12 证照号
 */
const LABELS = {
  SCE_Bill_Letter: [
    { text: 'BAKER, NATE', hipaa: 1, note: '收件人姓名，「姓, 名」格式' },
    /*
     * 2026-08-30：换成 fixture-regen-2026-08-30 的真实 PP-OCRv6 输出后，
     * 这两行不再粘连——'1234FIRSTAVE'→'1234 FIRST AVE'、
     * 'SIMIVALLEY'→'SIMI VALLEY, CA'。断言文本同步改回带空格的形态
     * （用粘连形态断言等于「测试自己假装挡住了」）。这两行是否真的被挡，
     * 由下面的 leak 检查如实反映——之前担心的「紧挨 CLEAN POWER
     * ALLIANCE / EDISON 被当机构地址放行」在新 OCR 上是否复现，看跑分。
     */
    { text: '1234 FIRST AVE', hipaa: 2, note: '服务地址（老人自己的），紧挨机构名' },
    { text: 'SIMI VALLEY', hipaa: 2, note: '服务地址所在城市' },
    { text: '8012345678', hipaa: 11, note: '服务账号' },
    { text: '123456789012345678', hipaa: 11, note: 'POD-ID' }
  ],
  'hoag-invoice-mychart': [
    { text: 'JANE DOE', hipaa: 1, note: '收件人姓名' },
    { text: 'MOCKINGBIRD', hipaa: 2, note: '收件人街道' },
    { text: 'ANYTOWN', hipaa: 2, note: '收件人城市' },
    { text: '00112233', hipaa: 11, note: '账号' },
    { text: '22222222', hipaa: 11, note: 'Online Biller ID' }
  ],
  statefarm_bill: [
    { text: 'SMITH', hipaa: 1, note: '收件人姓' },
    { text: 'BRENDA', hipaa: 1, note: '收件人名' },
    { text: 'GREAT TRI FO WAY', hipaa: 2, note: '收件人街道' },
    { text: '04-EW-D206-9', hipaa: 12, note: '保单号' }
  ],
  water_bill: [
    { text: 'John Smith', hipaa: 1, note: '收件人姓名，「名 姓」格式 —— 正则抓不到' },
    { text: '123 A St', hipaa: 2, note: '收件人街道' },
    { text: 'OAK VIEW', hipaa: 2, note: '收件人城市' }
  ],
  att_bill: [
    { text: 'WINDBELL', hipaa: 2, note: '收件人街道' },
    { text: 'MESQUITE', hipaa: 2, note: '收件人城市' },
    { text: '287289569829', hipaa: 11, note: '账号' },
    { text: '58037035', hipaa: 11, note: 'Foundation Account' }
  ],
  IRS_cp503: [
    /*
     * 2026-08-30：从 fixture-regen-2026-08-30 的真实 PP-OCRv6 输出重标
     * （之前用的是旧 fixture，PDF 没跑进去）。旧 fixture 里这几行全是
     * 粘连的（JAMES&KARENQ.HINDS / 22BOULDERSTREET / HANSON,CT00000-7253 /
     * James Q.Hinds），新 OCR 全部带空格分开了——原图本来就是分开的，
     * 粘连是旧 OCR 的假象。断言文本同步改成新 OCR 的实际输出。
     */
    { text: 'JAMES & KAREN Q. HINDS', hipaa: 1, note: '收件人姓名（官方示例姓名，非真人）' },
    { text: '22 BOULDER STREET', hipaa: 2, note: '收件人街道' },
    { text: 'HANSON, CT 00000-7253', hipaa: 2, note: '收件人城市州邮编' },
    { text: 'James Q. Hinds', hipaa: 1, note: '收件人姓名第二次出现（付款联）——被任务 3B 的 NER 交叉核对带出来，之前人工标注也漏标了' }
  ],
  DMV_Registration: [
    { text: 'GONZELES C', hipaa: 1, note: '收件人姓名（官方示例姓名，非真人），「姓 名首字母」格式' },
    { text: '3615 S H0PE ST', hipaa: 2, note: '收件人街道；OCR 把 O 认成了 0' },
    { text: 'LOS ANGELES', hipaa: 2, note: '收件人城市' }
  ],
  Medicare_Notice: [
    { text: 'JENNIFERWASHINGTON', hipaa: 1, note: '收件人姓名（官方示例姓名，非真人），「名 姓」格式，OCR 粘连——这正是正则抓不到的那种形状' },
    { text: '1A23BC4DE56', hipaa: 10, note: 'Medicare Number' }
  ],
  SoCalGas: [
    { text: 'JOHNBDOE', hipaa: 1, note: '收件人姓名（官方示例姓名，非真人），OCR 粘连' },
    { text: '24915APPLE CT', hipaa: 2, note: '收件人街道，OCR 粘连' },
    { text: 'MONTEREYPARKCA91754-2217', hipaa: 2, note: '收件人城市州邮编，OCR 粘连' }
  ],
  /*
   * 决定 11 之后新扩的样本——之前只标注了 9 封信，
   * 这两封是仓库里剩下的 demo 样本中，真的带着可辨认真人 PII（不是
   * 官方示例姓名、不是已经泛化成 ANY CITY / VALUED CUSTOMER 的模板）的。
   * 其余没扩的样本（SCE_Letter 是写给州监管机构的商务信；IRS_cp501 /
   * IRS_CP504_Notice 原图上就是字面的 TAXPAYERNAME / ADDRESS 占位符；
   * aaa-policy_renew 会员名那一栏是空的；ca-dmv-registration-fee 是纯
   * 收费代码表；SCE_Sample_Bill 通篇是 VALUED CUSTOMER / ANY CITY 泛化
   * 模板；wm_trash_bill 这页没有姓名地址）——这些信里没有可测的真实 PII，
   * 不是漏标，是没有能标的东西。
   */
  Hospital_Bill: [
    { text: 'JANEDOE', hipaa: 1, note: '收件人姓名，OCR 粘连（原文 "iJANEDOE" / "JANEDOE:"）' },
    { text: '123ANYSTREET', hipaa: 2, note: '收件人街道，OCR 粘连（原文 ":123ANYSTREET"）' },
    { text: 'MINNEAPOLISMN55480-9125', hipaa: 2, note: '收件人城市州邮编，OCR 粘连' },
    { text: '0000000', hipaa: 11, note: '账号（页面上出现两次）' }
  ],
  Medical_Invoice: [
    { text: 'Aaron Brown', hipaa: 1, note: '收件人姓名（"Bill To" 字段），「名 姓」格式 —— 正则抓不到' }
  ]
};

const HIPAA_NAME = {
  1: '姓名',
  2: '地理信息（街道/城市/邮编）',
  5: '电话',
  7: '邮箱',
  10: '保险会员号',
  11: '账号',
  12: '证照/保单号'
};

const byCat = {};
const leaks = [];
let total = 0, caught = 0;

for (const [name, items] of Object.entries(LABELS)) {
  const doc = docs[name];
  if (!doc) continue;
  const r = buildTranslatablePayload(doc.lines, { imageHeight: doc.height });
  const sent = r.payloadText.toUpperCase();

  for (const item of items) {
    total += 1;
    byCat[item.hipaa] = byCat[item.hipaa] || { total: 0, caught: 0, missed: [] };
    byCat[item.hipaa].total += 1;

    const leaked = sent.includes(item.text.toUpperCase());
    if (leaked) {
      leaks.push({ letter: name, ...item });
      byCat[item.hipaa].missed.push(`${name}: ${item.text}`);
    } else {
      caught += 1;
      byCat[item.hipaa].caught += 1;
    }
  }
}

const staleNames = Object.keys(LABELS).filter((n) => docs[n] && !freshNames.has(n));
if (staleNames.length) {
  console.log(`⚠️ 这 ${staleNames.length} 封信还在用旧 fixture（不是当前真实 OCR 输出）：${staleNames.join('、')}\n`);
}

console.log('按 HIPAA Safe Harbor 分类的召回率');
console.log('─'.repeat(66));
for (const cat of Object.keys(byCat).sort((a, b) => a - b)) {
  const c = byCat[cat];
  const pct = Math.round((c.caught / c.total) * 100);
  const bar = pct === 100 ? '✅' : pct >= 80 ? '🟠' : '🔴';
  console.log(`${bar} ${String(cat).padStart(2)} ${(HIPAA_NAME[cat] || '?').padEnd(26)} ${c.caught}/${c.total}  ${pct}%`);
  c.missed.forEach((m) => console.log(`      漏：${m}`));
}
console.log('─'.repeat(66));
const pct = Math.round((caught / total) * 100);
console.log(`总计 ${caught}/${total}  ${pct}%   （${Object.keys(LABELS).length} 封信）`);

/*
 * ── 门槛 ──
 *
 * 现在故意设成「不许比现状更差」，而不是「必须 100%」。
 *
 * 定成 100% 的话这个测试今天就是红的，红着的测试等于没有测试 ——
 * 大家会习惯性忽略它。定成现状，任何**新的**泄露会立刻被抓到，
 * 而已知的那几个漏在下面单独列着，不会被忘掉。
 *
 * 每修好一个，就把门槛往上调一格。
 */
/*
 * 2026-08-30：换成真实 OCR fixture 之后从 25 升到 29（不是正则变强了，
 * 是之前那几条漏检本来就是旧 OCR 粘连的假象，P1 的结论）；同一天做完
 * P0-C 的 ownership 三段式拆分之后，att_bill 的机构名误判修好，
 * 29 → 30；顺手修复的 looksLikeName 全大写形状不再要求「在页面上方」
 * 又从 30 → 31（付款联/回执区重印的收件人姓名之前全靠一个无关 bug的
 * 副作用碰巧被护住，那个 bug 修好之后这里裸奔了，属于同一轮改动
 * 连带发现的）。
 *
 * 2026-08-30（第二次）：SCE_Bill_Letter + IRS_cp503 也上了真实 PP-OCRv6
 * fixture（fixture-regen-2026-08-30，IRS 由 PDF 用 qlmanage 渲染成 300dpi
 * PNG 后再跑）。旧 fixture 里这两封的街道/城市/姓名全是粘连的，新 OCR
 * 全部带空格分开——4 条漏检（SCE「1234 FIRST AVE」、IRS「JAMES & KAREN
 * Q. HINDS」/「22 BOULDER STREET」/「HANSON, CT 00000-7253」）直接被现有
 * 逻辑挡住，31 → 35，跟第一次一样是「旧 OCR 假象消失」，不是正则变强。
 * 真实剩下 3 条，全是 Detection 层形状缺口（没有 OCR / Ownership /
 * Redaction 层的漏）：DMV_Registration「GONZELES C」（姓 首字母，未重跑）、
 * SCE_Bill_Letter「SIMI VALLEY, CA」（城市+州、无 ZIP 的单行不命中地址
 * 正则）、IRS_cp503 付款联「James Q. Hinds」（名 中间名首字母 姓，
 * looksLikeName 混排分支只认两个词）。只剩 hoag-invoice-mychart 还在旧
 * fixture 上。
 */
const BASELINE = 35;
console.log(`\n门槛：至少挡住 ${BASELINE}/${total}（今天的水平，只许升不许降）`);

const known = leaks.map((l) => `${l.letter} · ${l.text}（${l.note}）`);
if (known.length) {
  console.log('\n已知还在漏的：');
  known.forEach((k) => console.log('  🔴 ' + k));
}

console.log(`\n===== 脱敏召回 ${caught}/${total} =====`);
process.exit(caught < BASELINE ? 1 : 0);
