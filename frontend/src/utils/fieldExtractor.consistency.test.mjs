const { extractLetterFields } = await import('./fieldExtractor.js');
let L=0;
const mk=(t,l,top,r,c=96)=>({id:L++,text:t,confidence:c,left:l,top,right:r,bottom:top+26,width:r-l,height:26,centerX:(l+r)/2,centerY:top+13});
const page=(rows)=>{L=0;return rows.flatMap((row,i)=>{const top=50+i*38;
  if(Array.isArray(row))return[mk(row[0],100,top,100+row[0].length*9),mk(row[1],830,top,940)];
  return[mk(row,100,top,Math.min(940,100+row.length*9))];});};
const T=new Date('2026-08-25T00:00:00Z');

// 用户实拍的那封 Hoag 医院账单（照抄图上的文字）
const HOAG = page([
 'RETAIN THIS PORTION FOR YOUR RECORDS',
 'Hoag Orthopedic Institute',
 '500 Superior Ave. Suite 250',
 'Newport Beach, CA 92663-3662',
 'PFS@hoag.org',
 '949-764-8404',
 'RETURN SERVICE REQUESTED',
 'To pay your bill online, please visit www.orthopedichospital.com',
 'For your convenience your Online Biller ID is: 22222222',
 'PAGE: 1 of 1',
 'PATIENT NAME','Jane Doe',
 'ACCOUNT NUMBER','00112233',
 'STATEMENT DATE','10/19/18',
 ['AMOUNT YOU OWE','$333.33'],
 'AMOUNT PAID',
 'JANE DOE','1234 MOCKINGBIRD LANE.','NEWPORT BEACH, CA 92663',
 'HOAG ORTHOPEDIC INSTITUTE','MAILSTOP: 14294131','PO BOX 660064','DALLAS, TX 75266-0064',
]);

const CASES=[['Hoag 医院账单（用户实拍）',HOAG]];
// 四种确认组合，逐一检查大意句是否和下面的结论一致
const combos=[
 ['金额✓ 日期✓',['CITY WATER DISTRICT','Water Service Charges','Water usage 14 HCF',['Water charges','$40.00'],['Sewer charge','$30.00'],['Meter fee','$27.30'],['Total Amount Due','$97.30'],'Due Date 09/18/26']],
 ['金额✓ 日期✗',['CITY WATER DISTRICT','Water Service Charges','Water usage 14 HCF',['Water charges','$40.00'],['Sewer charge','$30.00'],['Meter fee','$27.30'],['Total Amount Due','$97.30']]],
 ['金额✗ 日期✓',['CITY WATER DISTRICT','Water Service Charges','Water usage 14 HCF','Due Date 09/18/26','Your account summary','Thank you for your payment']],
];
combos.forEach(([n,rows])=>CASES.push([n,page(rows)]));

let bad=0;
CASES.forEach(([n,lines])=>{
 const r=extractLetterFields(lines,{imageWidth:1000,imageHeight:1000,today:T});
 const l=r.layer0;
 console.log(`\n【${n}】 ${r.fields.urgency.flag}${r.fields.urgency.symbol}`);
 console.log('  ' + l.whatIsIt);
 console.log('  ' + (l.whoSentIt||''));
 console.log('  ' + (l.gist||''));
 console.log('  ' + (l.howMuch||''));
 console.log('  ' + (l.whenDue||'（无截止日期句）'));
 console.log('  提示: ' + r.fields.urgency.hint);
 if(l.uncertain.length) console.log('  没看准: ' + l.uncertain.join(' '));
 console.log('  建议: ' + l.advice);

 // 一致性断言
 const claimsDate = /确认了(?:[^，。]*和)?截止日期/.test(l.gist||'');
 const deniesDate = /没有找到明确的截止日期|没能确认/.test(l.whenDue||'') || !r.fields.dueDate.trusted;
 if (claimsDate && deniesDate){ console.log('  ❌ 矛盾：大意说确认了日期，实际没有'); bad++; }
 const claimsAmt = /确认了要交多少钱/.test(l.gist||'');
 if (claimsAmt && !r.fields.amount.isPaymentDemand){ console.log('  ❌ 矛盾：大意说确认了金额，实际没有'); bad++; }
});
console.log(`\n===== 矛盾 ${bad} 处 =====`);
