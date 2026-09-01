# Mama Helper · 工作守则

> Claude Code 每次开工会自动先读这个文件。**人接手也该先读它。**
> 它只回答三件事：这是什么项目 · 什么不能碰 · 改完要做什么。
>
> 技术细节在 [`docs/how-it-works.md`](docs/how-it-works.md)。
> 历史、bug、决定在 [`docs/journal.md`](docs/journal.md)。
> 全项目只有这三份文档，不要再新建。

---

## 一句话

帮在美华人老人看懂英文信件。拍一张照 → 浏览器本地 OCR → 抽出金额/日期/机构/类别
→ 交叉校验 → 拼成中文结论。**整条链路零网络。**

用户是看不懂英文的老人。这一点决定了下面所有的规矩：
**没有人能替我们发现错误，所以不能有需要人兜底的设计。**

---

## 五条铁律

要动其中任何一条，先去 `docs/journal.md` 找对应的那条决定，看清楚当初为什么这么定。

| | 铁律 | 依据 |
|---|---|---|
| 1 | **金额和日期永远由本地抽取，不能来自 LLM。** 本地读不出就说「看不准」，不让模型填 | 决定 01 |
| 2 | **脱敏是白名单方向** —— 只发确认安全的行，不是「检测到 PII 才挡」 | 决定 02 |
| 3 | **默认零网络。** 飞行模式下核心功能必须照常，这是可以当场验证的承诺 | 决定 04 |
| 4 | **不确定就说「看不准」，不许猜。** 对老人报错一个金额，比说不知道糟糕得多 | — |
| 5 | **真实信件不进 git。** 放 `demo_image/real/`，OCR 结果存 `private_*.json` | — |

**要推翻，就去 journal 顶部写一条新的 ⚖️ 决定**，写明推翻了哪条、为什么、代价是什么。
不要直接改代码了事，也不要删掉旧那条 —— 旧的那条要留着，只在标题下加一行「已被 XX 取代」。

---

## 改完代码，必须做这三件事

```bash
# 1 · 跑全量回归（六层全绿才算完）
cd frontend/src/utils && for t in *.test.mjs; do echo "── $t"; node "$t" | tail -3; done

# 2 · 重新生成文档里的数字（自动，任何数字都不要手写）
node scripts/update-docs.mjs

# 3 · 往 docs/journal.md 最上面加一条
```

第 3 步记什么：

| 你做了什么 | 记吗 | 怎么记 |
|---|---|---|
| 修了一个 bug | 🐛 记 | 必须写**是被哪张图/哪个测试炸出来的** —— 这一列比其他列都有用 |
| 加了能力，或改了对外行为 | ✅ 记 | 记行为变化，不记重构 |
| 做了一个三个月后会问「当初为什么」的选择 | ⚖️ 记 | 必须写「什么情况下该推翻」。**不写失效条件的决定就是教条** |
| 纯重构 / 改名 / 格式化 | 不记 | |

**新克隆仓库之后先跑一次**（只需一次）：

```bash
git config core.hooksPath scripts/hooks
```

之后 pre-commit 钩子生效：改了抽取器或脱敏器却没动 journal，提交会被拦下来；
真实信件（`demo_image/real/`、`private_*.json`）也一律拦住。
确实不需要记的那次用 `git commit --no-verify` 跳过。

---

## 文件地图

```
CLAUDE.md                      ← 你在这
docs/how-it-works.md           读信管线 · 隐私处理 · 准确率验证（白板，随时改写）
docs/journal.md                变更 · bug · 决定（日记，只加不改）
scripts/update-docs.mjs        从代码和测试重新生成文档里的数字
scripts/hooks/pre-commit       提交前检查（需先设 core.hooksPath，见上）

frontend/src/utils/
  imagePrep.js                 图像预处理（四角检测/透视矫正/去斜/去阴影）
  fieldExtractor.js            空间字段抽取 + 14 项交叉校验 + 中文模板
  contentRedactor.js           逐行脱敏判定，六道关卡
  *.test.mjs                   六层测试
  ground_truth.json            真实账单的人工真值 ← 这份是最高权威
```

**优先级：测试 > 代码 > 文档。** 三者冲突时以测试和 `ground_truth.json` 为准，
文档是描述现状的，不是规范。

---

## 高层 Roadmap（下一步该做什么）

> 这里只放高层结论。每个 Phase 背后的 benchmark 数字、实验过程、推翻依据
> 都在 [`docs/journal.md`](docs/journal.md)（决定 11–14 + 对应日期条目）。
> 产品的安全边界是「**LLM 可以看不懂，但绝不能看到不该看到的东西**」——
> 现在最该投入的是把「敏感信息出本机之前真的被挡住了」这条链路做扎实。

### 当前状态（2026-09-01）

- **Phase 1 — COMPLETE**：对**本轮 benchmark 观察到的具体 detection failure
  mode** 的定向调查，据此做窄 regex 硬化。production 改动（`App.jsx` 的 6 处
  `PII_PATTERNS` + 测试镜像同步）**已完成，但尚未 commit，等 review**。
  **不是完整的 PII taxonomy / coverage pass** —— 范围见下方 Phase 1 条目。
- **Phase 2-0 — NEXT**：Local PII Model A/B Benchmark，不改 production。

### 核心决策原则（比 roadmap 本身更重要）

工作方式是 **假设 → benchmark → evidence → decision → production**，
不是「想到一个技术 → 加进去 → 再想下一个技术」。

- **不因为「理论上存在某种格式」就加 regex。** 没有真实美国信件样本支持的
  格式缺口，记录为 known gap，不猜。
- **Real-world evidence > synthetic assumptions。** 我方构造的对抗样例只能
  定位「哪个子模式失败」，不能当作「这问题真实存在且值得修」的证据。
- **Benchmark before adding models / dependencies。** 引入任何 model / 库 /
  数据资产之前，先在真实信件上跑 A/B；delta 不显著就不引入。
- **最终指标是 redaction 之后的实际 privacy leakage，不是 detector recall。**
  被 detector 漏掉、但被 Redaction 层兜底挡住的字段，不算泄露。
- **实验性代码在 benchmark 验证前不进 production。**
- **不再为了继续 Phase 1 而新增 Item。** DOB / MRN / Medicaid ID / … 走
  Phase 2-0 + taxonomy audit，不是一个个变成新的 regex patch。

> 不推翻决定 01：`FieldExtractor` 抽出来的金额/日期仍然是当前结构化结论的
> 唯一来源。*This does not revoke Decision 01 — local amount/date extraction
> remains the source of truth for the structured result.*

### 当前实际 pipeline（现状）

```
拍照 → 图像预处理 → 本地 OCR
  → 逐行 PII 判定：deterministic regex detectors + hasIdLikeToken 兜底
    + classifyOwnership（P0-C，目前只覆盖 ADDRESS/PHONE 的 sender/recipient 归属）
  → 逐行 redaction（buildTranslatablePayload）→ 只有放行的行进 payload
  → LLM 理解层（目前是实验开关，见决定 10）
```

### 目标架构（尚未实现，逐步演进，不要写成已完成）

```
OCR
 ↓
PII Detection
 ├─ deterministic regex / structured detectors   ← 现在只有这个
 ├─ PII model                                    ← Phase 2 才评估要不要
 └─ context / spatial evidence                   ← Phase 3
 ↓
Evidence Fusion / PII Ownership                   ← Phase 3（现在只有部分 Ownership）
 ↓
Local Redaction
 ↓
Privacy Gate                                      ← 显式的最终把关，现在是隐式的
 ↓
Redacted text → LLM
```

### Phases

**Phase 1 · Structured PII detection / narrow regex hardening —— COMPLETE**

> *Phase 1 is a targeted investigation of observed detection failure modes,
> not a complete PII taxonomy or coverage pass.*

- 解决什么：明确格式的 Detection 漏洞（分隔符变体、掩码写法、label 拼写
  等），用窄、可解释、低 FP 的 regex 修。
- **范围 —— 不是什么**：
  - 不是完整的 PII taxonomy coverage review，也不是「每种 PII type 至少
    配一个 Item」。**Item 编号 = 本轮调查中发现的一个具体 failure mode /
    finding**，不是「要覆盖的 PII 类型清单」。
  - 只有**经过真实信件 evidence 验证、且适合窄 production fix** 的 finding
    才进 production（Items 1–6）。
  - **ADDRESS 实际被调查过**（Item 7），但因真实 prevalence / FP 证据不足，
    保留为 known gap，**没有 production change**。
  - **PERSON / NAME 没有在 Phase 1 做完整 coverage** —— `looksLikeName` 的
    边界见 journal「当前 regex 方案最大的剩余问题」。**不要理解成「姓名
    已解决」。**
  - 未在 Phase 1 覆盖的 PII 类型（PERSON 长尾、DOB、MRN、Medicaid /
    medical ID 类、VIN / 牌照、PIN / verification code 等）走 Phase 2-0 /
    taxonomy audit / model·context benchmark **系统评估**，不是靠继续给
    Phase 1 加 regex 补齐。
- 什么决定进入下一阶段：明确格式的缺口已修完；再往下做会开始依赖
  context/spatial 并产生 FP —— 已被证明（Items 7、8 就地停下，记录为
  known gap）。
- 什么推翻当前方案：若某个明确格式缺口既有真实信件证据、又能一行低 FP
  regex 解决，可以补做（走正常流程，不再新开 Item 编号）。

**Phase 2-0 · Local PII Model A/B Benchmark —— NEXT**

- 解决什么：回答核心问题 —— 现有 regex + `hasIdLikeToken` + redaction，
  与成熟本地 PII / NER model 相比，谁更适合我们的隐私 redaction？用同一批
  真实美国信件 OCR text 做 A/B，只在 benchmark 里跑，不接 production。
- 什么决定进入下一阶段：benchmark 给出每类 PII 的 recall / precision / FP、
  **redaction 之后的实际 leakage**、latency / model size / 浏览器移动端可
  运行性 / 离线可行性。据此三选一 —— (a) model 全面明显更好 → 考虑
  hybrid 或 model 主导 detection；(b) model 只在 PERSON/ADDRESS/DOB 等
  context-heavy 类型更好 → 结构化 PII 继续用 deterministic regex，model 补
  长尾和 context；(c) 在真实信件上没有明显优势 → 不引入，保留现有
  deterministic pipeline。
- 什么推翻当前方案：benchmark 数据本身就是判据。不因为「模型理论上更先进」
  就替换。

**Phase 2-1+ · Conditional specialized benchmarks**

- 解决什么：只有当 Phase 2-0 指出某一类 PII 有**可测量的 gap**，才评估
  针对该类的专用组件（如电话解析库、地名 / 姓名 gazetteer 等）。
- 什么决定进入下一阶段：每个专用组件独立 A/B（现有实现 vs 该组件：
  recall / precision / bundle size / 移动端影响 / 离线）。delta 显著才引入。
- 什么推翻当前方案：Phase 2-0 没指出对应 gap 就不做；A/B 没有明显优势就
  不引入。**不预设任何具体组件一定要做。**

**Phase 3 · Context / Spatial / PII Ownership / Evidence Fusion**

- 解决什么：regex 和 model 都处理不了的部分 —— 需要版面/位置证据（无
  suffix 地址的收件人块延伸、姓名的页面位置判断）、需要归属判断
  （sender / recipient / third-party）、需要把多个 detector 的证据融合成
  一个结论。已记录的 known gaps 由这一层接住。
- 什么决定进入下一阶段：Evidence Fusion + Ownership 能在真实信件上稳定地
  把「检测到的 PII」正确归类并交给 Redaction。
- 什么推翻当前方案：若纯位置/归属判断被证明比多证据融合更可靠、更简单
  （呼应决定 13 的推翻要件），退回简单方案。

**Phase 4 · 剩余高风险 PII（按真实样本决定）**

- 解决什么：Phase 1 期间点名但没系统处理的类型（DOB / MRN / Medicaid ID /
  Beneficiary ID / Group Number / Claim Number / Card number /
  PIN·verification·activation code / VIN·license plate 等）。先做 taxonomy
  audit（当前覆盖什么 / 完全没 detector 的 / 命中但仍可能 leak 的 / 真实
  信件里高 prevalence 的 / P0-P2 / 适合 regex / 需要 model / 需要 context），
  再按证据决定补哪些、怎么补。
- 什么决定进入下一阶段：audit 产出分类 + roadmap；高 prevalence + 有真实
  样本的类型按 Phase 2-0 的三条路处理。
- 什么推翻当前方案：某类型在真实美国老人信件里 prevalence 很低，或没有
  真实样本支持安全实现 → 记录为 known gap，不做。

**Phase 5 · Advanced model / NER**

- 解决什么：Phase 2–4 之后仍然存在、且 deterministic + 轻量方案都解决不了
  的缺口（最可能是 PERSON 长尾里 gazetteer 也覆盖不到的部分）。
- 什么决定进入下一阶段：benchmark 证明这类缺口真实存在、影响 privacy
  leakage、且没有更轻的方案。
- 什么推翻当前方案：benchmark 证明缺口可接受，或轻量方案已经够。目前
  **不下载 NER 模型、不集成、不增加体积和推理延迟**。

### 仍然有效、但不是当前重点的旧欠账

不属于隐私链路，`FieldExtractor` 那部分投入随时可以恢复时再捡起来，
不是永久取消：

- 多页信件（拍了没金额的那一页，现在说「没找到」而不是「这封信还有别的页」）
- 中文信件（OCR 现在写死 `lang: 'en'`）
- 让「看不准」说具体（现在只说看不准，应该说「金额那行没拍清楚，把下半部分
  再拍一张」）

OCR 粘连导致的 PII 漏检（曾经的 P1）已按**决定 12** 降级：现有证据不支持
继续投入，代码保留不优化，重新捡起的条件见决定 12。
