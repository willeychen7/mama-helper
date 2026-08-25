const { extractLetterFields } = await import('./fieldExtractor.js');
let L=0;
const mk=(t,l,top,r,c=96)=>({id:L++,text:t,confidence:c,left:l,top,right:r,bottom:top+26,width:r-l,height:26,centerX:(l+r)/2,centerY:top+13});
const page=(rows)=>{L=0;return rows.flatMap((row,i)=>{const top=50+i*38;
  if(Array.isArray(row))return[mk(row[0],100,top,100+row[0].length*9),mk(row[1],830,top,940)];
  return[mk(row,100,top,Math.min(940,100+row.length*9))];});};
const TODAY=new Date('2026-08-25T00:00:00Z');

// ============================================================
// 以下每一句都是从真实官方 PDF 里逐字抄来的
// ============================================================
const REAL = [
{ name:'CMS 官方 MSN 样本（Part A）', src:'cms.gov/…/sample-part-a-medicare-summary-notice.pdf',
  expect:{cat:'medicare',urg:'green',notBill:true}, rows:[
  'MEDICARE SUMMARY NOTICE',
  'THIS IS NOT A BILL',
  'Date of This Notice September 15, 2020',
  'Claims Processed Between June 15 – September 15, 2020',
  'Your Deductible Status',
  'Part A Deductible: You have now met your $1,184.00 deductible',
  'Your Claims & Costs This Period',
  'Did Medicare Approve All Claims? YES',
  ['Total You May Be Billed','$2,062.50'],
  'Your Inpatient Claims for Part A (Hospital Insurance)',
  'Appeals must be filed in writing',
  'Our claims office must receive your appeal within 120 days from the date you get this notice',
  'We must receive your appeal by: January 21, 2021' ]},

{ name:'DHCS 官方 Medi-Cal 年度复审通知', src:'dhcs.ca.gov/…/MC210RV_Notice.pdf',
  expect:{cat:'medi_cal',urg:'red'}, rows:[
  'MEDI-CAL ANNUAL REDETERMINATION NOTICE',
  'California Department of Health Care Services',
  'Fill out and return the form even if you think you may not be eligible',
  'send it back to us by 09/30/26',
  'If we do not get your completed form your Medi-Cal or health plan benefits may be stopped',
  'If you do not fill out and return the Annual Redetermination form we will take steps to stop your Medi-Cal' ]},

{ name:'加州中区联邦法院 真实陪审传票', src:'cacd.uscourts.gov/…/A1_2018 Jury Summons.pdf',
  expect:{cat:'court',urg:'red'}, rows:[
  'UNITED STATES DISTRICT COURT CENTRAL DISTRICT OF CALIFORNIA',
  'THE COURT SUMMONS YOU FOR JURY DUTY BEGINNING ON THE DATE, TIME, AND LOCATION SHOWN BELOW',
  'DATE 09/14/26   TIME 8:00 AM',
  'FAILURE TO OBEY THIS SUMMONS MAY RESULT IN A FINE OF NOT MORE THAN $1,000,',
  'IMPRISONMENT FOR NOT MORE THAN THREE DAYS, ORDER TO PERFORM COMMUNITY SERVICE,',
  'You must complete and submit a Juror Qualification Questionnaire within 10 days' ]},

{ name:'里弗赛德县 真实地税单措辞', src:'countytreasurer.org/current-secured-tax-bill-sample',
  expect:{cat:'property_tax',urg:'orange'}, rows:[
  'RIVERSIDE COUNTY TREASURER-TAX COLLECTOR',
  'ANNUAL SECURED PROPERTY TAX BILL',
  "Assessor's parcel number (APN) 934-221-014",
  ['Total Base Tax Amount','$4,281.10'],
  ['First Installment','$2,140.55'],
  ['Second Installment','$2,140.55'],
  'First Installment amount is due November 1st no later than December 10th',
  'First installment penalty of 10% if paid after the delinquency date of December 10th',
  'Second Installment penalty of 10% plus cost if paid after delinquency date of April 10th' ]},

{ name:'加州民法 5660 条 法定 HOA pre-lien 原文', src:'Cal. Civ. Code § 5660',
  expect:{cat:'hoa',urg:'red'}, rows:[
  'SUNRIDGE COMMUNITY ASSOCIATION',
  'NOTICE OF DELINQUENT ASSESSMENT',
  'IMPORTANT NOTICE: IF YOUR SEPARATE INTEREST IS PLACED IN FORECLOSURE',
  'BECAUSE YOU ARE BEHIND IN YOUR ASSESSMENTS, IT MAY BE SOLD WITHOUT COURT ACTION',
  'You have the right to request a payment plan and internal dispute resolution',
  ['Total Amount Due','$2,845.00'] ]},

{ name:'PG&E / RCEA 真实账单字段', src:'redwoodenergy.org/…/Understanding-Your-Bill-Residential-TOU.pdf',
  expect:{cat:'electric',urg:'orange'}, rows:[
  'PACIFIC GAS AND ELECTRIC COMPANY',
  'Account Number 1234567890-1',
  'Rate Schedule E-TOU-C',
  'PG&E Electric Delivery Charges',
  ['Total PG&E Electric Delivery Charges','$88.42'],
  'RCEA Electric Generation Charges',
  ['Total RCEA Electric Generation Charges','$61.13'],
  ['Franchise Fee Surcharge','$0.44'],
  ['Total Amount Due','$149.99'],
  'Due Date 09/10/26' ]}
];

let pass=0, fail=0;
REAL.forEach(c=>{
  const r=extractLetterFields(page(c.rows),{imageWidth:1000,imageHeight:1000,today:TODAY});
  const errs=[];
  if(r.fields.category.id!==c.expect.cat) errs.push(`类别 期望 ${c.expect.cat} 得到 ${r.fields.category.id}`);
  if(r.fields.urgency.level!==c.expect.urg) errs.push(`紧急度 期望 ${c.expect.urg} 得到 ${r.fields.urgency.level}`);
  if(c.expect.notBill && r.fields.amount.isPaymentDemand) errs.push('不是账单却说要交钱');
  const ok=errs.length===0; ok?pass++:fail++;
  console.log(`${ok?'✅':'❌'} ${r.fields.urgency.flag} ${c.name}`);
  console.log(`     来源: ${c.src}`);
  console.log(`     类别=${r.fields.category.cn} 机构=${r.fields.sender.display||'—'} 子类型=${r.fields.subtype?r.fields.subtype.id:'—'} 金额=${r.fields.amount.value??'—'} 日期=${r.fields.dueDate.value??'—'}`);
  console.log(`     命中句式: ${r.fields.phrases.map(p=>p.cn.slice(0,18)).join(' / ')||'（无）'}`);
  errs.forEach(e=>console.log('     ⚠ '+e));
  console.log('');
});
console.log(`===== 真实措辞 ${pass} 通过 / ${fail} 失败 =====`);
