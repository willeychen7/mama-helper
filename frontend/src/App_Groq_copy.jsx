import os
import json
import io
import re
import base64
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from groq import Groq
from PIL import Image, ImageOps

app = FastAPI(title="Mama Helper - Groq Vision Backend")

# 启用跨域 CORS，支持移动端和前端网页调用
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ==========================================
# 1. 结构化 Prompt（适配 Groq 视觉模型）
# ==========================================
GROQ_VISION_PROMPT = """
You are a Computer Vision engine for OCR/spatial extraction and a warm, empathetic community assistant helping elderly Chinese-Americans understand mail. Read the letter image and output ONLY a valid JSON object without markdown fences if possible, or just standard JSON.

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
  "legal_disclaimer": boolean,
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
    return {"message": "Mama Helper Groq Backend Ready!"}

# ==========================================
# 2. 核心路由 - 拍照识信
# ==========================================
@app.post("/api/analyze-letter")
async def analyze_letter(file: UploadFile = File(...)):
    groq_key = os.getenv("GROQ_API_KEY")
    if not groq_key:
        raise HTTPException(status_code=500, detail="未检测到 GROQ_API_KEY")

    try:
        # 1. 读取上传的信件图片并用 PIL 载入
        image_bytes = await file.read()
        image = Image.open(io.BytesIO(image_bytes))

        # 🛡️ 核心修复 1：自动校正手机拍照产生的 EXIF 旋转，确保坐标系与前端渲染完全一致
        image = ImageOps.exif_transpose(image)

        # 🛡️ 核心修复 2：等比例缩放图片（限制最大边长在 1280 像素以内，大幅减少体积，防止超时）
        image.thumbnail((1280, 1280))
        if image.mode in ("RGBA", "P"):
            image = image.convert("RGB")

        # 将 PIL Image 转换为 Base64 格式供 Groq 视觉 API 调用
        buffered = io.BytesIO()
        image.save(buffered, format="JPEG")
        img_base64 = base64.b64encode(buffered.getvalue()).decode("utf-8")
        image_url = f"data:image/jpeg;base64,{img_base64}"

    except Exception as e:
        raise HTTPException(status_code=400, detail=f"图片读取失败，请确保格式正确: {str(e)}")


    # 2. 调用 Groq Vision 模型 (qwen/qwen3.6-27b)
    text_response = ""
    try:
        client = Groq(api_key=groq_key)
        completion = client.chat.completions.create(
            model="qwen/qwen3.6-27b",  # Groq 官方支持视觉与 JSON 模式的模型
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": GROQ_VISION_PROMPT},
                        {
                            "type": "image_url",
                            "image_url": {"url": image_url}
                        }
                    ]
                }
            ],
            response_format={"type": "json_object"},
            reasoning_effort="none", # 👈 关键：关闭思考链，防止干扰 JSON 校验
            temperature=0.1
        )
        
        # 提取并解析 JSON
        text_response = completion.choices[0].message.content.strip()

        
        # 🛡️ 核心修复：防止模型偶尔吐出带 ```json 或前后有多余文字的脏数据导致崩塌
        if text_response.startswith("```"):
            text_response = re.sub(r"^```(?:json)?\s*", "", text_response)
            text_response = re.sub(r"\s*```$", "", text_response)

        groq_result = json.loads(text_response)

    except json.JSONDecodeError as je:
        # 如果模型返回的不是标准 JSON，这里进行优雅降级，而不是直接抛出 500 崩溃
        print(f"JSON 解析失败，原始返回内容: {text_response if 'text_response' in locals() else '无内容'}")
        groq_result = {
            "is_readable": False,
            "unclear_reason_cn": "信件内容识别失败，大模型未能返回正确的数据结构。"
        } 

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Groq 智能识信失败: {str(e)}")
        
    # 3. 如果信件不可读，直接返回统一格式的不可读提示
    if not groq_result.get("is_readable", True):
        unclear_data = {
            **groq_result,
            "summary_cn": "照片太模糊或没拍全，小助手看不清。",
            "action_cn": "请找一个光线亮堂的地方，把信件平铺，再重新拍一张照片给小助手看看吧。",
            "risk_reason_cn": "看不清信件可能导致漏掉重要的缴费或政府通知，影响您的生活。"
        }
        return {"success": True, "data": unclear_data}

    # 4. 对返回字段进行智能兜底，确保万无一失
    unified_letter_data = {
        "is_readable": groq_result.get("is_readable", True),
        "unclear_reason_cn": groq_result.get("unclear_reason_cn"),
        "document_type": groq_result.get("document_type", "Unknown"),
        "sender": groq_result.get("sender", "Unknown"),
        "sender_box": groq_result.get("sender_box"),
        "mail_date": groq_result.get("mail_date", "Unknown"),
        "mail_date_box": groq_result.get("mail_date_box"),
        "is_action_required": groq_result.get("is_action_required", False),
        "amount": groq_result.get("amount"),
        "amount_box": groq_result.get("amount_box"),
        "due_date": groq_result.get("due_date"),
        "due_date_box": groq_result.get("due_date_box"),
        "raw_text_summary": groq_result.get("raw_text_summary"),
        "legal_disclaimer": groq_result.get("legal_disclaimer", False),
        
        # 中文白话解读字段（由 Groq 直接生成）
        "summary_cn": groq_result.get("summary_cn", "暂无中文概述"),
        "action_cn": groq_result.get("action_cn", "暂无行动建议"),
        "risk_reason_cn": groq_result.get("risk_reason_cn", "暂无风险提示")
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
    groq_key = os.getenv("GROQ_API_KEY")
    if not groq_key:
        raise HTTPException(status_code=500, detail="未检测到 GROQ_API_KEY")
    
    try:
        client = Groq(api_key=groq_key)
        context_str = json.dumps(req.letter_context, ensure_ascii=False)
        
        prompt = f"""你是一位极其耐心、温暖的在美华裔老人社区生活助手。用户针对刚刚解读的信件提出了追问，请用极其通俗、口语化的中文回答，简练亲切，不要用生硬的法律或金融专业术语。

信件背景信息：{context_str}

老人的追问是：{req.user_question}"""

        completion = client.chat.completions.create(
            model="qwen/qwen3.6-27b",
            messages=[{"role": "user", "content": prompt}],
            temperature=0.3
        )
        
        answer = completion.choices[0].message.content.strip()
        return {"answer": answer}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"追问处理失败: {str(e)}")