/*
 * ============================================================
 * 线索层：不再枚举整句，只枚举「零件」
 * ============================================================
 *
 * ── 为什么要有这一层 ──
 *
 * fieldExtractor 里手写了 84 条英文措辞（日期锚点 29、金额锚点 25、
 * 句式词典 30）。每一条都是某封信教会我们的。
 * 问题是英文写同一件事的方式是无限的，而表是有限的：
 *
 *   if payment is received after 07/02/2025: $92.05     ← 表里有
 *   payments received after the due date will incur...  ← 表里没有
 *   a penalty of 10% will be added after...             ← 表里没有
 *
 * 继续往表里加 if，第 200 封信还是会遇到没见过的写法。
 *
 * ── 换个枚举法 ──
 *
 * 上面三句话其实是同三个零件的不同排列：
 *
 *   付款词   payment / paid / received / postmarked / remit
 *   之后词   after / past / beyond / later than / following
 *   后果词   late charge / penalty / fee / assessed / incur
 *
 * 枚举整句要 5×6×6 = 180 条；枚举零件只要 17 个词加一条组合规则。
 * 这就是「少写规则，覆盖更多说法」的全部秘密 ——
 * 把乘法搬到运行时去做，而不是在表里预先展开。
 *
 * ── 三条自我约束 ──
 *
 * 1. 这一层永远是**兜底**，不是主力。
 *    明确锚点（Payment Due Date = 100 分）命中时，它一句话都不说。
 *    组合出来的分数一律压在 80 以下，抢不走任何明确锚点。
 *
 * 2. 它只负责「这句话在说哪个字段」，绝不负责「值是多少」。
 *    值仍然由 fieldExtractor 的空间匹配去找 ——
 *    也就是说抽出来的每个数字照样指得回 OCR 的哪一行、哪个框。
 *    决定 01（金额和日期必须可溯源）不受影响。
 *
 * 3. 每条线索都带 why，说明是哪几个零件凑出来的。
 *    出错的时候能一眼看出是哪个词类太宽，而不是对着一条
 *    30 个字符的正则发呆。
 */

/*
 * 词类。
 *
 * 注意统统不加 \b —— PP-OCR 不输出词间空格，
 * 整句会粘成 withaminimummonthlycharge，加了词边界就永远匹配不上。
 * 代价是会匹配到单词内部（比如 "after" 命中 "hereafter"），
 * 但因为要求多个零件同时出现，这种噪音基本被组合条件挡掉了。
 */
export const WORD_CLASSES = {
  // 谁：跟「付钱」有关的动作
  pay: /payment|paid|pay\b|remit|received|postmark|balance|amount|invoice|bill/i,

  // 关系：这天「之后」
  after: /after|past\s*due|beyond|later\s*than|following|subsequent\s*to|exceed/i,

  // 关系：这天「之前」
  before: /before|by\s|no\s*later\s*than|on\s*or\s*before|prior\s*to|within/i,

  // 后果：不办会怎么样
  consequence:
    /late\s*(charge|fee|payment)|penalt|delinquen|interest|surcharge|assess|incur|additional\s*charge|will\s*be\s*added|shut\s*off|disconnect|terminat|collection|failure\s*to|may\s*result\s*in|服务/i,

  // 期限本身
  deadline: /due|deadline|expir|last\s*day|final\s*date|must\s*(be\s*)?(receiv|respond|reply|return)/i,

  // 总额
  total: /total|balance|amount\s*due|grand\s*total|net\s*due|pay\s*this/i,

  // 要求回应
  respond: /respond|reply|return|submit|contact|appeal|renew|verif/i
};

const has = (cls, text) => WORD_CLASSES[cls].test(text);

/*
 * 组合规则。
 *
 * 每条 = 「哪几个零件同时出现」→「这句话在说哪个字段」+ 分数。
 * 分数全部 < 80，永远让位给明确锚点。
 *
 * 顺序有意义：先写的先命中，所以证据更强的排前面。
 */
const RULES = [
  {
    id: 'late-consequence',
    field: 'dueDate',
    need: ['pay', 'after', 'consequence'],
    weight: 78,
    cn: '付款词 + 之后 + 后果 = 这天之后要罚，所以这天是期限'
  },
  {
    id: 'deadline-after',
    field: 'dueDate',
    need: ['deadline', 'after', 'consequence'],
    weight: 76,
    cn: '期限词 + 之后 + 后果'
  },
  {
    id: 'pay-before',
    field: 'dueDate',
    need: ['pay', 'before', 'deadline'],
    weight: 74,
    cn: '付款词 + 之前 + 期限词'
  },
  {
    id: 'respond-before',
    field: 'dueDate',
    need: ['respond', 'before', 'deadline'],
    weight: 72,
    cn: '回应词 + 之前 + 期限词'
  },
  {
    id: 'consequence-after',
    field: 'dueDate',
    need: ['consequence', 'after'],
    weight: 74,
    cn: '后果 + 之后 = 罚则句，那个日期就是期限'
  },
  {
    id: 'pay-before-consequence',
    field: 'dueDate',
    need: ['pay', 'before', 'consequence'],
    weight: 74,
    cn: '付款词 + 之前 + 后果'
  },
  {
    id: 'pay-after',
    field: 'dueDate',
    need: ['pay', 'after'],
    weight: 66,
    cn: '付款词 + 之后（没写后果，证据弱一档）'
  },
  {
    id: 'total-due',
    field: 'amount',
    need: ['total', 'deadline'],
    weight: 70,
    cn: '总额词 + 期限词 = 要交的总数'
  }
];

/**
 * 把一行文字拆成零件，看能凑出哪些线索。
 *
 * @param {string} text  已经 normalize 过的一行文字
 * @returns {Array<{field, weight, ruleId, why}>} 按分数从高到低
 */
export const findClues = (text) => {
  if (!text) return [];
  const out = [];

  for (const rule of RULES) {
    if (rule.need.every((cls) => has(cls, text))) {
      out.push({
        field: rule.field,
        weight: rule.weight,
        ruleId: rule.id,
        why: `${rule.cn}（${rule.need.join(' + ')}）`
      });
    }
  }

  out.sort((a, b) => b.weight - a.weight);
  return out;
};

/**
 * 给 fieldExtractor 用的便捷版：只要某个字段的最强线索。
 * 形状跟 matchAnchor 的返回值保持一致，好让调用处不用分叉。
 */
export const matchClue = (text, field) => {
  const hit = findClues(text).find((c) => c.field === field);
  return hit
    ? { weight: hit.weight, pattern: `clue:${hit.ruleId}`, why: hit.why }
    : null;
};

export default { WORD_CLASSES, findClues, matchClue };
