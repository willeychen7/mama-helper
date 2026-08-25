const { extractLetterFields } = await import('./fieldExtractor.js');
let L=0;
const mk=(t,l,top,r,c=96)=>({id:L++,text:t,confidence:c,left:l,top,right:r,bottom:top+26,width:r-l,height:26,centerX:(l+r)/2,centerY:top+13});
const page=(rows)=>{L=0;return rows.flatMap((row,i)=>{const top=50+i*38;
  if(Array.isArray(row))return[mk(row[0],100,top,100+row[0].length*9),mk(row[1],830,top,940)];
  return[mk(row,100,top,Math.min(940,100+row.length*9))];});};
const TODAY=new Date('2026-08-25T00:00:00Z');

const CASES=[
{n:'SCE 电费', e:'电费账单', rows:['SOUTHERN CALIFORNIA EDISON','Your rate: TOU-D-4','Electricity Delivery Charges','Baseline Allowance 350 kWh','Generation Charges 412 kWh',['Total Amount Due','$188.40'],'Due Date 09/12/26']},
{n:'SoCalGas 天然气', e:'天然气账单', rows:['SOUTHERN CALIFORNIA GAS COMPANY','Natural Gas Service','Gas Charges for this period','Usage 41 therms','Gas meter read 08/01/26',['Total Amount Due','$62.15'],'Due Date 09/05/26']},
{n:'水费', e:'水费账单', rows:['VALLEY MUNICIPAL WATER DISTRICT','Water Service Charges','Water usage 14 HCF','Sewer service charge','Water meter read',['Total Amount Due','$97.30'],'Due Date 09/18/26']},
{n:'PG&E 水电气合并', e:'电费和天然气费账单', rows:['PACIFIC GAS AND ELECTRIC COMPANY','Electric Delivery Charges','Electricity usage 480 kWh','Generation Charges','Natural Gas Charges','Gas usage 22 therms','Gas service for this period',['Total Amount Due','$241.77'],'Due Date 09/20/26']},
{n:'垃圾费', e:'垃圾清运费', rows:['CITY WASTE MANAGEMENT SERVICES','Refuse Collection Service','Recycling service included','Trash collection quarterly charge','Sanitation service charges',['Amount Due','$88.00']]},
{n:'车险', e:'车险', rows:['STATE FARM MUTUAL AUTOMOBILE','Auto Policy Renewal Notice','Policy Number 123-4567-A','VIN 1HGCM82633A004352','Collision coverage $500 deductible','Comprehensive coverage','Uninsured motorist bodily injury','Listed drivers on this policy',['Premium Due','$742.00']]},
{n:'房屋保险', e:'房屋保险', rows:['ALLSTATE INSURANCE COMPANY','Homeowners Policy Declarations','Dwelling coverage $620,000','Personal property coverage','Loss of use coverage','Hazard insurance for your mortgage','Replacement cost of your home',['Annual Premium','$1,840.00']]},
{n:'人寿保险', e:'人寿保险', rows:['PACIFIC LIFE INSURANCE','Life Insurance Policy Statement','Whole life policy','Face amount $100,000','Death benefit payable','Beneficiary designation on file','Cash value as of this date']},
{n:'长期护理保险', e:'长期护理保险', rows:['GENWORTH LONG TERM CARE','Long-Term Care Policy Annual Statement','Nursing facility benefit per day','Assisted living benefit','Custodial care benefit included','Your long-term care insurance premium']},
];
let p=0,f=0;
CASES.forEach(c=>{
  const r=extractLetterFields(page(c.rows),{imageWidth:1000,imageHeight:1000,today:TODAY});
  const got=r.fields.category.cn; const ok=got===c.e; ok?p++:f++;
  console.log(`${ok?'✅':'❌'} ${(r.fields.urgency.symbol||'  ')} ${c.n}  →  ${got}${ok?'':`   ⚠ 期望 ${c.e}`}`);
  console.log(`      ${r.layer0.whatIsIt}  ${r.layer0.whoSentIt||''}`);
});
console.log(`\n===== ${p} 通过 / ${f} 失败 =====`);
