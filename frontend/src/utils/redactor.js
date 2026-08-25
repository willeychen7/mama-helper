import { createWorker } from 'tesseract.js';

// 敏感正则匹配：SSN 与 常见美国街道关键词
const SSN_REGEX = /\b\d{3}[-–\s]?\d{2}[-–\s]?\d{4}\b/;
const ADDRESS_KEYWORDS = /\b(street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|court|ct|way|pkwy|parkway)\b/i;

/**
 * 本地自动打码函数
 * @param {File} imageFile 原始图片文件
 * @param {Function} onProgress 进度回调 (0 - 100)
 * @returns {Promise<Blob>} 处理后打码的图片 Blob
 */
export async function autoRedactImage(imageFile, onProgress = () => {}) {
  // 1. 创建 Image 对象加载图片
  const img = await loadImage(imageFile);
  
  // 2. 创建 HTML5 Canvas
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);

  // 3. 启动离线 Tesseract 识别引擎
  const worker = await createWorker('eng');
  
  onProgress(30);

  // 4. 获取词级 (Words) 识别结果与坐标 (Bounding Box)
  const { data } = await worker.recognize(imageFile);
  await worker.terminate();

  onProgress(80);

  // 5. 遍历识别出的每个词，匹配敏感特征并绘制黑色方块
  ctx.fillStyle = '#000000'; // 纯黑色遮挡

  data.words.forEach((word) => {
    const text = word.text.trim();
    const isSSN = SSN_REGEX.test(text);
    const isAddress = ADDRESS_KEYWORDS.test(text);

    if (isSSN || isAddress) {
      const { x0, y0, x1, y1 } = word.bbox;
      // 适当扩充 4 像素外边距，确保彻底盖住边界
      const padding = 4;
      const width = (x1 - x0) + padding * 2;
      const height = (y1 - y0) + padding * 2;
      
      // 填充黑块
      ctx.fillRect(x0 - padding, y0 - padding, width, height);
    }
  });

  onProgress(100);

  // 6. 将 Canvas 导出为 JPEG 格式的 Blob 文件
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.9);
  });
}

// 辅助函数：将 File 转为 Image 对象
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}