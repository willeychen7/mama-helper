const { extractLetterFields } = await import('./fieldExtractor.js');
let L=0;
const mk=(t,l,top,r,c=99)=>({id:L++,text:t,confidence:c,left:l,top,right:r,bottom:top+26,width:r-l,height:26,centerX:(l+r)/2,centerY:top+13});
const page=(rows)=>{L=0;return rows.flatMap((row,i)=>{const top=50+i*38;
  if(Array.isArray(row))return[mk(row[0],100,top,100+row[0].length*9),mk(row[1],830,top,940)];
  return[mk(row,100,top,Math.min(940,100+row.length*9))];});};
const T=new Date('2024-03-01T00:00:00Z');

// 模拟 OCR 把总额的小数点吃掉：$88.42 -> $8842
const cases=[
 ['正常（有小数点）',[['SOUTHERN CALIFORNIA EDISON','']  ,'Electricity Delivery Charges','Usage 410 kWh',
   ['Delivery Charges','$52.10'],['Generation Charges','$33.94'],['Utility Tax','$2.38'],['Total Amount Due','$88.42']]],
 ['总额小数点被吃掉',[['SOUTHERN CALIFORNIA EDISON',''],'Electricity Delivery Charges','Usage 410 kWh',
   ['Delivery Charges','$52.10'],['Generation Charges','$33.94'],['Utility Tax','$2.38'],['Total Amount Due','$8842']]],
];
for(const [n,rows] of cases){
  const r=extractLetterFields(page(rows),{imageWidth:1000,imageHeight:1000,today:T});
  const f=r.fields;
  const chk=r.checks.find(c=>c.name==='decimal_point_sane');
  console.log(`\n【${n}】`);
  console.log('  金额='+f.amount.value+'  trusted='+f.amount.trusted+'  要交='+f.amount.isPaymentDemand);
  console.log('  小数点检查: '+(chk.passed?'PASS':'FAIL')+' — '+chk.detail);
  console.log('  老人看到: '+r.layer0.howMuch);
}
