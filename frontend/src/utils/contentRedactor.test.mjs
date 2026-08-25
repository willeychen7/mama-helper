const { buildTranslatablePayload } = await import('./contentRedactor.js');
let L=0;
const mk=(t,top)=>({id:L++,text:t,confidence:96,left:100,top,right:900,bottom:top+26,width:800,height:26,centerX:500,centerY:top+13});
const page=(rows)=>{L=0;return rows.map((t,i)=>mk(t,50+i*38));};

// 真实 SCE 账单的 OCR 输出（照抄用户 console 里那份）
const REAL_SCE = page([
 "Go paperless at www.sce.com/ebilling. It's fast, easy and secure.",
 'EDISON','SOUTHERN CALIFORNIA','An EDISON INTERNATIONAL Company',
 'BAKER, NATE / Page 5 of 5',
 'Service account','8012345678',
 'Service address','1234 FIRST AVE','SIMI VALLEY, CA 93065',
 'POD-ID','123456789012345678',
 'Details of your new charges','CLEAN POWER ALLIANCE',
 'Your rate: TOU-D-4','Service Account: 8012345678',
 'Billing period: 01/06/24 to 02/05/24 (31 days)',
 'Generation Charges',
 'Clean Power - Mid-Peak - Winter 161.14 kWh @ 0.2106','$33.94',
 'User Utility Tax','$4.27',
 'Sub-Total of CPA Generation Charges','$99.36',
 'Your New Charges','$99.36',
 'Things you should know',
 'Clean Power Alliance service expands to 35 cities',
 'CPA welcomes our new customers in Hermosa Beach, Monrovia, and Santa Paula.',
 'Winter energy savings tip',
 'When you leave the house or before you go to sleep, turn the thermostat down.',
]);

const MEDICAL = page([
 'ANTHEM BLUE CROSS','EXPLANATION OF BENEFITS','THIS IS NOT A BILL',
 'Patient: JOHN SMITH','Member ID: XYZ123456789','Claim Number: 2024-0099887',
 'JANE DOE','1234 MOCKINGBIRD LANE','ANYTOWN, CA 90210',
 'Date of service June 18 2026',
 'Your plan paid the provider directly',
 'You may owe your provider the amount shown as patient responsibility',
 'Call the number on your member card if you disagree with this decision',
 'Dear Mrs. Chen, please review the enclosed statement',
]);

const show=(name,lines)=>{
  const r=buildTranslatablePayload(lines,{imageHeight:1200});
  console.log('\n######### '+name+' #########');
  console.log(`总行数 ${r.stats.total} ｜ 可外发 ${r.stats.sendableCount} ｜ 拦下 ${r.stats.withheldCount} ｜ 覆盖率 ${r.stats.coverage}%`);
  console.log('拦下的类型:', r.stats.withheldTypes.join(', ')||'（无）');
  console.log('\n--- 被拦下的行（内容不外传，这里只是本地调试显示）---');
  r.withheld.forEach(w=>console.log(`  [${w.index}] ${lines[w.index].text.slice(0,52)}`.padEnd(62)+' ← '+w.reasons[0]));
  console.log('\n--- 实际会发出去的文本 ---');
  console.log(r.payloadText.split('\n').map(l=>'  '+l).join('\n'));
};
show('真实 SCE 账单 OCR 输出', REAL_SCE);
show('保险 EOB', MEDICAL);
