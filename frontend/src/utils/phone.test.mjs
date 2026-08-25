import fs from 'fs';
const { extractLetterFields } = await import('./fieldExtractor.js');
const gt=JSON.parse(fs.readFileSync('ground_truth.json','utf8'));
const ACT={pay:'要交',autopay:'自动扣款',none:'不用交'};
const run=(file,label)=>{
  const data=JSON.parse(fs.readFileSync(file,'utf8'));
  let s=[0,0]; const rows=[];
  for(const [n,d] of Object.entries(data)){
    const t=gt[n]; if(!t)continue;
    const r=extractLetterFields(d.lines,{imageWidth:d.width,imageHeight:d.height,today:new Date(t.today+'T00:00:00Z')});
    const f=r.fields;
    const amt=f.amount.trusted?f.amount.value:null;
    const act=f.amount.isPaymentDemand?'pay':(f.amount.onAutopay?'autopay':'none');
    const date=f.dueDate.trusted?f.dueDate.value:null;
    const catG=f.category.trusted?f.category.id:'UNTRUSTED';
    const ok=[catG===t.category,
      amt!==null?Math.abs(amt-(t.amount_shown??NaN))<=0.005:t.amount_shown==null,
      act===t.payment_action, date===t.due_date];
    ok.forEach(o=>{s[0]+=o?1:0;s[1]++;});
    rows.push([n,catG,amt,ACT[act],date,ok]);
  }
  console.log('\n### '+label);
  rows.forEach(([n,c,a,ac,dt,ok])=>console.log('  '+n.padEnd(22)+
    ((ok[0]?'✅':'❌')+c).padEnd(20)+((ok[1]?'✅':'❌')+(a??'无')).padEnd(18)+
    ((ok[2]?'✅':'❌')+ac).padEnd(18)+((ok[3]?'✅':'❌')+(dt||'无'))));
  console.log('  → '+s[0]+'/'+s[1]+'  '+Math.round(s[0]/s[1]*100)+'%');
  return s;
};
const a=run('demo_ocr_pp.json','数字扫描件');
const b=run('phone_ocr.json','手机实拍模拟（透视+阴影+失焦+JPEG）');
