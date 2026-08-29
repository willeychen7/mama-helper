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

## 下一步该做什么（欠账，按优先级 · 决定 11/12 定的顺序）

产品的安全边界是「**LLM 可以看不懂，但绝不能看到不该看到的东西**」，
不是「本地代码必须把美国所有账单理解得像 billing specialist」。
所以现在最该投入的不是继续加账单业务规则，而是先把「敏感信息出本机之前
真的被挡住了」这条链路做扎实。

> 这次重新排优先级**不推翻决定 01**：`FieldExtractor` 抽出来的金额/日期
> 仍然是当前结构化结论的唯一来源，只是不再是最该投入开发精力的地方。
> *This reprioritization does not revoke Decision 01. Local amount/date
> extraction remains the source of truth for the current structured
> result; it is simply no longer the highest-priority development area.*

**P0 · 本地隐私检测正确性** —— 目标：敏感信息不出本机

- Ground truth 持续扩充（`contentRedactor.recall.test.mjs`，现在 11 封信、
  38 条断言，仓库里还有信没标注）；**攒真实照片的优先级依旧高于写新代码**，
  v1 的 27 个 bug 没有一个是想出来的，全是被一张新图炸出来的。最想要：
  手机实拍的、医疗 EOB、政府信件（社安局/白卡）。
- 结构化 PII（SSN / 电话 / Email / 账号 / 保单号 / Member ID / DOB——DOB
  现在连检测器都没有，语料里也没有真实正样本，是目前最大的空白）
- 裸姓名、OCR 粘连姓名
- 地址 / 邮编
- 图片级遮盖验证（不只测「文字里还剩什么」，要测「图片上真的被涂黑了吗」）

**P1 · OCR 粘连导致的 PII 漏检** —— 已降级，见决定 12（2026-08-29 定论）

`JENNIFERWASHINGTON`/`JOHNBDOE`/`iJANEDOE`/`JAMES&KARENQ.HINDS` 这四个
案例最初诊断为「不是本项目行重建逻辑的锅，是 PaddleOCR 检测/识别阶段
自己把这几个词粘成一个框」，据此立了 P1。但那份诊断依据的 fixture
（`demo_ocr_pp.json`）已经过时——用当前真实 PP-OCRv6 重新生成 15 份
fixture（1,111 行）之后，这 4 个案例**全部不再复现**，`suspiciousGlue`
检测器标出的 16 处可疑行经核对**全部是误报**（precision 0%），已有
数据还显示二次 OCR 对误报内容重跑有误伤倾向。**现有证据不支持继续
投入 P1**，代码保留（`suspiciousGlue.js`/`secondPassOcr.js`/
`p1-experiment.html`/`fixture-regen.html`）但不再优化，不是当前开发
方向。什么时候该重新捡起来：新 benchmark 发现有统计意义的真实粘连
错误，且能证明二次 OCR 稳定提升准确率、误伤成本可接受。

**P2 · 复杂版面下的隐私遮盖**

任务 3A 在 `water_bill` 这封带图表的信上炸出两个 false positive，根因都是
「不能只靠 block/下标相邻当依据」——`lines + bbox`（像素位置）才是实际
遮盖该依据的东西，block 只能当辅助上下文。专门测表格、图表、多栏、跨区域
文字。

**P3 · 红队测试**

故意找：姓名没遮 · 地址没遮 · 数字型身份信息没遮 · OCR 粘连 · OCR 错读
导致检测失效 · 遮盖过大（连累有用信息，参考 `Payments Received` 那次）·
遮盖不足 · 图片已经遮住但 payload 文字里仍有原文。

**P4 · LLM 理解层**

等 P0–P3 基本可靠之后，把「脱敏后的图片/文字 → LLM → 这是什么信、谁寄的、
要做什么」当成主要 AI 能力去投入（现在是实验开关，见决定 10）。

**没排进 P0–P4、仍然有效但不是当前重点的旧欠账**：多页信件（老人拍了没
金额的那一页，现在会说「没找到」而不是「这封信还有别的页」）、中文信件
（OCR 现在写死 `lang: 'en'`）、让「看不准」说具体（现在只说看不准，应该说
「金额那行没拍清楚，把下半部分再拍一张」）——这三条不属于隐私链路，
FieldExtractor 那部分投入随时可以恢复时再捡起来，不是永久取消。
