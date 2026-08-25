import fs from 'fs';
const { extractLetterFields } = await import('./fieldExtractor.js');
const ocr = JSON.parse(fs.readFileSync('demo_ocr_pp.json','utf8'));
const gt  = JSON.parse(fs.readFileSync('ground_truth.json','utf8'));
const DEFAULT_TODAY='2026-08-25';

const eqAmt=(a,b)=>{ if(a==null&&b==null)return true; if(a==null||b==null)return false; return Math.abs(a-b)<=0.005; };
let score={cat:[0,0],amt:[0,0],act:[0,0],date:[0,0]};
const rows=[];

for (const [name, truth] of Object.entries(gt)) {
  const doc = ocr[name]; if(!doc) continue;
  const r = extractLetterFields(doc.lines,{imageWidth:doc.width,imageHeight:doc.height,today:new Date((truth.today||DEFAULT_TODAY)+'T00:00:00Z')});
  const f = r.fields;

  // 类别：NOT_A_BILL 期望「未确定」
  const catGot = f.category.trusted ? f.category.id : 'UNTRUSTED';
  const catOk = truth.category==='NOT_A_BILL' ? (catGot==='UNTRUSTED') : (catGot===truth.category);

  // 金额是多少（不管要不要交）
  const amtGot = f.amount.trusted ? f.amount.value : null;
  const amtOk = eqAmt(amtGot, truth.amount_shown);

  // 该怎么付：要交 / 自动扣款 / 不用交 —— 这是独立的一个维度
  const actGot = f.amount.isPaymentDemand ? 'pay'
               : (f.amount.onAutopay ? 'autopay' : 'none');
  const actOk = actGot === truth.payment_action;

  const dateGot = f.dueDate.trusted ? f.dueDate.value : null;
  const dateOk = dateGot === truth.due_date;

  score.cat[0]+=catOk?1:0; score.cat[1]++;
  score.amt[0]+=amtOk?1:0; score.amt[1]++;
  score.act[0]+=actOk?1:0; score.act[1]++;
  score.date[0]+=dateOk?1:0; score.date[1]++;
  rows.push({name,catOk,catGot,amtOk,amtGot,amtWant:truth.amount_shown,actOk,actGot,actWant:truth.payment_action,dateOk,dateGot,dateWant:truth.due_date});
}

const ACT={pay:'要交',autopay:'自动扣款',none:'不用交'};
console.log('图'.padEnd(24)+'类别'.padEnd(20)+'金额'.padEnd(18)+'付款方式'.padEnd(20)+'到期日');
console.log('-'.repeat(104));
for(const r of rows){
  console.log(
    r.name.padEnd(24)+
    ((r.catOk?'✅ ':'❌ ')+r.catGot).padEnd(20)+
    ((r.amtOk?'✅ ':'❌ ')+(r.amtGot??'无')+(r.amtOk?'':` (应${r.amtWant})`)).padEnd(18)+
    ((r.actOk?'✅ ':'❌ ')+ACT[r.actGot]+(r.actOk?'':` (应${ACT[r.actWant]})`)).padEnd(20)+
    ((r.dateOk?'✅ ':'❌ ')+(r.dateGot||'无')+(r.dateOk?'':` (应为${r.dateWant||'无'})`)));
}
console.log('-'.repeat(104));
const pct=a=>`${a[0]}/${a[1]} ${Math.round(a[0]/a[1]*100)}%`;
console.log(`类别 ${pct(score.cat)}   金额 ${pct(score.amt)}   付款方式 ${pct(score.act)}   到期日 ${pct(score.date)}`);
