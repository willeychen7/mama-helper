/**
 * utils/fieldExtractor.js
 *
 * 「第 0 层」：完全本地的关键字段抽取。
 *
 * 为什么需要它：
 *   白名单架构下，我们只把「明确认定安全的字段」交给外部模型，
 *   而不是把整页文字过一遍正则再发出去。
 *   这意味着这几个字段抽得准不准，直接决定产品成不成立。
 *
 * 为什么不靠「把整页拍平成文字再正则」：
 *   账单的语义有一半住在空间关系里 —— 标签在左、数值在右，
 *   金额靠右对齐成一列。拍平成字符串的那一刻这些信息就没了。
 *   所以这里全部基于 OCR 行的 bbox 做空间匹配。
 *
 * 最重要的一条设计原则：
 *   宁可说「我看不准」，也不能自信地说错金额。
 *   所有抽取结果都必须通过交叉校验才会被标记为可信；
 *   校验不过就走「建议找家人确认」的兜底文案。
 *
 * 输入：OCR 行数组，每行形如
 *   { text, confidence, left, top, right, bottom, width, height, centerX, centerY }
 * 输出：见文件末尾 extractLetterFields 的注释。
 */


// ============================================================
// 文本归一化
// ============================================================

const normalize = (text) =>
  String(text || '')
    .replace(/\s+/g, ' ')
    .trim();

const lower = (text) => normalize(text).toLowerCase();

/**
 * OCR 在纯数字语境里的常见混淆。
 * 只在「已经确认这是数字串」之后才做替换，
 * 避免把正常单词里的字母也改掉。
 */
const fixDigitConfusion = (token) =>
  token
    .replace(/[Oo]/g, '0')
    .replace(/[lI|]/g, '1')
    .replace(/[Ss]/g, '5')
    .replace(/[Bb]/g, '8')
    .replace(/[Gg]/g, '6')
    .replace(/[Zz]/g, '2');


// ============================================================
// 金额解析
// ============================================================

/*
 * 严格的「整行就是一个金额」模式。
 * 用于识别右对齐金额列 —— 这类行通常只有一个数字。
 */
/*
 * 小数点和千分位逗号，OCR 经常认反。
 * 真实的 State Farm 账单上 $165.00 被读成了 $165,00。
 * 「逗号后面只有两位」一定是小数点，因为千分位后面必然是三位。
 */
const PURE_MONEY_RE =
  /^\(?\s*-?\s*\$?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:[.,](\d{2}))\s*\)?\s*(CR|cr)?$/;

/*
 * 宽松模式：从一行文字里挑出所有像金额的片段。
 * 必须带 $，否则会把 "161.14 kWh @ 0.2106" 里的用电量也当成钱。
 */
/*
 * 这里原来写的是 (\d{1,3}(?:,\d{3})*|\d+)。
 * 因为小数部分是可选的，正则在 \d{1,3} 匹配到前三位就能成功收工，
 * 于是 "$8842" 被解析成 884、"$1250" 被解析成 125 ——
 * **任何不带千分位逗号的四位数金额都会被截掉一位**。
 *
 * 修法：千分位那一支必须真的出现逗号（+ 而不是 *），
 * 否则就走 \d+ 把整串数字吃下来。
 */
const INLINE_MONEY_RE =
  /\$\s*(\d{1,3}(?:,\d{3})+|\d+)(?:[.,](\d{2})(?!\d))?/g;

const toNumber = (intPart, decPart) => {
  const clean = String(intPart).replace(/,/g, '');
  const dec = decPart ? `.${decPart}` : '';
  const value = Number(`${clean}${dec}`);
  return Number.isFinite(value) ? value : null;
};

/** 整行是不是一个纯金额 */
export const parsePureMoney = (text) => {
  const raw = normalize(text);
  if (!raw) return null;

  const match = raw.match(PURE_MONEY_RE);
  if (!match) return null;

  const value = toNumber(match[1], match[2]);
  if (value === null) return null;

  // (123.45) 和 123.45 CR 都表示负数/贷记
  const isCredit =
    /^\(/.test(raw) || /CR$/i.test(raw) || /^-|\s-/.test(raw);

  return {
    value: isCredit ? -value : value,
    hasDollarSign: raw.includes('$'),
    isCredit,
    raw
  };
};

/** 从一行里找出所有带 $ 的金额 */
export const findMoneyInText = (text) => {
  const raw = normalize(text);
  const results = [];

  INLINE_MONEY_RE.lastIndex = 0;

  let match = INLINE_MONEY_RE.exec(raw);
  while (match) {
    const value = toNumber(match[1], match[2]);
    if (value !== null) {
      results.push({
        value,
        index: match.index,
        hasDollarSign: true,
        raw: match[0]
      });
    }
    match = INLINE_MONEY_RE.exec(raw);
  }

  return results;
};


// ============================================================
// 日期解析
// ============================================================

const MONTH_NAMES = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12
};

const isValidYmd = (y, m, d) => {
  if (!y || !m || !d) return false;
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  if (y < 1990 || y > 2100) return false;
  const probe = new Date(Date.UTC(y, m - 1, d));
  return (
    probe.getUTCFullYear() === y &&
    probe.getUTCMonth() === m - 1 &&
    probe.getUTCDate() === d
  );
};

const expandYear = (raw) => {
  const num = Number(raw);
  if (raw.length === 4) return num;
  if (raw.length === 2) return num >= 70 ? 1900 + num : 2000 + num;
  return null;
};

const pad = (n) => String(n).padStart(2, '0');

/**
 * 从一行文字里找出所有日期。
 * 返回 { iso, index, raw, format }。
 * 美国信件默认 MM/DD/YYYY。
 */
export const findDatesInText = (text, options = {}) => {
  const raw = normalize(text);
  const found = [];

  // 1) 02/05/24 | 2/5/2024 | 02-05-2024
  const numericRe = /\b(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})\b/g;
  let match = numericRe.exec(raw);
  while (match) {
    const month = Number(match[1]);
    const day = Number(match[2]);
    const year = expandYear(match[3]);
    if (isValidYmd(year, month, day)) {
      found.push({
        iso: `${year}-${pad(month)}-${pad(day)}`,
        index: match.index,
        raw: match[0],
        format: 'numeric'
      });
    }
    match = numericRe.exec(raw);
  }

  // 2) February 5, 2024 | Feb. 5 2024
  const wordRe =
    /\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/g;
  match = wordRe.exec(raw);
  while (match) {
    const month = MONTH_NAMES[match[1].toLowerCase()];
    const day = Number(match[2]);
    const year = Number(match[3]);
    if (month && isValidYmd(year, month, day)) {
      found.push({
        iso: `${year}-${pad(month)}-${pad(day)}`,
        index: match.index,
        raw: match[0],
        format: 'word'
      });
    }
    match = wordRe.exec(raw);
  }

  // 2b) 不带年份：December 10th / November 1st
  //     真实地税单大量使用这种写法。
  //     年份按「从今天算起最近的一次」推断，并标记出来。
  const monthDayRe =
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s*(\d{1,2})(?:st|nd|rd|th)?\b(?!\s*,?\s*\d{4})/gi;
  match = monthDayRe.exec(raw);
  while (match) {
    const month = MONTH_NAMES[match[1].toLowerCase()];
    const day = Number(match[2]);
    const base = options.today || new Date();
    let year = base.getUTCFullYear();

    if (isValidYmd(year, month, day)) {
      const candidate = Date.UTC(year, month - 1, day);
      // 已经过去超过 30 天，就认为说的是明年
      if (candidate < base.getTime() - 30 * 86400000) year += 1;
    }

    if (isValidYmd(year, month, day)) {
      found.push({
        iso: `${year}-${pad(month)}-${pad(day)}`,
        index: match.index,
        raw: match[0],
        format: 'month-day',
        yearInferred: true
      });
    }
    match = monthDayRe.exec(raw);
  }

  // 3) 2024-02-05
  const isoRe = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g;
  match = isoRe.exec(raw);
  while (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (isValidYmd(year, month, day)) {
      found.push({
        iso: `${year}-${pad(month)}-${pad(day)}`,
        index: match.index,
        raw: match[0],
        format: 'iso'
      });
    }
    match = isoRe.exec(raw);
  }

  return found;
};

/**
 * 判断一行是不是「账单周期」而不是到期日。
 * 例：Billing period: 01/06/24 to 02/05/24 (31 days)
 * 这类行必须排除，否则会把周期结束日当成缴费截止日。
 */
export const looksLikeDateRange = (text) => {
  const raw = lower(text);
  const dates = findDatesInText(text);
  if (dates.length < 2) return false;
  return /\b(to|through|thru|until|[-–—])\b/.test(raw) ||
    /billing\s*period|service\s*period|statement\s*period|coverage\s*period/.test(
      raw
    );
};


// ============================================================
// 锚点词
//
// 注意 "Amount Paid" / "Previous Balance" 这类必须排除：
// 它们长得很像应缴金额，但抓错了就是灾难。
// ============================================================

const AMOUNT_ANCHORS = [
  { re: /\btotal\s*amount\s*due\b/i, weight: 100 },
  { re: /\bamount\s*you\s*owe\b/i, weight: 98 },
  { re: /\btotal\s*due\b/i, weight: 95 },
  { re: /\bamount\s*due\b/i, weight: 92 },
  { re: /\bbalance\s*due\b/i, weight: 88 },
  { re: /\bplease\s*pay\b/i, weight: 84 },
  { re: /\bpay\s*this\s*amount\b/i, weight: 84 },
  { re: /\btotal\s*current\s*charges\b/i, weight: 80 },
  { re: /\byour\s*new\s*charges\b/i, weight: 78 },
  { re: /\bnew\s*charges\b/i, weight: 72 },
  { re: /\bamount\s*enclosed\b/i, weight: 40 },

  /*
   * 以下锚点全部抄自真实样本文件，
   * 不是我凭印象编的措辞：
   *   · 里弗赛德县地税单        Total Base Tax Amount / First Installment
   *   · CMS 官方 MSN 样本       Total You May Be Billed（注意它不是账单）
   */
  /*
   * 保险账单不用「amount due」，用的是「premium」。
   * 真实的 State Farm 账单上写的是 Total Premium $165.00，
   * 早期版本只靠通用的 total 匹配（权重 35），
   * 佐证不足，于是保费读对了却不敢告诉老人。
   */
  { re: /\btotal\s*premium\b/i, weight: 95 },
  { re: /\bpremium\s*due\b/i, weight: 93 },
  { re: /\bannual\s*premium\b/i, weight: 88 },
  { re: /\bminimum\s*(amount\s*)?due\b/i, weight: 90 },
  { re: /\bcurrent\s*amount\s*due\b/i, weight: 94 },
  { re: /\btotal\s*balance\b/i, weight: 86 },
  { re: /\bcurrent\s*charges\b/i, weight: 74 },

  /*
   * 「Sub-Total of CPA Generation Charges」原来只能匹配到
   * 通用的 \btotal\b（权重 35），低于「算不算要交钱」的门槛 72，
   * 于是手机拍的那张 SCE 账单金额读对了 99.36，
   * 却被降级成「不用交」。小计本身就是合法的应缴锚点。
   */
  { re: /\bsub-?\s*total\b/i, weight: 74 },

  { re: /\btotal\s*base\s*tax\s*amount\b/i, weight: 95 },
  { re: /\b(first|second)\s*installment\b/i, weight: 70 },
  { re: /\b(total|maximum)\s*you\s*may\s*be\s*billed\b/i, weight: 60 },
  { re: /\btotal\s*amount\s*you\s*owe\b/i, weight: 96 },

  { re: /\btotal\b/i, weight: 35 }
];

const AMOUNT_ANCHOR_BLOCKERS =
  /\bamount\s*paid\b|\bprevious\s*balance\b|\bpayment\s*received\b|\blast\s*payment\b|\bprior\s*balance\b|\bamount\s*of\s*your\s*last\b|\bpaid\s*to\s*date\b/i;

const DATE_ANCHORS = [
  { re: /\bpayment\s*due\s*date\b/i, weight: 100 },
  { re: /\bdue\s*date\b/i, weight: 98 },
  { re: /\bpay\s*by\b/i, weight: 90 },
  { re: /\bdue\s*by\b/i, weight: 90 },
  { re: /\bpayable\s*by\b/i, weight: 86 },
  { re: /\bplease\s*pay\s*by\b/i, weight: 86 },
  { re: /\bpayment\s*due\b/i, weight: 82 },
  { re: /\brespond\s*by\b/i, weight: 70 },
  { re: /\breply\s*by\b/i, weight: 70 },
  { re: /\bdeadline\b/i, weight: 68 },
  { re: /\bon\s*or\s*before\b/i, weight: 60 },

  /*
   * 真实措辞补充：
   *   CMS MSN        "We must receive your appeal by:"
   *   Medi-Cal 复审  "send it back to us by ____"
   *   里弗赛德地税单  "due November 1st no later than December 10th"
   */
  { re: /\bwe\s*must\s*receive\s*.{0,40}\s*by\b/i, weight: 94 },
  { re: /\bsend\s*it\s*back\s*to\s*us\s*by\b/i, weight: 92 },
  { re: /\bno\s*later\s*than\b/i, weight: 88 },
  { re: /\bdelinquen(t|cy)\s*(date|after)\b/i, weight: 80 },

  /*
   * 房产税、保费、分期账单的标准措辞：
   *   The FIRST INSTALLMENT is due in full on November 1, 2024.
   * 原来一条锚点都不命中，于是 11月1日 压根没进候选，
   * 系统只看得见「deadline … December 10」那两行。
   */
  { re: /\bdue\s*in\s*full\b/i, weight: 96 },
  { re: /\bis\s*due\s*on\b/i, weight: 94 },

  /*
   * 真实的水费账单，到期日印在表格格子里，
   * 标签就只有两个字母：
   *     CURRENT AMOUNT | $ 71.20 | BY: 04/30/2024
   *
   * 「BY:」太通用，不能全文乱匹配，
   * 所以限定必须出现在行首 —— 那说明它是个独立的表格字段标签。
   */
  { re: /^(pay\s*)?by\s*:/i, weight: 76 }
];

/*
 * 发信日期（statement date）和截止日期（due date）是两回事，
 * 混在一起是最容易让老人做错事的一类错。
 *
 *   发信日期  这封信是什么时候写的        —— 只是背景，不用做任何事
 *   截止日期  你必须在这天之前做点什么    —— 要行动
 *
 * Hoag 那张医院账单上只有 STATEMENT DATE 10/19/18，根本没有到期日。
 * 早期版本要么把它当成「请在 2018年10月19日 之前处理」（凭空造出一个期限），
 * 要么被 DATE_ANCHOR_BLOCKERS 整个挡掉、于是这个日期就消失了。
 * 两种都不对：它是一个真实存在、老人也想知道的信息，
 * 只是不能冒充截止日。所以单独抽，单独显示。
 */
const STATEMENT_DATE_ANCHORS = [
  { re: /\bstatement\s*date\b/i, weight: 100 },
  { re: /\bstatement\s*(closing|period\s*ending)\s*date\b/i, weight: 98 },
  { re: /\binvoice\s*date\b/i, weight: 98 },
  { re: /\bbill(ing)?\s*date\b/i, weight: 96 },
  { re: /\bdate\s*of\s*(this\s*)?(notice|letter|statement)\b/i, weight: 96 },
  { re: /\bnotice\s*date\b/i, weight: 94 },
  { re: /\bdate\s*(issued|mailed|printed|prepared)\b/i, weight: 92 },
  { re: /\bissue\s*date\b/i, weight: 90 },
  { re: /\bprinted\s*on\b/i, weight: 84 }
];

/*
 * 出生日期和就诊日期长得像发信日期，但都不是。
 * 尤其 date of birth —— 那是 PII，抽出来显示在卡片上就是泄露。
 */
/*
 * 政府信、法院信、律师信通常没有「Statement Date」这种标签，
 * 只在信头孤零零印一行日期：
 *
 *     April 24, 2024
 *
 * 这恰恰是后果最重的一类信，日期不能丢。
 *
 * 但「页面上方有个日期」本身是个很松的规则，很容易误抓
 * （出生日期、就诊日期、正文里随口提到的日期都长这样）。
 * 所以卡死四个条件，全满足才认：
 *   1. 这一行除了日期什么都没有 —— 排除句子里的日期
 *   2. 在页面上三分之一 —— 信头位置
 *   3. 不在未来
 *   4. 没有任何带标签的发信日期 —— 有标签的永远优先
 *
 * 注意 PP-OCR 不输出词间空格（April24,2024），所以全用 \s*。
 */
const BARE_DATE_LINE_RE =
  /^[\s,.:;]*((jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*\d{1,2}\s*,?\s*\d{4}|\d{1,2}\s*[/-]\s*\d{1,2}\s*[/-]\s*\d{2,4}|\d{4}\s*-\s*\d{2}\s*-\s*\d{2})[\s,.:;]*$/i;

const STATEMENT_ANCHOR_BLOCKERS =
  /\bdate\s*of\s*(birth|service|death)\b|\bdob\b/i;

/*
 * 「Medi-Cal」必须带分隔符。
 *
 * 原来写的是 /medi-?cal\b/i —— 连字符可选。但 "medical" 这个英文单词
 * 恰好就是 medi + cal，于是 "Medical care"、"MEDICAL CENTER"、
 * "Hoag Medical Group" 全都被认成了白卡 Medi-Cal。
 * 一封私立医院的账单会被告诉老人「这是白卡寄来的」。
 *
 * 加了 i 标志之后，"MediCal" 和 "medical" 在正则眼里是同一个字符串，
 * 没有任何办法区分。所以只能要求分隔符：官方写法一直是带连字符的
 * 「Medi-Cal」，而 DHCS / department of health care services 这两个
 * 别名本来就还在，官方信照样认得出。
 *
 * 代价是 OCR 万一把连字符吃掉就漏认 —— 但漏认只是机构显示成「未知」，
 * 误认是自信地说错。方向上永远选前者。
 */
const MEDI_CAL_RE = /\bmedi[-\s]cal\b/i;

const DATE_ANCHOR_BLOCKERS =
  /\bbilling\s*period\b|\bservice\s*period\b|\bstatement\s*date\b|\bbill\s*date\b|\bdate\s*of\s*(birth|service|this\s*notice)\b|\bprinted\s*on\b|\bclaims\s*processed\s*between\b|\bpay\s*by\s*(phone|credit|card|mail|check|cheque|debit|bank|text|app|online|web|autopay)\b/i;

/*
 * 「Pay by Phone: 855-594-0615」是缴费方式，不是缴费期限。
 * 真实的 Ventura River 水费账单上就有这么一行，
 * 早期版本把它当成 due date 锚点，
 * 然后从旁边的电话号码里凑出了一个 2024-03-31 的假截止日 ——
 * 对老人报一个信上根本不存在的日期，比不报更糟。
 */

/*
 * 申诉期限 ≠ 缴费期限
 *
 * 真实的 CMS MSN 样本上印着
 *   「We must receive your appeal by: January 21, 2021」
 * 这是「如果你想申诉，最晚哪天」，
 * 而 MSN 本身明写着 THIS IS NOT A BILL，根本不用做事。
 *
 * 早期版本把它当成缴费截止日，加上日期已过，
 * 直接把一封「不用管」的信标成了 🔴。
 * 现在单独识别、单独存放，不参与紧急度升级。
 */
const APPEAL_DEADLINE_CONTEXT =
  /\bappeal\b|\breconsideration\b|\bdispute\b|\bgrievance\b/i;

/*
 * 「明确写着不用交钱」的几种写法。
 *
 * 真实的 State Farm 续保声明上写的是：
 *     AMOUNT DUE:        None
 *     Payment is due by  BILLED THROUGH SFPP
 *
 * 也就是「这期不用交，走自动扣款」。
 * 但 None 不是数字，findValueNearAnchor 在这个锚点上什么也没找到，
 * 于是权重更低的「Total Premium $165.00」胜出，
 * 变成对老人说「要交 165 美元」—— 那是年度保费，不是应缴款。
 *
 * 让人白交一笔钱，和让人漏交一笔钱，一样糟。
 */
const EXPLICIT_ZERO_RE =
  /^(none|n\/?a|nil|no\s*payment(\s*due)?|not?\s*due|\$?\s*0(\.00)?|-{1,3}|—)$/i;

const AUTOPAY_VALUE_RE =
  /billed\s*through|auto\s*-?pay|automatic\s*payment|on\s*file|enrolled|draft(ed)?\s*from/i;

const matchAnchor = (text, anchors, blockers) => {
  const raw = normalize(text);
  if (!raw) return null;
  if (blockers && blockers.test(raw)) return null;

  for (let i = 0; i < anchors.length; i += 1) {
    if (anchors[i].re.test(raw)) {
      return { weight: anchors[i].weight, pattern: anchors[i].re.source };
    }
  }
  return null;
};


// ============================================================
// 空间匹配：从锚点找到它对应的值
//
//   1. 同一行、锚点右边、最近的  -> 最优
//   2. 锚点正下方、水平重叠、3 行高之内 -> 次优
//   3. 锚点自己这一行里就带着值   -> 也接受
// ============================================================

const verticalOverlapRatio = (a, b) => {
  const top = Math.max(a.top, b.top);
  const bottom = Math.min(a.bottom, b.bottom);
  const overlap = bottom - top;
  if (overlap <= 0) return 0;
  return overlap / Math.min(a.height || 1, b.height || 1);
};

const horizontalOverlapRatio = (a, b) => {
  const left = Math.max(a.left, b.left);
  const right = Math.min(a.right, b.right);
  const overlap = right - left;
  if (overlap <= 0) return 0;
  return overlap / Math.min(a.width || 1, b.width || 1);
};

/**
 * @param anchorLine 锚点所在行
 * @param lines      全部 OCR 行
 * @param parseValue (line) => value | null
 * @returns { line, value, relation, score } | null
 */
const findValueNearAnchor = (anchorLine, lines, parseValue) => {
  const unit = Math.max(1, anchorLine.height || 20);
  const candidates = [];

  /*
   * --- 情况 3：值就在锚点这一行 ---
   *
   * 分数必须高于「正下方」（85）。
   *
   * 原来给 70，结果 OC 房产税单上这一行：
   *     The deadline to pay without penalty is December 10, 2024.
   * 锚点「deadline」自己这行就带着 12月10日，
   * 但下一行「…is due in full on February 1, 2025.」按「正下方」拿到 81 分，
   * 把自带的日期顶掉了 —— 于是对老人说「请在 2025年2月1日 之前处理」，
   * 而真正会罚 10% 的是 2024年12月10日。
   *
   * 标签和值出现在同一个 OCR 行里，是最强的证据，
   * 不该输给「下面那行碰巧也有个数」。
   *
   * 仍然低于「同行右侧」（近距离时接近 100）—— 表格式版面里
   * 「标签 | 值」分成两个框才是最标准的写法。
   */
  const selfValue = parseValue(anchorLine, true);
  if (selfValue !== null && selfValue !== undefined) {
    candidates.push({
      line: anchorLine,
      value: selfValue,
      relation: 'same-line',
      score: 92
    });
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === anchorLine) continue;

    const value = parseValue(line, false);
    if (value === null || value === undefined) continue;

    // --- 情况 1：同一行、右边 ---
    if (
      verticalOverlapRatio(anchorLine, line) > 0.45 &&
      line.left >= anchorLine.right - unit * 0.3
    ) {
      const gap = (line.left - anchorLine.right) / unit;
      if (gap <= 25) {
        candidates.push({
          line,
          value,
          relation: 'right',
          score: 100 - gap * 2
        });
      }
      continue;
    }

    // --- 情况 2：正下方 ---
    if (
      line.top >= anchorLine.bottom - unit * 0.2 &&
      horizontalOverlapRatio(anchorLine, line) > 0.25
    ) {
      const gap = (line.top - anchorLine.bottom) / unit;
      if (gap <= 3.2) {
        candidates.push({
          line,
          value,
          relation: 'below',
          score: 85 - gap * 8
        });
      }
    }
  }

  if (!candidates.length) return null;

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0];
};


// ============================================================
// 右对齐金额列
//
// 账单几乎总是把金额排成靠右对齐的一列。
// 找到这一列，就等于免费拿到了「哪些数字是钱」的答案，
// 也拿到了做分项求和自检的原料。
// ============================================================

const detectAmountColumn = (lines, pageWidth) => {
  const moneyLines = [];

  for (let i = 0; i < lines.length; i += 1) {
    const parsed = parsePureMoney(lines[i].text);
    if (parsed) {
      moneyLines.push({ line: lines[i], ...parsed });
    }
  }

  if (moneyLines.length < 3) {
    return { column: null, members: moneyLines };
  }

  const tolerance = Math.max(10, pageWidth * 0.02);
  const clusters = [];

  moneyLines.forEach((entry) => {
    const found = clusters.find(
      (cluster) => Math.abs(cluster.right - entry.line.right) <= tolerance
    );
    if (found) {
      found.items.push(entry);
      found.right =
        found.items.reduce((sum, it) => sum + it.line.right, 0) /
        found.items.length;
    } else {
      clusters.push({ right: entry.line.right, items: [entry] });
    }
  });

  clusters.sort((a, b) => b.items.length - a.items.length);

  const best = clusters[0];
  if (!best || best.items.length < 3) {
    return { column: null, members: moneyLines };
  }

  best.items.sort((a, b) => a.line.top - b.line.top);
  return { column: best, members: moneyLines };
};

/**
 * 在金额列里找「分项之和 == 小计」的关系。
 * 找到 = 这一列被读对了的强证据。
 * 优先返回覆盖分项最多的那一组。
 */
export const findSumRelation = (values, tolerance = 0.02) => {
  let best = null;

  for (let end = 2; end < values.length; end += 1) {
    for (let start = 0; start <= end - 2; start += 1) {
      let sum = 0;
      let nonZero = 0;
      for (let k = start; k < end; k += 1) {
        sum += values[k];
        if (Math.abs(values[k]) > 0.005) nonZero += 1;
      }

      /*
       * 至少要有两个非零分项才算数。
       * 账单上 $0.00 遍地都是（未使用的费率档、减免项），
       * 一堆 0 加上两个真数字也能凑出「和」，
       * 那是巧合不是验证。
       */
      if (nonZero < 2) continue;

      /*
       * 不能要求和为正。
       * AT&T 那张账单上 -66.27 + 59.94 = -6.33 正好对得上，
       * 但早期版本因为 sum > 0 直接跳过，于是对着一张
       * 算得清清楚楚的账单说「分项加起来对不上小计」。
       * 贷记账单是完全正常的情况，不该被当成识别错误。
       */
      if (Math.abs(sum) > 0.005 && Math.abs(sum - values[end]) <= tolerance) {
        const count = end - start;
        if (!best || count > best.count) {
          best = { start, end, count, sum, total: values[end] };
        }
      }
    }
  }

  return best;
};


// ============================================================
// 寄件机构
//
// 先查已知机构词典（能顺带给出中文名和行业），
// 查不到再退回「页面上方字号最大的一行」。
// ============================================================

const KNOWN_ORGS = [
  // ---- 政府 / 福利 ----
  { re: /social\s*security\s*administration|\bSSA\b/i, en: 'Social Security Administration', abbr: 'SSA', cn: '美国社会安全局', kind: 'social_security' },
  { re: /\bmedicare\b|centers\s*for\s*medicare/i, en: 'Medicare', abbr: 'Medicare', cn: 'Medicare（红蓝卡）', kind: 'medicare' },
  { re: /\bmedi[-\s]cal\b|department\s*of\s*health\s*care\s*services|\bDHCS\b/i, en: 'Medi-Cal', abbr: 'Medi-Cal', cn: 'Medi-Cal（白卡）', kind: 'medi_cal' },
  { re: /internal\s*revenue\s*service|\bIRS\b/i, en: 'Internal Revenue Service', abbr: 'IRS', cn: '美国国税局', kind: 'tax' },
  { re: /franchise\s*tax\s*board|\bFTB\b/i, en: 'Franchise Tax Board', abbr: 'FTB', cn: '加州税务局', kind: 'tax' },
  { re: /\bUSCIS\b|citizenship\s*and\s*immigration/i, en: 'USCIS', abbr: 'USCIS', cn: '美国移民局', kind: 'immigration' },
  { re: /department\s*of\s*motor\s*vehicles|\bDMV\b/i, en: 'Department of Motor Vehicles', abbr: 'DMV', cn: '车辆管理局', kind: 'dmv' },
  { re: /\bCalPERS\b|public\s*employees.?\s*retirement\s*system/i, en: 'CalPERS', abbr: 'CalPERS', cn: '加州公务员退休基金', kind: 'pension' },
  { re: /\bCalSTRS\b|state\s*teachers.?\s*retirement/i, en: 'CalSTRS', abbr: 'CalSTRS', cn: '加州教师退休基金', kind: 'pension' },
  { re: /\bCalFresh\b|\bSNAP\b|food\s*stamps/i, en: 'CalFresh', abbr: 'CalFresh', cn: 'CalFresh 食物补助', kind: 'benefits' },
  { re: /\bIHSS\b|in-?home\s*supportive\s*services/i, en: 'IHSS', abbr: 'IHSS', cn: 'IHSS 居家照顾服务', kind: 'benefits' },
  { re: /social\s*services\s*agency|department\s*of\s*public\s*social\s*services|\bDPSS\b/i, en: 'DPSS', abbr: 'DPSS', cn: '县社会服务局', kind: 'benefits' },
  { re: /treasurer-?\s*tax\s*collector|county\s*assessor|assessor-?recorder/i, en: 'County Tax Collector', abbr: null, cn: '县地税局', kind: 'property_tax' },
  { re: /superior\s*court|\bcourt\s*of\b|clerk\s*of\s*the\s*court|jury\s*commissioner/i, en: 'Superior Court', abbr: null, cn: '加州高等法院', kind: 'court' },

  // ---- 水电煤 / 电信 ----
  { re: /southern\s*california\s*edison|\bSCE\b/i, en: 'Southern California Edison', abbr: 'SCE', cn: '南加州爱迪生电力', kind: 'electric' },
  { re: /pacific\s*gas\s*(and|&)\s*electric|\bPG&?E\b/i, en: 'PG&E', abbr: 'PG&E', cn: '太平洋煤气电力', kind: 'gas_electric' },
  { re: /socalgas|southern\s*california\s*gas/i, en: 'SoCalGas', abbr: 'SoCalGas', cn: '南加州天然气', kind: 'gas' },
  { re: /\bLADWP\b|los\s*angeles\s*department\s*of\s*water/i, en: 'LADWP', abbr: 'LADWP', cn: '洛杉矶水电局', kind: 'water_electric' },
  { re: /clean\s*power\s*alliance/i, en: 'Clean Power Alliance', abbr: 'CPA', cn: 'Clean Power Alliance 电力', kind: 'electric' },
  { re: /\bwater\s*district\b|municipal\s*water|water\s*department/i, en: 'Water District', abbr: null, cn: '自来水公司', kind: 'water' },
  { re: /\bAT&?T\b|at&t\s*mobility/i, en: 'AT&T', abbr: 'AT&T', cn: 'AT&T 电信', kind: 'telecom' },
  { re: /\bverizon\b/i, en: 'Verizon', abbr: 'Verizon', cn: 'Verizon 电信', kind: 'telecom' },
  { re: /t-?mobile/i, en: 'T-Mobile', abbr: 'T-Mobile', cn: 'T-Mobile 电信', kind: 'telecom' },
  { re: /\bxfinity\b|\bcomcast\b/i, en: 'Xfinity', abbr: 'Xfinity', cn: 'Xfinity 网络', kind: 'telecom' },
  { re: /\bspectrum\b/i, en: 'Spectrum', abbr: 'Spectrum', cn: 'Spectrum 网络', kind: 'telecom' },

  // ---- 医疗 / 保险 ----
  { re: /kaiser\s*permanente/i, en: 'Kaiser Permanente', abbr: 'Kaiser', cn: 'Kaiser 医疗集团', kind: 'medical' },
  { re: /hoag\b/i, en: 'Hoag', abbr: 'Hoag', cn: 'Hoag 医院', kind: 'medical' },
  { re: /cedars-?sinai|ucla\s*health|keck\s*medicine|providence\s*(health|st)/i, en: 'Hospital', abbr: null, cn: '医院', kind: 'medical' },
  { re: /anthem\s*blue\s*cross|blue\s*shield|\bcigna\b|\baetna\b|unitedhealth(care)?|\bhumana\b|scan\s*health|molina\s*healthcare|health\s*net/i, en: 'Health Plan', abbr: null, cn: '健康保险公司', kind: 'health_insurance' },
  { re: /state\s*farm/i, en: 'State Farm', abbr: 'State Farm', cn: 'State Farm 保险', kind: 'insurance' },
  { re: /\ballstate\b/i, en: 'Allstate', abbr: 'Allstate', cn: 'Allstate 保险', kind: 'insurance' },
  { re: /\bgeico\b/i, en: 'GEICO', abbr: 'GEICO', cn: 'GEICO 保险', kind: 'insurance' },
  { re: /\bprogressive\b/i, en: 'Progressive', abbr: 'Progressive', cn: 'Progressive 保险', kind: 'insurance' },
  { re: /farmers\s*insurance/i, en: 'Farmers', abbr: 'Farmers', cn: 'Farmers 保险', kind: 'insurance' },
  { re: /mercury\s*insurance/i, en: 'Mercury', abbr: 'Mercury', cn: 'Mercury 保险', kind: 'insurance' },
  { re: /\bAAA\b|automobile\s*club\s*of\s*southern/i, en: 'AAA', abbr: 'AAA', cn: 'AAA 保险', kind: 'insurance' },
  { re: /pacific\s*life|new\s*york\s*life|northwestern\s*mutual|metlife|prudential/i, en: 'Life Insurer', abbr: null, cn: '人寿保险公司', kind: 'insurance' },
  { re: /genworth|mutual\s*of\s*omaha/i, en: 'LTC Insurer', abbr: null, cn: '长期护理保险公司', kind: 'insurance' },

  // ---- 银行 / 住房 ----
  { re: /bank\s*of\s*america|\bchase\b|wells\s*fargo|citibank|\bUS\s*Bank\b|east\s*west\s*bank|cathay\s*bank|credit\s*union/i, en: 'Bank', abbr: null, cn: '银行', kind: 'bank' },
  { re: /homeowners?\s*association|\bHOA\b|community\s*association|property\s*management/i, en: 'HOA', abbr: 'HOA', cn: '业主协会', kind: 'hoa' }
];

const SENDER_NOISE =
  /^(page\s*\d|go\s*paperless|retain\s*this|please\s*detach|www\.|http|thank\s*you|customer\s*service|account\s*number|statement)/i;

/*
 * 兜底挑机构名时，这些**绝不可能**是机构名，必须先排除。
 *
 * 起因：WM 那封垃圾账单认不出机构，兜底去挑「页面上方字号最大的一行」，
 * 挑中了 $87.05 —— 老人看到「寄件机构：$87.05」。
 *
 * 这条为什么重要：全美水电气垃圾公司几千家，机构词典永远补不完，
 * **兜底会一直被触发**，所以兜底自己必须是对的。
 * 显示「未知」是诚实的，显示一个金额是胡说。
 */
/*
 * 兜底挑机构名，方向必须是**白名单**：挑出来的那一行必须长得像机构名，
 * 而不是「排除掉不像的」。
 *
 * 黑名单排不完。第一版排除了金额，兜底就去挑了「Visit wm.com/MyWM」；
 * 再排除网址，它还会去挑别的。每补一条黑名单，它就换个地方咬。
 *
 * 白名单方向的代价是「更多信显示未知」，黑名单方向的代价是
 * 「老人看到『寄件机构：$87.05』」。跟决定 02 是同一个取舍。
 */
const LOOKS_LIKE_ORG =
  /\b(inc|llc|llp|ltd|corp|corporation|company|co|association|assoc|department|dept|bureau|agency|court|bank|credit\s*union|hospital|clinic|institute|medical|memorial|center|centre|district|county|city|state|university|college|school|insurance|assurance|health|healthcare|energy|gas|water|power|electric|utilities|utility|authority|administration|office|trust|fund|foundation|society|union|partners?|holdings?|management|properties|realty|mutual|federal|national|services?|systems?|group|waste|sanitation|disposal|recycling|edison|permanente)\b/i;

/*
 * 或者：整行大写、两个词以上、不含数字 —— 典型的信头写法
 *   SOUTHERN CALIFORNIA EDISON / HOAG ORTHOPEDIC INSTITUTE
 */
const LOOKS_LIKE_LETTERHEAD = (t) =>
  /^[A-Z][A-Z\s&.,'-]{5,}$/.test(t) && t.trim().split(/\s+/).length >= 2;

const detectSender = (lines, pageHeight) => {
  const joined = lines.map((line) => line.text).join(' \n ');

  /*
   * 一封信里可能同时出现多个已知机构。
   * 例：保险公司寄来的理赔说明里，文末会提到就诊的医院。
   * 寄件人的抬头一定在最上面，所以取「命中位置最靠上」的那个，
   * 而不是词典里排在最前面的那个。
   */
  const orgHits = [];

  for (let i = 0; i < KNOWN_ORGS.length; i += 1) {
    if (!KNOWN_ORGS[i].re.test(joined)) continue;

    const hit = lines.find((line) => KNOWN_ORGS[i].re.test(line.text));
    if (!hit) continue;

    orgHits.push({ org: KNOWN_ORGS[i], line: hit });
  }

  if (orgHits.length) {
    orgHits.sort((a, b) => a.line.top - b.line.top);

    const winner = orgHits[0];

    return {
      value: winner.org.en,
      // 有缩写就用缩写 —— SSA / DMV / HOA / SCE 这类
      // 比全称好认，也比全称好念
      abbr: winner.org.abbr,
      cn: winner.org.cn,
      kind: winner.org.kind,
      source: 'known-org',
      box: winner.line,
      // 页面上出现了不止一个已知机构，把握降一点
      confidence: orgHits.length > 1 ? 84 : 92,
      alternatives: orgHits.slice(1).map((h) => h.org.abbr)
    };
  }

  // 兜底：页面上方 35% 里字号最大、且不是噪声的一行
  const topZone = lines.filter(
    (line) =>
      line.top < pageHeight * 0.35 &&
      normalize(line.text).length >= 3 &&
      !SENDER_NOISE.test(normalize(line.text)) &&
      // 白名单：必须长得像机构名，否则宁可显示「未知」
      (LOOKS_LIKE_ORG.test(normalize(line.text)) ||
        LOOKS_LIKE_LETTERHEAD(normalize(line.text)))
  );

  if (!topZone.length) {
    return { value: null, abbr: null, cn: null, kind: 'unknown', source: 'none', box: null, confidence: 0 };
  }

  topZone.sort((a, b) => (b.height || 0) - (a.height || 0));

  return {
    value: normalize(topZone[0].text),
    abbr: null,
    cn: null,
    kind: 'unknown',
    source: 'largest-top-line',
    box: topZone[0],
    confidence: 45
  };
};


// ============================================================
// 文档类型
// ============================================================

/*
 * 信件类别
 *
 * 类别的判断来自两个方向的合力：
 *   1. 寄件机构是谁（sender.kind）—— 强信号
 *   2. 信里出现了什么关键词       —— 补充和纠偏
 *
 * baseUrgency 是这一类信的「默认紧急度」，
 * 之后还会被具体内容（催缴、停电、逾期、剩余天数）继续升降。
 */
const LETTER_CATEGORIES = [
  { id: 'medicare', cn: '红蓝卡 Medicare', kinds: ['medicare'], baseUrgency: 'yellow',
    re: /\bmedicare\s*(summary\s*notice|advantage|part\s*[abcd])\b|\bMSN\b|annual\s*notice\s*of\s*change|\bANOC\b|evidence\s*of\s*coverage|\bIRMAA\b|medicare\s*number/i, weight: 4 },

  { id: 'medi_cal', cn: '白卡 Medi-Cal', kinds: ['medi_cal'], baseUrgency: 'orange',
    re: /\bmedi[-\s]cal\b|annual\s*redetermination|\bMC\s*2(10|16|17)\b|notice\s*of\s*action|keep\s*your\s*(medi[-\s]cal\s*)?coverage|renew\s*your\s*medi[-\s]cal/i, weight: 4 },

  { id: 'social_security', cn: '社安局 SSA', kinds: ['social_security'], baseUrgency: 'orange',
    re: /social\s*security|\bSSI\b|cost-?of-?living\s*adjustment|\bCOLA\b|benefit\s*verification|award\s*letter|\bSSA-\d{3,4}\b|continuing\s*disability\s*review/i, weight: 4 },

  { id: 'pension', cn: '退休金', kinds: ['pension'], baseUrgency: 'green',
    re: /\bCalPERS\b|\bCalSTRS\b|retirement\s*(allowance|benefit|check)|annual\s*member\s*statement|\b1099-?R\b|pension\s*(payment|statement)/i, weight: 4 },

  { id: 'medical_provider', cn: '医院 / 诊所', kinds: ['medical'], baseUrgency: 'yellow',
    re: /\bpatient\b|\bappointment\b|\bprovider\b|medical\s*record|\bclinic\b|\bhospital\b|date\s*of\s*service|guarantor/i, weight: 3 },

  { id: 'health_insurance', cn: '健保 / 医疗保险', kinds: ['health_insurance'], baseUrgency: 'yellow',
    re: /explanation\s*of\s*benefits|\bEOB\b|\bmember\s*id\b|\bclaim\s*number\b|\bdeductible\b|\bcopay(ment)?\b|prior\s*authorization|\bformulary\b/i, weight: 3 },

  /*
   * 保险同理，必须分清是哪一种。
   * State Farm 既卖车险也卖房险，光看机构名没用，
   * 只能靠保单里特有的术语来分。
   */
  { id: 'auto_insurance', cn: '车险', kinds: ['insurance'], baseUrgency: 'yellow',
    re: /auto\s*(policy|insurance)|vehicle\s*(coverage|policy)|\bVIN\b|\bcollision\s*coverage\b|comprehensive\s*coverage|bodily\s*injury|uninsured\s*motorist|property\s*damage\s*liability|listed\s*drivers?/i, weight: 7 },

  { id: 'home_insurance', cn: '房屋保险', kinds: ['insurance'], baseUrgency: 'yellow',
    re: /homeowners?\s*(policy|insurance)|dwelling\s*coverage|hazard\s*insurance|personal\s*property\s*coverage|loss\s*of\s*use|\bHO-?[3456]\b|renters?\s*insurance|replacement\s*cost\s*of\s*your\s*home|location\s*of\s*residence|residence\s*premises|\bcondo\s*unitowners?\b/i, weight: 7 },

  { id: 'life_insurance', cn: '人寿保险', kinds: ['insurance'], baseUrgency: 'yellow',
    re: /life\s*insurance|death\s*benefit|face\s*amount|beneficiar(y|ies)\s*(on\s*file|designation)|term\s*life|whole\s*life|universal\s*life|cash\s*value/i, weight: 7 },

  { id: 'ltc_insurance', cn: '长期护理保险', kinds: ['insurance'], baseUrgency: 'yellow',
    re: /long-?term\s*care\s*(policy|insurance|benefit)|nursing\s*(home|facility)\s*benefit|custodial\s*care\s*benefit|assisted\s*living\s*benefit/i, weight: 7 },

  /*
   * 通用「保险」只是兜底。权重必须低于具体险种，
   * 否则 premium / policy 这类通用词出现次数多，
   * 反而会把「房屋保险」这种明确判断压下去 ——
   * 一张写着 Location of Residence Premises 的
   * State Farm 房屋保单就是这么被归成「种类待确认」的。
   */
  { id: 'insurance', cn: '保险（种类待确认）', kinds: ['insurance'], baseUrgency: 'yellow',
    re: /\bpolicy\s*(number|period)\b|\bcoverage\s*period\b|declarations?\s*page/i, weight: 1 },

  /*
   * 水电煤必须分开。
   * 老人看到「水电煤账单」还得自己再想一遍是哪个，
   * 直接说「电费账单」才是有用的信息。
   *
   * 判断依据是计量单位 —— 这比机构名可靠：
   *   kWh   -> 电
   *   therm -> 天然气
   *   HCF   -> 水
   * PG&E 同时供气供电，LADWP 同时供水供电，
   * 光看机构名分不出来，必须看账单里量的是什么。
   */
  { id: 'electric', cn: '电费账单', kinds: ['electric', 'gas_electric', 'water_electric'], baseUrgency: 'orange',
    re: /\bkwh\b|kilowatt|electric(ity)?\s*(service|charges|delivery|generation|usage)|baseline\s*allowance|generation\s*charges|delivery\s*charges/i, weight: 3 },

  { id: 'gas', cn: '天然气账单', kinds: ['gas', 'gas_electric'], baseUrgency: 'orange',
    re: /\btherms?\b|natural\s*gas|gas\s*(service|charges|usage|meter|delivery)/i, weight: 3 },

  { id: 'water', cn: '水费账单', kinds: ['water', 'water_electric'], baseUrgency: 'orange',
    re: /\bHCF\b|water\s*(service|usage|charges|consumption)|\bsewer\b|gallons\s*used|water\s*meter/i, weight: 3 },

  { id: 'trash', cn: '垃圾清运费', kinds: [], baseUrgency: 'green',
    re: /refuse\s*(collection|service)|waste\s*(collection|management)|sanitation\s*(service|charges)|trash\s*(service|collection)|recycling\s*service/i, weight: 3 },

  { id: 'telecom', cn: '电话 / 网络', kinds: ['telecom'], baseUrgency: 'green',
    re: /wireless\s*(bill|service|statement|account)|internet\s*service|data\s*plan|monthly\s*service\s*charge|data\s*(used|usage)\s*\(?GB|talk\s*&\s*text|unlimited\s*plan|mobility/i, weight: 3 },

  { id: 'bank', cn: '银行', kinds: ['bank'], baseUrgency: 'yellow',
    re: /\bcertificate\s*of\s*deposit\b|\bCD\s*(matures|maturity)\b|dormant\s*account|inactive\s*account|unclaimed\s*property|escheat|overdraft|insufficient\s*funds|account\s*statement|\bFDIC\b/i, weight: 3 },

  { id: 'property_tax', cn: '房产地税', kinds: ['property_tax'], baseUrgency: 'orange',
    re: /property\s*tax|secured\s*property|supplemental\s*(tax|assessment)|assessed\s*value|\bparcel\s*number\b|\bAPN\b|homeowners?.?\s*exemption|tax\s*collector/i, weight: 4 },

  { id: 'tax', cn: '报税（IRS / 加州税局）', kinds: ['tax'], baseUrgency: 'orange',
    re: /internal\s*revenue|franchise\s*tax|\bnotice\s*CP\d+\b|tax\s*(return|year)\s*\d{4}|\bform\s*1040\b|amount\s*you\s*owe.*IRS|balance\s*due.*tax/i, weight: 4 },

  { id: 'hoa', cn: '业主协会 HOA', kinds: ['hoa'], baseUrgency: 'orange',
    re: /homeowners?\s*association|\bassessment(s)?\s*(due|delinquent)\b|\bpre-?lien\b|notice\s*of\s*delinquent\s*assessment|architectural\s*(review|violation)|\bCC&Rs?\b|violation\s*notice/i, weight: 4 },

  { id: 'dmv', cn: '车管所 DMV', kinds: ['dmv'], baseUrgency: 'orange',
    re: /vehicle\s*registration|registration\s*renewal|driver\s*license|\bsmog\s*(check|certification)\b|license\s*plate|\bVIN\b/i, weight: 4 },

  { id: 'court', cn: '法院', kinds: ['court'], baseUrgency: 'red',
    re: /\bsummons\b|\bsubpoena\b|jury\s*(duty|summons|service)|\bplaintiff\b|\bdefendant\b|case\s*(no|number)|unlawful\s*detainer|small\s*claims|notice\s*to\s*appear|\bhearing\s*date\b/i, weight: 5 },

  { id: 'immigration', cn: '移民局 USCIS', kinds: ['immigration'], baseUrgency: 'red',
    re: /\bUSCIS\b|receipt\s*notice|request\s*for\s*evidence|\bRFE\b|\bform\s*I-\d{3}\b|permanent\s*resident\s*card|naturalization/i, weight: 5 },

  { id: 'benefits', cn: '政府福利', kinds: ['benefits'], baseUrgency: 'orange',
    re: /\bCalFresh\b|food\s*stamps|\bIHSS\b|\bSNAP\b|public\s*social\s*services|benefit\s*(amount|month)|recertification|semi-?annual\s*report/i, weight: 3 },

  { id: 'marketing', cn: '广告推销', kinds: [], baseUrgency: 'green',
    re: /\blimited\s*time\b|\bapply\s*now\b|you\s*may\s*qualify|special\s*offer|act\s*now|pre-?approved|\bno\s*obligation\b|call\s*today/i, weight: 2 }
];

const detectCategory = (lines, sender) => {
  const joined = lines.map((line) => line.text).join(' \n ');
  const scores = {};

  /*
   * 内容得分要和机构加分分开记。
   *
   * SCE 除了寄电费账单，也会寄监管报告、施工通知、停电预告。
   * 早期版本里「机构是 SCE」单独就给 8 分，
   * 刚好够到 trusted 的门槛，于是一封写给加州公用事业委员会的
   * 安全评估函被判定成了「电费账单」。
   *
   * 机构只能起加权作用，不能单独定性 ——
   * 必须信件内容里也出现了这类信件该有的词。
   */
  const contentScores = {};

  LETTER_CATEGORIES.forEach((cat) => {
    const matches = joined.match(new RegExp(cat.re.source, 'gi'));
    if (matches) {
      contentScores[cat.id] = matches.length * cat.weight;
      scores[cat.id] = (scores[cat.id] || 0) + matches.length * cat.weight;
    }

    // 寄件机构对上了，是很强的信号 —— 但只是加权，不能单独定性
    if (sender && sender.kind && cat.kinds.includes(sender.kind)) {
      scores[cat.id] = (scores[cat.id] || 0) + 8;
    }
  });

  const ranked = Object.keys(scores).sort((a, b) => scores[b] - scores[a]);

  if (!ranked.length) {
    return {
      id: 'unknown',
      cn: '暂时认不出类别',
      baseUrgency: 'yellow',
      score: 0,
      trusted: false
    };
  }

  const cat = LETTER_CATEGORIES.find((c) => c.id === ranked[0]);

  /*
   * PG&E 一张账单同时收电费和天然气费，
   * LADWP 同时收水费和电费。
   * 两项都明显命中时，标签要如实反映，
   * 不能随便挑一个说成「电费账单」。
   */
  const UTILITY_IDS = ['electric', 'gas', 'water'];
  const UTILITY_CN = { electric: '电费', gas: '天然气费', water: '水费' };

  if (UTILITY_IDS.includes(cat.id)) {
    const strong = UTILITY_IDS.filter(
      (id) => (scores[id] || 0) >= Math.max(6, scores[cat.id] * 0.5)
    );

    if (strong.length > 1) {
      return {
        id: cat.id,
        cn: strong.map((id) => UTILITY_CN[id]).join('和') + '账单',
        baseUrgency: cat.baseUrgency,
        score: scores[cat.id],
        contentScore: contentScores[cat.id] || 0,
        trusted: (contentScores[cat.id] || 0) >= 3,
        combinedUtilities: strong
      };
    }
  }

  return {
    id: cat.id,
    cn: cat.cn,
    baseUrgency: cat.baseUrgency,
    score: scores[cat.id],
    contentScore: contentScores[cat.id] || 0,
    // 总分够 + 内容里确实有证据，两个条件都要满足
    trusted: scores[cat.id] >= 6 && (contentScores[cat.id] || 0) >= 3,
    runnerUp: ranked[1] || null
  };
};


// ============================================================
// 信件子类型
//
// 认出具体是哪一种信，能让「大意」精确得多。
// 例：同样是 Medicare 寄来的，
//   MSN  = 理赔汇总，不用做事
//   ANOC = 明年计划要变，得在开放注册期之前看
// ============================================================

const LETTER_SUBTYPES = [
  { id: 'MSN', category: 'medicare', notABill: true, cn: 'Medicare 理赔汇总通知（MSN）', re: /medicare\s*summary\s*notice|\bMSN\b/i,
    gist: '这是 Medicare 寄来的理赔汇总，列出这段时间看了哪些病、Medicare 付了多少。这不是账单，通常不用做任何事，核对一下有没有你没做过的项目就行。', urgency: 'green' },

  { id: 'ANOC', category: 'medicare', notABill: true, cn: 'Medicare 计划变更通知（ANOC）', re: /annual\s*notice\s*of\s*change|\bANOC\b/i,
    gist: '这封信说明你的 Medicare 计划明年的保费、药物清单或就医规则会有变化。不用马上做事，但要在每年的开放注册期结束前看一遍，决定要不要换计划。', urgency: 'yellow' },

  { id: 'EOB', category: 'health_insurance', notABill: true, cn: '保险理赔说明（EOB）', re: /explanation\s*of\s*benefits|\bEOB\b/i,
    gist: '这是保险公司寄来的理赔说明，告诉你这次看病一共多少钱、保险付了多少、你可能还要付多少。它本身不是账单。', urgency: 'green' },

  { id: 'NOA', category: 'benefits', notABill: true, cn: '福利决定通知（Notice of Action）', re: /notice\s*of\s*action\b/i,
    gist: '这是政府对你的福利资格做出的正式决定通知，可能是批准、变更或停止。如果不同意，信里通常会写申诉期限。', urgency: 'orange' },

  { id: 'REDETERMINATION', category: 'medi_cal', notABill: true, cn: '白卡年度资格复审', /*
     * MC 216 是现在真正在寄的那张年度复审表（MC 210 RV 是旧的）。
     * 官方措辞是「Your Medi-Cal is up for renewal.」，
     * 比旧版的「annual redetermination」软得多，原来一条都不命中。
     */
    re: /annual\s*redetermination|renew\s*your\s*medi[-\s]cal|keep\s*your\s*coverage|\bMC\s*2(10\s*RV|16|17)\b|medi[-\s]cal\s*(is\s*up\s*for\s*renewal|renewal\s*form)|your\s*medi[-\s]cal\s*is\s*up\s*for\s*renewal/i,
    gist: '这是白卡（Medi-Cal）的年度资格复审。必须按时把表格填好寄回，否则医疗保险会被停掉。', urgency: 'red' },

  { id: 'COLA', category: 'social_security', notABill: true, cn: '社安金生活费调整通知（COLA）', re: /cost-?of-?living\s*adjustment|\bCOLA\b.*(notice|increase)/i,
    gist: '这是社安局通知你明年每月能领到的金额有调整。不用做任何事，收好备查即可。', urgency: 'green' },

  { id: 'SSA_OVERPAYMENT', category: 'social_security', notABill: false, cn: '社安金多付追讨通知', re: /(we|social\s*security)\s*(paid|overpaid)\s*you|overpayment\s*(notice|of)|you\s*were\s*overpaid/i,
    gist: '社安局认为多付了钱给你，要求退回。这类信有严格期限，通常是 30 天内提出异议或申请豁免，逾期会直接从每月的社安金里扣。', urgency: 'red' },

  { id: 'HOA_PRELIEN', category: 'hoa', notABill: false, cn: 'HOA 留置权前置通知', re: /pre-?lien|intent\s*to\s*lien|notice\s*of\s*delinquent\s*assessment|placed\s*in\s*foreclosure/i,
    gist: '业主协会通知你管理费拖欠，如果 30 天内不处理，可能会对房子设定留置权，严重时房子会被强制拍卖。这是非常严重的信。', urgency: 'red' },

  { id: 'JURY', category: 'court', notABill: true, cn: '陪审团传票', re: /jury\s*(summons|duty|service)|juror\s*(number|badge)|report\s*for\s*jury/i,
    gist: '这是法院寄来的陪审员传票。必须在指定日期前回复，年满一定岁数或健康原因可以申请免除，但不能不理。', urgency: 'red' },

  /*
   * 停供通知不写死类别 —— 停电、停气、停水共用这套措辞，
   * 具体是哪一种交给计量单位去判断。
   */
  { id: 'SHUTOFF', category: null, notABill: false, cn: '停水停电通知', re: /disconnection\s*notice|shut-?off\s*notice|service\s*(will|may)\s*be\s*(disconnected|discontinued)/i,
    gist: '水电公司通知即将停止供应。必须在信上写的日期之前缴费或联系公司安排分期，否则会被断供。', urgency: 'red' },

  { id: 'DMV_RENEWAL', category: 'dmv', notABill: false, cn: '车辆注册续期通知', re: /registration\s*renewal\s*notice|renew\s*your\s*(vehicle\s*)?registration/i,
    gist: '车管所通知车辆注册要到期了，需要在到期日前缴费续期，逾期会有罚款。', urgency: 'orange' },

  { id: 'CD_MATURITY', category: 'bank', notABill: true, cn: '定存到期通知', re: /\bCD\s*(matures|maturity|will\s*mature)|certificate\s*of\s*deposit\s*(matures|maturity)|grace\s*period/i,
    gist: '银行通知你的定期存款快到期了。如果在宽限期内不做选择，通常会按当时的利率自动转存，利率可能比原来低。', urgency: 'orange' },

  { id: 'DORMANT', category: 'bank', notABill: true, cn: '账户休眠 / 无人认领财产通知', re: /dormant\s*account|inactive\s*account|unclaimed\s*property|escheat/i,
    gist: '银行通知你的账户长期没有动过，如果继续不使用，里面的钱会被上缴给州政府保管。做一笔存取或联系银行就能避免。', urgency: 'orange' },

  { id: 'PROPERTY_TAX_BILL', category: 'property_tax', notABill: false, cn: '地税单', re: /secured\s*property\s*tax\s*bill|annual\s*property\s*tax|first\s*installment|second\s*installment/i,
    gist: '这是每年的房产地税单，通常分两期缴纳。逾期会有 10% 罚款，一定要留意信上的两个截止日。', urgency: 'orange' },

  { id: 'RFE', category: 'immigration', notABill: true, cn: '移民局补件通知（RFE）', re: /request\s*for\s*evidence|\bRFE\b|additional\s*evidence\s*is\s*needed/i,
    gist: '移民局要求补充材料。这类信有明确期限，过期不补件申请会被拒。务必尽快找律师或家人处理。', urgency: 'red' }
];

const detectSubtype = (lines) => {
  const joined = lines.map((line) => line.text).join(' \n ');

  for (let i = 0; i < LETTER_SUBTYPES.length; i += 1) {
    if (LETTER_SUBTYPES[i].re.test(joined)) {
      return LETTER_SUBTYPES[i];
    }
  }
  return null;
};


// ============================================================
// 疑似诈骗信号
//
// 研究要点（来自 Medicare / FTC 的公开说明）：
//   · Medicare 从不主动寄信索取 Medicare 号或 SSN
//   · 从不为「换新卡」收取手续费
//   · 从不威胁取消福利
//   · 正规退款是自动处理的，不会要银行账号
//
// 老人是这类信的头号目标，而且恰恰最难分辨。
// 命中两条以上就直接标红。
// ============================================================

const SCAM_SIGNALS = [
  { re: /verify\s*your\s*(medicare|social\s*security)\s*(number|card)/i, cn: '要求你核对 Medicare 号或社安号', weight: 3 },
  { re: /(processing|activation|shipping)\s*fee.*(card|benefit)|fee\s*to\s*(issue|mail|activate)\s*your\s*(new\s*)?card/i, cn: '要求为「新卡」支付手续费', weight: 3 },
  { re: /your\s*(benefits?|coverage|account)\s*will\s*be\s*(cancell?ed|terminated|suspended)\s*(unless|if\s*you\s*do\s*not)/i, cn: '威胁取消你的福利', weight: 3 },
  { re: /new\s*(medicare|benefits?)\s*card\s*(has\s*been\s*)?(issued|approved|ready)/i, cn: '声称已为你签发新卡', weight: 2 },
  { re: /you\s*(have\s*)?(won|are\s*a\s*winner)|sweepstakes|claim\s*your\s*prize|cash\s*award/i, cn: '中奖 / 抽奖话术', weight: 3 },
  { re: /wire\s*transfer|money\s*gram|western\s*union|gift\s*card|prepaid\s*card|cryptocurrency|bitcoin/i, cn: '要求用电汇、礼品卡等无法追回的方式付款', weight: 3 },
  { re: /within\s*(24|48)\s*hours|immediate\s*action\s*required|final\s*warning|do\s*not\s*ignore/i, cn: '制造紧迫感催你马上行动', weight: 1 },
  { re: /send\s*(us\s*)?your\s*(social\s*security|bank\s*account|routing)\s*number/i, cn: '直接索要社安号或银行账号', weight: 3 },
  { re: /call\s*this\s*number\s*immediately|call\s*within\s*\d+\s*(hours|days)\s*to\s*avoid/i, cn: '催促立刻拨打某个电话', weight: 1 }
];

const detectScamSignals = (lines) => {
  const hits = [];

  lines.forEach((line) => {
    SCAM_SIGNALS.forEach((rule) => {
      if (hits.some((h) => h.cn === rule.cn)) return;
      if (rule.re.test(line.text)) {
        hits.push({ cn: rule.cn, weight: rule.weight, box: line });
      }
    });
  });

  const score = hits.reduce((sum, h) => sum + h.weight, 0);

  return {
    hits,
    score,
    // 单独一条「制造紧迫感」不足以定性，正规催缴信也会这么写
    suspected: score >= 4
  };
};


// ============================================================
// 紧急程度：红 / 橙 / 黄 / 绿
//
// 最重要的一条规则写在最后：
// 拿不准的时候往「更紧急」的方向靠，绝不往绿色靠。
// 把紧急的信说成不紧急，代价远大于反过来。
// ============================================================

const URGENCY_ORDER = ['green', 'yellow', 'orange', 'red'];

/*
 * 四个等级都给颜色，最紧急的那一档再叠一个感叹号。
 * 颜色让老人一眼分出轻重，感叹号把「最要紧」再拔高一层。
 *
 * 注意这里不再写死 hint。
 * 原来每个等级配一句固定提示，结果出现过自相矛盾的输出：
 *   橙色（因为「要付钱」触发）配的提示是「有明确期限」，
 *   下面紧接着却写「信里没有找到明确的截止日期」。
 * 现在提示语由 buildUrgencyHint 按真实原因生成。
 */
const URGENCY_META = {
  red: { flag: '🔴', symbol: '‼️', cn: '非常紧急' },
  orange: { flag: '🟠', symbol: '', cn: '要留意' },
  yellow: { flag: '🟡', symbol: '', cn: '看一下就好' },
  green: { flag: '🟢', symbol: '', cn: '不用做什么' }
};

/**
 * 按「到底为什么是这个等级」来生成提示语，
 * 而不是按等级套一句现成的话。
 */
const buildUrgencyHint = (level, ctx) => {
  const { remaining, dueDateKnown, isPaymentDemand, hasSevere, category } = ctx;

  const parts = [];

  if (dueDateKnown && remaining !== null) {
    if (remaining < 0) {
      parts.push(`信上的日期已经过了 ${Math.abs(remaining)} 天`);
    } else if (remaining === 0) {
      parts.push('信上写的截止日期就是今天');
    } else if (remaining <= 7) {
      parts.push(`离信上写的日期只剩 ${remaining} 天`);
    } else {
      parts.push(`离信上写的日期还有 ${remaining} 天`);
    }
  } else if (isPaymentDemand) {
    // 这里正是原来出矛盾的地方：要付钱，但日期没读到
    parts.push('这封信要交钱，但小助手没在信上找到截止日期');
  } else if (hasSevere) {
    parts.push('信里有需要处理的事情，但没写明具体日期');
  }

  if (level === 'red') {
    parts.push('请尽快处理，最好今天就找家人一起看');
  } else if (level === 'orange') {
    parts.push(
      isPaymentDemand && !dueDateKnown
        ? '建议找家人核对一下要交多少、什么时候交'
        : '别放着不管'
    );
  } else if (level === 'yellow') {
    if (!parts.length) parts.push('不急，但建议抽空看看');
  } else {
    if (!parts.length) {
      parts.push(
        category && category.trusted
          ? '通常只是通知，收好即可'
          : '看起来不用做什么，但小助手没完全看懂，收好备查'
      );
    }
  }

  return parts.join('，') + '。';
};

const raise = (current, next) =>
  URGENCY_ORDER.indexOf(next) > URGENCY_ORDER.indexOf(current) ? next : current;

const daysUntil = (iso, today) => {
  if (!iso) return null;
  const target = new Date(`${iso}T00:00:00Z`).getTime();
  const now = new Date(
    `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}-${String(
      today.getUTCDate()
    ).padStart(2, '0')}T00:00:00Z`
  ).getTime();
  if (!Number.isFinite(target)) return null;
  return Math.round((target - now) / 86400000);
};

const computeUrgency = (context) => {
  const {
    category,
    subtype,
    phrases,
    scam,
    amount,
    dueDate,
    today,
    explicitlyNotABill
  } = context;

  const reasons = [];

  // ---- 起点 ----
  let level = subtype ? subtype.urgency : category.baseUrgency;
  if (subtype) reasons.push(`信件类型：${subtype.cn}`);

  // ---- 诈骗直接封顶 ----
  if (scam.suspected) {
    return {
      ...URGENCY_META.red,
      level: 'red',
      isScamWarning: true,
      reasons: ['这封信有多处诈骗常见特征'].concat(scam.hits.map((h) => h.cn)),
      hint: '先别按信上的指示做任何事，找家人一起看。'
    };
  }

  // ---- 句式命中 ----
  /*
   * 区分两种严重措辞：
   *
   *   状态型 —— 「已经逾期」「最后通知」「已转催收」
   *             描述的是当下的事实，永远标红。
   *
   *   条件型 —— 「逾期会加收 10% 罚款」「不回复会终止保险」
   *             描述的是错过期限之后才会发生的事。
   *             一封 12 月才到期的地税单在 8 月标红，
   *             只会让老人对红色警报麻木，反而更危险。
   *
   * 所以条件型只有在「期限未知或已经很近」时才升到红。
   */
  const remainingPreview =
    dueDate && dueDate.trusted ? daysUntil(dueDate.value, today) : null;

  /*
   * 「不知道期限」和「期限就在眼前」是两回事。
   *
   * 里弗赛德县真实地税单写着
   *   「penalty of 10% if paid after the delinquency date of December 10th」
   * 这是条件型严重措辞，但没有可解析的完整日期。
   * 早期版本把「期限未知」当成「期限很近」，
   * 于是一张 12 月才到期的地税单在 8 月被标成 🔴。
   *
   * 天天见红，老人就不再把红色当回事 —— 反而更危险。
   *
   * 现在期限未知时，条件型措辞最多升到 🟠。
   * 真正危险的那几类（法院、HOA 留置权、移民补件、白卡复审）
   * 本身的基准紧急度就是红，不受这条影响。
   */
  const deadlineIsNear =
    remainingPreview !== null && remainingPreview <= 21;

  /*
   * 真实的 CMS MSN 样本上同时写着：
   *   「THIS IS NOT A BILL」
   *   「Appeals must be filed in writing ... within 120 days」
   *
   * 后面那句是在告诉你「如果你想申诉，窗口有多长」，
   * 是一项权利。早期版本把它当成待办义务，
   * 于是一封明说不用做事的信被标成了橙色。
   *
   * 所以：信件已明说不是账单时，申诉类措辞不参与紧急度升级。
   * 反过来，福利终止通知（notABill 为 false）里的申诉期限
   * 依然照常升级 —— 那时候申诉才是真的要紧。
   */
  const relevantPhrases = explicitlyNotABill
    ? phrases.filter((p) => !p.appealRelated)
    : phrases;

  const unconditionalSevere = relevantPhrases.some(
    (p) => p.severity >= 3 && !p.conditional
  );
  const conditionalSevere = relevantPhrases.some(
    (p) => p.severity >= 3 && p.conditional
  );

  const maxSeverity = relevantPhrases.reduce(
    (max, p) => Math.max(max, p.severity),
    -1
  );

  if (unconditionalSevere) {
    level = raise(level, 'red');
    reasons.push('信里有需要马上处理的措辞');
  } else if (conditionalSevere) {
    if (deadlineIsNear) {
      level = raise(level, 'red');
      reasons.push('信里写明了过期的后果，而期限就在眼前');
    } else {
      level = raise(level, 'orange');
      reasons.push('信里写明了过期会有后果，但期限还早');
    }
  } else if (maxSeverity === 2) {
    level = raise(level, 'orange');
  } else if (maxSeverity === 1) {
    level = raise(level, 'yellow');
  }

  // ---- 截止日期还剩几天 ----
  const remaining = dueDate && dueDate.trusted ? daysUntil(dueDate.value, today) : null;

  if (remaining !== null) {
    if (remaining < -180) {
      /*
       * 半年以上的「过期」几乎不可能是真的待办事项，
       * 更可能是识别错了日期，或者这是一封陈年旧信。
       * 这种情况不报警，改成提示看不准。
       */
      reasons.push('信上的日期已经过去很久，可能识别有误');
    } else if (remaining < 0) {
      level = raise(level, 'red');
      reasons.push(`截止日期已经过了 ${Math.abs(remaining)} 天`);
    } else if (remaining <= 7) {
      level = raise(level, 'red');
      reasons.push(`离截止日只剩 ${remaining} 天`);
    } else if (remaining <= 21) {
      level = raise(level, 'orange');
      reasons.push(`离截止日还有 ${remaining} 天`);
    }
  }

  // ---- 要交钱 ----
  if (amount && amount.isPaymentDemand) {
    level = raise(level, 'orange');
    reasons.push('这封信要求付款');
  }

  // ---- 唯一允许降级的情况 ----
  //
  // 信里明说了「不是账单 / 不需要付款」，
  // 而且确实没有金额、没有期限、没有严重措辞。
  const explicitlyNoAction = relevantPhrases.some(
    (p) => p.intent === 'INFO_ONLY'
  );
  const nothingToDo =
    explicitlyNoAction &&
    maxSeverity <= 0 &&
    !(amount && amount.isPaymentDemand) &&
    remaining === null;

  if (nothingToDo) {
    return {
      ...URGENCY_META.green,
      level: 'green',
      isScamWarning: false,
      reasons: ['信里明确写了不需要付款，也没有截止日期'],
      hint: '信里写明了不需要付款，收好备查就可以。'
    };
  }

  // ---- 兜底：认不出类别就不许说「不用管」----
  //
  // 绿色的含义是「我看懂了，确实不用做事」，
  // 而不是「我没看懂，所以大概没事」。
  if (!category.trusted && level === 'green') {
    level = 'yellow';
    reasons.push('这封信的类别没能确定，保险起见提醒一下');
  }

  if (!reasons.length) reasons.push('按这类信件的常规情况判断');

  return {
    ...URGENCY_META[level],
    level,
    isScamWarning: false,
    reasons,
    hint: buildUrgencyHint(level, {
      remaining,
      dueDateKnown: Boolean(dueDate && dueDate.trusted),
      isPaymentDemand: Boolean(amount && amount.isPaymentDemand),
      hasSevere: unconditionalSevere || conditionalSevere,
      category
    })
  };
};


// ============================================================
// 意图 / 高频句式词典
//
// 「内容大意」不可能靠一句模板覆盖所有信件，
// 但美国的账单和通知高度套路化 —— 真正重要的那几句话
// 翻来覆去就是这些。这里把它们直接翻成中文，
// 不需要模型，也不会出现模型幻觉。
// ============================================================

const PHRASE_RULES = [
  { re: /service\s*(may|will|can)\s*be\s*(disconnected|shut\s*off|terminated)|disconnection\s*notice|shut-?off\s*notice/i,
    cn: '信里提到：如果不按时缴费，可能会被停止供电或供水。', intent: 'SHUTOFF_WARNING', severity: 3, conditional: true },
  { re: /final\s*notice|last\s*notice|urgent\s*notice/i,
    cn: '信里写明这是最后一次通知。', intent: 'COLLECTION', severity: 3 },
  { re: /past\s*due|overdue|delinquent/i,
    cn: '信里提到这笔费用已经逾期。', intent: 'COLLECTION', severity: 3 },
  { re: /collection\s*agency|referred\s*for\s*collection|sent\s*to\s*collections/i,
    cn: '信里提到欠款可能会被转交催收公司。', intent: 'COLLECTION', severity: 3 },
  { re: /late\s*(fee|charge|payment\s*charge)|penalty\s*(will|may)\s*be/i,
    cn: '信里提到逾期会产生滞纳金。', intent: 'PAY', severity: 2 },
  { re: /you\s*must\s*(respond|reply|appear|contact)|response\s*(is\s*)?required|failure\s*to\s*respond/i,
    cn: '信里要求您在期限内做出回复。', intent: 'VERIFY_INFO', severity: 3, conditional: true },
  /*
   * 这里踩过一个非常危险的坑。
   *
   * 一张真实的 Ventura River 水费账单上印着：
   *   「RECURRING PAYMENT - DO NOT PAY」
   * 意思是「你已经登记了自动扣款，不要再重复交一次」——
   * 钱照样要付，只是不用手动付。
   *
   * 但 do not pay 命中了这条 INFO_ONLY 规则，
   * 于是 $71.20 的真账单被告诉老人
   * 「这不是账单，不用交钱」。
   *
   * 所以 do not pay 从这条规则里拿掉了，
   * 只保留含义明确、不会有歧义的说法。
   */
  /*
   * 真实的 AT&T 账单印的是「Payment is Not Required」，
   * 我原来只写了「no payment is required」—— 语序反过来就匹配不上。
   * 同一个意思英文有好几种说法，这里把常见语序都覆盖。
   */
  { re: /this\s*is\s*not\s*a\s*bill|no\s*payment\s*(is\s*)?(required|due|necessary)|payment\s*(is\s*)?not\s*(required|due|necessary)|do\s*not\s*send\s*(a\s*)?payment|nothing\s*is\s*due/i,
    cn: '信里明确说明这不是账单，不需要付款。', intent: 'INFO_ONLY', severity: 0 },

  /* do not pay 的真正含义：已登记自动扣款 */
  { re: /recurring\s*payment.{0,12}do\s*not\s*pay|do\s*not\s*pay.{0,20}(auto\s?pay|recurring|already\s*enrolled)|enrolled\s*in\s*auto\s?pay|automatic\s*(bank\s*)?draft|billed\s*through/i,
    cn: '您已经登记了自动扣款，这笔钱会自动从账户扣走，不用再手动去交一次。',
    intent: 'AUTOPAY_NOTICE', severity: 1, autopayConfirmed: true },
  { re: /explanation\s*of\s*benefits|\bEOB\b/i,
    cn: '这是保险理赔说明，通常不是要您付钱的账单。', intent: 'INFO_ONLY', severity: 0 },
  /*
   * 原来只要出现 auto-pay 三个字就算「已自动扣款」。
   * 但 AT&T 账单上有「$20 AutoPay discount」（营销话术）和
   * 「CHECK FOR AUTO PAY (SEE REVERSE)」（一个待勾选的空方框）——
   * 两者都只是**提到**自动扣款，不代表这个账户已经登记了。
   * 必须有「你的 / 已登记 / 将会扣」这类归属或时态的词才算数。
   */
  { re: /your\s*(account\s*)?(is\s*)?(enrolled|set\s*up|signed\s*up)\s*(in|for)\s*auto-?pay|automatic(ally)?\s*(payment|withdraw(al)?|deduct(ion)?|debit)\s*(will|has|is)|will\s*be\s*(automatically\s*)?(charged|drafted|deducted)\s*(to|from)\s*your|payment\s*will\s*be\s*automatically/i,
    cn: '信里提到会自动扣款，通常不需要另外操作。', intent: 'AUTOPAY_NOTICE', severity: 1 },
  { re: /appointment\s*(is\s*)?(scheduled|confirmed)|your\s*visit\s*(is\s*)?on|please\s*arrive/i,
    cn: '这是就诊或预约通知。', intent: 'APPOINTMENT', severity: 1 },
  { re: /renewal\s*notice|renew\s*your\s*(policy|coverage|plan)|policy\s*(will\s*)?(expire|renew)/i,
    cn: '这是保单或资格的续期通知。', intent: 'RENEWAL', severity: 2 },
  { re: /rate\s*(increase|change|adjustment)|premium\s*(will\s*)?(increase|change)|new\s*rate/i,
    cn: '信里提到费率或保费有变动。', intent: 'BENEFIT_CHANGE', severity: 2 },
  { re: /verify\s*your\s*(information|identity|income)|proof\s*of\s*(income|residence)|additional\s*(information|documents)\s*(is\s*)?(needed|required)/i,
    cn: '信里要求您提供或核对个人资料。', intent: 'VERIFY_INFO', severity: 3 },
  { re: /benefits?\s*(will|may)\s*(end|change|be\s*terminated)|no\s*longer\s*(eligible|qualify)/i,
    cn: '信里提到您的福利或资格可能发生变化。', intent: 'BENEFIT_CHANGE', severity: 3, conditional: true },
  { re: /court\s*(date|hearing)|you\s*are\s*(hereby\s*)?summoned|failure\s*to\s*appear/i,
    cn: '信里涉及法院程序和出庭要求。', intent: 'LEGAL_DEADLINE', severity: 3 },
  { re: /limited\s*time|apply\s*now|you\s*may\s*qualify|special\s*offer|pre-?approved/i,
    cn: '这看起来是一封推销广告。', intent: 'MARKETING', severity: 0 },

  // ---- 通用期限句式（覆盖面最广的一批）----
  { re: /you\s*have\s*\d+\s*(calendar\s*|business\s*)?days\s*to|within\s*\d+\s*(calendar\s*|business\s*)?days(\s*(from|of|after))?/i,
    cn: '信里给了一个明确的天数期限，过期会有后果。', intent: 'DEADLINE', severity: 3, conditional: true },
  { re: /must\s*be\s*(received|postmarked|returned|submitted)\s*by|we\s*must\s*receive\s*.{0,40}\s*by|send\s*it\s*back\s*to\s*us\s*by|no\s*later\s*than\s*\w+\s*\d{1,2}/i,
    cn: '信里要求在指定日期之前寄回或提交。', intent: 'DEADLINE', severity: 3, conditional: true },
  { re: /(complete|sign|fill\s*out)\s*and\s*(return|submit)\s*(the\s*)?(enclosed\s*)?(form|questionnaire)?|return\s*the\s*enclosed\s*form|fill\s*out\s*and\s*return/i,
    cn: '信里附了表格，需要填好签名寄回。', intent: 'VERIFY_INFO', severity: 3, conditional: true },
  /*
   * 真实的 Medi-Cal 年度复审通知写的是
   *   「your Medi-Cal or health plan benefits may be stopped」
   *   「we will take steps to stop your Medi-Cal」
   * 原来只匹配 will end / will be terminated，
   * 这两句真实措辞全都漏掉了 —— 而这是最不该漏的一类信。
   */
  { re: /(your\s*)?(coverage|benefits?|eligibility|medi[-\s]cal)\s*(will|may)\s*(end|be\s*(terminated|stopped|discontinued|cancell?ed)|stop)|take\s*steps\s*to\s*stop\s*your/i,
    cn: '信里提到你的保险或福利可能会被停掉。', intent: 'BENEFIT_CHANGE', severity: 3, conditional: true },
  { re: /(request|file)\s*(an\s*)?(appeal|reconsideration)|you\s*have\s*the\s*right\s*to\s*appeal/i,
    cn: '如果不同意信里的决定，可以在期限内提出申诉。', intent: 'DEADLINE', severity: 2 },

  // ---- 房产 / HOA ----
  { re: /10\s*%\s*penalty|penalty\s*of\s*10\s*%|penalt(y|ies)\s*(of\s*)?.{0,20}(will\s*be\s*)?(added|imposed|apply)|plus\s*cost\s*if\s*paid\s*after|if\s*paid\s*after\s*the\s*delinquen/i,
    cn: '逾期会被加收罚款。', intent: 'PAY', severity: 3, conditional: true },
  { re: /foreclos(e|ure)|may\s*be\s*sold\s*without\s*court\s*action|lien\s*(may\s*be\s*)?recorded/i,
    cn: '信里提到房子可能被设定留置权甚至被拍卖，这是很严重的情况。', intent: 'LEGAL_DEADLINE', severity: 3, conditional: true },

  // ---- 法院 / 车管 ----
  /*
   * 加州中区联邦法院真实传票原文：
   *   「FAILURE TO OBEY THIS SUMMONS MAY RESULT IN A FINE OF NOT MORE THAN $1,000,
   *     IMPRISONMENT FOR NOT MORE THAN THREE DAYS...」
   * 原来只匹配 failure to appear，漏掉了 failure to obey。
   */
  { re: /report\s*(for\s*jury|to\s*the\s*courthouse)|failure\s*to\s*(appear|obey|comply|respond|return)\s*.{0,30}(may|will)\s*result|the\s*court\s*summons\s*you/i,
    cn: '信里要求你在指定日期到法院报到，不理会会被罚款。', intent: 'LEGAL_DEADLINE', severity: 3 },
  { re: /smog\s*certification\s*(is\s*)?required|proof\s*of\s*insurance\s*(is\s*)?required/i,
    cn: '办理前还需要准备验车或保险证明。', intent: 'VERIFY_INFO', severity: 2 },

  // ---- 银行 ----
  { re: /will\s*automatically\s*renew|automatic\s*renewal|rolls?\s*over\s*(in)?to/i,
    cn: '如果不做选择，到期后会自动续存或续约。', intent: 'AUTOPAY_NOTICE', severity: 1 },
  { re: /transferred\s*to\s*the\s*state|turned\s*over\s*to\s*the\s*state|state\s*controller/i,
    cn: '账户里的钱可能会被上缴给州政府保管。', intent: 'BENEFIT_CHANGE', severity: 2 },

  // ---- 明确不用做事 ----
  { re: /no\s*action\s*(is\s*)?(required|needed)\s*(on\s*your\s*part|at\s*this\s*time)?/i,
    cn: '信里明确写了这次不需要你做任何事。', intent: 'INFO_ONLY', severity: 0 },
  { re: /keep\s*this\s*(notice|letter|statement)\s*for\s*your\s*records/i,
    cn: '这封信留着备查就可以。', intent: 'INFO_ONLY', severity: 0 }
];

const detectPhrases = (lines) => {
  const hits = [];
  const seen = new Set();

  lines.forEach((line) => {
    PHRASE_RULES.forEach((rule) => {
      if (seen.has(rule.cn)) return;
      if (rule.re.test(line.text)) {
        seen.add(rule.cn);
        hits.push({
          cn: rule.cn,
          intent: rule.intent,
          severity: rule.severity,
          conditional: Boolean(rule.conditional),
          autopayConfirmed: Boolean(rule.autopayConfirmed),
          /*
           * 这句是不是出现在「申诉 / 复议 / 争议」的语境里。
           * 申诉期限是一项**权利**，不是**义务** ——
           * 「你可以在 120 天内申诉」和
           * 「你必须在 30 天内交钱」性质完全不同。
           */
          appealRelated: APPEAL_DEADLINE_CONTEXT.test(line.text),
          box: line
        });
      }
    });
  });

  hits.sort((a, b) => b.severity - a.severity);
  return hits;
};


// ============================================================
// 值解析器（喂给 findValueNearAnchor）
// ============================================================

const makeMoneyParser = () => (line, isSelf) => {
  if (isSelf) {
    const inline = findMoneyInText(line.text);
    return inline.length ? inline[inline.length - 1].value : null;
  }

  const pure = parsePureMoney(line.text);
  if (pure) return pure.value;

  // 短行里带 $ 的也接受，例如 "Due: $99.36"
  const raw = normalize(line.text);
  if (raw.length <= 24) {
    const inline = findMoneyInText(raw);
    if (inline.length === 1) return inline[0].value;
  }

  return null;
};

const makeDateParser = (today) => (line) => {
  if (looksLikeDateRange(line.text)) return null;
  const dates = findDatesInText(line.text, { today });
  if (!dates.length) return null;
  if (dates.length > 1) return null; // 一行多个日期，太可能是周期，宁可放弃
  return dates[0].iso;
};


// ============================================================
// 格式化
// ============================================================

const formatMoneyCn = (value) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const fixed = Math.abs(value).toFixed(2);
  const [intPart, decPart] = fixed.split('.');
  const withCommas = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${value < 0 ? '-' : ''}${withCommas}.${decPart}`;
};

const formatDateCn = (iso) => {
  if (!iso) return null;
  const parts = iso.split('-');
  if (parts.length !== 3) return iso;
  return `${Number(parts[0])}年${Number(parts[1])}月${Number(parts[2])}日`;
};


// ============================================================
// 主入口
// ============================================================

/**
 * @param {Array} lines OCR 行（含 bbox）
 * @param {object} options { imageWidth, imageHeight }
 * @returns {{
 *   fields: object,          // 每个字段带 value / box / trusted / evidence
 *   checks: Array,           // 交叉校验明细
 *   layer0: object,          // 中文模板句（不含任何 PII）
 *   safePayload: object,     // 白名单：唯一允许交给外部模型的东西
 *   trustworthy: boolean
 * }}
 */
export function extractLetterFields(lines, options = {}) {
  const safeLines = Array.isArray(lines) ? lines.filter((l) => l && l.text) : [];

  const pageWidth =
    options.imageWidth ||
    safeLines.reduce((max, l) => Math.max(max, l.right || 0), 1);
  const pageHeight =
    options.imageHeight ||
    safeLines.reduce((max, l) => Math.max(max, l.bottom || 0), 1);

  const checks = [];
  const addCheck = (name, passed, detail) =>
    checks.push({ name, passed, detail });

  if (safeLines.length < 4) {
    /*
     * 文字太少就直接放弃。
     * 注意返回的 fields 必须保持完整形状 ——
     * 上层 UI 会直接读 fields.category.cn 这类路径，
     * 返回一个空对象会让整个结果页崩掉。
     */
    return {
      fields: {
        category: { id: 'unknown', cn: '认不出类别', trusted: false },
        subtype: null,
        urgency: {
          level: 'yellow',
          flag: '🟡',
          symbol: '',
          cn: '需要看一下',
          hint: '照片没拍清楚，先重拍一次。',
          reasons: ['识别到的文字太少'],
          isScamWarning: false
        },
        scam: { hits: [], score: 0, suspected: false },
        sender: { value: null, display: null, abbr: null, cn: null, trusted: false },
        amount: { value: null, trusted: false, isPaymentDemand: false },
        dueDate: { value: null, trusted: false },
        documentType: { value: 'unknown', cn: '认不出类别', trusted: false },
        phrases: [],
        lineItems: []
      },
      checks: [{ name: 'enough_text', passed: false, detail: '识别到的文字太少' }],
      layer0: buildUnreadableLayer0(),
      safePayload: null,
      trustworthy: false
    };
  }

  // ---------------- 基础分类 ----------------
  //
  // 顺序有讲究：先认出寄件机构，
  // 它的 kind 会作为强信号参与类别判断。
  const sender = detectSender(safeLines, pageHeight);
  let category = detectCategory(safeLines, sender);
  const subtype = detectSubtype(safeLines);

  /*
   * 认出具体子类型，是比关键词打分强得多的信号。
   *
   * 真实例子：一封 Medicare 的 ANOC，抬头写着
   * 「Humana Gold Plus HMO」。按机构打分会被归到「健保公司」，
   * 但它本质上是一封 Medicare 计划变更通知。
   * 子类型认出来了，就以子类型为准。
   */
  if (subtype && subtype.category && subtype.category !== category.id) {
    const forced = LETTER_CATEGORIES.find((c) => c.id === subtype.category);
    if (forced) {
      category = {
        id: forced.id,
        cn: forced.cn,
        baseUrgency: forced.baseUrgency,
        score: category.score + 10,
        trusted: true,
        forcedBySubtype: subtype.id,
        runnerUp: category.id
      };
    }
  }
  const phrases = detectPhrases(safeLines);
  const scam = detectScamSignals(safeLines);

  // ---------------- 金额 ----------------
  const moneyParser = makeMoneyParser();
  const amountCandidates = [];

  safeLines.forEach((line) => {
    const anchor = matchAnchor(line.text, AMOUNT_ANCHORS, AMOUNT_ANCHOR_BLOCKERS);
    if (!anchor) return;

    const hit = findValueNearAnchor(line, safeLines, moneyParser);
    if (!hit) return;

    amountCandidates.push({
      value: hit.value,
      box: hit.line,
      anchorLine: line,
      anchorText: normalize(line.text),
      relation: hit.relation,
      score: anchor.weight + hit.score * 0.3,
      anchorWeight: anchor.weight,
      confidence: hit.line.confidence
    });
  });

  /*
   * 先扫一遍：有没有强锚点明确写着「不用交」。
   * 有的话，后面所有金额都不作为「要交的钱」呈现。
   */
  let explicitNoAmountDue = null;

  safeLines.forEach((line) => {
    const anchor = matchAnchor(line.text, AMOUNT_ANCHORS, AMOUNT_ANCHOR_BLOCKERS);
    if (!anchor || anchor.weight < 88) return;

    const hit = findValueNearAnchor(line, safeLines, (candidate) => {
      const raw = normalize(candidate.text)
        .replace(/^[^:]*:\s*/, '')
        .trim();
      if (EXPLICIT_ZERO_RE.test(raw)) return { kind: 'zero', raw };
      if (AUTOPAY_VALUE_RE.test(raw)) return { kind: 'autopay', raw };
      return null;
    });

    if (hit && !explicitNoAmountDue) {
      explicitNoAmountDue = {
        anchorText: normalize(line.text),
        kind: hit.value.kind,
        raw: hit.value.raw
      };
    }
  });

  amountCandidates.sort((a, b) => b.score - a.score);

  const { column } = detectAmountColumn(safeLines, pageWidth);
  const columnValues = column ? column.items.map((it) => it.value) : [];
  const sumRelation = columnValues.length >= 3 ? findSumRelation(columnValues) : null;

  const amount = amountCandidates[0] || null;

  addCheck(
    'explicit_no_amount_due',
    !explicitNoAmountDue,
    explicitNoAmountDue
      ? `信上写明「${explicitNoAmountDue.anchorText}」→ 不需要付款`
      : 'ok'
  );

  addCheck(
    'amount_anchor_found',
    Boolean(amount),
    amount ? `锚点「${amount.anchorText}」→ ${amount.value}` : '没有找到应缴金额的锚点词'
  );

  /*
   * 小数点丢失 —— 目前实测到的最危险的 OCR 错误。
   *
   * AT&T 账单上的 $59.94 被读成 "$5994"，**置信度 100%**。
   * 模型不知道自己错了，金额直接放大 100 倍。
   * 靠置信度筛不掉，只能靠上下文。
   *
   * 判据：这一页别的金额都是两位小数，只有它没有，
   * 而且量级大得离谱 —— 那多半是小数点没认出来。
   */
  const decimalAmounts = [];
  safeLines.forEach((line) => {
    const m = normalize(line.text).match(
      /\$\s*(\d{1,3}(?:,\d{3})*|\d+)[.,](\d{2})\b/
    );
    if (m) {
      decimalAmounts.push(
        Number(`${m[1].replace(/,/g, '')}.${m[2]}`)
      );
    }
  });

  const amountRawText = amount && amount.box ? normalize(amount.box.text) : '';
  const amountHasDecimal = /[.,]\d{2}\b/.test(amountRawText);

  let decimalPointSuspect = false;
  if (amount && !amountHasDecimal && decimalAmounts.length >= 2) {
    const sorted = [...decimalAmounts].map(Math.abs).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    /*
     * 阈值取 15 倍。丢一个小数点通常放大 100 倍，
     * 但 OCR 有时只吃掉一位（88.42 -> 884），
     * 定太高会漏掉这种。
     */
    if (median > 0 && Math.abs(amount.value) / median >= 15) {
      decimalPointSuspect = true;
    }
  }

  addCheck(
    'decimal_point_sane',
    !decimalPointSuspect,
    decimalPointSuspect
      ? `「${amountRawText}」没有小数点，且比同页其他金额大 50 倍以上，疑似小数点漏认`
      : 'ok'
  );

  const magnitudeOk =
    amount && Math.abs(amount.value) >= 0.01 && Math.abs(amount.value) <= 500000;
  addCheck('amount_magnitude_sane', Boolean(magnitudeOk), amount ? String(amount.value) : 'n/a');

  const inColumn =
    amount && columnValues.some((v) => Math.abs(v - amount.value) <= 0.005);
  addCheck(
    'amount_in_column',
    Boolean(inColumn),
    column ? `右对齐金额列有 ${columnValues.length} 项` : '没有识别到金额列'
  );

  const sumVerified =
    Boolean(sumRelation) &&
    amount &&
    Math.abs(sumRelation.total - amount.value) <= 0.02;
  addCheck(
    'amount_sum_verified',
    Boolean(sumVerified),
    sumRelation
      ? `${sumRelation.count} 个分项相加 = ${sumRelation.total.toFixed(2)}`
      : '没有找到「分项之和 = 小计」的关系'
  );

  // 两个高权重锚点给出不同金额 -> 危险信号
  const strongCandidates = amountCandidates.filter((c) => c.anchorWeight >= 92);
  const conflicting =
    strongCandidates.length > 1 &&
    strongCandidates.some(
      (c) => Math.abs(c.value - strongCandidates[0].value) > 0.02
    );
  addCheck('no_conflicting_totals', !conflicting, conflicting ? '多个「应缴金额」锚点给出了不同的数字' : 'ok');

  const amountConfidenceOk =
    amount && (amount.confidence === null || amount.confidence >= 60);
  addCheck('amount_ocr_confidence', Boolean(amountConfidenceOk),
    amount && amount.confidence !== null ? `${amount.confidence.toFixed(1)}%` : 'n/a');

  /*
   * 佐证条件原来只有三条：分项求和、金额列、超强锚点。
   *
   * 但真实照片里 OCR 常常把「标签 + 金额」并成一行
   * （"Your New Charges $99.36"、"Total Amount Due on Account $71.20"），
   * 这时候右对齐金额列根本不存在，三条全落空，
   * 于是金额明明读对了，却对老人说「没能确认具体金额」。
   *
   * 补两条同样可靠的佐证：
   *   · 标签和数字就在同一行 —— 贴在一起本身就是强关联
   *   · 同一个数字在页面上出现两次以上（小计 + 总计）
   */
  const sameLineWithStrongAnchor = Boolean(
    amount && amount.relation === 'same-line' && amount.anchorWeight >= 72
  );

  /*
   * 比较绝对值。
   * findMoneyInText 不认 CR 后缀，返回的永远是正数；
   * 而贷记账单抽出来的 amount.value 是负的。
   * 原来直接相减，$6.33CR 在页面上出现五次也对不上，
   * 于是 AT&T 那张手机照片的金额佐证不足、被判为不可信。
   */
  const repeatedValue = Boolean(
    amount &&
      safeLines.filter((line) =>
        findMoneyInText(line.text).some(
          (m) => Math.abs(Math.abs(m.value) - Math.abs(amount.value)) <= 0.005
        )
      ).length >= 2
  );

  addCheck(
    'amount_corroborated',
    Boolean(sumVerified || inColumn || sameLineWithStrongAnchor || repeatedValue),
    [
      sumVerified && '分项求和',
      inColumn && '金额列',
      sameLineWithStrongAnchor && '标签与数字同行',
      repeatedValue && '页面上重复出现'
    ]
      .filter(Boolean)
      .join(' / ') || '没有任何佐证'
  );

  const amountTrusted = Boolean(
    amount &&
      magnitudeOk &&
      !decimalPointSuspect &&
      !conflicting &&
      amountConfidenceOk &&
      (sumVerified ||
        inColumn ||
        sameLineWithStrongAnchor ||
        repeatedValue ||
        amount.anchorWeight >= 92)
  );

  /*
   * 金额列有足够多的分项，却凑不出任何「相加 = 小计」的关系
   * —— 说明这一列里至少有一个数字被读错了。
   * 总额本身可能还是对的，但必须让用户知道有对不上的地方。
   */
  /*
   * 只有「确实存在多个不同的分项」时，凑不出小计才算异常。
   *
   * AT&T 那张账单的金额列是 [-6.33, -6.33, -6.33, -6.33] ——
   * 同一个总额在页面上重复了四次，本来就没有分项可加。
   * 早期版本对它报「分项加起来对不上小计」，纯属噪音，
   * 而且会让老人以为账单有问题。
   */
  const distinctNonZero = new Set(
    columnValues
      .filter((v) => Math.abs(v) > 0.005)
      .map((v) => v.toFixed(2))
  ).size;

  const columnLooksInconsistent =
    columnValues.length >= 4 && distinctNonZero >= 3 && !sumRelation;

  // ---------------- 日期 ----------------
  const dateParser = makeDateParser(options.today || new Date());
  const dateCandidates = [];

  const appealCandidates = [];

  const statementCandidates = [];

  // 无标签的信头日期，只在没有带标签的发信日期时才用
  const bareDateCandidates = [];

  const pageBottom =
    options.imageHeight ||
    safeLines.reduce((m, l) => Math.max(m, l.bottom || 0), 1);

  safeLines.forEach((line) => {
    if (
      BARE_DATE_LINE_RE.test(normalize(line.text)) &&
      line.top < pageBottom * 0.35
    ) {
      // dateParser 收的是整个 line 对象（它内部要读 line.text），不是字符串
      const bare = dateParser(line);
      if (bare) {
        bareDateCandidates.push({
          value: bare,
          box: line,
          anchorText: normalize(line.text),
          relation: 'letterhead',
          // 比任何带标签的都低，保证标签优先
          score: 30 - line.top / pageBottom,
          confidence: line.confidence
        });
      }
    }

    /*
     * 先判发信日期。
     *
     * 这一行本来就会被 DATE_ANCHOR_BLOCKERS 挡掉（那是为了不让它冒充截止日），
     * 所以必须在那之前把它捡出来，否则这个日期就永远丢了。
     *
     * 命中之后直接 return —— 同一行不能既当发信日期又当截止日。
     */
    const stmtAnchor = matchAnchor(
      line.text,
      STATEMENT_DATE_ANCHORS,
      STATEMENT_ANCHOR_BLOCKERS
    );

    if (stmtAnchor) {
      const stmtHit = findValueNearAnchor(line, safeLines, dateParser);
      if (stmtHit) {
        statementCandidates.push({
          value: stmtHit.value,
          box: stmtHit.line,
          anchorText: normalize(line.text),
          relation: stmtHit.relation,
          score: stmtAnchor.weight + stmtHit.score * 0.3,
          confidence: stmtHit.line.confidence
        });
      }
      return;
    }

    const anchor = matchAnchor(line.text, DATE_ANCHORS, DATE_ANCHOR_BLOCKERS);
    if (!anchor) return;

    const hit = findValueNearAnchor(line, safeLines, dateParser);
    if (!hit) return;

    // 申诉期限单独放一边，不当作缴费截止日
    if (APPEAL_DEADLINE_CONTEXT.test(line.text)) {
      appealCandidates.push({
        value: hit.value,
        box: hit.line,
        anchorText: normalize(line.text)
      });
      return;
    }

    dateCandidates.push({
      value: hit.value,
      box: hit.line,
      anchorLine: line,
      anchorText: normalize(line.text),
      relation: hit.relation,
      score: anchor.weight + hit.score * 0.3,
      anchorWeight: anchor.weight,
      confidence: hit.line.confidence
    });
  });

  dateCandidates.sort((a, b) => b.score - a.score);

  /*
   * 一张单子上可能印着好几个到期日。
   * OC 房产税单是最典型的：
   *     FIRST INSTALLMENT is due in full on November 1, 2024
   *     deadline to pay without penalty is December 10, 2024
   *     SECOND INSTALLMENT is due in full on February 1, 2025
   *     deadline to pay without penalty is April 10, 2025
   *
   * 原来只取分数最高的那个。这几行用的是同一个锚点词、权重一模一样，
   * 谁排第一纯粹看 hit.score 的零头 —— 实测选中了 2025年2月1日，
   * 也就是**第二期**。对老人说「请在 2025年2月1日 之前处理」，
   * 而真正会罚 10% 的是 2024年12月10日。
   *
   * 老人要的永远是「下一个该做事的日子」，不是分数最高的那个日子。
   * 所以在**分数接近的候选**里，挑今天之后最早的那一个。
   *
   * 限定「分数接近」（差 20 分以内）很重要：不能让一个弱锚点
   * 只因为日期更近就顶掉强锚点。强弱差距大的时候，还是信锚点。
   */
  const todayIso = new Date(
    (options.today || new Date()).getTime()
  )
    .toISOString()
    .slice(0, 10);

  const topScore = dateCandidates.length ? dateCandidates[0].score : 0;

  const contenders = dateCandidates.filter((c) => c.score >= topScore - 20);

  /*
   * 信头裸日期不能是「已经被某个标签认领过的值框」。
   *
   * 「Due Date | 12/10/2024」这种两个框的排版里，右边那个框
   * 本身就是一行光秃秃的日期，又在页面上方 —— 会被信头规则抓走，
   * 于是同一个日期既是截止日又成了发信日期。
   * 正是这次要消灭的那种混淆。
   */
  const claimedBoxes = new Set(
    [...dateCandidates, ...statementCandidates].map((c) => c.box)
  );

  for (let i = bareDateCandidates.length - 1; i >= 0; i -= 1) {
    if (claimedBoxes.has(bareDateCandidates[i].box)) {
      bareDateCandidates.splice(i, 1);
    }
  }

  const upcoming = contenders
    .filter((c) => c.value >= todayIso)
    .sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));

  const dueDate = upcoming[0] || dateCandidates[0] || null;

  const multipleDeadlines =
    new Set(contenders.map((c) => c.value)).size > 1;

  addCheck(
    'due_date_single',
    !multipleDeadlines,
    multipleDeadlines
      ? `信上有多个到期日（${Array.from(new Set(contenders.map((c) => c.value)))
          .sort()
          .join(' / ')}），取今天之后最近的 ${dueDate ? dueDate.value : '—'}`
      : 'ok'
  );

  addCheck(
    'due_date_anchor_found',
    Boolean(dueDate),
    dueDate ? `锚点「${dueDate.anchorText}」→ ${dueDate.value}` : '没有找到截止日期的锚点词'
  );

  const dateConfidenceOk =
    dueDate && (dueDate.confidence === null || dueDate.confidence >= 60);
  addCheck('due_date_ocr_confidence', Boolean(dateConfidenceOk),
    dueDate && dueDate.confidence !== null ? `${dueDate.confidence.toFixed(1)}%` : 'n/a');

  /*
   * State Farm 那封信上，OCR 把
   *   「Payment is due by BILLED THROUGH SFPP」
   * 配上了两年前的 2024-05-10。
   * 一个 837 天前的日期不可能是待办事项，
   * 却仍然被显示成「请在 2024年5月10日 之前处理」。
   *
   * 超过半年的过期日期一律不采信 —— 要么是识别错了，
   * 要么这封信早就过时了，两种情况都不该当成截止日展示。
   */
  const dueDateDaysOut = dueDate
    ? Math.round(
        (new Date(`${dueDate.value}T00:00:00Z`).getTime() -
          (options.today || new Date()).getTime()) /
          86400000
      )
    : null;

  const dueDateStale = dueDateDaysOut !== null && dueDateDaysOut < -180;

  addCheck(
    'due_date_not_stale',
    !dueDateStale,
    dueDateStale ? `信上的日期已过去 ${Math.abs(dueDateDaysOut)} 天，不采信` : 'ok'
  );

  const dueDateTrusted = Boolean(dueDate && dateConfidenceOk && !dueDateStale);

  // ---------------- 发信日期 ----------------
  statementCandidates.sort((a, b) => b.score - a.score);
  bareDateCandidates.sort((a, b) => b.score - a.score);

  /*
   * 带标签的优先。只有一条带标签的都没有，才用信头那个裸日期。
   * 顺序不能反 —— 裸日期是猜出来的，标签是信上白纸黑字写的。
   */
  const statementDate =
    statementCandidates[0] || bareDateCandidates[0] || null;

  const statementConfidenceOk =
    statementDate &&
    (statementDate.confidence === null || statementDate.confidence >= 60);

  addCheck(
    'statement_date_confidence',
    !statementDate || Boolean(statementConfidenceOk),
    statementDate && statementDate.confidence !== null
      ? `${statementDate.confidence.toFixed(1)}%`
      : 'n/a'
  );

  /*
   * 发信日期不可能在未来 —— 信已经寄到你手上了。
   * 留 2 天余量：印刷日和邮戳日偶尔会差一点，时区也会差一天。
   * 超出就说明读错了（多半是年份认岔了）。
   */
  const statementDaysOut = statementDate
    ? Math.round(
        (new Date(`${statementDate.value}T00:00:00Z`).getTime() -
          (options.today || new Date()).getTime()) /
          86400000
      )
    : null;

  const statementInFuture = statementDaysOut !== null && statementDaysOut > 2;

  addCheck(
    'statement_date_not_future',
    !statementInFuture,
    statementInFuture
      ? `发信日期比今天还晚 ${statementDaysOut} 天，不可能，不采信`
      : 'ok'
  );

  /*
   * 信总是先写、后到期。发信日期晚于截止日期，一定有一个读错了。
   * 这时候丢掉发信日期而不是截止日期 —— 截止日的锚点词强得多
   * （payment due date 权重 100），而且截止日错了后果更重。
   */
  const statementAfterDue = Boolean(
    statementDate &&
      dueDate &&
      dueDateTrusted &&
      statementDate.value > dueDate.value
  );

  addCheck(
    'statement_date_before_due',
    !statementAfterDue,
    statementAfterDue
      ? `发信日期 ${statementDate.value} 晚于截止日期 ${dueDate.value}，不采信发信日期`
      : 'ok'
  );

  const statementDateTrusted = Boolean(
    statementDate &&
      statementConfidenceOk &&
      !statementInFuture &&
      !statementAfterDue
  );

  // ---------------- 汇总 ----------------
  /*
   * 关键区分：信上出现金额，不代表这是要你交的钱。
   *
   * 真实例子：Medicare 的 MSN 上印着
   * 「Total charges by providers $1,842.00」，
   * 但同一页明明白白写着 This is not a bill。
   * 早期版本会对老人说「要交 1842 美元」—— 这是灾难性的误报。
   *
   * 所以只有同时满足才算「要你交钱」：
   *   1. 锚点足够强（不是随便一个 total）
   *   2. 子类型不属于「本来就不是账单」那一类
   *   3. 信里没有明说「不需要付款」
   */
  const explicitlyNotABill =
    (subtype && subtype.notABill) ||
    phrases.some((p) => p.intent === 'INFO_ONLY');

  /*
   * 金额其实有三种状态，早期版本只做了两种：
   *
   *   ① 要你去交            -> 「要交 71.20 美元」
   *   ② 明确不用交          -> 「这次不需要付款」
   *   ③ 要付，但已自动扣款  -> 早期版本归进了 ①，于是对着一张
   *                            印着 RECURRING PAYMENT - DO NOT PAY
   *                            的水费单说「要交 71.20 美元」，
   *                            老人可能真的会跑去交第二遍。
   *
   * 第三种必须单独说清楚：钱照付，但**不用你动手**。
   */
  const autopayConfirmed = phrases.some((p) => p.autopayConfirmed);

  const amountIsPaymentDemand = Boolean(
    amountTrusted &&
      amount &&
      amount.value > 0 &&
      amount.anchorWeight >= 72 &&
      !explicitlyNotABill &&
      !explicitNoAmountDue &&
      !autopayConfirmed
  );

  /*
   * 贷记余额（CR = credit）。
   * AT&T 账单上的「Balance $6.33CR」是**公司欠客户** 6.33 元。
   * 早期版本把负数金额当成「没能确认金额」，
   * 于是对着一张明写 Payment is Not Required 的账单说
   * 「和缴费有关但没看清金额」—— 白白让人担心一场。
   */
  const amountIsCredit = Boolean(
    amountTrusted && amount && amount.value < 0
  );

  // 金额有效、只是不需要老人动手去交
  const amountOnAutopay = Boolean(
    autopayConfirmed && amountTrusted && amount && amount.value > 0
  );

  const BILLING_CATEGORIES = [
    'electric',
    'gas',
    'water',
    'trash',
    'telecom',
    'property_tax',
    'tax',
    'hoa',
    'medical_provider',
    'insurance',
    'auto_insurance',
    'home_insurance',
    'life_insurance',
    'ltc_insurance'
  ];

  const expectsPayment =
    !explicitlyNotABill &&
    (BILLING_CATEGORIES.includes(category.id) ||
      amountCandidates.some((c) => c.anchorWeight >= 88) ||
      phrases.some((p) => p.intent === 'PAY' || p.intent === 'COLLECTION'));

  const urgency = computeUrgency({
    category,
    subtype,
    phrases,
    scam,
    explicitlyNotABill,
    amount: {
      value: amount ? amount.value : null,
      trusted: amountTrusted,
      isPaymentDemand: amountIsPaymentDemand,
      onAutopay: amountOnAutopay
    },
    explicitNoAmountDue: Boolean(explicitNoAmountDue),
    dueDate: { value: dueDate ? dueDate.value : null, trusted: dueDateTrusted },
    statementDate: {
      value: statementDate ? statementDate.value : null,
      trusted: statementDateTrusted
    },
    today: options.today || new Date()
  });

  addCheck(
    'category_identified',
    category.trusted,
    `${category.cn}（得分 ${category.score}）`
  );

  addCheck(
    'scam_screen',
    !scam.suspected,
    scam.suspected ? `命中 ${scam.hits.length} 条诈骗特征` : '没有明显诈骗特征'
  );

  // ---------------- 重拍提示 ----------------
  /*
   * 只为「要交多少」和「什么时候交」这两件事开口要求重拍。
   *
   * 姓名、地址、账号缺了 —— **一个字都不说**。老人很可能是故意不拍的。
   * 一个卖点是「你的隐私归你」的 app，不能反过来天天催用户把隐私拍进来。
   * 机构名也不催：信头和收件人地址通常挨在一起（信封窗口那块），
   * 催拍信头等于可能催出地址，而认不出机构的代价小得多。
   * 见 journal「决定 05 · 默认不问」。
   *
   * 反过来说，金额和日期是老人拍这张照片的**目的**，
   * 他绝不会故意挡住 —— 所以催这两样永远踩不到隐私。
   */
  const heights = safeLines
    .map((l) => l.height || 0)
    .filter(Boolean)
    .sort((a, b) => a - b);

  const medianHeight = heights.length ? heights[Math.floor(heights.length / 2)] : 0;

  // 已经被某个锚点认领过的值框（名字不能叫 claimedBoxes —— 上面信头判定已经用了）
  const anchoredBoxes = new Set(
    [...amountCandidates, ...dateCandidates, ...statementCandidates].map((c) => c.box)
  );

  /*
   * 「很显眼但没人认领」= 字号明显大于正文、在页面上半部、
   * 却没有被任何锚点认领的金额或日期。
   *
   * 这正是 WM 那封垃圾账单的形态：$87.05 字号 1.5 倍、在最顶上，
   * 而它上面那行「Your Payment is Due」被照片边缘切掉了上半截字母。
   *
   * 注意只在页面上半部找 —— 手机拍照有透视，纸的下半部离镜头近，
   * 底部的法律条文字号反而最大（实测 2.1 倍），不能当显眼看待。
   */
  const findSalientOrphan = (parser) => {
    if (!medianHeight) return null;
    let best = null;
    for (const line of safeLines) {
      if (anchoredBoxes.has(line)) continue;
      const v = parser(line);
      if (v === null || v === undefined) continue;
      const rel = (line.height || 0) / medianHeight;
      if (rel < 1.3) continue;
      if (line.top > pageHeight * 0.5) continue;
      if (!best || line.height > best.line.height) best = { line, rel };
    }
    return best;
  };

  const retakeHints = [];

  const pushHint = (field, cnField, candidate) => {
    const orphan = findSalientOrphan(field === 'amount' ? moneyParser : dateParser);
    if (orphan) {
      retakeHints.push({
        field,
        reason: 'label-missing',
        cn: `信上有一个很显眼的${cnField}，但它旁边那行标签没能读出来。请把整张单子重新拍一次，特别是这个${cnField}上方那一行字。`
      });
      return;
    }
    if (candidate && typeof candidate.confidence === 'number' && candidate.confidence < 75) {
      retakeHints.push({
        field,
        reason: 'blurry',
        cn: `${cnField}那一块没拍清楚。请把手机拿稳一点，对着${cnField}那部分再拍一次。`
      });
    }
  };

  if (!amountTrusted && expectsPayment) pushHint('amount', '金额', amount);
  if (!dueDateTrusted && expectsPayment) pushHint('dueDate', '日期', dueDate);

  /*
   * 金额和日期通常挨在一起（账单顶部那一排框），
   * 两条提示都说「请重拍整张单子」等于把同一句话说两遍。
   * 老人只需要知道**做一件事**：重拍。所以同因合并。
   */
  if (retakeHints.length === 2 && retakeHints[0].reason === retakeHints[1].reason) {
    const reason = retakeHints[0].reason;
    retakeHints.length = 0;
    retakeHints.push({
      field: 'amount+dueDate',
      reason,
      cn:
        reason === 'label-missing'
          ? '信上的金额和日期都很显眼，但它们旁边那行标签没能读出来。请把整张单子重新拍一次，特别是最上面那一行字。'
          : '金额和日期那一块没拍清楚。请把手机拿稳一点，对着单子上半部分再拍一次。'
    });
  }

  const trustworthy =
    category.trusted && (!expectsPayment || amountTrusted);

  const fields = {
    category: {
      id: scam.suspected ? 'suspected_scam' : category.id,
      // 诈骗信往往会伪装成正规机构，
      // 这时候「它自称是谁」远不如「它可能是假的」重要
      cn: scam.suspected
        ? `疑似诈骗（伪装成${category.trusted ? category.cn : '正规机构'}）`
        : category.cn,
      trusted: scam.suspected ? true : category.trusted,
      claimedCategory: category.id
    },
    subtype: subtype
      ? { id: subtype.id, cn: subtype.cn }
      : null,
    urgency,
    scam,
    documentType: { value: category.id, cn: category.cn, trusted: category.trusted },
    sender: {
      value: sender.value,
      // 显示用：有缩写优先用缩写（SSA / DMV / HOA / SCE）
      display: sender.abbr || sender.value,
      abbr: sender.abbr,
      cn: sender.cn,
      kind: sender.kind,
      box: sender.box,
      trusted: sender.confidence >= 80
    },
    amount: amount
      ? {
          value: amount.value,
          box: amount.box,
          anchorText: amount.anchorText,
          relation: amount.relation,
          confidence: amount.confidence,
          trusted: amountTrusted,
          isPaymentDemand: amountIsPaymentDemand,
          // 钱要付，但已登记自动扣款 —— 和「要你去交」是两回事
          onAutopay: amountOnAutopay,
          // 负数 = 账上有余额，是公司欠你
          isCredit: amountIsCredit
        }
      : { value: null, trusted: false, isPaymentDemand: false, onAutopay: false },
    dueDate: dueDate
      ? {
          value: dueDate.value,
          box: dueDate.box,
          anchorText: dueDate.anchorText,
          relation: dueDate.relation,
          confidence: dueDate.confidence,
          trusted: dueDateTrusted
        }
      : { value: null, trusted: false, isPaymentDemand: false, onAutopay: false },

    /*
     * 发信日期跟截止日期分开放，永远不合并。
     * 前端也必须分开显示 —— 这两个日期挨着放在一起，
     * 老人很容易把「信是 10月19日 写的」看成「10月19日 之前要交」。
     */
    statementDate: statementDate
      ? {
          value: statementDate.value,
          box: statementDate.box,
          anchorText: statementDate.anchorText,
          relation: statementDate.relation,
          confidence: statementDate.confidence,
          trusted: statementDateTrusted
        }
      : { value: null, trusted: false },
    explicitNoAmountDue,
    autopay: {
      confirmed: autopayConfirmed,
      amountOnAutopay
    },
    phrases,
    lineItems: sumRelation
      ? columnValues.slice(sumRelation.start, sumRelation.end)
      : []
  };

  return {
    fields,
    checks,
    layer0: buildLayer0(fields, {
      expectsPayment,
      trustworthy,
      columnLooksInconsistent,
      subtype,
      explicitlyNotABill,
      explicitNoAmountDue,
      amountOnAutopay,
      amountIsCredit,
      autopayConfirmed,
      retakeHints
    }),
    safePayload: buildSafePayload(fields, sumRelation, columnValues),
    trustworthy
  };
}


// ============================================================
// 第 0 层：中文模板拼句
//
// 这些句子是写死的模板，不是模型生成的。
// 好处是：不联网、不会有幻觉、今天和明天说的一模一样。
// 老人对一封信的五个核心问题，全部在这里回答。
// ============================================================

function buildUnreadableLayer0() {
  return {
    readable: false,
    category: null,
    categoryTrusted: false,
    orgName: null,
    orgCn: null,
    subtypeCn: null,
    urgency: {
      level: 'yellow',
      flag: '🟡',
      symbol: '',
      cn: '需要看一下',
      hint: '照片没拍清楚，先重拍一次。',
      reasons: ['照片不清楚，无法判断紧急程度'],
      isScamWarning: false
    },
    scamWarning: null,
    whatIsIt: '这封信小助手看不太清楚。',
    whoSentIt: null,
    gist: null,
    howMuch: null,
    whenDue: null,
    uncertain: ['照片可能太模糊、太暗，或者没有拍完整。'],
    advice: '请把信平铺在光线充足的地方，完整拍进去再试一次。'
  };
}

function buildLayer0(fields, context) {
  const uncertain = [];

  // ---- 1. 这是什么 ----
  /*
   * 类别名现在已经是「电费账单」「车险」这种自然说法，
   * 再套一个「的信」就变成「一封电费账单的信」，很别扭。
   * 本身就是名词的直接用，其余的才补「的信」。
   */
  const catName = fields.category.cn || '';
  const readsAsNoun = /(账单|单|票|通知|信|费)$/.test(catName);

  const whatIsIt = fields.category.trusted
    ? `这是一封${catName}${readsAsNoun ? '' : '的信'}。`
    : '小助手暂时判断不出这是什么类型的信。';

  if (!fields.category.trusted) {
    uncertain.push('信件类别没能确定。');
  }

  // ---- 2. 谁寄的 ----
  let whoSentIt = null;
  if (fields.sender.cn) {
    // 有缩写就把缩写一起给出来，老人认缩写比认全称容易
    /*
     * 只有真正的缩写才值得放进括号。
     * 「寄信的是自来水公司（自来水公司）」这种重复
     * 只会让老人多读一遍废话。
     * 判断标准：含拉丁字母，且不是中文名的一部分。
     */
    const abbr = fields.sender.abbr;
    const worthShowing =
      abbr &&
      /[A-Za-z]/.test(abbr) &&
      !fields.sender.cn.includes(abbr);

    whoSentIt = worthShowing
      ? `寄信的是${fields.sender.cn}（${abbr}）。`
      : `寄信的是${fields.sender.cn}。`;
  } else if (fields.sender.value) {
    /*
     * 这是版面推测出来的「页面上字最大的一行」，
     * 有可能根本不是机构名。措辞要留足余地。
     */
    whoSentIt = `信上最显眼的一行写的是「${fields.sender.value}」，可能是寄信的机构。`;
    uncertain.push('寄件机构没能确定，上面那行只是根据版面推测的。');
  } else {
    uncertain.push('没能看出寄信的机构。');
  }

  // ---- 3. 内容大意 ----
  //
  // 美国的账单和通知高度套路化，真正要紧的那几句
  // 翻来覆去就是那些。命中词典就直接给中文，
  // 一句都没命中就只说类型，绝不编。
  let gist = null;

  if (context.subtype) {
    /*
     * 认出了具体是哪一种信 —— 这是最好的情况。
     * 子类型自带一段写好的中文说明，
     * 再把命中的句式接在后面补充细节。
     */
    gist = context.subtype.gist;

    const extra = fields.phrases.slice(0, 2).map((p) => p.cn).join('');
    if (extra) gist += extra;
  } else if (fields.phrases.length) {
    gist = fields.phrases.slice(0, 3).map((p) => p.cn).join('');
  } else if (
    ['electric', 'gas', 'water', 'trash', 'telecom', 'medical_provider'].includes(
      fields.category.id
    ) &&
    fields.amount.trusted
  ) {
    /*
     * 账单是个例外：金额和日期本身就承载了主要信息，
     * 读不出别的句子不算失败。
     *
     * 但这句话必须**如实说出到底确认了什么**。
     * 原来写死成「只确认了金额和日期」，
     * 结果一封只读到金额、没读到日期的 Hoag 医院账单，
     * 上面说「确认了金额和日期」，下面紧接着说
     * 「信里没有找到明确的截止日期」—— 自己打自己的脸。
     *
     * 凡是模板句里出现「确认了 X」，
     * X 就必须真的来自已通过校验的字段，不能是写死的。
     */
    const confirmed = [];
    if (fields.amount.isPaymentDemand) confirmed.push('要交多少钱');
    if (fields.dueDate.trusted) confirmed.push('截止日期');

    const missing = [];
    if (!fields.amount.isPaymentDemand) missing.push('金额');
    if (!fields.dueDate.trusted) missing.push('截止日期');

    gist = '这看起来是一封常规账单。';

    if (confirmed.length) {
      gist += `小助手确认了${confirmed.join('和')}`;
      gist += missing.length
        ? `，但没能确认${missing.join('和')}。`
        : '。';
    } else {
      gist += '但金额和截止日期都没能确认。';
    }

    gist += '信里其他内容没有逐句读。';
  } else {
    /*
     * 关键修正
     *
     * 这里原来写的是「没有发现特别紧急的措辞」。
     * 那句话是危险的 —— 词典一条都没命中，
     * 真实含义是「我没读懂」，不是「信里不紧急」。
     * 一封写着「30 天内不回应视为放弃权利」的法院信，
     * 只要措辞不在词典里，就会被说成不紧急。
     *
     * 沉默必须沉默得诚实：不懂就说不懂，
     * 绝不能把「没检测到」说成「不存在」。
     */
    gist = '这封信具体在说什么，小助手没能读懂。';
    uncertain.push('信件的具体内容没能读懂，建议请家人看一下原文。');
  }

  /*
   * 高风险类型无论有没有命中词典，都要额外提醒。
   * 这类信件错过期限的代价，远高于多提醒一次的打扰。
   */
  if (
    ['court', 'immigration', 'tax', 'medi_cal', 'social_security'].includes(
      fields.category.id
    )
  ) {
    uncertain.push(
      '这类文件可能涉及重要期限，请务必让家人或专业人士看过原文。'
    );
  }

  // ---- 4. 要交多少 ----
  let howMuch = null;

  if (context.amountIsCredit) {
    /*
     * CR = credit balance，账上有余额、公司欠你钱。
     * 早期版本把负数金额当成「没能确认」，
     * 对着一张写着 Payment is Not Required 的账单
     * 说「和缴费有关但没看清金额」，白让人担心一场。
     */
    howMuch = `这封信不用交钱。您账上还有 ${formatMoneyCn(
      Math.abs(fields.amount.value)
    )} 美元的余额，是公司欠您的（信上写的 CR 就是这个意思）。`;
  } else if (context.amountOnAutopay) {
    /*
     * 钱是要付的，但账单上明确写了已登记自动扣款。
     * 说「要交 X 美元」会让老人跑去交第二遍 —— 真实的
     * Ventura River 水费单上就印着 RECURRING PAYMENT - DO NOT PAY。
     *
     * 正确的说法是把两件事都讲清楚：多少钱、不用你动手。
     */
    howMuch = `这期是 ${formatMoneyCn(
      fields.amount.value
    )} 美元，会自动从您的账户扣走，不用另外去交。`;

    if (fields.dueDate.trusted && fields.dueDate.value) {
      howMuch += `扣款日期在 ${formatDateCn(fields.dueDate.value)} 之前。`;
    }

    howMuch += '如果账户余额不足，扣款可能失败，这一点要留意。';
  } else if (context.explicitNoAmountDue) {
    /*
     * 信上白纸黑字写着不用交 —— 这比我们自己抽出来的任何数字都权威。
     * 同时要说明信上那个数字是什么，否则老人看到金额还是会慌。
     */
    howMuch =
      context.explicitNoAmountDue.kind === 'autopay'
        ? '这封信不用另外交钱，费用会自动扣款。'
        : '信上写明这次不需要付款。';

    if (fields.amount.value !== null) {
      howMuch += `（信上的 ${formatMoneyCn(
        fields.amount.value
      )} 美元是保费或费用总额，不是要您现在付的钱。）`;
    }
  } else if (fields.amount.isPaymentDemand) {
    howMuch = `要交 ${formatMoneyCn(fields.amount.value)} 美元。`;
  } else if (
    fields.amount.value !== null &&
    context.explicitlyNotABill
  ) {
    // 信上有金额，但它不是要你交的钱 —— 必须说清楚，否则老人会白交一次
    howMuch = `这封信不是账单，不用交钱。（信上的 ${formatMoneyCn(
      fields.amount.value
    )} 美元是费用明细，不是要您付的钱。）`;
  } else if (context.expectsPayment) {
    howMuch = '这封信看起来和缴费有关，但小助手没能确认具体金额。';
    uncertain.push('应缴金额没能确认。');
  } else {
    howMuch = '这封信里没有提到要交钱。';
  }

  if (context.columnLooksInconsistent) {
    uncertain.push('账单上的分项金额加起来对不上小计，可能有数字没认准。');
  }

  // ---- 5. 什么时候之前 ----
  let whenDue = null;
  if (context.amountOnAutopay) {
    // 已经在「金额」那段说过扣款日期了，这里不重复
    whenDue = null;
  } else if (fields.dueDate.trusted && fields.dueDate.value) {
    whenDue = `请在 ${formatDateCn(fields.dueDate.value)} 之前处理。`;
  } else if (context.expectsPayment) {
    whenDue = '信里没有找到明确的截止日期。';
    uncertain.push('截止日期没能确认。');
  }

  /*
   * ---- 6. 这封信什么时候写的 ----
   *
   * 单独一句、单独一个框，措辞里刻意不出现「之前」「要」这类字眼，
   * 免得老人把它读成一个期限。
   */
  const sentOn =
    fields.statementDate && fields.statementDate.trusted && fields.statementDate.value
      ? `这封信写于 ${formatDateCn(fields.statementDate.value)}。`
      : null;

  // ---- 兜底建议 ----
  //
  // 最重要的一条原则：宁可承认看不准，
  // 也不能自信地说错金额或日期。
  /*
   * UI 上方已经有「这几项小助手没看准」的小标题和清单了，
   * 这里再说一遍「有几项小助手没看准」纯属重复。
   * 只给行动建议，不复述状态。
   */
  const advice = uncertain.length
    ? '建议把这封信拿给家人再确认一下。'
    : '如果对内容还有疑问，可以继续问小助手。';

  return {
    readable: true,

    category: fields.category.cn,
    categoryTrusted: fields.category.trusted,

    orgName: fields.sender.display || null,
    orgCn: fields.sender.cn || null,

    subtypeCn: context.subtype ? context.subtype.cn : null,

    urgency: fields.urgency,

    scamWarning: fields.scam.suspected
      ? {
          title: '这封信可能是诈骗',
          reasons: fields.scam.hits.map((h) => h.cn),
          advice:
            '不要按信上的电话打过去，也不要提供社安号、银行账号或付任何费用。先找家人核实，或直接拨打机构官方号码。'
        }
      : null,

    whatIsIt,
    whoSentIt,
    gist,
    howMuch,
    whenDue,
    sentOn,
    retakeHints: context.retakeHints || [],
    uncertain,
    advice,
    highlights: [
      fields.amount.trusted && fields.amount.box
        ? { kind: 'amount', box: fields.amount.box, label: '应缴金额' }
        : null,
      fields.dueDate.trusted && fields.dueDate.box
        ? { kind: 'dueDate', box: fields.dueDate.box, label: '截止日期' }
        : null,
      fields.statementDate &&
      fields.statementDate.trusted &&
      fields.statementDate.box
        ? {
            kind: 'statementDate',
            box: fields.statementDate.box,
            label: '发信日期'
          }
        : null,
      fields.sender.box
        ? { kind: 'sender', box: fields.sender.box, label: '寄件机构' }
        : null
    ].filter(Boolean)
  };
}


// ============================================================
// 白名单载荷
//
// 这是「第 1 层」唯一允许交给外部模型的东西。
//
// 关键点：这是**枚举出来的字段**，不是「过滤过的全文」。
// 姓名、地址、账号、会员号根本没有机会进入这个对象 ——
// 不是被删掉了，是从来没被放进来过。
// 漏检因此不会造成泄露，最多是信息少一点。
// ============================================================

function buildSafePayload(fields, sumRelation, columnValues) {
  if (!fields.category.trusted) return null;

  return {
    category: fields.category.id,
    letter_subtype: fields.subtype ? fields.subtype.id : null,
    urgency: fields.urgency.level,
    document_type: fields.documentType.value,

    // 只放已知机构词典命中的英文名。
    // 版面推测出来的那种「最大的一行」不放 —— 它有可能是收件人姓名。
    sender_org:
      fields.sender.trusted && fields.sender.kind !== 'unknown'
        ? fields.sender.value
        : null,

    amount_due: fields.amount.trusted ? fields.amount.value : null,
    due_date: fields.dueDate.trusted ? fields.dueDate.value : null,

    // 发信日期和到期日一样，是关于这封信的事实，不是关于这个人的
    statement_date:
      fields.statementDate && fields.statementDate.trusted
        ? fields.statementDate.value
        : null,

    // 只有数字，不带任何描述文字 —— 描述里可能夹带姓名或地址
    line_item_amounts: sumRelation
      ? columnValues.slice(sumRelation.start, sumRelation.end)
      : [],

    // 命中的是我们自己写的中文模板，不是信里的原文
    detected_notices: Array.from(
      new Set(fields.phrases.map((p) => p.intent))
    ),

    _note:
      'Whitelisted fields only. No names, addresses, account numbers, or raw OCR text.'
  };
}

export default extractLetterFields;
