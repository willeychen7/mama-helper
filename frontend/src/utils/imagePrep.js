/**
 * utils/imagePrep.js
 *
 * 纯浏览器端「文档图像预处理」。
 *
 * 目的：
 *   PaddleOCR 的 PP-StructureV3 里有一个 doc-preprocessor 模块
 *   （文档方向分类 + 文档矫正 unwarping），但 paddleocr-js 浏览器包
 *   只打包了 det + rec，没有这个模块。
 *   这个文件就是在浏览器里把最关键的那部分补回来。
 *
 * 设计原则：
 *   1. 不引入 OpenCV.js（避免主线程再多加载一份 12MB 的 wasm）
 *      —— 全部用 Canvas + TypedArray 手写，零新增下载体积。
 *   2. 原图绝不离开浏览器，这里所有运算都在本地内存里完成。
 *   3. 每一步都有「置信度闸门」：判断不可靠就跳过，
 *      宁可不处理，也不能把好照片改坏。
 *   4. 任何一步抛错都回退到「只缩放」的原始行为。
 *
 * 输出两张图：
 *   displayBlob —— 彩色，只做了几何矫正，给老人看的预览
 *   ocrBlob     —— 灰度 + 去阴影 + 对比度增强，喂给 PaddleOCR
 *   两张图几何一致，所以 OCR 返回的坐标可以直接画在预览上。
 */


// ============================================================
// 基础工具
// ============================================================

const clamp = (value, min, max) =>
  value < min ? min : value > max ? max : value;

const dist = (a, b) =>
  Math.hypot(a.x - b.x, a.y - b.y);

const makeCanvas = (width, height) => {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
};

const canvasToBlob = (canvas, type, quality) =>
  new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob
          ? resolve(blob)
          : reject(new Error('canvas.toBlob 返回空结果')),
      type,
      quality
    );
  });

const getContext = (canvas) => {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    throw new Error('无法创建 Canvas 2D 上下文');
  }
  return ctx;
};


// ============================================================
// 灰度 / 直方图 / 阈值
// ============================================================

const toGray = (imageData) => {
  const { data, width, height } = imageData;
  const gray = new Uint8ClampedArray(width * height);

  for (let p = 0, i = 0; p < gray.length; p += 1, i += 4) {
    gray[p] =
      (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0;
  }

  return gray;
};

const buildHistogram = (gray) => {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i += 1) {
    hist[gray[i]] += 1;
  }
  return hist;
};

/** Otsu 全局阈值 */
const otsuThreshold = (gray) => {
  const hist = buildHistogram(gray);
  const total = gray.length;

  let sum = 0;
  for (let t = 0; t < 256; t += 1) {
    sum += t * hist[t];
  }

  let sumB = 0;
  let wB = 0;
  let best = 0;
  let threshold = 127;

  for (let t = 0; t < 256; t += 1) {
    wB += hist[t];
    if (wB === 0) continue;

    const wF = total - wB;
    if (wF === 0) break;

    sumB += t * hist[t];

    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);

    if (between > best) {
      best = between;
      threshold = t;
    }
  }

  return threshold;
};

/** 从直方图取百分位 */
const percentileFromHist = (hist, total, ratio) => {
  const target = total * ratio;
  let acc = 0;
  for (let v = 0; v < 256; v += 1) {
    acc += hist[v];
    if (acc >= target) return v;
  }
  return 255;
};


// ============================================================
// 可分离盒式模糊（running sum，O(n) 与半径无关）
// ============================================================

const boxBlur = (src, width, height, radius) => {
  const win = radius * 2 + 1;
  const tmp = new Float32Array(width * height);
  const out = new Float32Array(width * height);

  // 横向
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    let sum = 0;

    for (let x = -radius; x <= radius; x += 1) {
      sum += src[row + clamp(x, 0, width - 1)];
    }

    for (let x = 0; x < width; x += 1) {
      tmp[row + x] = sum / win;
      sum -= src[row + clamp(x - radius, 0, width - 1)];
      sum += src[row + clamp(x + radius + 1, 0, width - 1)];
    }
  }

  // 纵向
  for (let x = 0; x < width; x += 1) {
    let sum = 0;

    for (let y = -radius; y <= radius; y += 1) {
      sum += tmp[clamp(y, 0, height - 1) * width + x];
    }

    for (let y = 0; y < height; y += 1) {
      out[y * width + x] = sum / win;
      sum -= tmp[clamp(y - radius, 0, height - 1) * width + x];
      sum += tmp[clamp(y + radius + 1, 0, height - 1) * width + x];
    }
  }

  return out;
};


// ============================================================
// 纸张四角检测
//
// 思路：
//   把图缩到 ~480px 做分析 → Otsu 分出「亮区」（纸）
//   → 取最大连通域 → 用 x+y / x-y 的极值点定位四角。
//   这对「桌面较暗、信纸较亮」的手机照片非常稳。
//   如果照片本身是扫描件（整幅都是纸），连通域会占满全画幅，
//   会被后面的闸门直接判为「不需要矫正」，这正是我们想要的。
// ============================================================

const largestBrightComponent = (gray, width, height, threshold) => {
  const total = width * height;
  const labels = new Int32Array(total).fill(-1);
  const stack = new Int32Array(total);

  let bestLabel = -1;
  let bestSize = 0;
  let label = 0;

  for (let start = 0; start < total; start += 1) {
    if (labels[start] !== -1 || gray[start] <= threshold) continue;

    let top = 0;
    let size = 0;

    stack[top] = start;
    top += 1;
    labels[start] = label;

    while (top > 0) {
      top -= 1;
      const idx = stack[top];
      size += 1;

      const x = idx % width;
      const y = (idx / width) | 0;

      // 4-邻接
      if (x > 0) {
        const n = idx - 1;
        if (labels[n] === -1 && gray[n] > threshold) {
          labels[n] = label;
          stack[top] = n;
          top += 1;
        }
      }
      if (x < width - 1) {
        const n = idx + 1;
        if (labels[n] === -1 && gray[n] > threshold) {
          labels[n] = label;
          stack[top] = n;
          top += 1;
        }
      }
      if (y > 0) {
        const n = idx - width;
        if (labels[n] === -1 && gray[n] > threshold) {
          labels[n] = label;
          stack[top] = n;
          top += 1;
        }
      }
      if (y < height - 1) {
        const n = idx + width;
        if (labels[n] === -1 && gray[n] > threshold) {
          labels[n] = label;
          stack[top] = n;
          top += 1;
        }
      }
    }

    if (size > bestSize) {
      bestSize = size;
      bestLabel = label;
    }

    label += 1;
  }

  return { labels, bestLabel, bestSize };
};

/** 从连通域像素里取四个角（TL, TR, BR, BL） */
const cornersFromComponent = (labels, bestLabel, width, height) => {
  let minSum = Infinity;
  let maxSum = -Infinity;
  let minDiff = Infinity;
  let maxDiff = -Infinity;

  let tl = null;
  let br = null;
  let tr = null;
  let bl = null;

  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      if (labels[row + x] !== bestLabel) continue;

      const sum = x + y;
      const diff = x - y;

      if (sum < minSum) {
        minSum = sum;
        tl = { x, y };
      }
      if (sum > maxSum) {
        maxSum = sum;
        br = { x, y };
      }
      if (diff > maxDiff) {
        maxDiff = diff;
        tr = { x, y };
      }
      if (diff < minDiff) {
        minDiff = diff;
        bl = { x, y };
      }
    }
  }

  if (!tl || !tr || !br || !bl) return null;
  return [tl, tr, br, bl];
};

const polygonArea = (quad) => {
  let area = 0;
  for (let i = 0; i < quad.length; i += 1) {
    const a = quad[i];
    const b = quad[(i + 1) % quad.length];
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) / 2;
};

const isConvex = (quad) => {
  let sign = 0;
  for (let i = 0; i < 4; i += 1) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    const c = quad[(i + 2) % 4];
    const cross =
      (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (cross === 0) continue;
    const current = cross > 0 ? 1 : -1;
    if (sign === 0) sign = current;
    else if (sign !== current) return false;
  }
  return true;
};

const cornerAngleDeg = (a, b, c) => {
  const v1x = a.x - b.x;
  const v1y = a.y - b.y;
  const v2x = c.x - b.x;
  const v2y = c.y - b.y;
  const dot = v1x * v2x + v1y * v2y;
  const mag = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y);
  if (mag === 0) return 0;
  return (Math.acos(clamp(dot / mag, -1, 1)) * 180) / Math.PI;
};

/**
 * 四边形合理性闸门。
 * 任何一条不满足就放弃透视矫正 —— 宁可不做，也不能做错。
 */
const validateQuad = (quad, width, height) => {
  const frameArea = width * height;
  const area = polygonArea(quad);
  const coverage = area / frameArea;

  // 太小 => 多半误检；太大 => 本来就是整幅纸，不需要矫正
  if (coverage < 0.18) return { ok: false, reason: 'too-small', coverage };
  if (coverage > 0.985) return { ok: false, reason: 'full-frame', coverage };

  const sides = [
    dist(quad[0], quad[1]),
    dist(quad[1], quad[2]),
    dist(quad[2], quad[3]),
    dist(quad[3], quad[0])
  ];

  if (Math.min(...sides) < 0.15 * Math.min(width, height)) {
    return { ok: false, reason: 'thin-side', coverage };
  }

  const widthRatio =
    Math.max(sides[0], sides[2]) / Math.max(1, Math.min(sides[0], sides[2]));
  const heightRatio =
    Math.max(sides[1], sides[3]) / Math.max(1, Math.min(sides[1], sides[3]));

  // 对边长度差太大 => 不像一张平铺的纸
  if (widthRatio > 1.9 || heightRatio > 1.9) {
    return { ok: false, reason: 'opposite-sides', coverage };
  }

  for (let i = 0; i < 4; i += 1) {
    const angle = cornerAngleDeg(
      quad[(i + 3) % 4],
      quad[i],
      quad[(i + 1) % 4]
    );
    if (angle < 55 || angle > 125) {
      return { ok: false, reason: 'corner-angle', coverage };
    }
  }

  if (!isConvex(quad)) {
    return { ok: false, reason: 'not-convex', coverage };
  }

  // 已经基本是正的矩形 => 矫正没意义，省掉一次重采样
  const maxDeviation = Math.max(
    Math.abs(quad[0].x - quad[3].x),
    Math.abs(quad[1].x - quad[2].x),
    Math.abs(quad[0].y - quad[1].y),
    Math.abs(quad[3].y - quad[2].y)
  );

  if (maxDeviation < 0.012 * Math.max(width, height) && coverage > 0.9) {
    return { ok: false, reason: 'already-flat', coverage };
  }

  return { ok: true, reason: 'accepted', coverage };
};


// ============================================================
// 透视变换（homography）
// ============================================================

/** 高斯消元解 n 元线性方程组 */
const solveLinearSystem = (matrix, vector, n) => {
  const a = matrix.map((row, i) => [...row, vector[i]]);

  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) {
        pivot = row;
      }
    }

    if (Math.abs(a[pivot][col]) < 1e-10) return null;

    const swap = a[col];
    a[col] = a[pivot];
    a[pivot] = swap;

    for (let row = 0; row < n; row += 1) {
      if (row === col) continue;
      const factor = a[row][col] / a[col][col];
      for (let k = col; k <= n; k += 1) {
        a[row][k] -= factor * a[col][k];
      }
    }
  }

  const result = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    result[i] = a[i][n] / a[i][i];
  }
  return result;
};

/**
 * 求「输出矩形 -> 源四边形」的逆映射矩阵。
 * 输出像素 (x, y) -> 源像素 (u, v)：
 *   u = (a x + b y + c) / (g x + h y + 1)
 *   v = (d x + e y + f) / (g x + h y + 1)
 */
const computeInverseHomography = (dstCorners, srcCorners) => {
  const matrix = [];
  const vector = [];

  for (let i = 0; i < 4; i += 1) {
    const { x, y } = dstCorners[i];
    const { x: u, y: v } = srcCorners[i];

    matrix.push([x, y, 1, 0, 0, 0, -x * u, -y * u]);
    vector.push(u);

    matrix.push([0, 0, 0, x, y, 1, -x * v, -y * v]);
    vector.push(v);
  }

  return solveLinearSystem(matrix, vector, 8);
};

/** 双线性采样的透视重采样 */
const warpPerspective = (sourceCanvas, srcQuad, outWidth, outHeight) => {
  const srcCtx = getContext(sourceCanvas);
  const srcData = srcCtx.getImageData(
    0,
    0,
    sourceCanvas.width,
    sourceCanvas.height
  );

  const sw = srcData.width;
  const sh = srcData.height;
  const src = srcData.data;

  const dstCorners = [
    { x: 0, y: 0 },
    { x: outWidth - 1, y: 0 },
    { x: outWidth - 1, y: outHeight - 1 },
    { x: 0, y: outHeight - 1 }
  ];

  const h = computeInverseHomography(dstCorners, srcQuad);
  if (!h) return null;

  const [a, b, c, d, e, f, g, hh] = h;

  const outCanvas = makeCanvas(outWidth, outHeight);
  const outCtx = getContext(outCanvas);
  const outData = outCtx.createImageData(outWidth, outHeight);
  const out = outData.data;

  for (let y = 0; y < outHeight; y += 1) {
    // 沿一行 x 递增，分子分母都是线性的，可以增量计算
    let nu = b * y + c;
    let nv = e * y + f;
    let den = hh * y + 1;

    let o = y * outWidth * 4;

    for (let x = 0; x < outWidth; x += 1) {
      const w = den === 0 ? 1e-9 : den;
      const u = nu / w;
      const v = nv / w;

      nu += a;
      nv += d;
      den += g;

      if (u < 0 || v < 0 || u > sw - 1 || v > sh - 1) {
        out[o] = 255;
        out[o + 1] = 255;
        out[o + 2] = 255;
        out[o + 3] = 255;
        o += 4;
        continue;
      }

      const x0 = u | 0;
      const y0 = v | 0;
      const x1 = x0 + 1 > sw - 1 ? sw - 1 : x0 + 1;
      const y1 = y0 + 1 > sh - 1 ? sh - 1 : y0 + 1;

      const fx = u - x0;
      const fy = v - y0;

      const i00 = (y0 * sw + x0) * 4;
      const i10 = (y0 * sw + x1) * 4;
      const i01 = (y1 * sw + x0) * 4;
      const i11 = (y1 * sw + x1) * 4;

      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;

      out[o] =
        src[i00] * w00 + src[i10] * w10 + src[i01] * w01 + src[i11] * w11;
      out[o + 1] =
        src[i00 + 1] * w00 +
        src[i10 + 1] * w10 +
        src[i01 + 1] * w01 +
        src[i11 + 1] * w11;
      out[o + 2] =
        src[i00 + 2] * w00 +
        src[i10 + 2] * w10 +
        src[i01 + 2] * w01 +
        src[i11 + 2] * w11;
      out[o + 3] = 255;

      o += 4;
    }
  }

  outCtx.putImageData(outData, 0, 0);
  return outCanvas;
};


// ============================================================
// 去斜（deskew）
//
// 用投影剖面法：对候选角度做行投影，行间差分平方和最大的角度
// 就是文字行最「齐」的角度。用剪切近似代替真旋转，O(n) 每个角度。
// ============================================================

const skewScore = (ink, width, height, angleRad) => {
  const tangent = Math.tan(angleRad);
  const offset = Math.ceil(Math.abs(tangent) * width) + 1;
  const bins = new Float32Array(height + offset * 2 + 2);
  const halfWidth = width / 2;

  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      if (ink[row + x] === 0) continue;
      const yy = (y + tangent * (x - halfWidth) + offset) | 0;
      bins[yy] += 1;
    }
  }

  let score = 0;
  for (let i = 1; i < bins.length; i += 1) {
    const delta = bins[i] - bins[i - 1];
    score += delta * delta;
  }
  return score;
};

const estimateSkewDeg = (canvas) => {
  // 缩到 640 长边做分析，够准且快
  const scale = Math.min(1, 640 / Math.max(canvas.width, canvas.height));
  const w = Math.max(32, Math.round(canvas.width * scale));
  const h = Math.max(32, Math.round(canvas.height * scale));

  const small = makeCanvas(w, h);
  getContext(small).drawImage(canvas, 0, 0, w, h);

  const gray = toGray(getContext(small).getImageData(0, 0, w, h));
  const threshold = otsuThreshold(gray);

  const ink = new Uint8Array(w * h);
  let inkCount = 0;
  for (let i = 0; i < ink.length; i += 1) {
    if (gray[i] < threshold) {
      ink[i] = 1;
      inkCount += 1;
    }
  }

  // 墨点太少或太多，说明不是一页正常文字，别猜
  const inkRatio = inkCount / ink.length;
  if (inkRatio < 0.005 || inkRatio > 0.6) {
    return { angle: 0, confident: false, inkRatio };
  }

  const search = (from, to, step) => {
    let bestAngle = 0;
    let bestScore = -Infinity;
    for (let deg = from; deg <= to + 1e-9; deg += step) {
      const score = skewScore(ink, w, h, (deg * Math.PI) / 180);
      if (score > bestScore) {
        bestScore = score;
        bestAngle = deg;
      }
    }
    return { bestAngle, bestScore };
  };

  const coarse = search(-10, 10, 1);
  const fine = search(coarse.bestAngle - 1, coarse.bestAngle + 1, 0.2);

  const baseline = skewScore(ink, w, h, 0);
  const gain = baseline > 0 ? fine.bestScore / baseline : 1;

  return {
    angle: fine.bestAngle,
    // 相对 0 度提升不到 2% 就当作本来就是正的
    confident: Math.abs(fine.bestAngle) >= 0.3 && gain >= 1.02,
    inkRatio,
    gain
  };
};

/** 估计纸张底色，用来填旋转后露出的角 */
const estimatePaperColor = (canvas) => {
  const ctx = getContext(canvas);
  const { width, height } = canvas;
  const band = Math.max(2, Math.round(Math.min(width, height) * 0.02));

  const strips = [
    ctx.getImageData(0, 0, width, band),
    ctx.getImageData(0, height - band, width, band)
  ];

  const values = [[], [], []];
  strips.forEach((strip) => {
    const data = strip.data;
    for (let i = 0; i < data.length; i += 4 * 7) {
      values[0].push(data[i]);
      values[1].push(data[i + 1]);
      values[2].push(data[i + 2]);
    }
  });

  const median = (arr) => {
    if (!arr.length) return 255;
    arr.sort((a, b) => a - b);
    return arr[(arr.length / 2) | 0];
  };

  return `rgb(${median(values[0])}, ${median(values[1])}, ${median(
    values[2]
  )})`;
};

const rotateCanvas = (canvas, angleDeg, fillStyle) => {
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));

  const outWidth = Math.round(canvas.width * cos + canvas.height * sin);
  const outHeight = Math.round(canvas.width * sin + canvas.height * cos);

  const out = makeCanvas(outWidth, outHeight);
  const ctx = getContext(out);

  ctx.fillStyle = fillStyle;
  ctx.fillRect(0, 0, outWidth, outHeight);

  ctx.translate(outWidth / 2, outHeight / 2);

  /*
   * 符号说明（很容易搞反，这里写清楚）：
   *
   * estimateSkewDeg 用剪切近似找的是「让文字行最齐」的 theta，
   * 满足 y + tan(theta) * x = const，
   * 所以图像真实倾角 alpha = -theta。
   *
   * 要摆正就得反向转 alpha，也就是按 theta 转。
   * canvas 的 rotate() 在 y 轴向下的坐标系里正值是顺时针，
   * 因此这里直接用 +rad，不能写成 -rad
   * （写反会把倾斜量翻倍）。
   */
  ctx.rotate(rad);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);

  return out;
};


// ============================================================
// 光照归一化 + 对比度增强
//
//   1. 大半径盒式模糊估计「纸的底色场」（含阴影、渐变、偏黄）
//   2. gray / background  -> 阴影和不均匀光照被除掉
//   3. 百分位拉伸 -> 墨色压到近 0，纸色抬到近 255
//   4. 轻度锐化 -> 补回缩放和 JPEG 损失的笔画边缘
//
// 已经很干净的扫描件会被闸门跳过，避免过处理。
// ============================================================

const enhanceForOcr = (canvas) => {
  const ctx = getContext(canvas);
  const { width, height } = canvas;
  const imageData = ctx.getImageData(0, 0, width, height);

  const gray = toGray(imageData);
  const longSide = Math.max(width, height);

  // 判断是不是「本来就干净」：底色均匀 + 对比度已经足够
  const hist = buildHistogram(gray);
  const p02 = percentileFromHist(hist, gray.length, 0.02);
  const p92 = percentileFromHist(hist, gray.length, 0.92);

  const bgRadius = clamp(Math.round(longSide / 28), 12, 120);
  const background = boxBlur(gray, width, height, bgRadius);

  // 底色场的离散程度：大 => 有阴影/光照不均
  let bgMin = Infinity;
  let bgMax = -Infinity;
  for (let i = 0; i < background.length; i += 17) {
    const value = background[i];
    if (value < bgMin) bgMin = value;
    if (value > bgMax) bgMax = value;
  }
  const bgSpread = bgMax - bgMin;

  const alreadyClean = bgSpread < 18 && p02 < 60 && p92 > 205;

  if (alreadyClean) {
    return { applied: false, reason: 'already-clean', bgSpread, p02, p92 };
  }

  // --- 除以底色场 ---
  const normalized = new Uint8ClampedArray(gray.length);
  for (let i = 0; i < gray.length; i += 1) {
    const bg = background[i] < 1 ? 1 : background[i];
    normalized[i] = clamp(Math.round((gray[i] * 255) / bg), 0, 255);
  }

  // --- 百分位拉伸 ---
  const normHist = buildHistogram(normalized);
  const low = percentileFromHist(normHist, normalized.length, 0.02);
  const high = percentileFromHist(normHist, normalized.length, 0.92);
  const span = Math.max(30, high - low);

  const stretched = new Uint8ClampedArray(normalized.length);
  for (let i = 0; i < normalized.length; i += 1) {
    stretched[i] = clamp(
      Math.round(6 + ((normalized[i] - low) * 244) / span),
      0,
      255
    );
  }

  // --- 轻度非锐化掩模 ---
  const blurred = boxBlur(stretched, width, height, 1);
  const data = imageData.data;

  for (let i = 0, o = 0; i < stretched.length; i += 1, o += 4) {
    const sharpened = clamp(
      Math.round(stretched[i] + 0.5 * (stretched[i] - blurred[i])),
      0,
      255
    );
    data[o] = sharpened;
    data[o + 1] = sharpened;
    data[o + 2] = sharpened;
    data[o + 3] = 255;
  }

  ctx.putImageData(imageData, 0, 0);

  return { applied: true, reason: 'enhanced', bgSpread, p02, p92, bgRadius };
};


// ============================================================
// 主入口
// ============================================================

/**
 * @param {Blob} inputBlob   已经解过 HEIC 的图片
 * @param {object} options
 *   maxDimension  输出长边上限（默认 2200）
 *   onStage       (stageKey, textForUser) => void
 * @returns {Promise<{
 *   displayBlob: Blob,   // 彩色，仅几何矫正，用于预览
 *   ocrBlob: Blob,       // 灰度增强，用于 PaddleOCR
 *   width: number,
 *   height: number,
 *   report: object
 * }>}
 */
export async function enhanceDocumentImage(inputBlob, options = {}) {
  const {
    maxDimension = 2200,
    /*
     * 长边低于这个值就放大。
     * 1600 是经验值：低于它，账单上的小字（缴费联、脚注）
     * 笔画高度常常不足 10 像素，OCR 直接读不出来。
     */
    minDimension = 1600,
    onStage = () => {}
  } = options;

  const startedAt =
    typeof performance !== 'undefined' ? performance.now() : Date.now();

  const report = {
    warp: null,
    deskewDeg: null,
    photometric: null,
    steps: [],
    fellBack: false,
    elapsedMs: 0
  };

  let bitmap = null;

  try {
    bitmap = await createImageBitmap(inputBlob);

    // ---------- 0. 缩放到工作尺寸 ----------
    //
    // 原来这里只降不升（Math.min(1, ...)），小图会被原样送进 OCR。
    //
    // 实测：一张 727x294 的医院缴费联，原图 OCR 完全读不出
    // 「AMOUNT YOU OWE $333.33」—— 抽取器再聪明也没用，
    // 因为那几个字压根没进 OCR 结果。
    // 同一张图先放大到 3 倍，金额、账号、栏目名全部出来了。
    //
    // 文字识别对笔画的绝对像素高度很敏感：
    // 一行字只有 8 像素高时，det 模型框不住、rec 模型认不准。
    // 放大不会凭空创造信息，但能让笔画跨过模型的可识别下限。
    let width = bitmap.width;
    let height = bitmap.height;

    const longSide = Math.max(width, height);

    let scale;
    if (longSide > maxDimension) {
      scale = maxDimension / longSide;          // 太大 -> 降采样
    } else if (longSide < minDimension) {
      // 太小 -> 放大，但最多 3 倍。
      // 再往上放只是把 JPEG 块放大，帮不到识别。
      scale = Math.min(3, minDimension / longSide);
    } else {
      scale = 1;
    }

    width = Math.max(1, Math.round(width * scale));
    height = Math.max(1, Math.round(height * scale));

    report.resize = {
      from: `${bitmap.width}x${bitmap.height}`,
      to: `${width}x${height}`,
      scale: Number(scale.toFixed(2)),
      action: scale > 1 ? 'upscale' : scale < 1 ? 'downscale' : 'none'
    };

    if (scale > 1) report.steps.push(`upscale:${scale.toFixed(1)}x`);

    let base = makeCanvas(width, height);
    const baseCtx = getContext(base);
    baseCtx.imageSmoothingEnabled = true;
    baseCtx.imageSmoothingQuality = 'high';
    baseCtx.drawImage(bitmap, 0, 0, width, height);

    // ---------- 1. 透视矫正 ----------
    onStage('warp', '正在检测信件边缘并摆正...');

    try {
      const analysisScale = Math.min(1, 480 / Math.max(width, height));
      const aw = Math.max(64, Math.round(width * analysisScale));
      const ah = Math.max(64, Math.round(height * analysisScale));

      const analysis = makeCanvas(aw, ah);
      getContext(analysis).drawImage(base, 0, 0, aw, ah);

      const aGray = toGray(getContext(analysis).getImageData(0, 0, aw, ah));
      const aThreshold = otsuThreshold(aGray);

      const { labels, bestLabel, bestSize } = largestBrightComponent(
        aGray,
        aw,
        ah,
        aThreshold
      );

      if (bestLabel >= 0 && bestSize > aw * ah * 0.15) {
        const quad = cornersFromComponent(labels, bestLabel, aw, ah);

        if (quad) {
          const verdict = validateQuad(quad, aw, ah);
          report.warp = { ...verdict, applied: false };

          if (verdict.ok) {
            const invScale = 1 / analysisScale;

            /*
             * 四角向内收 0.6%：
             * 极值点常常正好落在纸的最外一像素上，
             * 直接用会把桌面的深色边带进来，
             * 反而在页边留下一条黑边干扰检测。
             */
            const centroid = quad.reduce(
              (acc, point) => ({
                x: acc.x + point.x / 4,
                y: acc.y + point.y / 4
              }),
              { x: 0, y: 0 }
            );

            const inset = 0.006;

            const fullQuad = quad.map((point) => ({
              x:
                (point.x +
                  (centroid.x - point.x) * inset) *
                invScale,
              y:
                (point.y +
                  (centroid.y - point.y) * inset) *
                invScale
            }));

            const targetWidth = Math.round(
              Math.max(dist(fullQuad[0], fullQuad[1]), dist(fullQuad[3], fullQuad[2]))
            );
            const targetHeight = Math.round(
              Math.max(dist(fullQuad[0], fullQuad[3]), dist(fullQuad[1], fullQuad[2]))
            );

            const fit = Math.min(
              1,
              maxDimension / Math.max(targetWidth, targetHeight)
            );

            const warped = warpPerspective(
              base,
              fullQuad,
              Math.max(64, Math.round(targetWidth * fit)),
              Math.max(64, Math.round(targetHeight * fit))
            );

            if (warped) {
              base = warped;
              width = warped.width;
              height = warped.height;
              report.warp.applied = true;
              report.steps.push('perspective-warp');
            }
          }
        }
      } else {
        report.warp = { ok: false, reason: 'no-component', applied: false };
      }
    } catch (warpError) {
      report.warp = { ok: false, reason: 'error', applied: false };
      console.warn('[imagePrep] 透视矫正跳过：', warpError);
    }

    // ---------- 2. 去斜 ----------
    onStage('deskew', '正在校正信件倾斜角度...');

    try {
      const skew = estimateSkewDeg(base);
      report.deskewDeg = Number(skew.angle.toFixed(2));

      if (skew.confident) {
        base = rotateCanvas(base, skew.angle, estimatePaperColor(base));
        width = base.width;
        height = base.height;
        report.steps.push(`deskew:${report.deskewDeg}deg`);
      } else {
        report.deskewDeg = 0;
      }
    } catch (skewError) {
      report.deskewDeg = null;
      console.warn('[imagePrep] 去斜跳过：', skewError);
    }

    // ---------- 3. 预览图（彩色，几何已矫正） ----------
    const displayBlob = await canvasToBlob(base, 'image/jpeg', 0.92);

    // ---------- 4. OCR 图（灰度 + 去阴影 + 增强） ----------
    onStage('enhance', '正在去除阴影、增强文字对比度...');

    const ocrCanvas = makeCanvas(width, height);
    getContext(ocrCanvas).drawImage(base, 0, 0);

    try {
      report.photometric = enhanceForOcr(ocrCanvas);
      if (report.photometric.applied) {
        report.steps.push('illumination-normalize');
      }
    } catch (enhanceError) {
      report.photometric = { applied: false, reason: 'error' };
      console.warn('[imagePrep] 光照归一化跳过：', enhanceError);
    }

    /*
     * OCR 用图一律 PNG 无损。
     *
     * 这张图只在浏览器内存里传给 OCR 引擎，从不上传，
     * 体积大一点毫无代价 —— 但 JPEG 的有损压缩会实实在在
     * 伤到小字。实测同一张医院缴费联：
     *   PNG 无损      命中 3/4
     *   JPEG q=0.95   命中 2/4   <- 原来的设置，反而最差
     * 主要是 JPEG 默认的色度二次采样在细笔画上产生振铃。
     *
     * 预览图仍然用 JPEG，那张是给人看的，体积更重要。
     */
    const ocrBlob = await canvasToBlob(ocrCanvas, 'image/png');

    report.elapsedMs = Math.round(
      (typeof performance !== 'undefined' ? performance.now() : Date.now()) -
        startedAt
    );

    return { displayBlob, ocrBlob, width, height, report };
  } catch (error) {
    // 任何意外都回退到「只缩放」的旧行为，保证功能不中断
    console.warn('[imagePrep] 预处理整体失败，回退到仅缩放：', error);

    const fallback = await fallbackResize(inputBlob, maxDimension, minDimension);

    report.fellBack = true;
    report.steps.push('fallback-resize-only');
    report.elapsedMs = Math.round(
      (typeof performance !== 'undefined' ? performance.now() : Date.now()) -
        startedAt
    );

    return { ...fallback, report };
  } finally {
    if (bitmap && typeof bitmap.close === 'function') {
      bitmap.close();
    }
  }
}

/** 旧行为：只做缩放 + JPEG 重编码 */
async function fallbackResize(inputBlob, maxDimension, minDimension = 1600) {
  const bitmap = await createImageBitmap(inputBlob);

  try {
    const longSide = Math.max(bitmap.width, bitmap.height);
    const scale =
      longSide > maxDimension
        ? maxDimension / longSide
        : longSide < minDimension
          ? Math.min(3, minDimension / longSide)
          : 1;
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = makeCanvas(width, height);
    const ctx = getContext(canvas);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, width, height);

    const blob = await canvasToBlob(canvas, 'image/jpeg', 0.92);

    return { displayBlob: blob, ocrBlob: blob, width, height };
  } finally {
    if (typeof bitmap.close === 'function') bitmap.close();
  }
}

export default enhanceDocumentImage;
