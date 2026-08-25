const { extractLetterFields } = await import('./fieldExtractor.js');
let L=0;
const mk=(t,l,top,r,c=96)=>({id:L++,text:t,confidence:c,left:l,top,right:r,bottom:top+26,width:r-l,height:26,centerX:(l+r)/2,centerY:top+13});
const page=(rows)=>{L=0;return rows.flatMap((row,i)=>{const top=50+i*38;
  if(Array.isArray(row))return[mk(row[0],100,top,100+row[0].length*9),mk(row[1],830,top,940)];
  return[mk(row,100,top,Math.min(940,100+row.length*9))];});};
const T=new Date('2026-08-25T00:00:00Z');
const cases=[
 ['要付钱但没读到日期（原来自相矛盾的那个）',['SOUTHERN CALIFORNIA EDISON','Electricity Delivery Charges','Baseline Allowance 350 kWh',['Your New Charges','$99.36'],'Generation Charges','Details of your new charges']],
 ['有日期且很近',['SOUTHERN CALIFORNIA EDISON','Electric service charges','Usage 410 kWh',['Amount Due','$188.40'],'Due Date 08/29/26']],
 ['有日期还早',['SOUTHERN CALIFORNIA EDISON','Electric service charges','Usage 410 kWh',['Amount Due','$188.40'],'Due Date 11/20/26']],
 ['MSN 不用做事',['MEDICARE SUMMARY NOTICE','THIS IS NOT A BILL','Your Deductible Status','Your Claims & Costs This Period',['Total You May Be Billed','$2,062.50'],'Keep this notice for your records']],
];
cases.forEach(([n,rows])=>{
 const r=extractLetterFields(page(rows),{imageWidth:1000,imageHeight:1000,today:T});
 const u=r.fields.urgency;
 console.log(`\n【${n}】`);
 console.log(`  ${u.flag}${u.symbol} （${u.cn}）`);
 console.log(`  ${u.hint}`);
 console.log(`  ${r.layer0.howMuch||''}`);
 console.log(`  ${r.layer0.whenDue||'（无截止日期句）'}`);
});

console.log('\n\n===== 关键场景：金额确认了、但日期没读到 =====');
const r2=extractLetterFields(page([
 'SOUTHERN CALIFORNIA EDISON','Electricity Delivery Charges','Usage 410 kWh',
 ['Delivery Charges','$52.10'],['Generation Charges','$33.94'],['Utility Tax','$4.27'],
 ['Total Amount Due','$90.31'],'Details of your new charges'
]),{imageWidth:1000,imageHeight:1000,today:T});
console.log(`  ${r2.fields.urgency.flag}${r2.fields.urgency.symbol} （${r2.fields.urgency.cn}）`);
console.log(`  ${r2.fields.urgency.hint}`);
console.log(`  ${r2.layer0.howMuch}`);
console.log(`  ${r2.layer0.whenDue}`);
