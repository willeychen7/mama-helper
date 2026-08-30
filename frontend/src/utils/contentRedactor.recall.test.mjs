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
 * 新 fixture 目前只覆盖了 15 封信里的一部分（IRS_cp503 是 PDF，
 * 没跑进去；SCE_Bill_Letter / hoag-invoice-mychart 也不在这批里）——
 * 这几封暂时还是用旧 fixture 兜底，缺口在下面输出里会标出来。
 */
const FRESH_FIXTURE_PATH = 'p1-results/fixture-regen-2026-08-29/fixture-regen-real.json';
const oldDocs = {
  ...JSON.parse(fs.readFileSync('demo_ocr_pp.json', 'utf8')),
  ...JSON.parse(fs.readFileSync('demo_ocr_photo.json', 'utf8'))
};
let freshDocs = {};
try {
  freshDocs = JSON.parse(fs.readFileSync(FRESH_FIXTURE_PATH, 'utf8')).fixture || {};
} catch (err) {
  console.log(`⚠️ 读不到新 fixture（${FRESH_FIXTURE_PATH}），全部回退到旧 fixture：${err.message}`);
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
     * 原来这两条断言写的是带空格的 '1234 FIRST AVE' / 'SIMI VALLEY'，
     * 但真实 OCR 输出是无空格粘连的 '1234FIRSTAVE' / 'SIMIVALLEY'——
     * 带空格的写法在粘连文本里永远搜不到，等于测试自己一直在假装挡住了。
     * 改成粘连形态后才发现这两行其实一直在泄露：
     * 「Service address」紧挨着「CLEAN POWER ALLIANCE」「EDISON」这些
     * STRONG_ORG_HINTS 命中的机构名，isOrgContactLine 把它当成了机构地址
     * 放行——但它明明是老人自己的服务地址，不是机构地址。
     * 地址正则本身也不认粘连形态（和刚修的姓名 bug 同一类根因）。
     * 这两处先如实记成「已知漏」，正则/语境判断怎么修留到后续任务。
     */
    { text: '1234FIRSTAVE', hipaa: 2, note: '服务地址（老人自己的），紧挨机构名被当成机构地址放行，OCR 粘连' },
    { text: 'SIMIVALLEY', hipaa: 2, note: '服务地址所在城市，同上，OCR 粘连' },
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
    { text: 'JAMES&KARENQ.HINDS', hipaa: 1, note: '收件人姓名（官方示例姓名，非真人），OCR 粘连成一个词' },
    { text: '22BOULDERSTREET', hipaa: 2, note: '收件人街道，OCR 粘连' },
    { text: 'HANSON,CT00000-7253', hipaa: 2, note: '收件人城市州邮编，OCR 粘连' },
    /*
     * 这条不是靠肉眼标注找到的，是任务 3B 做 NER A/B 测试时，compromise
     * 在其余 3 条已知漏检上全部交白卷，却顺手抓出了这条——付款联那一段
     * 里同一个人名的第二次出现，跟第一次（JAMES&KARENQ.HINDS，全大写粘连）
     * 长得完全不一样："James Q.Hinds"，中间名首字母跟姓氏粘连（"Q.Hinds"
     * 中间没有空格）。现有正则要求中间名和姓氏之间有空格，这里没有，所以
     * 一直没被挡住——这次之前的人工标注也漏标了，是被 NER 交叉核对带出来的。
     */
    { text: 'James Q.Hinds', hipaa: 1, note: '收件人姓名第二次出现（付款联），中间名首字母跟姓氏粘连（"Q.Hinds" 没空格）——被任务 3B 的 NER 交叉核对带出来，之前人工标注也漏标了' }
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
 * 2026-08-30：换成真实 OCR fixture 之后从 25 升到 29——不是正则变强了，
 * 是之前那几条漏检本来就是旧 OCR 粘连的假象（P1 的结论）。真实剩下的
 * 缺口是 att_bill（机构名误判，见同日 journal）和 DMV_Registration
 * （姓名格式没覆盖到），跟 3 封还没上真实 fixture 的信（IRS_cp503 /
 * SCE_Bill_Letter / hoag-invoice-mychart）。
 */
const BASELINE = 29;
console.log(`\n门槛：至少挡住 ${BASELINE}/${total}（今天的水平，只许升不许降）`);

const known = leaks.map((l) => `${l.letter} · ${l.text}（${l.note}）`);
if (known.length) {
  console.log('\n已知还在漏的：');
  known.forEach((k) => console.log('  🔴 ' + k));
}

console.log(`\n===== 脱敏召回 ${caught}/${total} =====`);
process.exit(caught < BASELINE ? 1 : 0);
