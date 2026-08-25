import os
import json
import io
import re
import base64
from typing import Any

from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from groq import Groq
from PIL import Image, ImageOps


# =========================================================
# App
# =========================================================

app = FastAPI(title="Mama Helper - Privacy-Aware Groq Vision Backend")


# =========================================================
# CORS
# =========================================================
# 开发阶段可以使用 *。
# 正式上线后建议改成你的真实前端域名，例如：
# allow_origins=["https://your-domain.com"]
# =========================================================

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# =========================================================
# 隐私 / 上传安全配置
# =========================================================

MAX_FILE_SIZE = 10 * 1024 * 1024  # 10MB

ALLOWED_CONTENT_TYPES = {
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/webp",
}


# =========================================================
# PII 脱敏工具
#
# 注意：
# 这一层处理的是：
# 1. AI 返回的文字
# 2. 追问接口传入的上下文
#
# 它不能阻止 Groq Vision 在分析阶段看到原始图片。
# 真正的“图片发送前脱敏”需要 OCR + 坐标定位 + 图片打码。
# =========================================================

def mask_sensitive_text(text: Any) -> Any:
    """
    对文本中的常见敏感信息进行基础脱敏。

    注意：
    这是第二层保护。
    不应该依赖 regex 作为唯一 PII 保护方案。
    """

    if not isinstance(text, str):
        return text

    result = text

    # -----------------------------
    # SSN
    # 123-45-6789
    # 123 45 6789
    # -----------------------------
    result = re.sub(
        r"\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b",
        "[已隐藏SSN]",
        result
    )

    # -----------------------------
    # Email
    # -----------------------------
    result = re.sub(
        r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b",
        "[已隐藏邮箱]",
        result
    )

    # -----------------------------
    # 美国电话号码
    # 949-123-4567
    # (949) 123-4567
    # +1 949 123 4567
    # -----------------------------
    result = re.sub(
        r"(?:\+?1[-.\s]?)?"
        r"(?:\(?\d{3}\)?[-.\s]?)"
        r"\d{3}[-.\s]?\d{4}",
        "[已隐藏电话]",
        result
    )

    # -----------------------------
    # 信用卡号
    # 16 位数字，允许空格或 -
    # -----------------------------
    result = re.sub(
        r"\b(?:\d[ -]*?){13,16}\b",
        "[已隐藏银行卡号]",
        result
    )

    return result


def sanitize_ai_text_fields(data: dict) -> dict:
    """
    对不需要暴露原始 PII 的 AI 文本字段进行二次清理。

    金额和截止日期等业务关键信息不会在这里被处理。
    """

    fields_to_mask = [
        "raw_text_summary",
        "summary_cn",
        "action_cn",
        "risk_reason_cn",
        "unclear_reason_cn",
    ]

    for field in fields_to_mask:
        if field in data and isinstance(data[field], str):
            data[field] = mask_sensitive_text(data[field])

    return data


def sanitize_letter_context(context: dict) -> dict:
    """
    用于 /api/ask-question。

    不把明显不需要的 PII 字段继续传给模型。
    """

    if not isinstance(context, dict):
        return {}

    safe_context = {}

    # 明确允许继续传递给 AI 的字段
    allowed_fields = [
        "is_readable",
        "unclear_reason_cn",
        "document_type",
        "sender",
        "mail_date",
        "is_action_required",
        "amount",
        "due_date",
        "raw_text_summary",
        "legal_disclaimer",
        "summary_cn",
        "action_cn",
        "risk_reason_cn",
    ]

    for key in allowed_fields:
        if key in context:
            value = context[key]

            if isinstance(value, str):
                value = mask_sensitive_text(value)

            safe_context[key] = value

    return safe_context


# =========================================================
# Prompt
# =========================================================

GROQ_VISION_PROMPT = """
You are a Computer Vision engine for OCR/spatial extraction and a warm,
empathetic community assistant helping elderly Chinese-Americans understand mail.

Read the letter image and output ONLY a valid JSON object.

IMPORTANT PRIVACY RULES:

The original document may contain sensitive personal information.

Do NOT unnecessarily reproduce or return:
- Full Social Security Numbers
- Full bank account numbers
- Full credit card numbers
- Full insurance member IDs
- Full medical record numbers
- Full phone numbers
- Full email addresses
- Full home addresses
- Other unnecessary personal identifiers

If sensitive information appears in extracted text, replace it with a general
placeholder such as:
[已隐藏敏感信息]

You MAY return information necessary for understanding the letter, including:
- Organization or sender name
- Document type
- Amount due
- Due date
- Required action
- Important deadline
- General consequences of not taking action

Do not include a person's full name unless it is absolutely necessary for
understanding the document.

Tasks:

1. Assess image readability (is_readable).
   If false, give reason in unclear_reason_cn.

2. Identify only the information necessary to help the user understand the mail:
   - document_type
   - sender
   - mail_date
   - amount
   - due_date
   - legal_disclaimer

3. Locate normalized 2D coordinates [top, left, bottom, right]
   with floats from 0.0 to 1.0 for:
   - amount_box
   - due_date_box
   - sender_box
   - mail_date_box

4. Generate warm, extremely easy-to-understand Chinese explanations
   suitable for elderly users:

   - summary_cn:
     用 1-2 句话告诉老人这封信是做什么的。

   - action_cn:
     明确告诉老人第一步应该做什么。
     如果不需要处理，要明确说“暂时不需要做什么”。

   - risk_reason_cn:
     简单说明如果不处理可能发生什么。

5. raw_text_summary:
   Extract only 1-3 important English sentences or short fragments needed
   to understand the letter.

   Do NOT copy unnecessary personal information.
   Replace sensitive information with [已隐藏敏感信息].

6. If this is a legal or court-related document:
   Do NOT provide legal advice.
   Only explain what the document appears to be, mention deadlines,
   and suggest contacting a qualified attorney, legal aid organization,
   court clerk, or trusted family member when appropriate.

JSON Schema:

{
  "is_readable": boolean,
  "unclear_reason_cn": "string or null",

  "document_type":
    "Bill | Government_Notice | Court_Legal | Medical | Marketing | Other | Unknown",

  "sender": "string or Unknown",
  "sender_box": [top, left, bottom, right] or null,

  "mail_date": "YYYY-MM-DD or Unknown",
  "mail_date_box": [top, left, bottom, right] or null,

  "is_action_required": boolean,

  "amount": number or null,
  "amount_box": [top, left, bottom, right] or null,

  "due_date": "YYYY-MM-DD or Unknown",
  "due_date_box": [top, left, bottom, right] or null,

  "raw_text_summary": "1-3 important English sentences or fragments with unnecessary PII removed",

  "legal_disclaimer": boolean,

  "summary_cn": "中文大意",
  "action_cn": "第一步行动建议",
  "risk_reason_cn": "风险提示"
}
"""


# =========================================================
# Request Models
# =========================================================

class QuestionRequest(BaseModel):
    letter_context: dict
    user_question: str


# =========================================================
# Helper
# =========================================================

def clean_json_response(text: str) -> str:
    """
    清理模型偶尔返回的 ```json markdown fence。
    """

    if not text:
        return ""

    text = text.strip()

    if text.startswith("```"):
        text = re.sub(
            r"^```(?:json)?\s*",
            "",
            text,
            flags=re.IGNORECASE
        )

        text = re.sub(
            r"\s*```$",
            "",
            text
        )

    return text.strip()


# =========================================================
# Root
# =========================================================

@app.get("/")
def read_root():
    return {
        "message": "Mama Helper Privacy-Aware Groq Backend Ready!"
    }


# =========================================================
# 核心接口：拍照识信
# =========================================================

@app.post("/api/analyze-letter")
async def analyze_letter(file: UploadFile = File(...)):

    groq_key = os.getenv("GROQ_API_KEY")

    if not groq_key:
        raise HTTPException(
            status_code=500,
            detail="未检测到 GROQ_API_KEY"
        )

    # -----------------------------------------------------
    # 1. 检查文件类型
    # -----------------------------------------------------

    if file.content_type not in ALLOWED_CONTENT_TYPES:
        raise HTTPException(
            status_code=400,
            detail="暂时只支持 JPG、PNG 或 WEBP 图片"
        )

    image_bytes = None
    image = None
    buffered = None

    try:

        # -------------------------------------------------
        # 2. 读取图片
        #
        # 图片只存在当前请求内存中
        # 不保存到本地 uploads/
        # -------------------------------------------------

        image_bytes = await file.read()

        # 文件大小限制
        if len(image_bytes) > MAX_FILE_SIZE:
            raise HTTPException(
                status_code=413,
                detail="图片太大，请上传 10MB 以内的图片"
            )

        if len(image_bytes) == 0:
            raise HTTPException(
                status_code=400,
                detail="没有读取到图片内容"
            )

        # -------------------------------------------------
        # 3. PIL 打开图片
        # -------------------------------------------------

        image = Image.open(io.BytesIO(image_bytes))

        # 防止异常图片文件
        image.verify()

        # verify() 后需要重新打开
        image = Image.open(io.BytesIO(image_bytes))

        # -------------------------------------------------
        # 4. 自动修正 EXIF 旋转
        # -------------------------------------------------

        image = ImageOps.exif_transpose(image)

        # -------------------------------------------------
        # 5. 限制图片尺寸
        #
        # 减少：
        # - 上传数据
        # - API payload
        # - token / latency
        # -------------------------------------------------

        image.thumbnail((1280, 1280))

        if image.mode in ("RGBA", "P", "LA"):
            image = image.convert("RGB")

        elif image.mode != "RGB":
            image = image.convert("RGB")

        # -------------------------------------------------
        # 6. 重新保存 JPEG
        #
        # 这一步不会保留原始 EXIF metadata。
        # -------------------------------------------------

        buffered = io.BytesIO()

        image.save(
            buffered,
            format="JPEG",
            quality=85,
            optimize=True
        )

        clean_image_bytes = buffered.getvalue()

        img_base64 = base64.b64encode(
            clean_image_bytes
        ).decode("utf-8")

        image_url = (
            f"data:image/jpeg;base64,{img_base64}"
        )

    except HTTPException:
        raise

    except Exception:
        # 不把具体图片内容、文件路径等信息暴露给用户
        raise HTTPException(
            status_code=400,
            detail="图片读取失败，请确保上传的是正常的图片文件"
        )

    finally:
        # 关闭上传文件
        await file.close()

        # 主动释放原始 bytes 引用
        image_bytes = None

    # -----------------------------------------------------
    # 7. 调用 Groq Vision
    # -----------------------------------------------------

    text_response = ""

    try:

        client = Groq(api_key=groq_key)

        completion = client.chat.completions.create(
            model="qwen/qwen3.6-27b",

            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": GROQ_VISION_PROMPT
                        },
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": image_url
                            }
                        }
                    ]
                }
            ],

            response_format={
                "type": "json_object"
            },

            reasoning_effort="none",

            temperature=0.1
        )

        text_response = (
            completion
            .choices[0]
            .message
            .content
            .strip()
        )

        text_response = clean_json_response(
            text_response
        )

        groq_result = json.loads(
            text_response
        )

    except json.JSONDecodeError:

        # ⚠️ 不打印完整模型返回
        # 因为返回内容可能包含用户信件中的 PII

        groq_result = {
            "is_readable": False,
            "unclear_reason_cn":
                "信件内容识别失败，请重新拍一张清楚的照片。"
        }

    except Exception as e:

        # ⚠️ 不把完整原始异常直接返回给用户
        # 生产环境也建议使用安全日志系统，
        # 不记录 image / base64 / 原始信件内容。

        raise HTTPException(
            status_code=500,
            detail="智能识信暂时失败，请稍后再试"
        )

    finally:

        # 主动断开对 Base64 / image URL 的引用
        image_url = None
        img_base64 = None
        clean_image_bytes = None
        buffered = None
        image = None

    # -----------------------------------------------------
    # 8. AI 返回结果二次 PII 清理
    # -----------------------------------------------------

    if isinstance(groq_result, dict):
        groq_result = sanitize_ai_text_fields(
            groq_result
        )

    # -----------------------------------------------------
    # 9. 不可读
    # -----------------------------------------------------

    if not groq_result.get("is_readable", True):

        unclear_data = {
            **groq_result,

            "summary_cn":
                "照片太模糊、太暗，或者信件没有拍完整，小助手现在看不清。",

            "action_cn":
                "请把信件平铺在光线充足的地方，完整拍进去，再重新上传。",

            "risk_reason_cn":
                "如果重要信件一直看不清，可能会错过缴费日期或政府通知。"
        }

        return {
            "success": True,
            "data": unclear_data
        }

    # -----------------------------------------------------
    # 10. 统一输出
    # -----------------------------------------------------

    unified_letter_data = {

        "is_readable":
            groq_result.get(
                "is_readable",
                True
            ),

        "unclear_reason_cn":
            groq_result.get(
                "unclear_reason_cn"
            ),

        "document_type":
            groq_result.get(
                "document_type",
                "Unknown"
            ),

        "sender":
            groq_result.get(
                "sender",
                "Unknown"
            ),

        "sender_box":
            groq_result.get(
                "sender_box"
            ),

        "mail_date":
            groq_result.get(
                "mail_date",
                "Unknown"
            ),

        "mail_date_box":
            groq_result.get(
                "mail_date_box"
            ),

        "is_action_required":
            groq_result.get(
                "is_action_required",
                False
            ),

        "amount":
            groq_result.get(
                "amount"
            ),

        "amount_box":
            groq_result.get(
                "amount_box"
            ),

        "due_date":
            groq_result.get(
                "due_date",
                "Unknown"
            ),

        "due_date_box":
            groq_result.get(
                "due_date_box"
            ),

        # 已经过 PII 清理
        "raw_text_summary":
            groq_result.get(
                "raw_text_summary"
            ),

        "legal_disclaimer":
            groq_result.get(
                "legal_disclaimer",
                False
            ),

        "summary_cn":
            groq_result.get(
                "summary_cn",
                "暂无中文概述"
            ),

        "action_cn":
            groq_result.get(
                "action_cn",
                "暂无行动建议"
            ),

        "risk_reason_cn":
            groq_result.get(
                "risk_reason_cn",
                "暂无风险提示"
            )
    }

    # 最后再统一清理一次文本字段
    unified_letter_data = sanitize_ai_text_fields(
        unified_letter_data
    )

    return {
        "success": True,
        "data": unified_letter_data
    }


# =========================================================
# Version 2：老人追问
# =========================================================

@app.post("/api/ask-question")
async def ask_question(
    req: QuestionRequest
):

    groq_key = os.getenv(
        "GROQ_API_KEY"
    )

    if not groq_key:
        raise HTTPException(
            status_code=500,
            detail="未检测到 GROQ_API_KEY"
        )

    try:

        client = Groq(
            api_key=groq_key
        )

        # -------------------------------------------------
        # 只传递经过白名单筛选的上下文
        #
        # 不直接：
        # json.dumps(req.letter_context)
        #
        # 因为前端未来可能加入姓名、地址、账号等字段
        # -------------------------------------------------

        safe_context = sanitize_letter_context(
            req.letter_context
        )

        context_str = json.dumps(
            safe_context,
            ensure_ascii=False
        )

        # 用户问题也做基础清理
        # 防止用户直接把 SSN / 电话等发进追问
        safe_question = mask_sensitive_text(
            req.user_question
        )

        prompt = f"""
你是一位极其耐心、温暖的在美华裔老人社区生活助手。

用户正在针对刚刚解读的一封美国信件提问。

请使用非常简单、口语化的中文回答，
避免复杂的法律、医疗或金融术语。

隐私规则：

- 不要猜测或生成用户的个人信息。
- 不要尝试恢复被隐藏的敏感信息。
- 不要要求用户提供 SSN、完整银行卡号或其他敏感身份信息。
- 如果用户的问题需要这些信息，请建议用户不要在聊天中发送。

法律相关：

如果涉及法院、诉讼或法律文件，
不要提供具体法律意见。
可以解释一般含义、提醒截止日期，
并建议联系律师、法律援助机构、
法院工作人员或可信赖的家人。

信件背景：

{context_str}

用户的问题：

{safe_question}
"""

        completion = (
            client
            .chat
            .completions
            .create(

                model="qwen/qwen3.6-27b",

                messages=[
                    {
                        "role": "user",
                        "content": prompt
                    }
                ],

                reasoning_effort="none",

                temperature=0.3
            )
        )

        answer = (
            completion
            .choices[0]
            .message
            .content
            .strip()
        )

        # 返回前再次脱敏
        answer = mask_sensitive_text(
            answer
        )

        return {
            "answer": answer
        }

    except Exception:

        # 不返回内部异常细节
        raise HTTPException(
            status_code=500,
            detail="追问处理失败，请稍后再试"
        )