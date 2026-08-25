import os
import json
import io
import re
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from google import genai
from google.genai import types
from PIL import Image, ImageOps

app = FastAPI(title="Mama Helper - Gemini Model Backend")

# 启用跨域 CORS，支持移动端和前端网页调用
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ==========================================
# 1. Gemini 全能 Prompt：图文感知、2D 坐标定位 + 温馨大白话解读
# ==========================================
GEMINI_PROMPT = """ You are a Computer Vision engine for OCR and spatial extraction. Read the letter image and output ONLY valid JSON.

Tasks:
1. Assess image readability (is_readable). If false, give reason in unclear_reason_cn.
2. Extract text information: document_type, sender, mail_date, amount, due_date, legal_disclaimer.
3. Locate normalized 2D coordinates [top, left, bottom, right] (floats 0.0-1.0) for:
    *  "amount_box"
    *  "due_date_box"
    *  "sender_box"
    *  "mail_date_box"
4. Generate warm, extremely easy-to-understand Chinese plain-language explanations (6th-grade reading level):
    *  "summary_cn": 用 2 句话总结这封信是干嘛的。
    *  "action_cn": 明确告知老人第一步具体要怎么做（如：找子女帮忙写支票/打客服电话/无需理会）。
    *  "risk_reason_cn": 如果不处理会发生什么后果。

JSON Schema: 
{ 
  "is_readable": boolean, 
  "unclear_reason_cn": "string or null", 
  "document_type": "Bill | Government_Notice | Court_Legal | Medical | Marketing | Other | Unknown", 
  "sender": "string or Unknown", 
  "sender_box": [top, left, bottom, right] or null, 
  "mail_date": "YYYY-MM-DD or Unknown", 
  "mail_date_box": [top, left, bottom, right] or null, 
  "is_action_required": boolean, 
  "amount": number or null, 
  "amount_box": [top, left, bottom, right] or null, 
  "due_date": "YYYY-MM-DD or Unknown", 
  "due_date_box": [top, left, bottom, right] or null, 
  "raw_text_summary": "Extract 2-3 main raw sentences from the letter in English", 
  "legal_disclaimer": boolean，
  "summary_cn": "中文大意", 
  "action_cn": "第一步行动建议", 
  "risk_reason_cn": "风险提示" 
} """

# 追问请求的模型
class QuestionRequest(BaseModel):
    letter_context: dict
    user_question: str

# 根路由
@app.get("/")
def read_root():
    return {"message": "Mama Helper Pure Gemini Backend Ready!"}

# ==========================================
# 2. 核心路由 - 拍照识信
# ==========================================
@app.post("/api/analyze-letter")
async def analyze_letter(file: UploadFile = File(...)):
    gemini_key = os.getenv("GEMINI_API_KEY")
    if not gemini_key:
        raise HTTPException(status_code=500, detail="未检测到 GEMINI_API_KEY")

    try:
        # 1. 读取上传的信件图片并用 PIL 载入
        image_bytes = await file.read()
        image = Image.open(io.BytesIO(image_bytes))

        # 🛡️ 核心修复：自动校正手机拍照产生的 EXIF 旋转，确保坐标系与前端渲染完全一致
        image = ImageOps.exif_transpose(image)

    except Exception as e:
        raise HTTPException(status_code=400, detail=f"图片读取失败，请确保格式正确: {str(e)}")

    # 2. 调用 Gemini-3.6-Flash 进行 OCR 识别及关键信息 2D 坐标定位
    try:
        client = genai.Client(api_key=gemini_key)
        response = client.models.generate_content(
            model="gemini-3.6-flash",
            contents=[image, GEMINI_PROMPT],
            config=types.GenerateContentConfig(response_mime_type="application/json")
        )
        
        # 提取并解析 JSON
        text_response = response.text.strip()
        if "```" in text_response:
            text_response = re.sub(r"```[a-zA-Z]*\n?", "", text_response).strip()
            text_response = text_response.replace("```", "").strip()
            
        gemini_result = json.loads(text_response)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Gemini 图文定位失败: {str(e)}")

    # 3. 如果信件不可读，直接返回统一格式的不可读提示
    if not gemini_result.get("is_readable", True):
        unclear_data = {
            **gemini_result,
            "summary_cn": "照片太模糊或没拍全，小助手看不清。",
            "action_cn": "请找一个光线亮堂的地方，把信件平铺，再重新拍一张照片给小助手看看吧。",
            "risk_reason_cn": "看不清信件可能导致漏掉重要的缴费或政府通知，影响您的生活。"
        }
        return {"success": True, "data": unclear_data}

    # 4. 对返回字段进行智能兜底，确保万无一失
    unified_letter_data = {
        "is_readable": gemini_result.get("is_readable", True),
        "unclear_reason_cn": gemini_result.get("unclear_reason_cn"),
        "document_type": gemini_result.get("document_type", "Unknown"),
        "sender": gemini_result.get("sender", "Unknown"),
        "sender_box": gemini_result.get("sender_box"),
        "mail_date": gemini_result.get("mail_date", "Unknown"),
        "mail_date_box": gemini_result.get("mail_date_box"),
        "is_action_required": gemini_result.get("is_action_required", False),
        "amount": gemini_result.get("amount"),
        "amount_box": gemini_result.get("amount_box"),
        "due_date": gemini_result.get("due_date"),
        "due_date_box": gemini_result.get("due_date_box"),
        "raw_text_summary": gemini_result.get("raw_text_summary"),
        "legal_disclaimer": gemini_result.get("legal_disclaimer", False),
        
        # 中文白话解读字段（由 Gemini 直接生成）
        "summary_cn": gemini_result.get("summary_cn", "暂无中文概述"),
        "action_cn": gemini_result.get("action_cn", "暂无行动建议"),
        "risk_reason_cn": gemini_result.get("risk_reason_cn", "暂无风险提示")
    }
    
    # 5. 严格返回符合前端 resData.data 契约的统一格式
    return {
        "success": True,
        "data": unified_letter_data
    }

# ==========================================
# 4. 预留接口：老人语音追问（仅作 Version 2 预留，不实现具体调用）
# ==========================================
@app.post("/api/ask-question")
async def ask_question(req: QuestionRequest):
    gemini_key = os.getenv("GEMINI_API_KEY")
    if not gemini_key:
        raise HTTPException(status_code=500, detail="未检测到 GEMINI_API_KEY")
    
    try:
        client = genai.Client(api_key=gemini_key)
        context_str = json.dumps(req.letter_context, ensure_ascii=False)
        
        prompt = f"""你是一位极其耐心、温暖的在美华裔老人社区生活助手。用户针对刚刚解读的信件提出了追问，请用极其通俗、口语化的中文回答，简练亲切，不要用生硬的法律或金融专业术语。

信件背景信息：{context_str}

老人的追问是：{req.user_question}"""

        response = client.models.generate_content(
            model="gemini-3.6-flash",
            contents=[prompt],
        )
        
        answer = response.text.strip()
        return {"answer": answer}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"追问处理失败: {str(e)}")