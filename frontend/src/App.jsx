import React, {
  useEffect,
  useRef,
  useState
} from 'react';

import {
  Camera,
  Volume2,
  AlertTriangle,
  CheckCircle,
  RefreshCw,
  ShieldCheck,
  X,
  HelpCircle,
  SwitchCamera
} from 'lucide-react';

import heic2any from 'heic2any';
import { PaddleOCR } from '@paddleocr/paddleocr-js';

import './App.css';


// ============================================================
// V4.1
// Browser Local OCR + Local PII Detection
//
// IMAGE
//   ↓
// Browser local image processing
//   ↓
// PaddleOCR.js / PP-OCRv5
//   ↓
// Browser Worker / WASM
//   ↓
// Local PII Detection
//   ↓
// Redacted OCR Text
//
// IMPORTANT
// - Original image is NOT sent to main.py
// - OCR runs in browser
// - PII detection runs in browser
// - AI is NOT called in this version
// ============================================================


// ============================================================
// Luhn
// ============================================================

const luhnCheck = (numStr) => {
  if (!/^\d+$/.test(numStr)) {
    return false;
  }

  let sum = 0;
  let shouldDouble = false;

  for (let i = numStr.length - 1; i >= 0; i -= 1) {
    let digit = Number(numStr[i]);

    if (shouldDouble) {
      digit *= 2;

      if (digit > 9) {
        digit -= 9;
      }
    }

    sum += digit;
    shouldDouble = !shouldDouble;
  }

  return sum % 10 === 0;
};


// ============================================================
// Credit Card
// ============================================================

const findCreditCardDetections = (text) => {
  const detections = [];

  // 13-19 digits, allowing spaces or hyphens
  const regex = /\b(?:\d[ -]?){12,18}\d\b/g;

  let match;

  while ((match = regex.exec(text)) !== null) {
    const raw = match[0];
    const digitsOnly = raw.replace(/[^\d]/g, '');

    if (
      digitsOnly.length >= 13 &&
      digitsOnly.length <= 19 &&
      luhnCheck(digitsOnly)
    ) {
      detections.push({
        type: 'CREDIT_CARD',
        value: raw,
        start: match.index,
        end: match.index + raw.length,
        placeholder: '[CREDIT_CARD]',
        priority: 96
      });
    }

    if (match[0].length === 0) {
      regex.lastIndex += 1;
    }
  }

  return detections;
};


// ============================================================
// PII Patterns
// ============================================================

const PII_PATTERNS = [
  {
    type: 'SSN',
    mode: 'full',
    priority: 100,
    regex: /\b\d{3}-\d{2}-\d{4}\b/g,
    placeholder: '[SSN]'
  },

  {
    type: 'ROUTING_NUMBER',
    mode: 'trailing',
    priority: 95,
    regex:
      /(?:Routing\s*(?:Number|No\.?|#)?|ABA\s*(?:Number|#)?)[:\s]*(\d{9})\b/gi,
    placeholder: '[ROUTING_NUMBER]'
  },

  {
    type: 'DRIVER_LICENSE',
    mode: 'trailing',
    priority: 90,
    regex:
      /(?:Driver'?s?\s*License(?:\s+Number)?|DL\s*(?:No\.?|#)?|License\s+Number)[:\s]*([A-Z0-9]{5,15})\b/gi,
    placeholder: '[DRIVER_LICENSE]'
  },

  {
    type: 'MEDICARE_NUMBER',
    mode: 'trailing',
    priority: 88,
    regex:
      /(?:Medicare\s*(?:Number|No\.?|#)?)[:\s]*([A-Z0-9-]{5,15})\b/gi,
    placeholder: '[MEDICARE_NUMBER]'
  },

  {
    type: 'POLICY_NUMBER',
    mode: 'trailing',
    priority: 85,
    regex:
      /(?:Policy\s*(?:Number|No\.?|#)?)[:\s]*([A-Z0-9-]{4,20})\b/gi,
    placeholder: '[POLICY_NUMBER]'
  },

  {
    type: 'MEMBER_ID',
    mode: 'trailing',
    priority: 84,
    regex:
      /(?:Member\s*(?:ID|Number|No\.?|#)?|Subscriber\s*(?:ID|Number|No\.?|#)?)[:\s]*([A-Z0-9-]{4,20})\b/gi,
    placeholder: '[MEMBER_ID]'
  },

  {
    type: 'CASE_NUMBER',
    mode: 'trailing',
    priority: 83,
    regex:
      /(?:Case\s*(?:Number|No\.?|#)?|Claim\s*(?:Number|No\.?|#)?)[:\s]*([A-Z0-9-]{4,20})\b/gi,
    placeholder: '[CASE_NUMBER]'
  },

  {
    type: 'INVOICE_NUMBER',
    mode: 'trailing',
    priority: 82,
    regex:
      /(?:Invoice\s*(?:Number|No\.?|#)?)[:\s]*([A-Z0-9-]{4,20})\b/gi,
    placeholder: '[INVOICE_NUMBER]'
  },

  {
    type: 'ACCOUNT_NUMBER',
    mode: 'trailing',
    priority: 80,
    regex:
      /(?:Service\s+Account(?:\s+Number)?|Account\s*(?:Number|No\.?|#)?|Acct\.?\s*(?:Number|No\.?|#)?)[:\s]*([A-Z0-9][A-Z0-9-]{3,19})\b/gi,
    placeholder: '[ACCOUNT_NUMBER]'
  },

  {
    type: 'POD_ID',
    mode: 'trailing',
    priority: 78,
    regex:
      /(?:POD[-\s]?ID)[:\s]*([A-Z0-9-]{3,20})\b/gi,
    placeholder: '[POD_ID]'
  },

  {
    type: 'EMAIL',
    mode: 'full',
    priority: 70,
    regex:
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    placeholder: '[EMAIL]'
  },

  {
    type: 'PHONE',
    mode: 'full',
    priority: 60,
    regex:
      /(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]\d{3}[\s.-]\d{4}\b/g,
    placeholder: '[PHONE]'
  },

  {
    type: 'ADDRESS',
    mode: 'full',
    priority: 50,
    regex:
      /\b\d{1,6}\s+[A-Za-z0-9.'’#-]+(?:\s+[A-Za-z0-9.'’#-]+){0,4}\s+(?:Street|St|Avenue|Ave|Boulevard|Blvd|Road|Rd|Drive|Dr|Lane|Ln|Court|Ct|Way|Place|Pl|Circle|Cir|Parkway|Pkwy|Highway|Hwy|Terrace|Ter|Trail|Trl)\.?\b/gi,
    placeholder: '[ADDRESS]'
  },

  {
    type: 'DATE',
    mode: 'full',
    priority: 40,
    regex:
      /\b(?:0[1-9]|1[0-2])[\/-](?:0[1-9]|[12]\d|3[01])[\/-](?:19|20)\d{2}\b/g,
    placeholder: '[DATE]'
  },

  {
    type: 'ZIP_CODE',
    mode: 'trailing',
    priority: 30,
    regex:
      /\b[A-Z]{2}\s+(\d{5}(?:-\d{4})?)\b/g,
    placeholder: '[ZIP]'
  }
];


// ============================================================
// Collect Raw PII
// ============================================================

const collectRawDetections = (text) => {
  const raw = [];

  PII_PATTERNS.forEach((pattern) => {
    pattern.regex.lastIndex = 0;

    let match;

    while ((match = pattern.regex.exec(text)) !== null) {
      if (pattern.mode === 'full') {
        raw.push({
          type: pattern.type,
          value: match[0],
          start: match.index,
          end: match.index + match[0].length,
          placeholder: pattern.placeholder,
          priority: pattern.priority
        });
      }

      if (pattern.mode === 'trailing') {
        const value = match[1];

        if (value) {
          const fullMatch = match[0];

          const valueStart =
            match.index +
            fullMatch.length -
            value.length;

          const valueEnd =
            valueStart +
            value.length;

          raw.push({
            type: pattern.type,
            value,
            start: valueStart,
            end: valueEnd,
            placeholder: pattern.placeholder,
            priority: pattern.priority
          });
        }
      }

      if (match[0].length === 0) {
        pattern.regex.lastIndex += 1;
      }
    }
  });

  raw.push(
    ...findCreditCardDetections(text)
  );

  return raw;
};


// ============================================================
// Resolve PII Overlap
// ============================================================

const resolveOverlaps = (rawDetections) => {
  const sorted = [...rawDetections].sort(
    (a, b) => {
      if (b.priority !== a.priority) {
        return b.priority - a.priority;
      }

      const aLength = a.end - a.start;
      const bLength = b.end - b.start;

      return bLength - aLength;
    }
  );

  const accepted = [];

  sorted.forEach((detection) => {
    const overlaps = accepted.some(
      (existing) =>
        detection.start < existing.end &&
        existing.start < detection.end
    );

    if (!overlaps) {
      accepted.push(detection);
    }
  });

  return accepted.sort(
    (a, b) => a.start - b.start
  );
};


// ============================================================
// Local PII Detection
// ============================================================

const detectLocalPII = (text) => {
  if (!text || !text.trim()) {
    return {
      detections: [],
      redactedText: ''
    };
  }

  const rawDetections =
    collectRawDetections(text);

  const detections =
    resolveOverlaps(rawDetections);

  let redactedText = text;

  // Replace from right → left
  // so indexes remain valid.
  [...detections]
    .sort((a, b) => b.start - a.start)
    .forEach((item) => {
      redactedText =
        redactedText.slice(0, item.start) +
        item.placeholder +
        redactedText.slice(item.end);
    });

  return {
    detections,
    redactedText
  };
};


// ============================================================
// App
// ============================================================

export default function App() {
  // ==========================================================
  // Core State
  // ==========================================================

  const [imagePreview, setImagePreview] =
    useState(null);

  const [loading, setLoading] =
    useState(false);

  const [loadingText, setLoadingText] =
    useState('');

  const [isScanning, setIsScanning] =
    useState(false);

  const [showAnalysisResults, setShowAnalysisResults] =
    useState(false);

  const [showCancelModal, setShowCancelModal] =
    useState(false);

  const [error, setError] =
    useState(null);


  // ==========================================================
  // OCR State
  // ==========================================================

  const [ocrText, setOcrText] =
    useState('');

  const [ocrWords, setOcrWords] =
    useState([]);

  const [ocrLines, setOcrLines] =
    useState([]);

  const [ocrConfidence, setOcrConfidence] =
    useState(null);

  const [ocrProgress, setOcrProgress] =
    useState(0);

  const [ocrRuntime, setOcrRuntime] =
    useState(null);

  const [ocrMetrics, setOcrMetrics] =
    useState(null);


  // ==========================================================
  // PII
  // ==========================================================

  const [piiResults, setPiiResults] =
    useState([]);

  const [redactedOcrText, setRedactedOcrText] =
    useState('');


  // ==========================================================
  // Camera
  // ==========================================================

  const [isCameraActive, setIsCameraActive] =
    useState(false);

  const [facingMode, setFacingMode] =
    useState('environment');


  // ==========================================================
  // Refs
  // ==========================================================

  const videoRef =
    useRef(null);

  const streamRef =
    useRef(null);

  const imagePreviewUrlRef =
    useRef(null);

  const ocrEngineRef =
    useRef(null);

  const ocrInitializingRef =
    useRef(false);

  const ocrCancelledRef =
    useRef(false);

  const mountedRef =
    useRef(true);


  // ==========================================================
  // Safe State Helpers
  // ==========================================================

  const safeSet = (setter, value) => {
    if (mountedRef.current) {
      setter(value);
    }
  };


  // ==========================================================
  // Object URL Cleanup
  // ==========================================================

  const revokePreviewUrl = () => {
    if (imagePreviewUrlRef.current) {
      URL.revokeObjectURL(
        imagePreviewUrlRef.current
      );

      imagePreviewUrlRef.current = null;
    }
  };


  // ==========================================================
  // Stop Camera
  // ==========================================================

  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current
        .getTracks()
        .forEach((track) => {
          track.stop();
        });

      streamRef.current = null;
    }

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    safeSet(
      setIsCameraActive,
      false
    );
  };


  // ==========================================================
  // Initialize PaddleOCR
  // ==========================================================

  const getOCREngine = async () => {
    if (ocrEngineRef.current) {
      return ocrEngineRef.current;
    }

    if (ocrInitializingRef.current) {
      while (
        ocrInitializingRef.current &&
        !ocrEngineRef.current &&
        mountedRef.current
      ) {
        await new Promise((resolve) =>
          setTimeout(resolve, 100)
        );
      }

      return ocrEngineRef.current;
    }

    ocrInitializingRef.current = true;

    try {
      safeSet(
        setLoadingText,
        '正在准备本地 PaddleOCR...'
      );

      safeSet(
        setOcrProgress,
        5
      );

      const ocr =
        await PaddleOCR.create({
          lang: 'ch',
          ocrVersion: 'PP-OCRv5',

          // Run inference in Worker
          worker: true,

          ortOptions: {
            backend: 'auto',
            numThreads: 2,
            simd: true
          }
        });

      if (
        ocrCancelledRef.current ||
        !mountedRef.current
      ) {
        await ocr.dispose();
        return null;
      }

      ocrEngineRef.current = ocr;

      safeSet(
        setOcrProgress,
        15
      );

      safeSet(
        setLoadingText,
        '本地 PaddleOCR 已准备完成'
      );

      console.log(
        '[PaddleOCR] Initialized',
        ocr
      );

      return ocr;
    } catch (err) {
      console.error(
        '[PaddleOCR] Initialization failed:',
        err
      );

      throw new Error(
        'PaddleOCR 本地引擎启动失败，请刷新页面后重新尝试。'
      );
    } finally {
      ocrInitializingRef.current = false;
    }
  };


  // ==========================================================
  // Component Mount / Unmount
  // ==========================================================

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;

      revokePreviewUrl();

      stopCamera();

      ocrCancelledRef.current = true;

      if (ocrEngineRef.current) {
        ocrEngineRef.current
          .dispose()
          .catch(() => {});

        ocrEngineRef.current = null;
      }
    };
  }, []);


  // ==========================================================
  // Reset
  // ==========================================================

  const handleClose = () => {
    ocrCancelledRef.current = true;

    revokePreviewUrl();

    stopCamera();

    setImagePreview(null);
    setError(null);

    setLoading(false);
    setLoadingText('');

    setIsScanning(false);
    setShowAnalysisResults(false);
    setShowCancelModal(false);

    setOcrText('');
    setOcrWords([]);
    setOcrLines([]);
    setOcrConfidence(null);
    setOcrProgress(0);
    setOcrRuntime(null);
    setOcrMetrics(null);

    setPiiResults([]);
    setRedactedOcrText('');
  };


  // ==========================================================
  // Request Close
  // ==========================================================

  const handleRequestClose = () => {
    if (loading || isScanning) {
      setShowCancelModal(true);
    } else {
      handleClose();
    }
  };


  // ==========================================================
  // Confirm Cancel
  // ==========================================================

  const handleConfirmCancel = () => {
    ocrCancelledRef.current = true;

    setShowCancelModal(false);

    handleClose();
  };


  // ==========================================================
  // Resume
  // ==========================================================

  const handleResumeScan = () => {
    setShowCancelModal(false);
  };


  // ==========================================================
  // Camera
  // ==========================================================

  const startCamera = async (
    targetMode = facingMode
  ) => {
    setError(null);

    stopCamera();

    if (
      !navigator.mediaDevices ||
      !navigator.mediaDevices.getUserMedia
    ) {
      setError(
        '您的浏览器暂时无法打开摄像头，请使用手机相册选择照片。'
      );

      return;
    }

    try {
      let stream;

      try {
        stream =
          await navigator.mediaDevices.getUserMedia({
            video: {
              facingMode: {
                exact: targetMode
              }
            },
            audio: false
          });
      } catch {
        // Fallback for browsers that reject
        // exact facingMode.
        stream =
          await navigator.mediaDevices.getUserMedia({
            video: {
              facingMode: targetMode
            },
            audio: false
          });
      }

      if (!mountedRef.current) {
        stream
          .getTracks()
          .forEach((track) => track.stop());

        return;
      }

      streamRef.current = stream;

      setFacingMode(targetMode);
      setIsCameraActive(true);

      // Attach after React renders <video>
      requestAnimationFrame(() => {
        if (videoRef.current) {
          videoRef.current.srcObject =
            stream;

          videoRef.current
            .play()
            .catch(() => {});
        }
      });
    } catch (err) {
      console.error(
        '[Camera] Access failed:',
        err
      );

      setError(
        '无法打开摄像头。请检查浏览器的摄像头权限，或者直接从手机相册选择照片。'
      );
    }
  };


  // ==========================================================
  // Toggle Camera
  // ==========================================================

  const toggleCameraFacing = () => {
    const nextMode =
      facingMode === 'environment'
        ? 'user'
        : 'environment';

    startCamera(nextMode);
  };


  // ==========================================================
  // Capture Photo
  // ==========================================================

  const capturePhoto = () => {
    const video = videoRef.current;

    if (!video) {
      setError(
        '没有找到摄像头画面，请重新打开摄像头。'
      );

      return;
    }

    const width =
      video.videoWidth || 1920;

    const height =
      video.videoHeight || 1080;

    const canvas =
      document.createElement('canvas');

    canvas.width = width;
    canvas.height = height;

    const ctx =
      canvas.getContext('2d');

    if (!ctx) {
      setError(
        '拍照失败，请重新尝试。'
      );

      return;
    }

    if (facingMode === 'user') {
      ctx.translate(width, 0);
      ctx.scale(-1, 1);
    }

    ctx.drawImage(
      video,
      0,
      0,
      width,
      height
    );

    stopCamera();

    canvas.toBlob(
      async (blob) => {
        if (!blob) {
          setError(
            '拍照失败，请重新拍一张。'
          );

          return;
        }

        const file =
          new File(
            [blob],
            'captured_letter.jpg',
            {
              type: 'image/jpeg'
            }
          );

        await handleProcessFile(file);
      },
      'image/jpeg',
      0.94
    );
  };


  // ==========================================================
  // Local Image Processing
  // ==========================================================

  const processImagePrivacy = async (
    file
  ) => {
    setLoadingText(
      '正在本地处理照片，请稍候...'
    );

    let imageFile = file;

    // --------------------------------------------------------
    // HEIC → JPEG
    // --------------------------------------------------------

    if (
      file.type === 'image/heic' ||
      file.type === 'image/heif' ||
      file.name
        .toLowerCase()
        .endsWith('.heic') ||
      file.name
        .toLowerCase()
        .endsWith('.heif')
    ) {
      const convertedBlob =
        await heic2any({
          blob: file,
          toType: 'image/jpeg',
          quality: 0.92
        });

      imageFile =
        Array.isArray(convertedBlob)
          ? convertedBlob[0]
          : convertedBlob;
    }

    // --------------------------------------------------------
    // Read image
    // --------------------------------------------------------

    const img = new Image();

    const objectUrl =
      URL.createObjectURL(imageFile);

    try {
      await new Promise(
        (resolve, reject) => {
          img.onload = resolve;

          img.onerror = () =>
            reject(
              new Error(
                '图片格式不受支持或文件损坏。'
              )
            );

          img.src = objectUrl;
        }
      );
    } finally {
      URL.revokeObjectURL(objectUrl);
    }

    // --------------------------------------------------------
    // Resize
    // --------------------------------------------------------

    const maxDimension = 2200;

    let width = img.naturalWidth || img.width;
    let height = img.naturalHeight || img.height;

    if (
      width > maxDimension ||
      height > maxDimension
    ) {
      if (width >= height) {
        height =
          Math.round(
            (height * maxDimension) /
              width
          );

        width = maxDimension;
      } else {
        width =
          Math.round(
            (width * maxDimension) /
              height
          );

        height = maxDimension;
      }
    }

    const canvas =
      document.createElement('canvas');

    canvas.width = width;
    canvas.height = height;

    const ctx =
      canvas.getContext('2d');

    if (!ctx) {
      throw new Error(
        '照片处理失败，请重新尝试。'
      );
    }

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    ctx.drawImage(
      img,
      0,
      0,
      width,
      height
    );

    // --------------------------------------------------------
    // JPEG
    // --------------------------------------------------------

    const blob =
      await new Promise(
        (resolve, reject) => {
          canvas.toBlob(
            (result) => {
              if (result) {
                resolve(result);
              } else {
                reject(
                  new Error(
                    '照片处理失败，请重新尝试。'
                  )
                );
              }
            },
            'image/jpeg',
            0.92
          );
        }
      );

    revokePreviewUrl();

    const previewUrl =
      URL.createObjectURL(blob);

    imagePreviewUrlRef.current =
      previewUrl;

    setImagePreview(previewUrl);

    return {
      blob,
      previewUrl
    };
  };


  // ==========================================================
  // Extract PaddleOCR Structure
  // ==========================================================

  const extractPaddleOCRStructure = (
    ocrResult
  ) => {
    const items =
      Array.isArray(ocrResult?.items)
        ? ocrResult.items
        : [];

    const lines = [];
    const words = [];

    items.forEach((item) => {
      const text =
        typeof item?.text === 'string'
          ? item.text
          : '';

      if (!text.trim()) {
        return;
      }

      const score =
        typeof item?.score === 'number'
          ? item.score
          : null;

      const normalized = {
        text,
        confidence:
          score !== null
            ? score * 100
            : null,
        bbox: item?.poly || null
      };

      // PaddleOCR returns recognized
      // text lines rather than individual words.
      lines.push(normalized);
      words.push(normalized);
    });

    return {
      words,
      lines
    };
  };


  // ==========================================================
  // Run Local OCR
  // ==========================================================

  const runLocalOCR = async (
    imageBlob
  ) => {
    ocrCancelledRef.current = false;

    setOcrProgress(15);

    setLoadingText(
      '正在本地读取信件文字...'
    );

    try {
      const ocr =
        await getOCREngine();

      if (
        !ocr ||
        ocrCancelledRef.current
      ) {
        return null;
      }

      setOcrProgress(25);

      setLoadingText(
        'PaddleOCR 正在检测信件文字位置...'
      );

      const results =
        await ocr.predict(
          imageBlob,
          {
            textDetLimitSideLen: 1600,
            textDetLimitType: 'max',
            textRecScoreThresh: 0.25
          }
        );

      if (
        ocrCancelledRef.current
      ) {
        return null;
      }

      setOcrProgress(85);

      setLoadingText(
        '正在整理本地 OCR 结果...'
      );

      const result =
        results?.[0];

      if (!result) {
        throw new Error(
          'PaddleOCR 没有返回识别结果。'
        );
      }

      const {
        words,
        lines
      } =
        extractPaddleOCRStructure(
          result
        );

      const text =
        lines
          .map((line) => line.text)
          .join('\n');

      const scores =
        lines
          .map(
            (line) =>
              line.confidence
          )
          .filter(
            (value) =>
              typeof value ===
              'number'
          );

      const confidence =
        scores.length
          ? scores.reduce(
              (sum, value) =>
                sum + value,
              0
            ) / scores.length
          : null;

      const metrics =
        result?.metrics || null;

      const runtime =
        result?.runtime || null;

      console.group(
        '[PaddleOCR] Local OCR'
      );

      console.log(
        'Raw result:',
        result
      );

      console.log(
        'Text:',
        text
      );

      console.log(
        'Items:',
        result.items
      );

      console.log(
        'Confidence:',
        confidence
      );

      console.log(
        'Metrics:',
        metrics
      );

      console.log(
        'Runtime:',
        runtime
      );

      console.groupEnd();

      setOcrText(text);
      setOcrWords(words);
      setOcrLines(lines);
      setOcrConfidence(confidence);
      setOcrRuntime(runtime);
      setOcrMetrics(metrics);
      setOcrProgress(100);

      return {
        text,
        words,
        lines,
        blocks: [],
        confidence,
        metrics,
        runtime
      };
    } catch (err) {
      console.error(
        '[OCR] Local PaddleOCR failed:',
        err
      );

      if (
        ocrCancelledRef.current
      ) {
        return null;
      }

      throw new Error(
        '本地 PaddleOCR 文字识别失败，请重新拍一张照片。'
      );
    }
  };


  // ==========================================================
  // Associate PII with OCR Lines
  // ==========================================================

  const associatePIIWithOCRLines = (
    detections,
    words
  ) => {
    return detections.map(
      (detection) => {
        const detectionValue =
          String(
            detection?.value || ''
          )
            .trim()
            .toLowerCase();

        if (!detectionValue) {
          return {
            ...detection,
            relatedWords: []
          };
        }

        const relatedWords =
          words.filter((word) => {
            const wordText =
              String(
                word?.text || ''
              )
                .trim()
                .toLowerCase();

            if (!wordText) {
              return false;
            }

            return (
              detectionValue.includes(
                wordText
              ) ||
              wordText.includes(
                detectionValue
              )
            );
          });

        return {
          ...detection,
          relatedWords
        };
      }
    );
  };


  // ==========================================================
  // Local PII
  // ==========================================================

  const runLocalPIIDetection =
    async (
      text,
      words = []
    ) => {
      setLoadingText(
        '正在本地检查可能的个人信息...'
      );

      if (
        !text ||
        !text.trim()
      ) {
        setPiiResults([]);
        setRedactedOcrText('');

        return {
          detections: [],
          redactedText: ''
        };
      }

      try {
        const {
          detections,
          redactedText
        } =
          detectLocalPII(text);

        const detectionsWithWords =
          associatePIIWithOCRLines(
            detections,
            words
          );

        console.group(
          '[Local PII]'
        );

        console.log(
          'PII Count:',
          detectionsWithWords.length
        );

        console.log(
          'PII Results:',
          detectionsWithWords
        );

        console.log(
          'Original OCR:',
          text
        );

        console.log(
          'Redacted OCR:',
          redactedText
        );

        console.groupEnd();

        setPiiResults(
          detectionsWithWords
        );

        setRedactedOcrText(
          redactedText
        );

        return {
          detections:
            detectionsWithWords,
          redactedText
        };
      } catch (err) {
        console.error(
          '[Local PII] Failed:',
          err
        );

        throw new Error(
          '本地隐私信息检测失败，请重新尝试。'
        );
      }
    };


  // ==========================================================
  // Process File
  // ==========================================================

  const handleProcessFile =
    async (file) => {
      if (!file) {
        return;
      }

      // New operation
      ocrCancelledRef.current =
        false;

      setError(null);

      setOcrText('');
      setOcrWords([]);
      setOcrLines([]);
      setOcrConfidence(null);
      setOcrProgress(0);
      setOcrRuntime(null);
      setOcrMetrics(null);

      setPiiResults([]);
      setRedactedOcrText('');

      revokePreviewUrl();

      setImagePreview(null);

      setShowAnalysisResults(false);

      setLoading(true);

      try {
        // ------------------------------------------------------
        // STEP 1
        // Browser image preprocessing
        // ------------------------------------------------------

        const {
          blob
        } =
          await processImagePrivacy(
            file
          );

        if (
          ocrCancelledRef.current
        ) {
          return;
        }

        setLoading(false);
        setIsScanning(true);

        // ------------------------------------------------------
        // STEP 2
        // Local OCR
        // ------------------------------------------------------

        const ocrResult =
          await runLocalOCR(
            blob
          );

        if (
          !ocrResult ||
          ocrCancelledRef.current
        ) {
          setIsScanning(false);
          return;
        }

        // ------------------------------------------------------
        // STEP 3
        // Local PII
        // ------------------------------------------------------

        await runLocalPIIDetection(
          ocrResult.text,
          ocrResult.words
        );

        if (
          ocrCancelledRef.current
        ) {
          setIsScanning(false);
          return;
        }

        // ------------------------------------------------------
        // STEP 4
        // Done
        // ------------------------------------------------------

        setIsScanning(false);
        setShowAnalysisResults(true);
      } catch (err) {
        console.error(
          '[Process] Failed:',
          err
        );

        if (
          ocrCancelledRef.current
        ) {
          setLoading(false);
          setIsScanning(false);
          return;
        }

        setError(
          err?.message ||
          '照片处理失败，请重新拍一张。'
        );

        setLoading(false);
        setIsScanning(false);
        setShowAnalysisResults(true);
      }
    };


  // ==========================================================
  // Upload
  // ==========================================================

  const handleImageUpload = (
    event
  ) => {
    const file =
      event.target.files?.[0];

    if (file) {
      handleProcessFile(file);
    }

    // Allows selecting the same file again.
    event.target.value = '';
  };


  // ==========================================================
  // Speech
  // ==========================================================

  const handleSpeak = (
    text
  ) => {
    if (!text) {
      return;
    }

    if (
      !('speechSynthesis' in window)
    ) {
      alert(
        '您的浏览器暂不支持语音功能。'
      );

      return;
    }

    window.speechSynthesis.cancel();

    const utterance =
      new SpeechSynthesisUtterance(
        text
      );

    utterance.lang = 'zh-CN';
    utterance.rate = 0.85;

    window.speechSynthesis.speak(
      utterance
    );
  };


  // ==========================================================
  // Render
  // ==========================================================

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900 p-4 md:p-8 font-sans relative">

      {/* ======================================================
          HEADER
      ======================================================= */}

      <header className="max-w-xl mx-auto text-center my-6">
        <div className="flex items-center justify-center space-x-2 mb-2">

          <ShieldCheck
            className="text-green-600"
            size={36}
          />

          <h1 className="text-4xl font-extrabold text-blue-800 tracking-wide">
            安心小助手
          </h1>

        </div>

        <p className="text-xl text-slate-600 font-medium">
          拍照识信，中文解读
        </p>
      </header>


      {/* ======================================================
          MAIN
      ======================================================= */}

      <main className="max-w-xl mx-auto bg-white rounded-3xl shadow-xl p-6 border-4 border-slate-200 relative overflow-hidden">

        {/* ====================================================
            CAMERA
        ===================================================== */}

        {isCameraActive && (
          <div className="relative bg-black rounded-3xl overflow-hidden flex flex-col items-center p-2 mb-4 z-20">

            <button
              onClick={stopCamera}
              className="absolute top-4 right-4 bg-slate-900/80 hover:bg-slate-900 text-white p-2.5 rounded-full z-30 flex items-center justify-center shadow-lg border border-white/20 active:scale-95 transition-all"
              title="关闭相机"
            >
              <X size={24} />
            </button>


            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className={`w-full h-80 object-cover rounded-2xl ${
                facingMode === 'user'
                  ? '-scale-x-100'
                  : ''
              }`}
            />


            <div className="w-full text-center py-2 bg-slate-900/90 text-amber-300 font-bold text-base md:text-lg flex items-center justify-center">
              请把整封信放进画面里
            </div>


            <div className="flex items-center justify-center gap-6 w-full my-4 px-3">

              <button
                onClick={capturePhoto}
                className="bg-red-600 hover:bg-red-700 text-white font-bold text-xl py-3 px-8 rounded-full shadow-2xl flex items-center space-x-2 border-4 border-white animate-pulse shrink-0 active:scale-95 transition-all"
              >
                <Camera size={26} />

                <span>
                  拍照
                </span>
              </button>


              <button
                onClick={toggleCameraFacing}
                className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-3 rounded-2xl flex items-center space-x-1.5 text-base font-bold shadow-md shrink-0 active:scale-95 transition-all"
              >
                <SwitchCamera size={20} />

                <span>
                  翻转
                </span>
              </button>

            </div>

          </div>
        )}


        {/* ====================================================
            LOADING
        ===================================================== */}

        {loading && (
          <div className="text-center py-12 flex flex-col items-center justify-center space-y-6">

            <RefreshCw
              size={64}
              className="animate-spin text-blue-600 mx-auto"
            />

            <div className="bg-blue-50 border-2 border-blue-200 p-6 rounded-2xl w-full">

              <p className="text-2xl font-bold text-blue-950">
                {loadingText}
              </p>

            </div>


            <button
              onClick={handleRequestClose}
              className="bg-slate-200 hover:bg-slate-300 text-slate-700 font-bold px-6 py-2 rounded-full text-lg"
            >
              取消处理
            </button>

          </div>
        )}


        {/* ====================================================
            IMAGE + RESULTS
        ===================================================== */}

        {imagePreview && !loading && (
          <div className="space-y-6">

            {/* IMAGE */}

            <div className="relative rounded-2xl overflow-hidden border-2 border-slate-300 bg-transparent shadow-inner">

              <button
                onClick={handleRequestClose}
                className="absolute top-3 right-3 bg-slate-900/80 hover:bg-slate-900 text-white font-bold p-2.5 rounded-full z-40 flex items-center justify-center shadow-lg border border-white/20"
                title="关闭并返回"
              >
                <X size={24} />
              </button>


              <div className="relative w-full block">

                <img
                  src={imagePreview}
                  alt="信件预览"
                  className="w-full h-auto block relative z-10"
                />

                {isScanning && (
                  <div className="scanning-overlay z-15">
                    <div className="scanning-line" />
                  </div>
                )}

              </div>

            </div>


            {/* =================================================
                SCANNING
            ================================================== */}

            {isScanning && (
              <div className="bg-blue-50 border-4 border-blue-400 p-6 rounded-2xl text-center space-y-4">

                <div className="flex items-center justify-center space-x-2 text-blue-800">

                  <RefreshCw
                    size={36}
                    className="text-blue-600 animate-spin"
                  />

                  <span className="text-2xl font-black">
                    正在本地读取信件...
                  </span>

                </div>


                <p className="text-lg text-blue-900 font-bold">
                  PaddleOCR 正在您的浏览器中处理
                </p>


                <div className="w-full bg-blue-100 rounded-full h-4 overflow-hidden">

                  <div
                    className="bg-blue-600 h-4 rounded-full transition-all duration-300"
                    style={{
                      width: `${ocrProgress}%`
                    }}
                  />

                </div>


                <p className="text-base text-blue-800 font-bold">
                  {loadingText}
                </p>


                <p className="text-sm text-blue-700">
                  本阶段不会把照片发送到后端。
                </p>

              </div>
            )}


            {/* =================================================
                RESULTS
            ================================================== */}

            {!isScanning &&
              showAnalysisResults && (
                <div className="space-y-5">


                  {/* =================================================
                      OCR STATUS
                  ================================================== */}

                  <div className="bg-green-50 border-4 border-green-400 p-5 rounded-2xl">

                    <div className="flex items-center gap-3 mb-3">

                      <CheckCircle
                        size={40}
                        className="text-green-600"
                      />

                      <div>

                        <h2 className="text-2xl font-black text-green-950">
                          PaddleOCR + 本地隐私检测完成
                        </h2>

                        <p className="text-green-800 font-medium">
                          当前照片和 OCR 文字都没有上传到 main.py
                        </p>

                      </div>

                    </div>


                    {ocrConfidence !== null && (
                      <div className="bg-white rounded-xl p-4">

                        <p className="text-base text-slate-500 font-bold">
                          OCR 平均置信度
                        </p>

                        <p className="text-3xl font-black text-green-700">
                          {Math.round(
                            ocrConfidence
                          )}
                          %
                        </p>

                      </div>
                    )}

                  </div>


                  {/* =================================================
                      PII
                  ================================================== */}

                  <div className="bg-orange-50 border-4 border-orange-400 p-5 rounded-2xl">

                    <div className="flex items-center gap-3 mb-4">

                      <ShieldCheck
                        size={38}
                        className="text-orange-600"
                      />

                      <div>

                        <h2 className="text-2xl font-black text-orange-950">
                          本地 PII Detection
                        </h2>

                        <p className="text-orange-900 font-medium">
                          个人信息检查完全在浏览器本地进行
                        </p>

                      </div>

                    </div>


                    <div className="bg-white rounded-xl p-4">

                      <p className="text-base text-slate-500 font-bold">
                        检测到
                      </p>

                      <p className="text-3xl font-black text-orange-700">

                        {piiResults.length}

                        <span className="text-xl ml-2">
                          个可能的个人信息
                        </span>

                      </p>

                    </div>


                    {piiResults.length > 0 && (
                      <div className="mt-4 space-y-3">

                        <h3 className="font-black text-lg text-orange-950">
                          检测结果
                        </h3>


                        {piiResults.map(
                          (item, index) => (
                            <div
                              key={`${item.type || 'pii'}-${item.start ?? index}-${index}`}
                              className="bg-white border-2 border-orange-200 rounded-xl p-4"
                            >

                              <p className="text-sm text-orange-700 font-bold">
                                {item.type || 'PII'}
                              </p>

                              <p className="font-black text-slate-900 break-all">
                                {item.value ||
                                  '[检测到信息]'}
                              </p>

                              {item.placeholder && (
                                <p className="text-sm text-slate-500 mt-1">
                                  Redaction：
                                  {item.placeholder}
                                </p>
                              )}

                            </div>
                          )
                        )}

                      </div>
                    )}


                    {piiResults.length === 0 && (
                      <div className="mt-4 bg-white border-2 border-orange-200 rounded-xl p-4">

                        <p className="text-orange-800 font-bold">
                          当前没有检测到可能的 PII。
                        </p>

                        <p className="text-sm text-slate-500 mt-1">
                          注意：没有检测到不代表照片中一定不存在个人信息。
                        </p>

                      </div>
                    )}

                  </div>


                  {/* =================================================
                      REDACTED OCR
                  ================================================== */}

                  <div className="bg-purple-50 border-4 border-purple-400 rounded-2xl p-5">

                    <div className="flex items-center justify-between gap-3 mb-3">

                      <div>

                        <h3 className="text-xl font-black text-purple-950">
                          脱敏后的文字预览
                        </h3>

                        <p className="text-sm text-purple-800">
                          下一阶段发送给 AI 前将使用这个版本
                        </p>

                      </div>


                      <button
                        onClick={() =>
                          handleSpeak(
                            redactedOcrText
                          )
                        }
                        className="flex items-center gap-2 bg-purple-600 hover:bg-purple-700 text-white px-3 py-2 rounded-xl font-bold shrink-0"
                      >

                        <Volume2
                          size={20}
                        />

                        <span>
                          朗读
                        </span>

                      </button>

                    </div>


                    <div className="bg-white border-2 border-purple-200 rounded-xl p-4 max-h-96 overflow-y-auto">

                      {redactedOcrText ? (
                        <pre className="whitespace-pre-wrap break-words text-base text-slate-800 font-sans leading-relaxed">
                          {redactedOcrText}
                        </pre>
                      ) : (
                        <p className="text-slate-500">
                          没有可显示的脱敏文字。
                        </p>
                      )}

                    </div>

                  </div>


                  {/* =================================================
                      ORIGINAL OCR
                  ================================================== */}

                  <details className="bg-white border-4 border-slate-300 rounded-2xl p-5 shadow-sm">

                    <summary className="cursor-pointer font-black text-xl text-slate-900">

                      查看原始 OCR 文字

                    </summary>


                    <div className="flex items-center justify-between gap-3 mt-4 mb-3">

                      <p className="text-sm text-slate-500">
                        PaddleOCR 从照片中读取到的原始文字
                      </p>


                      <button
                        onClick={() =>
                          handleSpeak(
                            ocrText
                          )
                        }
                        className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-3 py-2 rounded-xl font-bold"
                      >

                        <Volume2
                          size={20}
                        />

                        <span>
                          朗读
                        </span>

                      </button>

                    </div>


                    <div className="bg-slate-50 border-2 border-slate-200 rounded-xl p-4 max-h-96 overflow-y-auto">

                      {ocrText ? (
                        <pre className="whitespace-pre-wrap break-words text-base text-slate-800 font-sans leading-relaxed">
                          {ocrText}
                        </pre>
                      ) : (
                        <p className="text-red-600 font-bold">
                          没有读取到文字。
                        </p>
                      )}

                    </div>

                  </details>


                  {/* =================================================
                      TECHNICAL INFORMATION
                  ================================================== */}

                  <details className="bg-slate-900 text-white rounded-2xl p-5">

                    <summary className="cursor-pointer text-lg font-black">
                      Local OCR 技术信息
                    </summary>


                    <div className="space-y-2 text-sm mt-4">

                      <p>
                        OCR Engine：
                        <strong className="text-green-300">
                          {' '}
                          PaddleOCR.js
                        </strong>
                      </p>


                      <p>
                        OCR Model：
                        <strong className="text-green-300">
                          {' '}
                          PP-OCRv5
                        </strong>
                      </p>


                      <p>
                        Execution：
                        <strong className="text-green-300">
                          {' '}
                          Browser Local
                        </strong>
                      </p>


                      <p>
                        Worker：
                        <strong className="text-green-300">
                          {' '}
                          Web Worker
                        </strong>
                      </p>


                      <p>
                        Runtime：
                        <strong>
                          {' '}
                          {ocrRuntime
                            ? JSON.stringify(
                                ocrRuntime
                              )
                            : 'Local Runtime'}
                        </strong>
                      </p>


                      {ocrMetrics && (
                        <>
                          <p>
                            OCR Time：
                            <strong>
                              {' '}
                              {typeof ocrMetrics.totalMs ===
                              'number'
                                ? `${Math.round(
                                    ocrMetrics.totalMs
                                  )} ms`
                                : 'N/A'}
                            </strong>
                          </p>

                          <p>
                            Detected Boxes：
                            <strong>
                              {' '}
                              {ocrMetrics.detectedBoxes ??
                                'N/A'}
                            </strong>
                          </p>

                          <p>
                            Recognized Lines：
                            <strong>
                              {' '}
                              {ocrMetrics.recognizedCount ??
                                'N/A'}
                            </strong>
                          </p>
                        </>
                      )}


                      <p>
                        PII Detection：
                        <strong className="text-green-300">
                          {' '}
                          Browser Local
                        </strong>
                      </p>


                      <p>
                        PII Count：
                        <strong>
                          {' '}
                          {piiResults.length}
                        </strong>
                      </p>


                      <p>
                        Original OCR Text：
                        <strong>
                          {' '}
                          {ocrText.length}
                        </strong>{' '}
                        characters
                      </p>


                      <p>
                        Redacted OCR Text：
                        <strong>
                          {' '}
                          {redactedOcrText.length}
                        </strong>{' '}
                        characters
                      </p>


                      <p>
                        Upload to Backend：
                        <strong className="text-green-300">
                          {' '}
                          NO
                        </strong>
                      </p>


                      <p>
                        Image Redaction：
                        <strong className="text-amber-300">
                          {' '}
                          NOT YET
                        </strong>
                      </p>

                    </div>

                  </details>


                  {/* =================================================
                      PII JSON
                  ================================================== */}

                  {piiResults.length > 0 && (
                    <details className="bg-slate-50 border-2 border-slate-300 rounded-2xl p-4">

                      <summary className="cursor-pointer font-bold text-lg text-slate-800">
                        查看 PII Detection 技术信息
                      </summary>


                      <div className="mt-4 overflow-x-auto">

                        <pre className="text-xs text-slate-700 whitespace-pre-wrap break-all">
                          {JSON.stringify(
                            piiResults,
                            null,
                            2
                          )}
                        </pre>

                      </div>

                    </details>
                  )}


                  {/* =================================================
                      OCR WORDS / LINES
                  ================================================== */}

                  {ocrWords.length > 0 && (
                    <details className="bg-slate-50 border-2 border-slate-300 rounded-2xl p-4">

                      <summary className="cursor-pointer font-bold text-lg text-slate-800">
                        查看 PaddleOCR Lines + Bounding Box
                      </summary>


                      <div className="mt-4 overflow-x-auto">

                        <pre className="text-xs text-slate-700 whitespace-pre-wrap break-all">
                          {JSON.stringify(
                            ocrWords,
                            null,
                            2
                          )}
                        </pre>

                      </div>

                    </details>
                  )}


                  {/* =================================================
                      SECURITY NOTE
                  ================================================== */}

                  <div className="bg-amber-50 border-2 border-amber-300 rounded-2xl p-5">

                    <div className="flex items-start gap-3">

                      <AlertTriangle
                        size={30}
                        className="text-amber-600 shrink-0"
                      />


                      <div>

                        <p className="font-black text-amber-950 text-lg">
                          当前是 Local OCR + Local PII 测试阶段
                        </p>


                        <p className="text-amber-900 mt-2 leading-relaxed">

                          当前照片只在您的浏览器中处理。

                          <br />
                          <br />

                          OCR 使用 PaddleOCR.js + PP-OCRv5。

                          <br />
                          <br />

                          PII Detection 使用本地正则和 Luhn 校验。

                          <br />
                          <br />

                          目前还没有把照片或 OCR
                          文字发送给 AI。

                          <br />
                          <br />

                          注意：当前 PII Detection
                          是规则型检测，不代表能够发现照片中的全部个人信息。

                        </p>

                      </div>

                    </div>

                  </div>


                  {/* =================================================
                      BUTTONS
                  ================================================== */}

                  <div className="flex gap-4">

                    <button
                      onClick={handleClose}
                      className="flex-1 bg-slate-200 hover:bg-slate-300 text-slate-800 font-bold text-xl py-4 rounded-2xl flex items-center justify-center space-x-2"
                    >

                      <X size={24} />

                      <span>
                        关闭
                      </span>

                    </button>


                    <button
                      onClick={() =>
                        startCamera(
                          'environment'
                        )
                      }
                      className="flex-1 bg-blue-600 hover:bg-blue-700 text-white font-bold text-xl py-4 rounded-2xl flex items-center justify-center space-x-2 shadow-md"
                    >

                      <Camera
                        size={24}
                      />

                      <span>
                        再照一张
                      </span>

                    </button>

                  </div>

                </div>
              )}

          </div>
        )}


        {/* ====================================================
            HOME
        ===================================================== */}

        {!imagePreview &&
          !loading &&
          !isCameraActive && (
            <div className="my-8 space-y-4">

              <button
                onClick={() =>
                  startCamera(
                    'environment'
                  )
                }
                className="w-full h-48 bg-blue-600 hover:bg-blue-700 text-white rounded-3xl shadow-xl border-4 border-blue-400 flex flex-col items-center justify-center transition-transform active:scale-95"
              >

                <Camera
                  size={72}
                  className="mb-2"
                />

                <span className="text-3xl font-extrabold tracking-wider">
                  点击拍照
                </span>

                <span className="text-lg text-blue-100 mt-1">
                  对准信件，拍一下就知道
                </span>

              </button>


              <label className="cursor-pointer block text-center p-4 bg-slate-100 border-2 border-dashed border-slate-300 rounded-2xl hover:bg-slate-200 transition-all">

                <span className="text-lg font-bold text-slate-700">
                  从手机选择照片
                </span>


                <input
                  type="file"
                  accept="image/jpeg,image/png,image/heic,image/heif,image/*"
                  className="hidden"
                  onChange={
                    handleImageUpload
                  }
                />

              </label>

            </div>
          )}


        {/* ====================================================
            ERROR
        ===================================================== */}

        {error && !loading && (
          <div className="bg-red-100 border-2 border-red-400 rounded-2xl p-6 my-4 z-50 relative">

            <AlertTriangle
              size={48}
              className="text-red-600 mx-auto mb-2"
            />


            <p className="text-2xl font-bold text-red-800 text-center">
              {error}
            </p>


            <div className="flex justify-center gap-4 mt-4">

              <button
                onClick={handleClose}
                className="bg-slate-200 text-slate-800 text-xl font-bold py-3 px-6 rounded-full shadow hover:bg-slate-300"
              >
                关闭
              </button>


              <button
                onClick={() =>
                  startCamera(
                    'environment'
                  )
                }
                className="bg-red-600 text-white text-xl font-bold py-3 px-8 rounded-full shadow-lg hover:bg-red-700"
              >
                重新拍照
              </button>

            </div>

          </div>
        )}

      </main>


      {/* ======================================================
          CANCEL MODAL
      ======================================================= */}

      {showCancelModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">

          <div className="bg-white rounded-3xl p-6 md:p-8 max-w-sm w-full text-center space-y-6 shadow-2xl border-4 border-slate-200">

            <HelpCircle
              size={64}
              className="text-blue-600 mx-auto"
            />


            <div className="space-y-2">

              <h3 className="text-2xl font-black text-slate-900">
                取消识别？
              </h3>

              <p className="text-slate-600">
                当前本地 OCR 可能仍在处理中。
              </p>

            </div>


            <div className="flex flex-col gap-3">

              <button
                onClick={
                  handleConfirmCancel
                }
                className="w-full bg-red-600 hover:bg-red-700 text-white font-extrabold text-xl py-4 rounded-2xl shadow-lg"
              >
                取消
              </button>


              <button
                onClick={
                  handleResumeScan
                }
                className="w-full bg-slate-100 hover:bg-slate-200 text-slate-800 font-bold text-xl py-3 rounded-2xl border-2 border-slate-300"
              >
                继续
              </button>

            </div>

          </div>

        </div>
      )}

    </div>
  );
}