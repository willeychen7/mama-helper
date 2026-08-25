# Mama Helper 👵📬

**Mama Helper（爸妈帮手）** is an AI-powered web app designed to help Chinese-speaking seniors in the United States understand English letters, bills, and important documents.

> **看不懂美国的信？拍一下就知道。**

Users can take a photo of an American letter or upload an existing image. Mama Helper analyzes the document and explains the important information in Simplified Chinese, including whether action is required, deadlines, amounts, recommended actions, and potential risks.

## ✨ Features

* 📷 **Take a photo or upload a document**
* 🤖 **AI-powered document analysis**
* 🇨🇳 **Simplified Chinese explanations**
* 🔴 **Identify whether action is required**
* 💰 **Extract important amounts**
* 📅 **Identify due dates**
* ⚠️ **Highlight potential risks**
* 💬 **Ask follow-up questions about the document**
* 🔒 **API keys are stored locally through environment variables**

## 🎯 Target Users

Mama Helper is designed primarily for Chinese-speaking users in the United States who may have difficulty understanding English government letters, bills, medical documents, insurance notices, bank correspondence, HOA notices, and other important mail.

## 🧩 How It Works

```text
Take Photo / Upload Image
          ↓
       Frontend
          ↓
      Backend API
          ↓
      AI Analysis
          ↓
 Structured Information
          ↓
 Simplified Chinese Explanation
```

The application processes the uploaded document and returns structured information such as:

* Document type
* Sender
* Whether action is required
* Importance
* Amount
* Due date
* Summary
* Recommended action
* Risk level
* Risk explanation
* AI confidence

## 🏗️ Project Structure

```text
mama-helper/
│
├── backend/
│   ├── main.py
│   └── main_gemini_prompt.py
│
├── frontend/
│   ├── src/
│   │   ├── App.jsx
│   │   ├── App.css
│   │   ├── index.css
│   │   ├── main.jsx
│   │   └── utils/
│   │       └── redactor.js
│   │
│   ├── public/
│   ├── package.json
│   └── vite.config.js
│
├── demo_image/
│   ├── SCE_Bill_Letter.png
│   ├── SCE_Letter.png
│   ├── hoag-invoice-mychart.png
│   ├── statefarm_bill.webp
│   └── water_bill.avif
│
├── .gitignore
├── package.json
└── package-lock.json
```

## 🛠️ Tech Stack

### Frontend

* React
* Vite
* JavaScript / JSX
* CSS
* Lucide React

### Backend

* Python
* FastAPI
* Uvicorn

### AI

The backend supports AI-powered document analysis through API-based AI models.

API credentials are provided through environment variables and are **not stored in the repository**.

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

Create a local `.env` file inside the `backend` directory:

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

## 🔐 Security

This project uses environment variables for API credentials.

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

## 📌 Current Status

Mama Helper is currently an early-stage prototype.

The current focus is validating:

1. Document image upload
2. AI document understanding
3. Structured information extraction
4. Simplified Chinese explanations
5. Follow-up questions
6. Processing speed and reliability
7. Usability for older Chinese-speaking users

## 🗺️ Future Improvements

Potential future improvements include:

* Better OCR and document preprocessing
* Support for more document types
* Improved deadline and amount extraction
* More reliable document classification
* User document history
* Privacy-focused document storage
* Knowledge-base support for common U.S. government documents
* Improved accessibility for seniors
* Production deployment

## ⚠️ Disclaimer

Mama Helper provides AI-generated explanations to help users understand documents.

It is **not a substitute for professional legal, financial, medical, or tax advice**.

For legal, medical, financial, or other high-stakes documents, users should verify important information with the relevant organization or a qualified professional.

## 📄 License

License information will be added as the project develops.
