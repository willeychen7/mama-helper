/**
 * utils/piiOwnership.js
 *
 * P0-C：候选归属判断（sender / recipient / third_party / unknown）。
 *
 * ── 为什么单独拆出来 ──
 *
 * `contentRedactor.js` 原来的 `isOrgContactLine()` 同时承担了三件事：
 *   1. 这一行像不像 PII（形状判断）
 *   2. 这一行是谁的（位置判断：离机构名近就当机构的）
 *   3. 要不要放行（直接返回布尔值给调用方当放行依据）
 *
 * 三件事混在一条「离机构名 3 行以内」的位置判断里，出过两次真实事故：
 *   - `SCE_Bill_Letter`：「Service address」紧挨机构名，
 *     老人自己的服务地址被当成机构地址放行。
 *   - `att_bill`：收件人自己的公司名「TECH GROUP & ASSOCIATES INC」
 *     命中 STRONG_ORG_HINTS，紧挨着的收件人地址被当成机构地址放行。
 *
 * 两次事故的根因相同：单靠「离某一行机构名近」判断归属，
 * 分不清「这行是机构的」还是「这行只是恰好印在机构名附近的收件人信息」。
 *
 * ── 这个模块做什么 ──
 *
 * 只做「候选属于谁」这一件事，不做「要不要放行」（那是调用方的策略）。
 * 输入一个候选行的位置，输出：
 *   role: 'SENDER' | 'RECIPIENT' | 'THIRD_PARTY' | 'UNKNOWN'
 *   evidence: 用到了哪些证据（数组，供 benchmark 统计哪类证据最有效）
 *   score: 内部打分（正数偏 SENDER，负数偏 RECIPIENT，供调试）
 *
 * 证据来源（用户明确要求不能只看"离机构名几行"）：
 *   - 已确认的寄件机构锚点（fieldExtractor 的 detectSender 结果，
 *     经过 KNOWN_ORGS 词典或版面最大字号判断，比裸的 STRONG_ORG_HINTS
 *     扫描可靠得多）——但即使靠近这个锚点，还要看是不是同一栏（见下）
 *   - 版面栏位：两个多栏信件（比如 att_bill）里，收件人信息栏和
 *     机构 logo 经常在 `buildSpatialReadingOrder` 排出来的顺序里
 *     紧挨着（同一"行"其实是两栏内容），但像素上的水平位置
 *     （bbox.left）差得很远——这是行号距离测不出来、但 bbox 能测出来的
 *     多栏证据。
 *   - 机构投递标签（MAILSTOP/PO BOX/remit to 等）——这类标签只有
 *     机构自己会用，内容本身就是强证据，不需要位置佐证。
 *   - 联系方式引导语（customer service/contact us/questions 等）。
 *   - 域名匹配（网址/邮箱域名里含机构抬头的关键词）。
 *   - 落款/签名（Sincerely/Regards 等后面通常是机构或部门）。
 *   - 收件人字段标签（To:/Customer:/Patient:/Dear .../Service Address
 *     等）——明确指向"这是收件人信息"。
 *   - 收件人区块成员——已经在 `findAddresseeBlock` 里判定过的地址块。
 *   - 位置：离机构名近/离人名近，作为最弱的补充证据，单独出现不足以
 *     决定归属（正是这条被单独拿出来当唯一依据才出的两次事故）。
 */

const normalize = (text) =>
  String(text || '')
    .replace(/\s+/g, ' ')
    .trim();

/*
 * 两个候选行如果分属不同栏（多栏版面），即使行号挨着，
 * 水平位置也会差出一大截。真实案例：att_bill 的 AT&T logo
 * bbox.left=157，收件人信息栏 bbox.left≈350，差 193px；
 * 同一栏内的正常缩进/对齐误差一般在几十像素以内。
 * 这个容差刻意留得比"正常缩进"宽，比"两栏净距离"窄。
 */
const COLUMN_TOLERANCE_PX = 120;

const sameColumn = (a, b) => {
  if (!a || !b) return false;
  const la = typeof a.left === 'number' ? a.left : null;
  const lb = typeof b.left === 'number' ? b.left : null;
  if (la === null || lb === null) return true; // 没有 bbox 信息时不做区分，退回纯位置判断
  return Math.abs(la - lb) <= COLUMN_TOLERANCE_PX;
};

const ORG_ROUTING_LABEL =
  /\b(mail\s?stop|mailstop|dept\.?\s*\d|department\s*\d|p\.?\s?o\.?\s*box|lock\s?box|remit\s*(to|payment)|remittance|return\s*service\s*requested|make\s*checks?\s*payable)\b/i;

const STRONG_ORG_HINTS =
  /\b(inc|llc|llp|ltd|plc|corp|corporation|company|association|institute|hospital|clinic|infirmary|bank|credit\s*union|university|college|district|bureau|agency|administration|court|authority|foundation|mutual|insurance|assurance|permanente|kaiser|edison|alliance|associates|physicians|orthopedic|cardiology|radiology|laboratory|pharmacy|department\s*of|board\s*of|office\s*of|city\s*of|county\s*of|state\s*of)\b/i;

const CONTACT_CONTEXT_HINT =
  /\b(customer\s*service|contact\s*us|questions?|call\s*(us|now)|billing\s*(department|inquiries|questions)|member\s*services|claims\s*department|support|help\s*line|for\s*(assistance|help)|general\s*inquiries|toll[\s-]?free)\b/i;

const SIGNATURE_CLOSING_RE =
  /\b(sincerely|regards|best\s*regards|thank\s*you\s*for)\b/i;

export const RECIPIENT_LABEL_RE =
  /\b(to|customer|member|patient|attn|attention|account\s*holder|policyholder|insured|guarantor|service\s*address|mailing\s*address|bill\s*to|ship\s*to)\s*[:：]/i;

const DEAR_RE = /\bdear\s*(mr|mrs|ms|miss|dr|prof)\.?\s*[A-Z]/i;

/*
 * 决定阈值——分数达到这个量级才敢下 SENDER/RECIPIENT 结论，
 * 够不到就是 UNKNOWN（调用方按策略处理，默认不放行）。
 * 单独一条"离机构名近"的弱证据（+10）不该单独跨过这条线，
 * 这正是之前两次事故的教训。
 */
const DECISION_THRESHOLD = 30;

/**
 * @param {object} params
 *   index          候选行在 lines 数组里的下标
 *   lines          全部 OCR 行（数组下标必须和 ctx/addresseeBlock 用的是同一套）
 *   ctx            buildContextMap() 的返回值
 *   addresseeBlock 可选，findAddresseeBlock() 的返回值（Set）——
 *                  候选行本身就在收件人区块里，直接判 RECIPIENT
 *   senderLineIndex 可选，fieldExtractor 确认过的寄件机构行下标
 *                  （注意：必须是数组下标，不是 OCR 的 line.id——
 *                  两者不是一回事，见 App.jsx 2026-08-30 的那次修复）
 * @returns {{ role: string, evidence: string[], score: number }}
 */
export function classifyOwnership({
  index,
  lines,
  ctx,
  addresseeBlock = null,
  senderLineIndex = null
}) {
  const raw = normalize(lines[index] && lines[index].text);
  const box = lines[index];
  const evidence = [];

  // --- 决定性证据 1：已经在收件人区块里 ---
  if (addresseeBlock && addresseeBlock.has(index)) {
    return { role: 'RECIPIENT', evidence: ['recipient_block'], score: -100 };
  }

  // --- 决定性证据 2：这一行本身就是确认过的寄件机构锚点 ---
  if (typeof senderLineIndex === 'number' && index === senderLineIndex) {
    return { role: 'SENDER', evidence: ['known_sender_line'], score: 100 };
  }

  let score = 0;

  // --- 内容证据（不看位置，本身就有说服力）---
  if (ORG_ROUTING_LABEL.test(raw)) {
    evidence.push('org_routing_label');
    score += 50;
  }
  if (ctx && ctx.domainMatchesOrg && ctx.domainMatchesOrg(raw)) {
    evidence.push('domain_matches_org');
    score += 50;
  }
  if (CONTACT_CONTEXT_HINT.test(raw)) {
    evidence.push('contact_label');
    score += 40;
  }
  if (RECIPIENT_LABEL_RE.test(raw) || DEAR_RE.test(raw)) {
    evidence.push('recipient_label');
    score -= 60;
  }

  // --- 邻近证据：落款/签名（往上看 3 行）---
  for (let k = Math.max(0, index - 3); k < index; k += 1) {
    if (SIGNATURE_CLOSING_RE.test(normalize(lines[k] && lines[k].text))) {
      evidence.push('signature_closing');
      score += 35;
      break;
    }
  }

  // --- 邻近证据：收件人字段标签在上面 1-2 行（比如"Customer:"另起一行）---
  if (!evidence.includes('recipient_label')) {
    for (let k = Math.max(0, index - 2); k < index; k += 1) {
      const t = normalize(lines[k] && lines[k].text);
      if (RECIPIENT_LABEL_RE.test(t) || DEAR_RE.test(t)) {
        evidence.push('recipient_label_nearby');
        score -= 50;
        break;
      }
    }
  }

  // --- 已确认寄件机构锚点：位置近 + 同一栏，才算强证据 ---
  if (typeof senderLineIndex === 'number' && lines[senderLineIndex]) {
    const near = Math.abs(index - senderLineIndex) <= 3;
    if (near) {
      if (sameColumn(box, lines[senderLineIndex])) {
        evidence.push('near_confirmed_sender_same_column');
        score += 45;
      } else {
        /*
         * 行号挨着，但像素上的水平位置差一大截——多半是
         * `buildSpatialReadingOrder` 把两栏内容排到了相邻的
         * "行"里，不代表内容真的相关。只给很弱的分数。
         * att_bill 就是靠这条把 AT&T logo（左栏很远）跟收件人
         * 信息栏（挨着 TECH GROUP INC）区分开的。
         */
        evidence.push('near_confirmed_sender_diff_column');
        score += 5;
      }
    }
  }

  // --- letterhead：页面最上面几行本身命中机构强特征词 ---
  if (index <= 2 && STRONG_ORG_HINTS.test(raw)) {
    evidence.push('letterhead_top');
    score += 40;
  } else if (STRONG_ORG_HINTS.test(raw)) {
    /*
     * 这一行本身像机构名，但不在最上面——弱证据。
     * att_bill 的教训：收件人自己的公司名一样会命中这条正则，
     * 不能只凭这个就判定是机构。
     */
    evidence.push('org_name_on_line_weak');
    score += 15;
  }

  /*
   * 邻近证据：紧挨着机构投递标签本身（PO BOX/MAILSTOP 这类），
   * 不是「离某一行机构名近」，是「离一条已经很确定的机构内容近」。
   *
   * hoag 缴费联那次教训：机构抬头在信里印了两次（页头一次、
   * 缴费联一次），`senderLineIndex` 只指向第一次出现的位置，缴费联
   * 那次重印离它太远（差 11 行），单靠"离确认过的寄件锚点近"接不住。
   * 但缴费联本身有 PO BOX / MAILSTOP 这类只有机构会用的强内容证据，
   * 挨着它的城市州邮编应该借到一部分confidence，而不是被当成孤立的
   * 弱位置证据。
   */
  if (!evidence.includes('org_routing_label')) {
    for (let k = Math.max(0, index - 2); k <= Math.min(lines.length - 1, index + 2); k += 1) {
      if (k === index) continue;
      if (ORG_ROUTING_LABEL.test(normalize(lines[k] && lines[k].text))) {
        evidence.push('near_org_routing_label');
        score += 40;
        break;
      }
    }
  }

  // --- 最弱的补充证据：纯位置（离哪种锚点近）---
  const hasStrongerOrgEvidence = evidence.some((e) =>
    ['org_routing_label', 'domain_matches_org', 'contact_label', 'letterhead_top', 'near_confirmed_sender_same_column', 'near_org_routing_label'].includes(e)
  );
  if (!hasStrongerOrgEvidence && ctx && ctx.nearOrg && ctx.nearOrg(index, 3)) {
    evidence.push('near_generic_org_hint');
    score += 10;
  }
  if (ctx && ctx.nearPerson && ctx.nearPerson(index, 3)) {
    evidence.push('near_person_anchor');
    score -= 10;
  }

  let role = 'UNKNOWN';
  if (score >= DECISION_THRESHOLD) role = 'SENDER';
  else if (score <= -DECISION_THRESHOLD) role = 'RECIPIENT';

  return { role, evidence, score };
}

/**
 * 归属 -> 是否放行。
 *
 * RECIPIENT / THIRD_PARTY / UNKNOWN 一律不放行——UNKNOWN 不是「大概率
 * 安全，先放行」，是「证据不够，按保守方向处理」（决定 02 的白名单方向）。
 * THIRD_PARTY 目前的隐私策略跟 RECIPIENT 一样保守，先不区分对待，
 * 等真的有第三方场景（比如信里提到别的病人）再细化。
 */
export function shouldRelease(role) {
  return role === 'SENDER';
}

export const __internal = {
  COLUMN_TOLERANCE_PX,
  DECISION_THRESHOLD,
  sameColumn,
  ORG_ROUTING_LABEL,
  STRONG_ORG_HINTS,
  CONTACT_CONTEXT_HINT,
  SIGNATURE_CLOSING_RE,
  DEAR_RE
};
