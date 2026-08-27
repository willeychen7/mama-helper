/*
 * 第一梯队：OC 老人最常收到、也最容易读错的四类信
 *
 * 每一行都是从官方 PDF 逐字抄来的。来源写在每个用例的 src 里。
 * 凡是官方模板里留成占位符的（[Insert Date]、XXXXXX），
 * 要么原样保留，要么在 note 里写明「按真实寄出件填了日期」—— 不偷偷编。
 *
 * 这四类的共同点：**信上金额很大，但一分都不用交。**
 * 这正是最容易产生「自信的错误答案」的地方。
 */
const { extractLetterFields } = await import('./fieldExtractor.js');

let L = 0;
const mk = (t, l, top, r, c = 96) => ({
  id: L++, text: t, confidence: c,
  left: l, top, right: r, bottom: top + 26,
  width: r - l, height: 26, centerX: (l + r) / 2, centerY: top + 13
});
const page = (rows) => {
  L = 0;
  return rows.flatMap((row, i) => {
    const top = 50 + i * 38;
    if (Array.isArray(row))
      return [mk(row[0], 100, top, 100 + row[0].length * 9), mk(row[1], 830, top, 940)];
    return [mk(row, 100, top, Math.min(940, 100 + row.length * 9))];
  });
};

const CASES = [
{
  name: 'CMS 官方 EOB 样本（保险给付说明）',
  src: 'cms.gov/files/document/11819-sample-explanation-benefits-508.pdf',
  note: '官方样本，个人字段本来就是 XXXXXX 占位符，原样保留',
  today: '2022-04-15',
  expect: { notBill: true, noPaymentDemand: true, mustNotShowAmount: 406.60 },
  rows: [
  'Statement Date: XXXXXX',
  'Document Number: XXXXXXXXXX',
  'THIS IS NOT A BILL',
  'EXPLANATION OF BENEFITS',
  'Subscriber Number: XXXXXXXXXX',
  'Customer Service Number: 1-800-123-4567',
  'Patient Name: XXXXXX',
  'Claim Number: XXXXXXXX',
  'Line No. Service Description Date of Service Claim Status',
  'Provider Charges Allowed Charges Co Pay Deductible Coinsurance',
  'Paid by Insurer What You Owe Remark Code',
  ['1 Medical care 3/20/22-3/20/22 Paid', '$31.60'],
  ['2 Medical care 3/20/22-3/20/22 Paid', '$375.00'],
  ['Total', '$406.60'],
  ['Paid by Insurer', '$85.27'],
  ['What You Owe', '$35.00'],
  'Remark Code: PDC-Billed amount is higher than the maximum payment insurance allows.',
  'What You Owe is the amount you owe after your insurer has paid everything else.',
  'You may have already paid part of this amount.',
  'An EOB is NOT A BILL. You may get a separate bill from the provider.',
  'If you disagree with a coverage or payment decision by your health plan, you may be able to appeal.' ]
},
{
  name: 'OC 财政局 官方房产税缴款通知',
  src: 'octreasurer.gov/sites/ttc/files/2024-10/OC Register CNSB 3860184.pdf',
  note: '法定公告原文；税单抬头和金额按 OC 税单版面补齐',
  today: '2024-10-15',
  expect: { paymentDemand: true, dueDate: '2024-11-01' },
  rows: [
  'ORANGE COUNTY TREASURER-TAX COLLECTOR',
  'ANNUAL SECURED PROPERTY TAX BILL',
  'NOTICE OF CURRENT PROPERTY TAXES DUE',
  ["Assessor's Parcel Number", '934-221-014'],
  ['Total Amount Due', '$4,281.10'],
  ['First Installment', '$2,140.55'],
  ['Second Installment', '$2,140.55'],
  'The FIRST INSTALLMENT is due in full on November 1, 2024.',
  'The deadline to pay without penalty is December 10, 2024.',
  'The SECOND INSTALLMENT is due in full on February 1, 2025.',
  'The deadline to pay without penalty is April 10, 2025.',
  'A 10% late penalty plus a $23 delinquent charge will be added.',
  'PENALTIES WILL BE APPLIED TO THE SECOND INSTALLMENT if full payment of the first installment,',
  'including any late fees, is not received prior to April 10, 2025.' ]
},
{
  name: 'DHCS 官方 MC 216 白卡年度复审',
  src: 'dhcs.ca.gov/wp-content/uploads/2025/10/I15-14.pdf',
  note: '官方模板原文；[Insert Date] 按真实寄出件填成 09/30/26',
  today: '2026-08-25',
  expect: { cat: 'medi_cal', urg: 'red', noPaymentDemand: true },
  rows: [
  'MEDI-CAL RENEWAL FORM MC 216',
  'California Department of Health Care Services',
  'Your Medi-Cal is up for renewal.',
  'return this form or provide this information online by 09/30/26',
  'If you return this form by mail, please make sure to sign the form on page 8.',
  'If your renewal form is missing anything that we require, we will contact you to get it.',
  'If you do not provide it, we will not be able to make a decision on your renewal.',
  'You may have to submit a new application, or you may not be able to get health insurance',
  'through Covered California, or your application for benefits renewal may be denied.' ]
},
{
  name: 'Kaiser 2026 ANOC 明年计划变更通知',
  src: 'healthy.kaiserpermanente.org/…/annual-notice-of-changes-high-d-mas-dc.pdf',
  today: '2025-09-25',
  expect: { noPaymentDemand: true, mustNotShowAmount: 5700 },
  rows: [
  'Annual Notice of Change 2026',
  'Kaiser Permanente Medicare Advantage High DC',
  "This material describes changes to our plan's costs and benefits next year.",
  'You have from October 15 - December 7 to make changes to your Medicare coverage for next year.',
  "If you don't join another plan by December 7, 2025, you'll stay in Kaiser Permanente Medicare Advantage High DC.",
  'If you do nothing by December 7, 2025, you will automatically be enrolled.',
  ['Monthly plan premium', '$105'],
  ['Maximum out-of-pocket amount', '$5,700'],
  ['Part D drug coverage deductible', '$0'] ]
}
];

let pass = 0, fail = 0;
for (const c of CASES) {
  const r = extractLetterFields(page(c.rows), {
    imageWidth: 1000, imageHeight: 1000,
    today: new Date(c.today + 'T00:00:00Z')
  });
  const f = r.fields;
  const errs = [];
  const e = c.expect;

  if (e.cat && f.category.id !== e.cat) errs.push(`类别 期望 ${e.cat} 得到 ${f.category.id}`);
  if (e.urg && f.urgency.level !== e.urg) errs.push(`紧急度 期望 ${e.urg} 得到 ${f.urgency.level}`);
  if (e.notBill && !r.context?.explicitlyNotABill && f.amount.isPaymentDemand)
    errs.push('信上写着 NOT A BILL，却说要交钱');
  if (e.noPaymentDemand && f.amount.isPaymentDemand)
    errs.push(`不该要交钱，却说要交 ${f.amount.value}`);
  if (e.paymentDemand && !f.amount.isPaymentDemand)
    errs.push('这是真账单，却没认出要交钱');
  if (e.mustNotShowAmount != null && f.amount.trusted &&
      Math.abs(f.amount.value - e.mustNotShowAmount) < 0.005)
    errs.push(`把 ${e.mustNotShowAmount} 当成了应缴金额 —— 这是最危险的一类错`);
  if (e.dueDate !== undefined) {
    const got = f.dueDate.trusted ? f.dueDate.value : null;
    if (got !== e.dueDate) errs.push(`截止日期 期望 ${e.dueDate} 得到 ${got}`);
  }

  const ok = errs.length === 0;
  ok ? pass++ : fail++;
  console.log(`${ok ? '✅' : '❌'} ${f.urgency.flag} ${c.name}`);
  console.log(`     来源: ${c.src}`);
  if (c.note) console.log(`     说明: ${c.note}`);
  console.log(`     类别=${f.category.cn || f.category.id}  机构=${f.sender.display || '—'}  子类型=${f.subtype ? f.subtype.id : '—'}`);
  console.log(`     金额=${f.amount.trusted ? f.amount.value : '（不采信）'}  要交=${f.amount.isPaymentDemand}  自动扣款=${f.amount.onAutopay}`);
  console.log(`     截止日=${f.dueDate.trusted ? f.dueDate.value : '—'}  发信日=${f.statementDate && f.statementDate.trusted ? f.statementDate.value : '—'}`);
  console.log(`     老人看到: ${r.layer0.howMuch || '—'}`);
  console.log(`               ${r.layer0.whenDue || '—'}`);
  errs.forEach((x) => console.log('     ⚠ ' + x));
  console.log('');
}
console.log(`===== 第一梯队 ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
