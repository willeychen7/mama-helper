/**
 * utils/secondPassOcr.js
 *
 * P1-B（决定 12）：对 suspiciousGlue.js 标出来的可疑行，裁切 bbox、放大、
 * 预处理，重跑一次 OCR，把结果记录成 candidate——不覆盖原始识别结果。
 *
 * 这个文件分两层，边界是故意划开的：
 *
 *   像素层（cropCanvas / upscaleCanvas / buildPreprocessVariants）
 *     真的操作 canvas 像素，依赖浏览器 document/Canvas API。
 *     这一层在 Node 沙箱里跑不了，只能在浏览器里验证。
 *
 *   编排层（runSecondPassOnLine / compareCandidates）
 *     不关心 crop 出来的图是谁给的、OCR 引擎具体是谁——两者都是注入的
 *     依赖，可以用 mock 在 Node 里测编排逻辑对不对（P1-B 能在沙箱里
 *     验证的就是这一层），也可以在浏览器里换成真实的 canvas 裁切函数
 *     和真实的 PaddleOCR engine（P1-C，见文件末尾"如何在浏览器里接真实
 *     引擎"）。
 *
 * 只产出 candidate，不自动选 winner——比较结果全部原样保留，
 * 由后续规则或人工决定要不要采信。
 */


// ============================================================
// 像素层 —— 需要浏览器 Canvas API，Node 沙箱里不会被调用到
// ============================================================

/**
 * 从原图 canvas 按 bbox 裁切出一块，四周留一点 padding。
 * @param {HTMLCanvasElement|OffscreenCanvas} sourceCanvas
 * @param {{left:number, top:number, right:number, bottom:number}} bbox
 * @param {number} paddingRatio  相对 bbox 高度的留边比例，默认 0.4
 */
export function cropCanvas(sourceCanvas, bbox, paddingRatio = 0.4) {
  if (typeof document === 'undefined') {
    throw new Error('cropCanvas 需要浏览器 Canvas API，这个环境里不可用');
  }

  const height = bbox.bottom - bbox.top;
  const pad = Math.max(2, Math.round(height * paddingRatio));

  const left = Math.max(0, Math.floor(bbox.left - pad));
  const top = Math.max(0, Math.floor(bbox.top - pad));
  const right = Math.min(sourceCanvas.width, Math.ceil(bbox.right + pad));
  const bottom = Math.min(sourceCanvas.height, Math.ceil(bbox.bottom + pad));

  const width = Math.max(1, right - left);
  const cropHeight = Math.max(1, bottom - top);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = cropHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(sourceCanvas, left, top, width, cropHeight, 0, 0, width, cropHeight);

  return { canvas, cropBox: { left, top, right, bottom } };
}

/**
 * 把 canvas 放大 factor 倍（最近邻，保留边缘锐利，比双线性更适合小字放大）。
 */
export function upscaleCanvas(canvas, factor) {
  if (typeof document === 'undefined') {
    throw new Error('upscaleCanvas 需要浏览器 Canvas API，这个环境里不可用');
  }

  const out = document.createElement('canvas');
  out.width = Math.round(canvas.width * factor);
  out.height = Math.round(canvas.height * factor);
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(canvas, 0, 0, out.width, out.height);
  return out;
}

function toGrayscale(canvas) {
  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = img.data;
  for (let i = 0; i < data.length; i += 4) {
    const gray = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
    data[i] = gray;
    data[i + 1] = gray;
    data[i + 2] = gray;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

function stretchContrast(canvas) {
  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = img.data;

  let min = 255;
  let max = 0;
  for (let i = 0; i < data.length; i += 4) {
    const v = data[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = Math.max(1, max - min);

  for (let i = 0; i < data.length; i += 4) {
    const v = Math.min(255, Math.max(0, Math.round(((data[i] - min) * 255) / span)));
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/*
 * 第一轮实验刻意只做 4 组固定组合，不做灰度/对比度/放大倍数的全排列——
 * 排列组合一多，出了效果好的结果也不知道是哪个因素起的作用。
 * 先看这 4 组有没有明显信号，再决定要不要细分。
 */
export const VARIANTS = [
  { id: 'A_original_crop', upscale: 1, grayscale: false, contrast: false },
  { id: 'B_upscale2x', upscale: 2, grayscale: false, contrast: false },
  { id: 'C_upscale3x_gray', upscale: 3, grayscale: true, contrast: false },
  { id: 'D_upscale3x_contrast', upscale: 3, grayscale: false, contrast: true }
];

/**
 * 对一份裁切好的 canvas，按 VARIANTS 生成预处理后的候选图。
 * 返回 [{ variantId, canvas }]。
 */
export function buildPreprocessVariants(croppedCanvas, variants = VARIANTS) {
  return variants.map((v) => {
    let canvas = croppedCanvas;
    if (v.upscale > 1) canvas = upscaleCanvas(canvas, v.upscale);
    // 放大用的是新 canvas，灰度/对比度在放大后的副本上做，不动原始裁切图
    if (v.grayscale) canvas = toGrayscale(canvas);
    if (v.contrast) canvas = stretchContrast(canvas);
    return { variantId: v.id, canvas };
  });
}


// ============================================================
// 编排层 —— 引擎和裁切都是注入的依赖，可以在 Node 里用 mock 测试
// ============================================================

/**
 * @param {object} params
 *   line              原始 OCR 行 {text, confidence, left, top, right, bottom}
 *   trigger           suspiciousGlue 的判定结果 {score, reasons}
 *   cropAndPreprocess (bbox) => Promise<[{variantId, blob}]>
 *                     —— 生产环境里这个函数内部会调用上面的
 *                        cropCanvas/upscaleCanvas/buildPreprocessVariants，
 *                        再 canvas.toBlob() 转成 engine.predict() 要的格式；
 *                        测试里替换成一个直接返回固定 variant 列表的 stub，
 *                        跳过真实像素操作。
 *   engine            { predict(blob, opts) => Promise<{items: [...]}> }
 *                     —— 生产环境传 App.jsx 里 getOCREngine() 返回的真实
 *                        PaddleOCR 引擎；测试里传一个 mock。
 *   engineMode        'REAL' | 'MOCK' —— 只用来打标签、写进日志，
 *                     不影响任何判定逻辑，防止事后把两种结果混在一起看。
 * @returns {Promise<object>} 结构化的完整记录（原图信息 + trigger + 每个
 *          variant 的 retry 结果 + comparison），不做任何"自动采用"的判断。
 */
export async function runSecondPassOnLine({ documentName, line, trigger, cropAndPreprocess, engine, engineMode }) {
  const bbox = { left: line.left, top: line.top, right: line.right, bottom: line.bottom };

  const variants = await cropAndPreprocess(bbox);

  const retries = [];
  for (const variant of variants) {
    const result = await engine.predict(variant.blob, {});
    const items = Array.isArray(result?.items) ? result.items : [];

    // 一个裁切区域理论上应该只识别出一段文字；多段就拼起来，仍然如实记录，
    // 不悄悄丢弃——如果 retry 把一个名字拆成了三段，这本身就是有用信息。
    const text = items.map((it) => it.text).join(' ').trim();
    /*
     * engine.predict() 返回的 score 是 PaddleOCR-js 原始的 0-1 区间
     * （跟 App.jsx 的 extractPaddleOCRStructure 里 `score * 100` 转换前
     * 是同一个东西），而这里要拿去跟 line.confidence 比较——那个字段
     * 存的是已经乘过 100 的 0-100 区间（比如 demo_ocr_pp.json 里的
     * 99.94）。两边不统一单位的话，compareCandidates 会把"其实差不多"
     * 误判成"candidate confidence 低了 99 个点"，这个坑第一版就踩过。
     */
    const confidence = items.length
      ? (items.reduce((sum, it) => sum + (typeof it.score === 'number' ? it.score : 0), 0) / items.length) * 100
      : null;

    retries.push({
      variantId: variant.variantId,
      engineMode: engineMode || 'UNKNOWN',
      text,
      confidence,
      comparison: compareCandidates(
        { text: line.text, confidence: line.confidence },
        { text, confidence }
      )
    });
  }

  return {
    document: documentName,
    lineIndex: line.index != null ? line.index : null,
    original: {
      text: line.text,
      confidence: line.confidence,
      bbox
    },
    trigger,
    retries
  };
}

/**
 * 纯比较逻辑，不判定谁"更好"、不选 winner。
 * @param {{text: string, confidence: number|null}} original
 * @param {{text: string, confidence: number|null}} candidate
 * @returns {{
 *   original_text, candidate_text, original_confidence, candidate_confidence,
 *   changed: boolean, change_type: string, reasons: string[]
 * }}
 */
export function compareCandidates(original, candidate) {
  const originalText = String(original?.text || '');
  const candidateText = String(candidate?.text || '');

  const normalize = (t) => t.replace(/\s+/g, '').toUpperCase();
  const changed = normalize(originalText) !== normalize(candidateText) || originalText !== candidateText;

  let changeType = 'no_change';
  const reasons = [];

  if (!changed) {
    changeType = 'no_change';
  } else if (normalize(originalText) === normalize(candidateText)) {
    // 去掉空格后字符完全一样 -> 只是空白差异
    changeType = candidateText.length > originalText.length ? 'added_space' : 'removed_space';
    reasons.push('去掉空白后字符序列一致，差异只在空白处');
  } else if (originalText.length !== candidateText.length) {
    changeType = candidateText.length > originalText.length ? 'added_char' : 'removed_char';
    reasons.push('字符数量不同，可能是识别出了/漏掉了字符，不只是空白差异');
  } else {
    changeType = 'different_chars';
    reasons.push('字符数量相同但内容不同，可能是误读，不是简单的重新分词');
  }

  if (
    typeof original?.confidence === 'number' &&
    typeof candidate?.confidence === 'number' &&
    candidate.confidence < original.confidence
  ) {
    reasons.push('候选结果 confidence 比原始识别更低');
  }

  return {
    original_text: originalText,
    candidate_text: candidateText,
    original_confidence: typeof original?.confidence === 'number' ? original.confidence : null,
    candidate_confidence: typeof candidate?.confidence === 'number' ? candidate.confidence : null,
    changed,
    change_type: changeType,
    reasons
  };
}

/*
 * ============================================================
 * 如何在浏览器里接真实引擎（P1-C，本地跑）
 * ============================================================
 *
 * 1. cropAndPreprocess 的真实实现：
 *
 *    const cropAndPreprocess = async (bbox) => {
 *      const { canvas: cropped } = cropCanvas(sourceCanvas, bbox);
 *      const variants = buildPreprocessVariants(cropped);
 *      return Promise.all(variants.map(async (v) => ({
 *        variantId: v.variantId,
 *        blob: await new Promise((resolve) => v.canvas.toBlob(resolve, 'image/png'))
 *      })));
 *    };
 *
 *    sourceCanvas 是原始信件那张 canvas（跟 App.jsx 里喂给 PaddleOCR 的
 *    ocrBlob 几何坐标一致的那张，比如 processImagePrivacy 返回的
 *    ocrBlob 画到 canvas 上）。
 *
 * 2. engine 的真实实现：直接用 App.jsx 里 getOCREngine() 返回的对象，
 *    它已经有 .predict(blob, opts) 方法，接口跟这里假设的完全一致。
 *
 * 3. 调用：
 *
 *    const engine = await getOCREngine();
 *    const result = await runSecondPassOnLine({
 *      documentName: 'my_letter',
 *      line: suspiciousLine,
 *      trigger: detectSuspiciousGlue(suspiciousLine, ctx),
 *      cropAndPreprocess,
 *      engine,
 *      engineMode: 'REAL'
 *    });
 *
 * 4. 把 result 存下来（比如 console.log(JSON.stringify(result)) 复制出来，
 *    或者写个小按钮存成文件下载）——这就是 P1-C 要收集的真实数据，
 *    跟这个仓库里已经生成的 MOCK 数据放在一起对比时，务必保留
 *    engineMode 字段，不要混着看。
 */
