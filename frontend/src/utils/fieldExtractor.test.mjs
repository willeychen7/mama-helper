const { extractLetterFields } = await import('./fieldExtractor.js');

let L = 0;
const mk = (t, l, top, r, c = 96) => {
  const b = top + 26;
  return { id: L++, text: t, confidence: c, left: l, top, right: r, bottom: b,
    width: r - l, height: 26, centerX: (l + r) / 2, centerY: (top + b) / 2 };
};
// 从一组 "文字" 或 ["左文字","右金额"] 生成版面
const page = (rows) => {
  L = 0;
  return rows.flatMap((row, i) => {
    const top = 50 + i * 38;
    if (Array.isArray(row)) return [mk(row[0], 100, top, 100 + row[0].length * 9), mk(row[1], 830, top, 940)];
    return [mk(row, 100, top, Math.min(940, 100 + row.length * 9))];
  });
};

const TODAY = new Date('2026-08-25T00:00:00Z');

const CASES = [
{ name: 'Medicare 理赔汇总 MSN', expect: { cat: 'medicare', urg: 'green', org: 'Medicare' }, rows: [
  'MEDICARE SUMMARY NOTICE',
  'Medicare Number: 1EG4-TE5-MK73',
  'This is not a bill. Keep this notice for your records.',
  'Your deductible status and claims for July 2026',
  ['Total charges by providers', '$1,842.00'],
  ['Medicare approved', '$1,120.00'],
  ['Maximum you may be billed', '$224.00'] ]},

{ name: 'Medicare 计划变更 ANOC', expect: { cat: 'medicare', urg: 'orange' }, rows: [
  'ANNUAL NOTICE OF CHANGE for 2027',
  'Humana Gold Plus HMO',
  'Changes to your plan costs and benefits for next year',
  'Your monthly premium will change',
  'Review this notice before Open Enrollment ends' ]},

{ name: '白卡年度复审 Medi-Cal', expect: { cat: 'medi_cal', urg: 'red' }, rows: [
  'MEDI-CAL ANNUAL REDETERMINATION',
  'California Department of Health Care Services',
  'Keep your Medi-Cal coverage',
  'Complete and return the enclosed form MC 210 RV',
  'Your form must be received by 09/15/26',
  'If we do not hear from you your coverage will end' ]},

{ name: '社安金多付追讨', expect: { cat: 'social_security', urg: 'red', org: 'SSA' }, rows: [
  'SOCIAL SECURITY ADMINISTRATION',
  'NOTICE OF OVERPAYMENT',
  'We paid you $4,320.00 more than you were due',
  'You have 30 calendar days to request a waiver',
  'You have the right to appeal this decision',
  ['Amount you owe', '$4,320.00'] ]},

{ name: '社安金 COLA 调整', expect: { cat: 'social_security', urg: 'green' }, rows: [
  'SOCIAL SECURITY ADMINISTRATION',
  'Your New Benefit Amount',
  '2027 Cost-of-Living Adjustment (COLA)',
  'No action is required on your part',
  'Keep this notice for your records' ]},

{ name: 'CalPERS 退休金年度对账单', expect: { cat: 'pension', urg: 'green', org: 'CalPERS' }, rows: [
  'CalPERS Annual Member Statement',
  'Public Employees Retirement System',
  'Your retirement allowance for the year','Service credit and contributions on file','Beneficiary designation on record',
  'No action is needed at this time' ]},

{ name: 'HOA 留置权前置通知', expect: { cat: 'hoa', urg: 'red', org: 'HOA' }, rows: [
  'SUNRIDGE HOMEOWNERS ASSOCIATION',
  'PRE-LIEN NOTICE / NOTICE OF INTENT TO LIEN',
  'IMPORTANT NOTICE: IF YOUR SEPARATE INTEREST IS PLACED IN FORECLOSURE',
  'BECAUSE YOU ARE BEHIND IN YOUR ASSESSMENTS IT MAY BE SOLD',
  'WITHOUT COURT ACTION',
  'You have 30 days to pay the delinquent assessments',
  ['Total Amount Due', '$2,845.00'] ]},

{ name: '地税单', expect: { cat: 'property_tax', urg: 'orange' }, rows: [
  'ORANGE COUNTY TREASURER-TAX COLLECTOR',
  'ANNUAL SECURED PROPERTY TAX BILL',
  'Parcel Number: 934-221-14',
  'Assessed Value',
  ['First Installment', '$2,140.55'],
  ['Second Installment', '$2,140.55'],
  ['Total Amount Due', '$4,281.10'],
  'Due Date 12/10/26',
  'A 10% penalty will be added after the due date' ]},

{ name: '陪审团传票', expect: { cat: 'court', urg: 'red' }, rows: [
  'SUPERIOR COURT OF CALIFORNIA COUNTY OF ORANGE',
  'JURY SUMMONS',
  'Juror Number 4471200',
  'You must report for jury service',
  'Report to the courthouse on 09/08/26',
  'Failure to appear may result in a fine' ]},

{ name: '停电通知', expect: { cat: 'electric', urg: 'red', org: 'SCE' }, rows: [
  'SOUTHERN CALIFORNIA EDISON',
  'DISCONNECTION NOTICE',
  'Your electric service may be disconnected',
  'Your account is past due',
  ['Amount Due', '$412.66'],
  'Pay By 08/29/26' ]},

{ name: '定存到期', expect: { cat: 'bank', urg: 'orange' }, rows: [
  'EAST WEST BANK',
  'Certificate of Deposit Maturity Notice',
  'Your CD matures on 09/05/26',
  'You have a 10 day grace period',
  'Your CD will automatically renew at the current rate' ]},

{ name: '账户休眠上缴州府', expect: { cat: 'bank', urg: 'orange' }, rows: [
  'WELLS FARGO BANK',
  'Notice of Dormant Account',
  'Your account has been inactive',
  'These funds may be transferred to the state',
  'Contact us to keep your account active' ]},

{ name: 'DMV 注册续期', expect: { cat: 'dmv', urg: 'orange', org: 'DMV' }, rows: [
  'CALIFORNIA DEPARTMENT OF MOTOR VEHICLES',
  'VEHICLE REGISTRATION RENEWAL NOTICE',
  'License Plate 8ABC123',
  'Smog certification is required',
  ['Total Amount Due', '$389.00'],
  'Due Date 09/30/26' ]},

{ name: '移民局补件 RFE', expect: { cat: 'immigration', urg: 'red', org: 'USCIS' }, rows: [
  'U.S. CITIZENSHIP AND IMMIGRATION SERVICES',
  'REQUEST FOR EVIDENCE',
  'Form I-485 Receipt Number MSC2190123456',
  'Additional evidence is needed to continue processing',
  'Your response must be received by 10/20/26' ]},

{ name: '★ 诈骗信：假 Medicare 新卡', expect: { cat: 'ANY', urg: 'red', scam: true }, rows: [
  'MEDICARE BENEFITS DEPARTMENT',
  'Your new Medicare card has been approved',
  'Verify your Medicare number to receive your card',
  'A $29.95 processing fee is required to mail your new card',
  'Your benefits will be cancelled unless you respond within 48 hours',
  'Call this number immediately' ]},

{ name: '★ 诈骗信：中奖', expect: { cat: 'ANY', urg: 'red', scam: true }, rows: [
  'NATIONAL PRIZE CLEARINGHOUSE',
  'You have won a cash award of $850,000',
  'Claim your prize within 24 hours',
  'Send your bank account number to receive payment',
  'Payment of taxes by wire transfer or gift card is required' ]},

{ name: '广告推销', expect: { cat: 'marketing', urg: 'green' }, rows: [
  'FINAL EXPENSE INSURANCE',
  'You may qualify for coverage with no obligation',
  'Limited time special offer',
  'Apply now — call today' ]}
];

let pass = 0, fail = 0;
const failures = [];

CASES.forEach((c) => {
  const r = extractLetterFields(page(c.rows), { imageWidth: 1000, imageHeight: 1000, today: TODAY });
  const got = { cat: r.fields.category.id, urg: r.fields.urgency.level,
                org: r.fields.sender.display, scam: r.fields.scam.suspected };
  const errs = [];
  if (c.expect.cat !== 'ANY' && got.cat !== c.expect.cat) errs.push(`类别 期望 ${c.expect.cat} 得到 ${got.cat}`);
  if (got.urg !== c.expect.urg) errs.push(`紧急度 期望 ${c.expect.urg} 得到 ${got.urg}`);
  if (c.expect.org && got.org !== c.expect.org) errs.push(`机构 期望 ${c.expect.org} 得到 ${got.org}`);
  if (c.expect.scam && !got.scam) errs.push('应判为诈骗但没有');
  if (!c.expect.scam && got.scam) errs.push('误判为诈骗');

  const ok = errs.length === 0;
  ok ? pass++ : fail++;
  if (!ok) failures.push({ c, r, errs });

  console.log(`${ok ? '✅' : '❌'} ${r.fields.urgency.flag} ${c.name}`);
  console.log(`     类别=${r.fields.category.cn}  机构=${got.org || '—'}  子类型=${r.fields.subtype ? r.fields.subtype.id : '—'}  金额=${r.fields.amount.value ?? '—'}  日期=${r.fields.dueDate.value ?? '—'}`);
  if (!ok) errs.forEach(e => console.log('     ⚠ ' + e));
});

console.log(`\n===== ${pass} 通过 / ${fail} 失败 =====`);
if (failures.length) {
  console.log('\n--- 失败详情 ---');
  failures.forEach(({ c, r }) => {
    console.log('\n### ' + c.name);
    console.log('  urgency reasons:', JSON.stringify(r.fields.urgency.reasons));
    console.log('  category score:', r.fields.category.trusted, r.fields.category.cn);
    console.log('  phrases:', r.fields.phrases.map(p => p.intent).join(','));
    console.log('  scam score:', r.fields.scam.score, r.fields.scam.hits.map(h=>h.cn).join(' | '));
  });
}
