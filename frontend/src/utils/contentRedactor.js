/**
 * utils/contentRedactor.js
 *
 * 决定「信里哪些内容可以交给外部模型」。
 *
 * 背景：
 *   第 0 层的模板只能说出词典里有的话。想让老人读懂整封信的大意，
 *   就必须把信的内容交给模型 —— 这一步绕不过去。
 *
 * 但用户看不懂英文，没法替我们把关。所以不能采用
 * 「先发出去、漏了再说」的思路，必须让**漏检不会造成泄露**。
 *
 * 做法是逐行设卡，只有全部通过的行才允许外发：
 *
 *   1. 正则 PII 检测（复用 App.jsx 里已有的那套）
 *   2. 姓名特征     —— 现有检测器没有 PERSON_NAME，这里补上
 *   3. 收件人区块   —— 整块盖掉，不逐词判断
 *   4. 编号型字符串 —— 长的字母数字混合串一律拦下
 *   5. 网址 / 邮箱  —— 常带账户标识
 *
 * 拦不准的代价是「少发几句、翻译得不完整」，
 * 而不是「老人的账号被发出去了」。这个方向是刻意选的。
 */


const normalize = (text) =>
  String(text || '')
    .replace(/\s+/g, ' ')
    .trim();


// ============================================================
// 姓名特征
//
// 现有的 PII 检测器覆盖了 16 种类型，但没有 PERSON_NAME。
// 之前那封 SCE 账单里的「BAKER, NATE」就是这么漏掉的。
// ============================================================

/*
 * 机构名也常常是「两三个大写词」，不能一律当人名。
 * 出现这些词就认为是机构，交给后面的规则判断。
 */
/*
 * 这张词表决定了「哪些行算机构名」，
 * 而机构名又决定了它旁边的地址电话是放行还是挡下。
 *
 * 第一版漏了 institute，于是整个
 *   HOAG ORTHOPEDIC INSTITUTE / MAILSTOP / PO BOX / DALLAS, TX
 * 都被当成收件人地址挡掉了 —— 而那正是「支票往哪寄」。
 */
const ORG_HINTS =
  /\b(inc|llc|llp|ltd|plc|co|corp|corporation|company|association|assoc|department|dept|bureau|agency|court|bank|credit\s*union|hospital|clinic|institute|medical|memorial|physicians?|associates|orthopedic|cardiology|radiology|imaging|laboratory|labs?|dental|pharmacy|center|centre|services?|systems?|group|district|county|city|state|university|college|school|insurance|assurance|health|healthcare|energy|gas|water|power|electric|utilities|utility|authority|administration|office|trust|fund|foundation|society|union|partners?|holdings?|management|properties|realty|mutual|federal|national|american|california|cross|shield|anthem|kaiser|edison|alliance|permanente)\b/i;


/*
 * 第一版按「形状」判断人名，结果糟糕透顶：
 *   Generation Charges / Your New Charges / User Utility Tax
 *     -> 被当成人名拦掉（账单正文全没了）
 *   BAKER, NATE / Page 5 of 5
 *     -> 反而漏了（真正的姓名）
 *
 * 问题在于英文文档里「两个首字母大写的词」满地都是。
 * 光看形状分不出人名和栏目名，必须再看**用的是不是常见文档词**。
 */

/* 账单和通知里的高频词。一行里出现任何一个，就不当人名。 */
const DOC_WORDS = new Set(
  `account amount balance benefit benefits bill billing case center charge charges
   claim class code company coverage credit current customer date deductible
   delivery department deposit detail details discount due electric energy
   enrollment explanation fee fees gas generation group history hospital
   important insurance interest invoice level line medical member message
   messages meter monthly network new notice number office page paid patient
   payment period plan policy power premium previous price provider quarterly
   rate rates reading records reference refuse renewal residential保
   sample savings schedule section service services statement status subtotal
   report director deputy assessment attachment exhibit appendix figure table
   manager officer supervisor president secretary treasurer administrator
   analyst engineer specialist coordinator representative agent adjuster
   summary subject reference regarding attention important message messages
   budget usage units gallons therms kilowatt tier rate description charge
   summary surcharge tax taxes term total transaction transfer tier usage
   utility value water year your our the and for from with this that not
   cross shield blue health care life auto home first second third annual
   inpatient outpatient pharmacy drug prescription`
    .split(/\s+/)
    .filter(Boolean)
);

const hasDocWord = (text) =>
  normalize(text)
    .toLowerCase()
    .split(/[^a-z']+/)
    .some((w) => w && DOC_WORDS.has(w));

/* 两字母州代码，避免把「SIMI VALLEY, CA」当成「姓, 名」 */
const STATE_CODES = new Set(
  `AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO
   MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC`
    .split(/\s+/)
);

/**
 * 姓名判定。
 * 前三条是「明确信号」，出现在行内任何位置都算。
 * 第四条是「形状信号」，只在页面上方、且不含文档常用词时才启用。
 *
 * 导出给 App.jsx 的 detectLocalPII 用——姓名检测只应该有一处实现，
 * 不能有两套各自维护的姓名判定逻辑同时存在。
 */
export const looksLikeName = (text, context = {}) => {
  const raw = normalize(text);
  if (!raw || raw.length > 90) return null;

  // --- 1. LASTNAME, FIRSTNAME（可以出现在行中间）---
  //     修正点：原来锚定整行，所以
  //     「BAKER, NATE / Page 5 of 5」这种真名反而漏掉。
  //     逗号两边的空格改成 \s*（不强制要求）——
  //     State Farm 账单 OCR 出来是「SMITH,BRENDA」，逗号紧贴两个词，
  //     原来要求 \s+ 的写法在这种紧贴 OCR 输出上完全不命中，
  //     这个真实姓名直接漏发了。
  const commaName = raw.match(
    /\b([A-Z][A-Z'-]{1,})\s*,\s*([A-Z][A-Z'-]{1,})\b/
  );
  if (commaName && !STATE_CODES.has(commaName[2])) {
    return '姓名（姓, 名 格式）';
  }

  // --- 2. 称呼 ---
  if (/\bdear\s*(mr|mrs|ms|miss|dr|prof)\.?\s*[A-Z]/i.test(raw)) {
    return '称呼里带姓名';
  }

  // --- 3. 带姓名标签的字段 ---
  if (
    /\b(patient|member|guarantor|insured|policyholder|account\s*holder|beneficiary|resident|addressee|name)\s*(name)?\s*[:：]\s*[A-Z]/i.test(
      raw
    )
  ) {
    return '带姓名标签的字段';
  }

  // --- 4. 形状信号（严格设限）---
  //
  // 只有同时满足才启用：
  //   · 位于页面上方 45%（收件人信息所在区域）
  //   · 整行很短
  //   · 不含任何机构词
  //   · 不含任何文档常用词  <- 这条是关键，
  //     没有它「Generation Charges」就会被当成人名
  const inUpperArea = context.inUpperArea !== false;

  if (inUpperArea && raw.length <= 34 && !ORG_HINTS.test(raw) && !hasDocWord(raw)) {
    if (/^[A-Z][a-z]+(\s+[A-Z]\.?)?\s+[A-Z][a-z]+$/.test(raw)) {
      return '看起来是人名';
    }
    if (/^[A-Z]{2,}(\s+[A-Z]\.?)?\s+[A-Z]{2,}$/.test(raw)) {
      return '看起来是人名（全大写）';
    }
  }

  return null;
};


// ============================================================
// 地址 / 编号 / 联系方式
// ============================================================

const STREET_RE =
  /\b\d{1,6}\s+[A-Za-z0-9.'-]+(\s+[A-Za-z0-9.'-]+)*\s+(st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|boulevard|way|ct|court|pl|place|ter|terrace|cir|circle|pkwy|parkway|hwy|highway|apt|unit|suite|ste)\b\.?/i;

const CITY_STATE_ZIP_RE =
  /\b[A-Za-z][A-Za-z\s.'-]{1,28},?\s+(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\s+\d{5}(-\d{4})?\b/;

const PO_BOX_RE = /\bP\.?\s?O\.?\s*BOX\s*\d+/i;

const CONTACT_RE =
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|https?:\/\/\S+|\bwww\.\S+/i;

/*
 * 长的字母数字混合串：账号、保单号、病例号、Medicare 号、
 * 案件号都是这个形状。逐一枚举永远追不上，按形状拦更可靠。
 *
 * 金额、日期、纯年份、百分比要排除，否则会把有用信息也拦掉。
 */
const isIdLikeToken = (token) => {
  const t = token.replace(/[.,;:()]+$/, '');
  if (t.length < 6) return false;
  if (/^\$/.test(t)) return false;
  if (/^\d{1,3}(,\d{3})*(\.\d{2})?$/.test(t)) return false;   // 金额
  if (/^\d{1,2}[/\-]\d{1,2}[/\-]\d{2,4}$/.test(t)) return false; // 日期
  if (/^\d{4}$/.test(t)) return false;                          // 年份
  if (/^\d+(\.\d+)?%$/.test(t)) return false;

  /*
   * 电话号码不算「编号」。
   * 它由前面的 PHONE 关卡处理 —— 机构的客服电话放行、
   * 老人自己的号码挡下。在这里一刀切会把
   * 949-764-8404 这种「该打的电话」也挡掉。
   */
  /*
   * 只放行**带分隔符**的电话（949-764-8404 / (949) 764-8404）。
   *
   * 裸的 10 位数字不能放行 —— SCE 的服务账号
   * 8012345678 正好也是 10 位，第一版把它当成电话放过去了。
   * 形状撞车时，一律按更危险的那个解释处理。
   */
  if (/^\+?1?[-.\s]?\(\d{3}\)[-.\s]?\d{3}[-.\s]?\d{4}$/.test(t)) return false;
  if (/^\+?1?[-.\s]\d{3}[-.\s]\d{3}[-.\s]\d{4}$/.test(t)) return false;
  if (/^\d{3}[-.]\d{3}[-.]\d{4}$/.test(t)) return false;

  const hasDigit = /\d/.test(t);
  if (!hasDigit) return false;

  // 连续 6 位以上数字，或字母数字混排且含分隔符
  if (/\d{6,}/.test(t)) return true;
  if (/^[A-Za-z0-9]*[A-Za-z][A-Za-z0-9]*\d[A-Za-z0-9-]*$/.test(t) && t.length >= 7) {
    return true;
  }
  if (/^[\dA-Za-z]+([-\s][\dA-Za-z]+){2,}$/.test(t) && /\d{3,}/.test(t)) {
    return true;
  }
  return false;
};

const hasIdLikeToken = (text) =>
  normalize(text)
    .split(/\s+/)
    .some(isIdLikeToken);


// ============================================================
// 寄件方地址 vs 收件人地址
//
// 这两者长得一模一样，但性质完全相反：
//
//   收件人地址  = 老人自己的家庭住址        -> 必须挡
//   寄件方地址  = 机构的地址、缴费信箱、电话 -> 应该放行
//
// 全挡掉看似安全，其实有害：
// 一封 Hoag 医院账单上的
//   HOAG ORTHOPEDIC INSTITUTE / PO BOX 660064 / DALLAS, TX
//   949-764-8404 / PFS@hoag.org
// 全是「支票往哪寄、电话打哪里」这类老人最需要的信息。
// 挡掉它们，翻译出来的大意就少了最实用的一半。
//
// 判别依据：这段地址挨着的是**机构名**还是**人名**。
// 两边都挨不上就按挡掉处理 —— 拿不准时仍然倒向保守。
// ============================================================

/*
 * 机构内部投递标签。这些是机构自己的路由信息，
 * 不是老人的个人标识，配合机构语境可以放行。
 */
const ORG_ROUTING_LABEL =
  /\b(mail\s?stop|mailstop|dept\.?\s*\d|department\s*\d|p\.?\s?o\.?\s*box|lock\s?box|remit\s*(to|payment)|remittance|return\s*service\s*requested|make\s*checks?\s*payable)\b/i;

/* 个人邮箱域名一律挡，不看语境 */
const PERSONAL_EMAIL_DOMAIN =
  /@(gmail|yahoo|hotmail|outlook|live|msn|icloud|me|aol|comcast|sbcglobal|qq|163|126|foxmail|sina)\./i;

/*
 * 重要区分：ORG_HINTS 和 STRONG_ORG_HINTS 用途不同。
 *
 * ORG_HINTS 很宽（含 service / office / state / health 这类词），
 * 用来判断「这行**不是**人名」—— 宽一点无所谓。
 *
 * 但拿它当「这行**是**机构名」的证据就出大问题：
 * 一封 SCE 账单上的「Service account」「Service address」
 * 因为含 service 被当成了机构锚点，
 * 于是紧跟其后的账号 8012345678 和服务地址
 * 全被判定为「机构信息」放行了 —— 这是最严重的一次泄露。
 *
 * 所以锚点必须用强信号：公司后缀、机构类型词、知名品牌名。
 */
const STRONG_ORG_HINTS =
  /\b(inc|llc|llp|ltd|plc|corp|corporation|company|association|institute|hospital|clinic|infirmary|bank|credit\s*union|university|college|district|bureau|agency|administration|court|authority|foundation|mutual|insurance|assurance|permanente|kaiser|edison|alliance|associates|physicians|orthopedic|cardiology|radiology|laboratory|pharmacy|department\s*of|board\s*of|office\s*of|city\s*of|county\s*of|state\s*of)\b/i;

const buildContextMap = (lines, senderLineIndex = null) => {
  const orgAnchors = [];
  const personAnchors = [];

  if (typeof senderLineIndex === 'number' && senderLineIndex >= 0) {
    orgAnchors.push(senderLineIndex);
  }

  lines.forEach((line, index) => {
    const raw = normalize(line.text);
    if (!raw) return;

    if (looksLikeName(raw, { inUpperArea: true })) {
      personAnchors.push(index);
      return;
    }

    if (STRONG_ORG_HINTS.test(raw)) orgAnchors.push(index);
  });

  /*
   * 从所有机构名行里提取特征词，用来认机构自己的网址和邮箱。
   *
   * 「To pay your bill online, please visit www.orthopedichospital.com」
   * 这一行离机构抬头有六行远，靠位置判断够不着，
   * 但域名里的 orthopedic 和抬头「Hoag Orthopedic Institute」对得上。
   * 这条比位置可靠得多，而且个人邮箱（gmail 之类）永远对不上。
   */
  const orgWords = new Set();

  orgAnchors.forEach((i) => {
    if (!lines[i]) return;
    normalize(lines[i].text)
      .toLowerCase()
      .split(/[^a-z]+/)
      .forEach((w) => {
        if (w.length >= 4 && !DOC_WORDS.has(w)) orgWords.add(w);
      });
  });

  const domainMatchesOrg = (text) => {
    const m = String(text).match(
      /(?:https?:\/\/|www\.|@)([A-Za-z0-9.-]+\.[A-Za-z]{2,})/
    );
    if (!m) return false;

    const domain = m[1].toLowerCase();
    if (PERSONAL_EMAIL_DOMAIN.test('@' + domain + '.')) return false;

    for (const w of orgWords) {
      if (domain.includes(w)) return true;
    }
    return false;
  };

  const within = (list, index, span) =>
    list.some((i) => Math.abs(i - index) <= span);

  return {
    domainMatchesOrg,
    nearOrg: (index, span = 3) => within(orgAnchors, index, span),
    nearPerson: (index, span = 3) => within(personAnchors, index, span),
    orgAnchors,
    personAnchors
  };
};

/**
 * 这一行是不是「机构自己的联系方式」。
 * 是的话可以放行，因为它对老人有用而且不涉及隐私。
 */
const isOrgContactLine = (raw, index, ctx) => {
  if (ctx.nearPerson(index, 2)) return false;
  if (PERSONAL_EMAIL_DOMAIN.test(raw)) return false;

  return (
    ctx.nearOrg(index, 3) ||
    ORG_ROUTING_LABEL.test(raw) ||
    ctx.domainMatchesOrg(raw)
  );
};


// ============================================================
// 收件人区块
//
// 美国信件的收件人地址块位置很固定 —— 抬头下面、页面上半部、
// 左侧或右侧一小块，连着三到五行。
//
// 这块整块盖掉，不逐词判断。
// 逐词判断意味着「姓名认出来了、街道没认出来」这种半漏，
// 而半漏和全漏在后果上没有区别。
// ============================================================

const findAddresseeBlock = (lines, pageHeight, ctx) => {
  const blocked = new Set();

  lines.forEach((line, index) => {
    const raw = normalize(line.text);
    const isAddressish =
      STREET_RE.test(raw) ||
      CITY_STATE_ZIP_RE.test(raw) ||
      PO_BOX_RE.test(raw);

    if (!isAddressish) return;

    /*
     * 挨着机构名、且附近没有人名 -> 这是机构地址，放行。
     * 页面下半部的「缴费信箱」就是靠这一条救回来的。
     */
    if (ctx && !ctx.nearPerson(index, 3) && ctx.nearOrg(index, 3)) return;

    // 位置不再作为硬条件：收件人姓名地址块也可能印在页面下半部
    if (!ctx && line.top > pageHeight * 0.45) return;

    /*
     * 命中地址行之后，把它上下几行一起划进收件人区块。
     * 上面 3 行通常是姓名和「c/o」之类，
     * 下面 2 行通常是城市州邮编。
     */
    /*
     * 往上下扩，把整个地址块盖住。
     *
     * 但不能盲目扩固定行数 —— 之前扩 3 行，
     * 结果把紧邻的「AMOUNT YOU OWE $333.33」也吞掉了。
     * 金额是整封信最不能误伤的一项。
     *
     * 改成按内容判断：只有「看起来确实属于地址块」的行才继续扩，
     * 一碰到金额、栏目标题或机构名就停。
     */
    const isBlockMember = (k) => {
      const t = normalize(lines[k].text);
      if (!t || t.length > 50) return false;
      if (/\$\s*\d/.test(t)) return false;      // 带金额 -> 不是地址
      if (STRONG_ORG_HINTS.test(t)) return false; // 机构名 -> 不是收件人
      if (hasDocWord(t)) return false;           // 栏目名 -> 不是地址
      return true;
    };

    blocked.add(index);

    for (let k = index - 1; k >= Math.max(0, index - 3); k -= 1) {
      if (!isBlockMember(k)) break;
      blocked.add(k);
    }

    for (let k = index + 1; k <= Math.min(lines.length - 1, index + 3); k += 1) {
      if (!isBlockMember(k)) break;
      blocked.add(k);
    }
  });

  return blocked;
};


// ============================================================
// 主入口
// ============================================================

/**
 * @param {Array} lines OCR 行（含 bbox）
 * @param {object} options
 *   detectPII    (text) => { detections: [...] }   可选，注入 App.jsx 里那套检测器
 *   imageHeight  用于判断收件人区块位置
 * @returns {{
 *   sendable: Array,      // 允许外发的行
 *   withheld: Array,      // 被拦下的行（只记原因，不外传内容）
 *   payloadText: string,  // 拼好的、可以交给模型的文本
 *   stats: object
 * }}
 */
export function buildTranslatablePayload(lines, options = {}) {
  const {
    detectPII = null,
    imageHeight = 1,
    /*
     * fieldExtractor 已经认出了寄件机构在哪一行。
     * 把它传进来当作确定的机构锚点，
     * 比在这里靠词表猜可靠得多。
     */
    senderLineIndex = null
  } = options;

  const safeLines = Array.isArray(lines) ? lines.filter((l) => l && l.text) : [];

  const pageHeight =
    imageHeight ||
    safeLines.reduce((max, l) => Math.max(max, l.bottom || 0), 1);

  const ctx = buildContextMap(safeLines, senderLineIndex);
  const addresseeBlock = findAddresseeBlock(safeLines, pageHeight, ctx);

  const sendable = [];
  const withheld = [];
  const payloadParts = [];

  let lastWasRedacted = false;

  safeLines.forEach((line, index) => {
    const raw = normalize(line.text);
    const reasons = [];
    const types = [];

    // --- 关卡 1：现有 PII 检测器 ---
    const orgContact = isOrgContactLine(raw, index, ctx);

    if (detectPII) {
      try {
        const result = detectPII(raw);
        const found = (result && result.detections) || [];

        /*
         * 电话和邮箱要看是谁的。
         * 机构的客服电话、缴费邮箱对老人是有用信息，
         * 不该跟老人自己的号码一起挡掉。
         */
        const CONTACTISH = ['PHONE', 'EMAIL'];
        const meaningful = orgContact
          ? found.filter((d) => d && !CONTACTISH.includes(d.type))
          : found;

        if (meaningful.length) {
          reasons.push('包含检测到的个人信息');
          meaningful.forEach((d) => {
            if (d && d.type && !types.includes(d.type)) types.push(d.type);
          });
        }
      } catch (err) {
        // 检测器出错就当作不安全 —— 失败要往保守方向倒
        reasons.push('个人信息检测失败，保守起见不外发');
      }
    }

    // --- 关卡 2：姓名 ---
    const nameWhy = looksLikeName(raw, {
      inUpperArea: line.top <= pageHeight * 0.45
    });
    if (nameWhy) {
      reasons.push(nameWhy);
      types.push('PERSON_NAME');
    }

    // --- 关卡 3：收件人区块 ---
    if (addresseeBlock.has(index)) {
      reasons.push('位于收件人地址区块');
      types.push('ADDRESS_BLOCK');
    }

    // --- 关卡 4：地址 / 信箱 ---
    if (
      !orgContact &&
      (STREET_RE.test(raw) || CITY_STATE_ZIP_RE.test(raw) || PO_BOX_RE.test(raw))
    ) {
      reasons.push('包含街道或城市邮编');
      types.push('ADDRESS');
    }

    // --- 关卡 5：编号型字符串 ---
    /*
     * 编号型字符串是风险最高的一类，原则上一律挡。
     * 唯一的例外是带明确机构投递标签的
     * （MAILSTOP: 14294131 / PO BOX 660064 / Dept 12），
     * 那是机构自己的路由号，不是老人的账号。
     *
     * 注意「Online Biller ID: 22222222」不在这个例外里 ——
     * 它带的是账户标签，仍然会被挡下。
     */
    const isOrgRouting =
      ORG_ROUTING_LABEL.test(raw) &&
      ctx.nearOrg(index, 3) &&
      !ctx.nearPerson(index, 2);

    if (!isOrgRouting && hasIdLikeToken(raw)) {
      reasons.push('包含疑似账号或编号');
      types.push('ID_LIKE');
    }

    // --- 关卡 6：网址 / 邮箱 ---
    if (!orgContact && CONTACT_RE.test(raw)) {
      reasons.push('包含网址或邮箱');
      types.push('CONTACT');
    }

    if (reasons.length) {
      withheld.push({ index, reasons, types, length: raw.length });

      /*
       * 在文本里留一个占位，让模型知道这里被拿掉了一段。
       * 不留占位的话，模型会把前后两句错误地缝在一起，
       * 编出一个信里根本没有的意思。
       */
      if (!lastWasRedacted) {
        payloadParts.push('[个人信息已在本机隐藏]');
        lastWasRedacted = true;
      }
      return;
    }

    sendable.push({ index, text: raw });
    payloadParts.push(raw);
    lastWasRedacted = false;
  });

  const total = safeLines.length;

  return {
    sendable,
    withheld,
    payloadText: payloadParts.join('\n'),
    stats: {
      total,
      sendableCount: sendable.length,
      withheldCount: withheld.length,
      coverage: total ? Math.round((sendable.length / total) * 100) : 0,
      withheldTypes: Array.from(
        new Set(withheld.flatMap((w) => w.types))
      )
    }
  };
}

export default buildTranslatablePayload;
