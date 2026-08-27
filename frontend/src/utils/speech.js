// ============================================================
// 无障碍：朗读 + 字号
//
// 对一个 70 岁、看不懂英文、也可能看不清小字的人，
// **朗读比准确率更重要** —— 她可能根本读不了我们辛苦拼出来的那句中文。
// ============================================================

/*
 * 把卡片上的中文拼成一段能读出来的话。
 *
 * 顺序按老人真正关心的先后：紧急程度 → 这是什么 → 谁寄的 → 大意
 * → 要交多少 → 什么时候之前 → 该做什么。
 *
 * 只读模板拼出来的中文，**不读任何 OCR 原文** ——
 * 原文里可能有姓名地址，而这些永远不该被念出声
 * （老人多半不是一个人在房间里用这个 app）。
 */
export const buildSpeechText = (layer0) => {
  if (!layer0) return '';

  const parts = [];

  if (layer0.scamWarning) {
    parts.push('注意，这封信有可疑的地方。');
    (layer0.scamWarning.reasons || []).forEach((r) => parts.push(r));
  }

  if (layer0.whatIsIt) parts.push(layer0.whatIsIt);
  if (layer0.whoSentIt) parts.push(layer0.whoSentIt);
  if (layer0.gist) parts.push(layer0.gist);
  if (layer0.howMuch) parts.push(layer0.howMuch);
  if (layer0.whenDue) parts.push(layer0.whenDue);
  // 逾期后果紧跟着截止日期念，别隔开 —— 这两句要连在一起才有意义
  if (layer0.lateConsequence) parts.push(layer0.lateConsequence);
  if (layer0.sentOn) parts.push(layer0.sentOn);

  (layer0.retakeHints || []).forEach((h) => parts.push(h.cn));

  if (layer0.advice) parts.push(layer0.advice);

  /*
   * 句子之间加停顿。老人听得慢，连着念会跟不上。
   * 用句号 + 空格，比依赖 SSML 可靠（浏览器对 SSML 支持很不一致）。
   */
  return parts
    .map((t) => String(t).trim())
    .filter(Boolean)
    .join(' ');
};

/*
 * 挑一个中文语音。
 *
 * **优先挑 localService 的**：Chrome 桌面版有些中文语音是
 * Google 的云端语音，念一句话要把文本发到服务器。
 * 我们念的是模板中文（不含姓名地址），但那仍然是一次网络请求 ——
 * 跟「零网络」的说法冲突，所以能用本地的就绝不用云端的。
 *
 * 挑不到本地中文语音时返回 { voice, isLocal:false }，
 * 由界面如实告诉用户，而不是偷偷发出去。
 */
export const pickChineseVoice = () => {
  if (typeof window === 'undefined' || !window.speechSynthesis) return null;

  const voices = window.speechSynthesis.getVoices() || [];
  if (!voices.length) return null;

  const zh = voices.filter((v) => /^zh/i.test(v.lang || ''));
  if (!zh.length) return null;

  const local = zh.filter((v) => v.localService);
  const preferCN = (list) =>
    list.find((v) => /zh[-_]?CN/i.test(v.lang)) || list[0];

  if (local.length) return { voice: preferCN(local), isLocal: true };
  return { voice: preferCN(zh), isLocal: false };
};


