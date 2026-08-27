# Mama Helper 👵📬

> **看不懂美国的信？拍一下就知道。**

Mama Helper reads U.S. mail — utility bills, insurance notices, Medicare and Medi-Cal
letters, court summons — and explains it in plain Chinese for elderly family members
who don't read English.

It answers the five things an older person actually needs to know:

> **这是什么信 · 谁寄的 · 大意 · 要交多少 · 什么时候之前**

**The letter never leaves the device.** Photo, OCR, extraction, validation and the
Chinese explanation all run in the browser — zero network requests.

> **Verify it yourself in five seconds:** turn on airplane mode and photograph a letter.
> It still works.
> **验证方法：把手机调成飞行模式，拍一张信。功能照常。**

That is the whole point. A privacy claim you can falsify is worth more than one you
have to trust — and the person deciding whether to install this is usually the adult
child, not the elder.

---

> **Status — v1 · 本地读信.** Reading, extraction and the Chinese explanation work
> end-to-end with no network. There is no AI layer, no chat and no account yet.
> What changed in each version, and why each design decision was made, lives in
> [`docs/journal.md`](docs/journal.md) — this README always describes the current state,
> never the history.

---

## What it does today

| | |
|---|---|
| **Classify** | electricity / gas / water / auto / home / life insurance / Medi-Cal / Medicare / SSA / court and more — utilities and insurance are kept **separate**, never lumped together |
| **Identify sender** | a dictionary of known organizations, abbreviated where an abbreviation exists (SCE, AT&T, HOA) |
| **Extract the amount** | and distinguish **three states**: 要交 / 自动扣款 / 不用交 (including credit balances) |
| **Extract two different dates** | the **due date** (act before this) and the **statement date** (when the letter was written) — shown in separate boxes, never merged. Confusing them is the single easiest way to make an elder act on a deadline that doesn't exist |
| **Say "no deadline" when there is none** | rather than inventing one from whatever date it can find |
| **Flag urgency** | 红 · 橙 · 黄 · 绿, with `‼️` for the most urgent. The wording is generated from the actual reason, not picked from a canned list per level |
| **Recognize subtypes** | MSN, ANOC, Medi-Cal annual renewal, HOA lien notice, jury summons … |
| **Screen for scams** | a set of signal patterns |
| **Compute redaction** | which lines could safely be sent to an external model — **computed only, nothing is sent** |

### Accuracy — measured, not estimated

Every number below is regenerated from the source and the test suite by
`scripts/update-docs.mjs`. None of them are typed by hand — see
[`docs/how-it-works.md`](docs/how-it-works.md) for the current run and the
dictionary sizes behind it.

<!-- AUTO:BEGIN README 分数由 scripts/update-docs.mjs 生成，不要手改 -->

| Suite | Result |
|---|---|
| **Real bills, hand-labeled ground truth** | 6 letters × 5 fields — category 6/6 100%   amount 6/6 100%   payment 6/6 100%   due date 6/6 100%   statement date 5/6 83% |
| `fieldExtractor.test.mjs` | 17 通过 / 0 失败 |
| `fieldExtractor.real.test.mjs` | 真实措辞 6 通过 / 0 失败 |
| `fieldExtractor.split.test.mjs` | 9 通过 / 0 失败 |
| `fieldExtractor.consistency.test.mjs` | 矛盾 0 处 |
| `contentRedactor.hoag.test.mjs` | 15 通过 / 0 失败 |
| `fieldExtractor.tier1.test.mjs` | 第一梯队 4 通过 / 0 失败 |
| `fieldExtractor.photo.test.mjs` | 手机实拍 7 通过 / 0 失败 |
| `speech.test.mjs` | 朗读 16 通过 / 0 失败 |
| `amount.corroboration.test.mjs` | 金额佐证 4 通过 / 0 失败 |
| `layoutText.test.mjs` | 版面还原 8 通过 / 0 失败 |
| `contentRedactor.recall.test.mjs` | 脱敏召回 16/21 |
| `knowledge.test.mjs` | 知识库 12 通过 / 0 失败 |

Dictionary sizes: 已知机构 40 · 信件类别 26 · 信件子类型 15 · 金额锚点 25 · 日期锚点 29 · 句式词典 30 · 诈骗特征 9 · 交叉校验 19 · 知识库词条 38.

<!-- AUTO:END -->

Measured OCR confidence: **97.8%** on numeric tokens, **99.3%** on dates.
**OCR is not the bottleneck** — 14 of the 27 bugs fixed so far were in the extraction layer, which
is far more dangerous because it produces *confidently wrong answers* rather than
"I can't read this."

### What it does NOT do yet

Listed honestly, because a README that promises features is the same failure mode as
a letter reader that guesses at amounts.

- ❌ **No follow-up questions.** There is no chat.
- ❌ **No AI advice.** The redaction layer is built and tested, but nothing is sent anywhere.
- ❌ **No multi-page handling.** Photograph the page without the amount on it and it will
  say "not found" instead of "this letter has more pages."
- ❌ **No Chinese-language letters.** OCR is pinned to `lang: 'en'`.
- ❌ **Name detection is regex-only.** `BAKER, NATE` is caught by its shape; `Nate Baker` is missed.
  This is the single weakest part of the system — see [`docs/how-it-works.md`](docs/how-it-works.md).

---

## Why it's built this way

The design splits the problem in two, and the split is the whole architecture:

```text
                     Letter photo
                          │
                 ┌────────┴────────┐
                 │  Local, always  │
                 └────────┬────────┘
                          │
        image prep → OCR → spatial extraction → 14 cross-checks
                          │
                          ▼
                   Verified facts                    Language & context
          amount · date · sender · category    ←──   explaining unusual wording,
          deterministic, arithmetic-checkable        suggesting next steps
                          │                          (a later version, opt-in,
                          ▼                           on redacted text only)
                Chinese explanation
                 template-composed
                 cannot hallucinate
```

**Deterministic systems own the facts. Language models never touch a number.**

An amount can be proven: `33.94 + 35.74 + 25.22 + 4.27 + 0.19 = 99.36`. A model that
outputs a number offers no second path to check it — and reading digits is a model's
weakest skill sitting in this system's highest-risk position. So amounts and dates come
from local extraction or they don't come at all.

The payoff shows up in cases like these — every one of them was read wrong before it was read right:

| Printed on the letter | Actually means | The wrong reading costs |
|---|---|---|
| `RECURRING PAYMENT - DO NOT PAY` | already on autopay | paying a real bill twice |
| `AMOUNT DUE: None` next to `Total Premium $165.00` | nothing owed | paying $165 for nothing |
| `Balance $6.33CR` | the company owes *you* | confusion, or paying a credit |
| `Pay by Phone: 855-…` | a payment method | a fabricated due date |

**When the cross-checks fail, it says 看不准 rather than guessing.** For this user, a
wrong number is worse than an admitted blank.

---

## Run locally

Reading letters needs **only the frontend**. There is no backend, no API key and no
account — that is not a setup shortcut, it's the product.

```bash
git clone https://github.com/willeychen7/mama-helper.git
cd mama-helper/frontend
npm install
npm run dev          # → http://localhost:5173
```

The OCR model downloads once on first run and is cached; after that the page works
offline.

<details>
<summary><code>backend/</code> — FastAPI scaffold for the future AI layer, not yet used</summary>

It exists for the opt-in advice feature described above. **Nothing in the letter-reading
path calls it**, and it has no `requirements.txt` yet — install its imports by hand:

```bash
cd backend && python3 -m venv venv && source venv/bin/activate
pip install fastapi uvicorn pydantic groq pillow
cp ../.env.example .env        # then fill in a key
uvicorn main:app --reload      # → http://127.0.0.1:8000
```

Keep keys in `backend/.env`. Never commit them.
</details>

## Verify the claims yourself

```bash
# 1 · The privacy claim: airplane mode, then photograph a letter. It still works.

# 2 · The accuracy claims:
cd frontend/src/utils
for t in *.test.mjs; do echo "── $t"; node "$t" | tail -3; done

# 3 · The numbers in the docs are generated from source, never hand-typed:
node scripts/update-docs.mjs --check
```

## Documentation

Three files, deliberately. Don't add a fourth.

| | |
|---|---|
| [`CLAUDE.md`](CLAUDE.md) | **工作守则** — five hard rules, what to do after every code change, what's next |
| [`docs/how-it-works.md`](docs/how-it-works.md) | **说明书** — the seven-stage pipeline, the privacy gates, how accuracy is verified |
| [`docs/journal.md`](docs/journal.md) | **日记** — changes ✅, bugs 🐛, decisions ⚖️. Append-only |

Every number in the docs is regenerated from the source and the test suite by
`scripts/update-docs.mjs` — none of them are typed by hand.

A pre-commit hook blocks a core-code change that doesn't touch the journal, and blocks
real letters from ever entering git. It lives in `scripts/hooks/` so it travels with the
repo, but git won't use it until you point at it once per clone:

```bash
git config core.hooksPath scripts/hooks
```

## Tech

React 19 · Vite · `@paddleocr/paddleocr-js` (PP-OCRv6 preferred, v5 fallback; WebGPU
preferred, WASM fallback). Image preprocessing — page-corner detection, perspective
correction, deskew, shadow removal — is hand-written over Canvas and typed arrays, so
it adds **zero** download weight. FastAPI backend, not yet used.

## Honest scope

Local processing is not the same as perfect privacy, and this project doesn't claim it.

**Protects against:** us seeing your mail · interception in transit · a breach on our
side, because we hold nothing of yours.

**Does not protect against:** someone holding your unlocked phone · browser or OS-level
compromise · you forwarding a screenshot yourself · category inference (knowing a letter
is a Medi-Cal renewal implies something about income).

PII detection cannot guarantee every identifier is caught. The goal is not a perfect
privacy guarantee — it's a privacy boundary that is **small, explicit and testable**.

## ⚠️ Disclaimer

Mama Helper produces software-generated explanations for informational purposes only.
It is **not** legal, financial, medical or tax advice. For anything consequential,
verify with the organization that sent the letter or with a qualified professional.

## 📄 License

To be added.
