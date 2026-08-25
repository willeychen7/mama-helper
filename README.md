# Mama Helper 👵📬

**Mama Helper（安心小帮手）** is a privacy-first document understanding assistant designed to help Chinese-speaking families in the United States understand English letters, bills, notices, and other important documents.

> **看不懂美国的信？拍一下就知道。**

Many important U.S. documents can be difficult to understand for people who are not comfortable reading English.

Mama Helper turns complicated documents into clear, practical Chinese explanations while keeping privacy at the center of the design.

The goal is not simply to translate a letter.

It is to help answer:

> **这是什么？重要吗？我要做什么？什么时候做？不处理会怎样？**

---

## 🌱 Vision

Mama Helper is built around a **local-first and privacy-conscious approach**.

Important documents can contain names, addresses, account numbers, medical information, financial information, and other sensitive data.

Instead of automatically sending an entire document to an external AI service, Mama Helper is designed to process as much information as possible **locally on the user's device**.

The long-term vision is to help users move from understanding a document to knowing what to do next:

```text
📬 Understand
      ↓
🧠 Explain
      ↓
👉 Know what to do
      ↓
📅 Remember when to do it
```

Future AI-assisted capabilities may include natural-language explanations, follow-up questions, suggested next steps, official resource links, and reminders.

---

## 🔐 Privacy-First Architecture

Privacy is a technical design principle in Mama Helper, not only a policy statement.

The core document-reading pipeline is designed to run locally:

```text
📷 Document Image
       │
       ▼
┌──────────────────────┐
│ Local Image          │
│ Processing           │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│ Local OCR            │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│ Structured Field     │
│ Extraction           │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│ Local Validation     │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│ Local PII Detection  │
└──────────┬───────────┘
           │
           ▼
🇨🇳 Chinese Explanation
```

Local processing includes:

* Image preprocessing
* Browser-based OCR
* Structured field extraction
* Document classification
* Amount and date extraction
* Payment-status detection
* Deterministic validation
* Local PII detection
* Chinese explanation generation

The core reading experience does not require an external AI model.

For future AI-assisted features, Mama Helper is designed to apply **redaction and data minimization before external processing**, so that an AI model does not automatically receive the original document.

> **Use AI where it adds value. Keep sensitive processing local whenever possible.**

---

## 🧠 A Different Approach to AI

A typical document-AI workflow might look like:

```text
Document
   ↓
Cloud AI
   ↓
Answer
```

Mama Helper separates document processing from AI assistance:

```text
                    Document
                       │
                       ▼
              Local Processing
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
         OCR      PII Detection   Validation
          │            │            │
          └────────────┼────────────┘
                       ▼
                Verified Facts
                       │
                       ▼
              Optional AI Layer
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
      Explain       Guide        Follow-up
```

The principle is:

### Let deterministic systems handle facts.

For example:

* Amounts
* Dates
* Payment status
* Structured fields
* Document categories

### Let AI handle language and context.

For example:

* Explaining complicated wording
* Answering follow-up questions
* Summarizing context
* Suggesting possible next steps

This reduces the need to make an AI model the sole source of truth for critical document information.

---

## 📚 文档

全项目只有三份文档，不要再新建。

| | |
|---|---|
| [`CLAUDE.md`](CLAUDE.md) | **工作守则** —— 五条铁律、改完代码必做的三件事、下一步该做什么 |
| [`docs/how-it-works.md`](docs/how-it-works.md) | **说明书** —— 读信管线 · 隐私处理 · 准确率验证（白板，随时改写） |
| [`docs/journal.md`](docs/journal.md) | **日记** —— 变更 · bug · 决定（只加不改，新的写最上面） |

文档里的数字（准确率、词典规模）由脚本生成，不手写：

```bash
node scripts/update-docs.mjs          # 更新
node scripts/update-docs.mjs --check  # CI 检查是否过期
```

装了 pre-commit 钩子：改了核心代码却没动 `docs/journal.md`，提交会被拦下。

## ✨ Features

* 📷 **Take a photo or upload a document**
* 🖼️ **Process real-world phone photos**
* 🔍 **Local browser-based OCR**
* 🧩 **Structured document understanding**
* 🇨🇳 **Simplified Chinese explanations**
* 🔴 **Identify whether action is required**
* 💰 **Extract important amounts**
* 📅 **Identify due dates**
* ⚠️ **Highlight potential risks**
* ✅ **Validate critical extracted information**
* 🔒 **Detect and redact potentially sensitive information locally**
* 💬 **Ask follow-up questions about the document**
* 🤖 **Support future AI-assisted explanations and guidance**

---

## 🧩 How It Works

The document-reading pipeline is designed to separate local document processing from optional AI assistance.

```text
Take Photo / Upload Image
          ↓
   Local Image Processing
          ↓
      Local OCR
          ↓
  Structured Extraction
          ↓
   Local Validation
          ↓
   Local PII Detection
          ↓
  Chinese Explanation
          ↓
 Optional AI Assistance
```

The application can identify and structure information such as:

* Document type
* Sender
* Whether action is required
* Importance
* Amount
* Payment status
* Due date
* Summary
* Recommended action
* Risk level
* Risk explanation
* Confidence

---

## 🛡️ Local PII Detection

Sensitive information is detected locally before future external AI processing.

The system currently considers categories such as:

* Names
* Addresses
* Account numbers
* Social Security numbers
* Medicare identifiers
* Payment information
* Email addresses
* Other identifier-like strings

Mama Helper follows a **data-minimization approach**:

```text
Original Document
       │
       ▼
Local Processing
       │
       ├── Extract what is needed
       ├── Detect sensitive information
       └── Minimize what may leave the device
                    │
                    ▼
             Optional AI
```

The goal is not to claim perfect privacy.

The goal is to make the privacy boundary **smaller, explicit, and testable**.

---

## 🛠️ Tech Stack

### Frontend

* React
* Vite
* JavaScript / JSX
* CSS
* Lucide React

### Local Document Processing

* PaddleOCR
* WebGPU
* WASM
* Browser-based image preprocessing
* Local PII detection and redaction

### Backend

* Python
* FastAPI
* Uvicorn

### AI

Mama Helper is designed to support API-based AI models for future document understanding and assistance.

API credentials are provided through environment variables and are **not stored in the repository**.

---

## 🚀 Run Locally

### 1. Clone the repository

```bash
git clone https://github.com/willeychen7/mama-helper.git
cd mama-helper
```

### 2. Backend Setup

Go into the backend directory:

```bash
cd backend
```

Create a Python virtual environment:

```bash
python3 -m venv venv
```

Activate it on macOS/Linux:

```bash
source venv/bin/activate
```

Install the required dependencies:

```bash
pip install -r requirements.txt
```

Start the FastAPI server:

```bash
uvicorn main:app --reload
```

The backend will normally be available at:

```text
http://127.0.0.1:8000
```

### 3. Configure API Keys

Create a local `.env` file inside the `backend` directory when using an AI-enabled backend implementation.

For example:

```text
GROQ_API_KEY=your_api_key_here
```

or, if using the Gemini implementation:

```text
GEMINI_API_KEY=your_api_key_here
```

**Never commit your `.env` file or real API keys to GitHub.**

### 4. Frontend Setup

Open another Terminal window and go to the frontend:

```bash
cd mama-helper/frontend
```

Install dependencies:

```bash
npm install
```

Start the development server:

```bash
npm run dev
```

Vite will provide a local URL, usually similar to:

```text
http://localhost:5173
```

Open that URL in your browser.

---

## 🔒 Security & Privacy

Mama Helper follows a **local-first and data-minimization approach**.

Local processing does not mean perfect privacy or perfect PII detection.

Known limitations include:

* PII detection cannot guarantee that every personal identifier will be detected.
* Browser and operating-system security are outside the application's control.
* Users can still manually copy, screenshot, or share documents.
* Future external AI integrations will introduce additional privacy considerations.
* External AI providers may have their own processing and retention policies.

Mama Helper therefore avoids claiming absolute privacy guarantees.

The goal is to **minimize unnecessary exposure of sensitive information and make the privacy boundary visible and testable**.

The repository intentionally excludes:

```text
.env
.env.*
backend/venv/
frontend/node_modules/
__pycache__/
*.pyc
.DS_Store
```

Do not place API keys directly inside frontend code or commit them to Git.

---

## 🗺️ Roadmap

Future development may include:

* More robust OCR and document preprocessing
* Support for additional document types
* AI-assisted explanations and follow-up questions
* Suggested next actions
* Official resource links
* Deadline and payment reminders
* Privacy-focused document history
* Family assistance workflows
* Improved accessibility for older users

---

## ⚠️ Disclaimer

Mama Helper provides software- or AI-generated explanations for informational purposes.

It is **not a substitute for professional legal, financial, medical, tax, or other professional advice**.

For high-stakes documents, users should verify important information with the relevant organization or a qualified professional.

---

## 📄 License

License information will be added as the project develops.
