/*
 * 真实手机实拍 —— 第一封
 *
 * 来源：Waste Management 垃圾账单，用户自己用手机拍的（demo_image/waste_managment.webp）。
 * OCR 结果里没有姓名、地址、账号 —— 那些都在照片裁掉的下半截，
 * 留下的 "Customer ID" / "Invoice Number" 只是栏目标题，值不在图里。
 *
 * ── 这封信为什么重要 ──
 *
 * 之前六封都是扫描件或网上的公开样本。这是第一封真实实拍，
 * 而它一上来就暴露了一个扫描件永远暴露不了的问题：
 *
 *   照片顶部那一行「Your Payment is Due」被边缘切掉了上半截字母。
 *   全页 OCR 对它的反应不是「低置信度」，是**整行没有输出**。
 *   裁出来放大 4 倍重认，得到的是「YourPayueitisvue」——
 *   放大救不回不在图里的像素。
 *
 * 所以 $87.05（置信度 100.0）和 Jul 02, 2025（98.2）都认得清清楚楚，
 * 但它们**没有标签**，系统不知道这两个数是什么意思。
 *
 * ── 那什么才算通过 ──
 *
 * 不是「抽对金额」——信息不全的照片，抽对了反而是瞎猜。
 * 通过的标准是三条：
 *   1. 绝不说错（金额和日期要么有出处，要么不报）
 *   2. 绝不乱认（机构宁可「未知」，不能显示成 $87.05）
 *   3. 缺东西时告诉老人怎么补救；不缺就别啰嗦
 */
import fs from 'fs';
const { extractLetterFields } = await import('./fieldExtractor.js');

const doc = JSON.parse(fs.readFileSync('demo_ocr_photo.json', 'utf8')).wm_trash_bill;
const r = extractLetterFields(doc.lines, {
  imageWidth: doc.width,
  imageHeight: doc.height,
  today: new Date('2025-06-20T00:00:00Z')
});
const f = r.fields;
const l0 = r.layer0;

let pass = 0, fail = 0;
const check = (label, ok, detail) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? '✅' : '❌'} ${label}${ok ? '' : '\n     ' + detail}`);
};

console.log('\n── 实际输出 ──');
console.log('   机构  :', f.sender.display || f.sender.value || '未知');
console.log('   金额  :', f.amount.trusted ? f.amount.value : '没能确认');
console.log('   截止日:', f.dueDate.trusted ? f.dueDate.value : '没找到');
console.log('   提示  :', (l0.retakeHints || []).map((h) => h.reason).join(', ') || '（无）');
console.log('');

/*
 * 1 · 说出来的必须是对的
 *
 * 这条断言一天内改了四次。过程比结论有用，全留着：
 *
 *   v1  不能报出任何金额        抽不出来，报了就是瞎猜
 *   v2  金额 87.05 必须报对      放宽佐证（裸数字也算）之后能采信
 *   v3  不能报出任何金额        佐证收回 —— 裸数字会把 AT&T 的流量 3.46 当成钱
 *   v4  金额 87.05 必须报对      改用**正当路径**拿到（见下）
 *
 * v4 和 v2 结论一样，但走的路完全不同，这是重点：
 *
 *   v2 走的是「放松确认标准」—— 让证据不足的也过关
 *   v4 走的是「把信息读全」  —— 表头「Total Account」/「Balance Due」
 *                              被拆成两行印，合并起来匹配到
 *                              total account balance due（95 分），
 *                              超过 92 门槛，根本不需要佐证
 *
 * **判据从头到尾一次都没变**：能验证就说，不能验证就闭嘴。
 * 变的是「能不能读全」，不是「要不要验证」。
 */
check(
  '金额 87.05 报对了（两行表头合并后匹配到 95 分的明确总额）',
  f.amount.trusted && Math.abs(f.amount.value - 87.05) < 0.005 && f.amount.isPaymentDemand,
  `trusted=${f.amount.trusted} value=${f.amount.value}`
);
/*
 * 截止日期：标签被拍缺了，但信里另有一句
 *   「If payment is received after / 07/02/2025: $92.05」
 * 罚金措辞把最后期限说清楚了，所以这个日期是抽得出来的，不是猜的。
 *
 * 反过来还要确认：这个日期不能同时被当成发信日期
 * ——「不用在这天之前办什么」会把最后期限说反。
 */
check(
  '从罚金措辞里拿到截止日期 2025-07-02',
  f.dueDate.value === '2025-07-02',
  `报了 ${f.dueDate.value}`
);
check(
  '同一个日期没有被当成发信日期',
  !f.statementDate.trusted,
  `发信日期报了 ${f.statementDate.value}`
);

// 2 · 绝不乱认
const senderShown = f.sender.display || f.sender.value || null;
check(
  '机构没有被兜底成一个金额或网址',
  !senderShown || !/[$]|\d{2,}|\.(com|org|gov)/i.test(senderShown),
  `显示成了「${senderShown}」`
);

// 3 · 告诉老人怎么补救
const hints = l0.retakeHints || [];
/*
 * 金额和日期都拿到了，就不该再让老人重拍。
 * 提示只有在真的缺东西时才出现 —— 无谓的重拍要求会把人劝退。
 */
check(
  '金额和日期都拿到了，不再要求重拍',
  hints.length === 0,
  '仍然提示：' + hints.map((h) => h.field).join(',')
);
check(
  '提示只针对金额和日期，没有要求补拍隐私信息',
  hints.every((h) => /^(amount|dueDate|amount\+dueDate)$/.test(h.field)),
  '提示里出现了隐私字段：' + hints.map((h) => h.field).join(',')
);
check(
  '提示不重复（同一个原因只说一遍）',
  hints.length <= 1 || new Set(hints.map((h) => h.reason)).size === hints.length,
  `${hints.length} 条提示原因重复`
);

console.log(`\n===== 手机实拍 ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
