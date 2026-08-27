/*
 * 美国信件理解知识库 —— 匹配与组合
 *
 * ── 这一层负责什么 ──
 *   知识库回答「**这类**信是什么、通常要做什么、不做会怎样」。
 *   它对手上这一封信的具体情况一无所知，也**不该**知道。
 *
 * ── 这一层绝不负责什么 ──
 *   金额、日期、机构名 —— 这些永远来自 fieldExtractor 的本地抽取 + 交叉校验，
 *   在最后一步才拼进来。
 *
 *   为什么分得这么死：知识是静态的（白卡复审的规则今年明年一样、张三李四一样），
 *   事实是每封信不同的。一旦让知识库说出「您要交 87.05 美元」，
 *   它就从「知识」变成了「可能过期的谎话」，而且没有任何办法验算。
 *   见 journal 决定 01。
 */

import KB from './knowledge.json' with { type: 'json' };

const compile = (list) =>
  (list || []).map((src) => {
    try {
      return new RegExp(src, 'i');
    } catch {
      return null;
    }
  }).filter(Boolean);

const ENTRIES = (KB.entries || []).map((e) => ({
  ...e,
  _strong: compile(e.signals && e.signals.strong),
  _weak: compile(e.signals && e.signals.weak)
}));

export const knowledgeVersion = KB.version;
export const allEntries = ENTRIES;

/*
 * 多标签匹配 —— 不是单选。
 *
 * 一封信可以同时是好几类：HOA 违规通知里带催缴、医院账单同时是催收信。
 * 硬选一个会丢掉真正要紧的那一面，所以返回**排序后的全部命中**，
 * 由上层决定说几个。
 *
 * 计分刻意做得很笨：强信号 10 分，弱信号 3 分，各自封顶。
 * 复杂的打分函数在这个项目里翻过车（只凭机构名 8 分就够门槛，
 * 把 SCE 的监管公函判成了电费账单），所以宁可笨一点、看得懂一点。
 */
export const matchDocumentTypes = (text, options = {}) => {
  const haystack = String(text || '');
  if (!haystack.trim()) return [];

  const results = [];

  for (const entry of ENTRIES) {
    const strongHits = entry._strong.filter((re) => re.test(haystack));
    const weakHits = entry._weak.filter((re) => re.test(haystack));

    // 一条强信号都没有、弱信号又少于两条 —— 不算命中
    if (!strongHits.length && weakHits.length < 2) continue;

    const score =
      Math.min(strongHits.length, 3) * 10 + Math.min(weakHits.length, 4) * 3;

    results.push({
      id: entry.id,
      cn: entry.cn,
      en: entry.en,
      group: entry.group,
      score,
      strongCount: strongHits.length,
      // 证据要能被人核对 —— 说不出理由的判断不该被信
      evidence: [...strongHits, ...weakHits].slice(0, 4).map((re) => {
        const m = haystack.match(re);
        return m ? m[0] : re.source;
      }),
      entry
    });
  }

  results.sort((a, b) => b.score - a.score);
  return results;
};

/*
 * 从排序结果里决定「说几个、怎么说」。
 *
 * 三种结局，对应三种诚实的说法：
 *   认得准     —— 头名分数够高，而且明显甩开第二名
 *   拿不准     —— 前两名咬得很紧，就两个都说，不假装只有一个
 *   不认识     —— 分数都不够，明说不认识，**不猜**
 */
export const resolveDocumentTypes = (matches, options = {}) => {
  const { minScore = 10, closeRatio = 0.7 } = options;

  if (!matches.length || matches[0].score < minScore) {
    return { status: 'unknown', primary: null, also: [] };
  }

  const primary = matches[0];
  const also = matches
    .slice(1)
    .filter((m) => m.score >= primary.score * closeRatio)
    .slice(0, 2);

  return {
    status: also.length ? 'ambiguous' : 'confident',
    primary,
    also
  };
};

/*
 * 组合：知识 + 本地验证过的事实
 *
 * ── 最要紧的设计 ──
 *
 * 输出的每一句话都带一个 source 标签：
 *
 *   'letter'    这句话里的事实是从**这封信上**读出来并通过交叉校验的
 *   'knowledge' 这句话讲的是**这类信**的常识，跟手上这封的具体内容无关
 *
 * 为什么非要分：知识库里写着「白卡复审通常给 30 到 60 天」。
 * 如果不加区分地说出来，老人会以为「我这封信给了 30 天」——
 * 那就是我们凭空造了一个期限，跟早期从电话号码里凑出假截止日一样糟。
 *
 * 加了标签之后，界面可以把两者显示成不同的样子，
 * 而且 knowledge.test.mjs 能机械地检查「knowledge 那一档里不许出现具体金额和年份」。
 */
export const composeGuidance = (resolved, fields = {}) => {
  const out = { status: resolved.status, lines: [], sources: [] };

  if (resolved.status === 'unknown') {
    out.lines.push({
      source: 'knowledge',
      kind: 'whatItIs',
      text: '这封信小助手还认不出是哪一类，没办法多说什么。建议拿给家人看一下。'
    });
    return out;
  }

  const e = resolved.primary.entry;

  out.lines.push({ source: 'knowledge', kind: 'whatItIs', text: e.whatItIs });
  out.lines.push({ source: 'knowledge', kind: 'purpose', text: e.purpose });

  // ── 谁寄的：只有本地认出来的机构才说 ──
  if (fields.sender && fields.sender.cn && fields.sender.trusted) {
    out.lines.push({
      source: 'letter',
      kind: 'sender',
      text: `这封信是 ${fields.sender.cn} 寄来的。`
    });
  }

  // ── 要交多少：只从本地校验过的金额来 ──
  const amount = fields.amount || {};
  if (amount.trusted && amount.isPaymentDemand) {
    out.lines.push({
      source: 'letter',
      kind: 'amount',
      text: `信上要交的是 ${amount.value} 美元。`
    });
  } else if (amount.trusted && amount.onAutopay) {
    out.lines.push({
      source: 'letter',
      kind: 'amount',
      text: `信上的 ${amount.value} 美元会自动扣款，不用另外去交。`
    });
  }

  out.lines.push({ source: 'knowledge', kind: 'typicalAction', text: e.typicalAction });

  /*
   * ── 期限：这里最容易造假，所以分得最死 ──
   *
   * 信上读到了确切日期    → 说那个日期，标 'letter'
   * 信上没读到           → 只讲这类信的规律，标 'knowledge'，
   *                        而且措辞里必须出现「通常 / 一般」，不能说成这封信的期限
   */
  const due = fields.dueDate || {};
  const rule = e.deadlineRule;

  if (due.trusted && due.value) {
    out.lines.push({
      source: 'letter',
      kind: 'deadline',
      text: `这封信上写的期限是 ${due.value}。`
    });
  }

  /*
   * deadlineRule 只在**有法定规则**时才存在（写在法律里、全州统一的那种）。
   *
   * 「这家公司通常给 30 天」一律不存 —— 电费按出账日算、医院按科室算、
   * HOA 按规约算，每家都不同，写一个数字出去就是编。
   * 没有这个字段时这里什么都不说，界面自然只剩「没在这封信上读到期限」。
   *
   * 法定规则跟信上有没有写日期无关，两种情况都值得说
   * （比如「12 月 10 日之后罚 10%」是到期日之外的另一件事）。
   */
  if (rule && rule.text) {
    out.lines.push({ source: 'knowledge', kind: 'deadlineStatutory', text: rule.text });
  }

  out.lines.push({ source: 'knowledge', kind: 'risks', text: e.risks });

  // ── 同时命中多类时，如实说，不假装只有一个 ──
  if (resolved.also.length) {
    out.lines.push({
      source: 'knowledge',
      kind: 'ambiguous',
      text: `这封信也可能是「${resolved.also.map((m) => m.cn).join('」或「')}」，小助手拿不太准。`
    });
  }

  const seen = new Set();
  for (const m of [resolved.primary, ...resolved.also]) {
    for (const s of m.entry.sources || []) {
      if (seen.has(s.url)) continue;
      seen.add(s.url);
      out.sources.push(s);
    }
  }

  return out;
};
