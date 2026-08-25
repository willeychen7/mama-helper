import fs from 'fs';
const { extractLetterFields } = await import('./fieldExtractor.js');
const { buildTranslatablePayload } = await import('./contentRedactor.js');

const data = JSON.parse(fs.readFileSync('./demo_ocr_pp.json','utf8'));
const TODAY = new Date('2026-08-25T00:00:00Z');

for (const [name, doc] of Object.entries(data)) {
  const r = extractLetterFields(doc.lines, { imageWidth: doc.width, imageHeight: doc.height, today: TODAY });
  const red = buildTranslatablePayload(doc.lines, {
    imageHeight: doc.height,
    senderLineIndex: r.fields.sender?.box?.id ?? null
  });
  const l = r.layer0, u = r.fields.urgency;

  console.log('\n' + '='.repeat(72));
  console.log(`### ${name}   (${doc.lines.length} 行 OCR)`);
  console.log('='.repeat(72));
  console.log(`${u.flag}${u.symbol} （${u.cn}）  ${u.hint}`);
  console.log(`  类别   : ${r.fields.category.cn}   [${r.fields.category.id}]`);
  console.log(`  机构   : ${r.fields.sender.display || '—'}  (${r.fields.sender.cn || '未识别'})`);
  console.log(`  子类型 : ${r.fields.subtype ? r.fields.subtype.cn : '—'}`);
  console.log(`  金额   : ${r.fields.amount.value ?? '—'}  要交钱=${r.fields.amount.isPaymentDemand}  锚点="${r.fields.amount.anchorText||'—'}"`);
  console.log(`  日期   : ${r.fields.dueDate.value ?? '—'}  锚点="${r.fields.dueDate.anchorText||'—'}"`);
  console.log(`  分项   : ${JSON.stringify(r.fields.lineItems)}`);
  console.log('  --- 老人看到的 ---');
  ['whatIsIt','whoSentIt','gist','howMuch','whenDue'].forEach(k=>{ if(l[k]) console.log('    '+l[k]); });
  if (l.uncertain?.length) console.log('    没看准: ' + l.uncertain.join(' '));
  console.log('  --- 校验 ---');
  r.checks.forEach(c=>console.log(`    ${c.passed?'PASS':'FAIL'}  ${c.name}  ${c.detail}`));
  console.log(`  --- 脱敏: 可外发 ${red.stats.sendableCount}/${red.stats.total} (${red.stats.coverage}%) ---`);
  red.withheld.forEach(w=>console.log(`    🚫 "${doc.lines[w.index].text.slice(0,44)}"  ← ${w.reasons[0]}`));
}
