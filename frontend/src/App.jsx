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

import { enhanceDocumentImage } from './utils/imagePrep';

import { extractLetterFields } from './utils/fieldExtractor';

import { buildTranslatablePayload, looksLikeName } from './utils/contentRedactor';

import {
  buildSpeechText,
  pickChineseVoice
} from './utils/speech';

import './App.css';


// ============================================================
// V5
// Browser Local OCR + Local Critical-field Re-OCR + Local PII
//
// PIPELINE
//
// IMAGE
//   ↓
// Browser Local Image Processing
//   ↓
// PaddleOCR PP-OCRv5
//   ↓
// OCR text + bbox + confidence
//   ↓
// Detect critical / suspicious lines
//   ↓
// Crop original local image region
//   ↓
// Upscale local crop
//   ↓
// PaddleOCR second pass
//   ↓
// Validate / choose better result
//   ↓
// Spatial reading order
//   ↓
// Local PII Detection
//   ↓
// Redacted OCR
//
// IMPORTANT
// - Original image is NOT sent to main.py
// - OCR is fully local
// - Second OCR pass is also fully local
// - PII detection is fully local
// - No AI is called in this version
// ============================================================


// ============================================================
// General Helpers
// ============================================================

const clamp = (value, min, max) =>
  Math.min(
    max,
    Math.max(min, value)
  );

const normalizeTextForComparison = (text) =>
  String(text || '')
    .replace(/\s+/g, ' ')
    .trim();

const digitCount = (text) =>
  (String(text || '').match(/\d/g) || []).length;

const alphaNumericCount = (text) =>
  (
    String(text || '').match(
      /[A-Z0-9]/gi
    ) || []
  ).length;


// ============================================================
// Luhn
// ============================================================

const luhnCheck = (numStr) => {
  if (!/^\d+$/.test(numStr)) {
    return false;
  }

  let sum = 0;
  let shouldDouble = false;

  for (
    let i = numStr.length - 1;
    i >= 0;
    i -= 1
  ) {
    let digit = Number(
      numStr[i]
    );

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

const findCreditCardDetections = (
  text
) => {
  const detections = [];

  const regex =
    /\b(?:\d[ -]?){12,18}\d\b/g;

  let match;

  while (
    (match = regex.exec(text)) !== null
  ) {
    const raw = match[0];

    const digitsOnly =
      raw.replace(/[^\d]/g, '');

    if (
      digitsOnly.length >= 13 &&
      digitsOnly.length <= 19 &&
      luhnCheck(digitsOnly)
    ) {
      detections.push({
        type: 'CREDIT_CARD',
        value: raw,
        start: match.index,
        end:
          match.index +
          raw.length,
        placeholder:
          '[CREDIT_CARD]',
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
    regex:
      /\b\d{3}([-.–])\d{2}\1\d{4}\b/g,
    placeholder: '[SSN]'
  },

  {
    // 部分掩码 SSN：前 5 位打码、后 4 位仍是真数字 —— 真实信件里最
    // 常见的 SSN 印法（"SSN on file: XXX-XX-6789"）。只认统一掩码字符
    // （全 X 或全 *）+ 3-2-4 连字符分组 + 末段是 4 位真数字。
    // 完全掩码（XXX-XX-XXXX / ***-**-****）没有可识别信息，不算 PII，
    // 不匹配。掩码非 SSN 编号极少用恰好 3-2-4 连字符这种分组，
    // 这里刻意不做上下文判断（宁可对掩码编号多遮一次，方向偏保守）。
    type: 'SSN',
    mode: 'full',
    priority: 99,
    regex:
      /(?<![A-Za-z0-9*])(?:[Xx]{3}-[Xx]{2}|\*{3}-\*{2})-\d{4}\b/g,
    placeholder: '[SSN]'
  },

  {
    // 带 SSN label/context 的裸 9 位数字（"SSN: 123456789"）。裸 9 位
    // 数字歧义极大（routing / account / ZIP+4 拼接 / 各种编号都是 9 位），
    // 所以只有紧跟在强 SSN 标签后面才算 —— label 和数字之间只允许空白
    // 和一个 `:`/`#`。priority 94，**低于 ROUTING(95)**：万一同一串数字
    // 同时命中 routing detector，ROUTING 的 type/ownership 优先，不被抢走。
    // 空格分隔的 "SSN: 123 45 6789" 不在本条范围（只认连续 9 位）。
    type: 'SSN',
    mode: 'trailing',
    priority: 94,
    regex:
      /\b(?:S\.?S\.?N\.?|SS\s?#|Soc\.?\s*Sec\.?(?:\s*(?:No\.?|Number|#))?|Social\s*Security(?:\s*(?:No\.?|Number|Num|#))?)\s*[:#]?\s*(\d{9})\b/gi,
    placeholder: '[SSN]'
  },

  {
    type: 'ROUTING_NUMBER',
    mode: 'trailing',
    priority: 95,
    regex:
      /(?:Routing\s*(?:Number|No\.?|#)?|ABA\s*(?:Number|#)?)[:\s]*(\d{9})\b/gi,
    placeholder:
      '[ROUTING_NUMBER]'
  },

  {
    type: 'DRIVER_LICENSE',
    mode: 'trailing',
    priority: 90,
    requireDigit: true,
    regex:
      /(?:Driver['‘’]?s?\s*License(?:\s+Number)?|DL\s*(?:No\.?|#)?|License\s+Number)[:\s]*([A-Z0-9]{5,15})\b/gi,
    placeholder:
      '[DRIVER_LICENSE]'
  },

  {
    type: 'MEDICARE_NUMBER',
    mode: 'trailing',
    priority: 88,
    requireDigit: true,
    regex:
      /(?:Medicare\s*(?:Number|No\.?|#)?)[:\s]*([A-Z0-9-]{5,15})\b/gi,
    placeholder:
      '[MEDICARE_NUMBER]'
  },

  {
    type: 'POLICY_NUMBER',
    mode: 'trailing',
    priority: 85,
    requireDigit: true,
    regex:
      /(?:Policy\s*(?:Number|No\.?|#)?)[:\s]*([A-Z0-9-]{4,20})\b/gi,
    placeholder:
      '[POLICY_NUMBER]'
  },

  {
    type: 'MEMBER_ID',
    mode: 'trailing',
    priority: 84,
    requireDigit: true,
    regex:
      /(?:Member\s*(?:ID|Number|No\.?|#)?|Subscriber\s*(?:ID|Number|No\.?|#)?)[:\s]*([A-Z0-9-]{4,20})\b/gi,
    placeholder:
      '[MEMBER_ID]'
  },

  {
    type: 'CASE_NUMBER',
    mode: 'trailing',
    priority: 83,
    requireDigit: true,
    regex:
      /(?:Case\s*(?:Number|No\.?|#)?|Claim\s*(?:Number|No\.?|#)?)[:\s]*([A-Z0-9-]{4,20})\b/gi,
    placeholder:
      '[CASE_NUMBER]'
  },

  {
    type: 'INVOICE_NUMBER',
    mode: 'trailing',
    priority: 82,
    requireDigit: true,
    regex:
      /(?:Invoice\s*(?:Number|No\.?|#)?)[:\s]*([A-Z0-9-]{4,20})\b/gi,
    placeholder:
      '[INVOICE_NUMBER]'
  },

  {
    type: 'ACCOUNT_NUMBER',
    mode: 'trailing',
    priority: 80,
    requireDigit: true,
    regex:
      /(?:Service\s+Account(?:\s+Number)?|Account\s*(?:Number|No\.?|#)?|Acct\.?\s*(?:Number|No\.?|#)?)[:\s]*([A-Z0-9][A-Z0-9-]{3,19})\b/gi,
    placeholder:
      '[ACCOUNT_NUMBER]'
  },

  {
    type: 'POD_ID',
    mode: 'trailing',
    priority: 78,
    requireDigit: true,
    regex:
      /(?:POD[-\s]?ID)[:\s]*([A-Z0-9-]{3,20})\b/gi,
    placeholder:
      '[POD_ID]'
  },

  {
    type: 'EMAIL',
    mode: 'full',
    priority: 70,
    regex:
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    placeholder:
      '[EMAIL]'
  },

  {
    type: 'PHONE',
    mode: 'full',
    priority: 60,
    regex:
      /(?:\+?1[\s.-]?)?(?:\(\d{3}\)[\s.-]?|\d{3}[\s.-])\d{3}[\s.-]\d{4}\b/g,
    placeholder:
      '[PHONE]'
  },

  {
    type: 'ADDRESS',
    mode: 'full',
    priority: 50,
    regex:
      /\b(?:\d{1,6}\s+[A-Za-z0-9.'’#-]+(?:\s+[A-Za-z0-9.'’#-]+){0,4}\s+(?:Street|St|Avenue|Ave|Boulevard|Blvd|Road|Rd|Drive|Dr|Lane|Ln|Court|Ct|Way|Place|Pl|Circle|Cir|Parkway|Pkwy|Highway|Hwy|Terrace|Ter|Trail|Trl)\.?(?:\s*,?\s*(?:Apt|Suite|Ste|Unit|#)\.?\s*[A-Za-z0-9-]+)?|P\.?\s?O\.?\s*Box\s*\d+)\b/gi,
    placeholder:
      '[ADDRESS]'
  },

  {
    type: 'ZIP_CODE',
    mode: 'trailing',
    priority: 30,
    regex:
      /\b[A-Z]{2}\s*,?\s+(\d{5}(?:-\d{4})?)\b/g,
    placeholder:
      '[ZIP]'
  },

  {
    type: 'ZIP_CODE',
    mode: 'full',
    priority: 20,
    regex:
      /(?<=\s)\d{5}(?:-\d{4})?(?=\s*$)/gm,
    placeholder:
      '[ZIP]'
  }
];


// ============================================================
// Collect Raw PII
// ============================================================

const collectRawDetections = (
  text
) => {
  const raw = [];

  PII_PATTERNS.forEach(
    (pattern) => {
      pattern.regex.lastIndex = 0;

      let match;

      while (
        (match =
          pattern.regex.exec(text)) !==
        null
      ) {
        if (
          pattern.mode === 'full'
        ) {
          raw.push({
            type:
              pattern.type,
            value:
              match[0],
            start:
              match.index,
            end:
              match.index +
              match[0].length,
            placeholder:
              pattern.placeholder,
            priority:
              pattern.priority
          });
        }

        if (
          pattern.mode ===
          'trailing'
        ) {
          const value =
            match[1];

          const passesDigitCheck =
            !pattern.requireDigit ||
            /\d/.test(
              value || ''
            );

          if (
            value &&
            passesDigitCheck
          ) {
            const fullMatch =
              match[0];

            const valueStart =
              match.index +
              fullMatch.length -
              value.length;

            const valueEnd =
              valueStart +
              value.length;

            raw.push({
              type:
                pattern.type,
              value,
              start:
                valueStart,
              end:
                valueEnd,
              placeholder:
                pattern.placeholder,
              priority:
                pattern.priority
            });
          }
        }

        if (
          match[0].length === 0
        ) {
          pattern.regex.lastIndex += 1;
        }
      }
    }
  );

  raw.push(
    ...findCreditCardDetections(
      text
    )
  );

  return raw;
};


// ============================================================
// Resolve PII Overlap
// ============================================================

const resolveOverlaps = (
  rawDetections
) => {
  const sorted = [
    ...rawDetections
  ].sort(
    (a, b) => {
      if (
        b.priority !==
        a.priority
      ) {
        return (
          b.priority -
          a.priority
        );
      }

      const aLength =
        a.end - a.start;

      const bLength =
        b.end - b.start;

      return (
        bLength -
        aLength
      );
    }
  );

  const accepted = [];

  sorted.forEach(
    (detection) => {
      const overlaps =
        accepted.some(
          (existing) =>
            detection.start <
              existing.end &&
            existing.start <
              detection.end
        );

      if (!overlaps) {
        accepted.push(
          detection
        );
      }
    }
  );

  return accepted.sort(
    (a, b) =>
      a.start - b.start
  );
};


// ============================================================
// Local PII Detection
// ============================================================

/*
 * 姓名检测——整行判定，不是逐词判定。
 *
 * 姓名判定逻辑只写在 contentRedactor.js 的 looksLikeName 里一份，
 * 这里只做「把 OCR 行位置换算成 text 里的字符偏移」这件事，
 * 不重新实现判断规则。之前这里（App.jsx 的 detectLocalPII）完全
 * 不认识姓名，只有 contentRedactor.js 的 buildTranslatablePayload
 * 认——于是「查看最终 OCR 文字」这个调试面板显示的是没有姓名保护的
 * 半成品，用户拿它测试时会看到姓名裸奔，以为脱敏漏了。
 *
 * text 由 lines.map(l => l.text).join('\n') 拼成（runLocalOCR 里
 * 就是这么拼的），所以按 lines 的顺序累加长度就能算出每一行在 text
 * 里的起止偏移，不需要在 text 里再搜一遍——重复的行内容（比如
 * 「JANE DOE」在页面上出现两次）搜字符串偏移会分不清是哪一次，
 * 按行顺序累加就没有这个问题。
 */
const collectNameDetections = (text, lines) => {
  if (!Array.isArray(lines) || !lines.length) return [];

  const pageHeight = lines.reduce(
    (max, l) => Math.max(max, l && l.bottom ? l.bottom : 0),
    1
  );

  const found = [];
  let cursor = 0;

  lines.forEach((line) => {
    const raw = line && line.text ? String(line.text) : '';
    const start = text.indexOf(raw, cursor);
    if (start === -1 || !raw) return;
    const end = start + raw.length;
    cursor = end;

    const inUpperArea = line.top <= pageHeight * 0.45;
    const why = looksLikeName(raw, { inUpperArea });
    if (why) {
      found.push({
        type: 'PERSON_NAME',
        value: raw,
        start,
        end,
        placeholder: '[NAME]',
        priority: 65
      });
    }
  });

  return found;
};

const detectLocalPII = (
  text,
  lines = []
) => {
  if (
    !text ||
    !text.trim()
  ) {
    return {
      detections: [],
      redactedText: ''
    };
  }

  const rawDetections =
    collectRawDetections(
      text
    ).concat(
      collectNameDetections(text, lines)
    );

  const detections =
    resolveOverlaps(
      rawDetections
    );

  let redactedText =
    text;

  [
    ...detections
  ]
    .sort(
      (a, b) =>
        b.start -
        a.start
    )
    .forEach(
      (item) => {
        redactedText =
          redactedText.slice(
            0,
            item.start
          ) +
          item.placeholder +
          redactedText.slice(
            item.end
          );
      }
    );

  return {
    detections,
    redactedText
  };
};


// ============================================================
// OCR Layout Helpers
// ============================================================

const getPolygonBounds = (
  poly
) => {
  if (
    !Array.isArray(poly) ||
    poly.length === 0
  ) {
    return null;
  }

  const points =
    poly
      .map(
        (point) => {
          if (
            Array.isArray(
              point
            )
          ) {
            return {
              x: Number(
                point[0]
              ),
              y: Number(
                point[1]
              )
            };
          }

          if (
            point &&
            typeof point ===
              'object'
          ) {
            return {
              x: Number(
                point.x ??
                  point[0]
              ),
              y: Number(
                point.y ??
                  point[1]
              )
            };
          }

          return null;
        }
      )
      .filter(
        (point) =>
          point &&
          Number.isFinite(
            point.x
          ) &&
          Number.isFinite(
            point.y
          )
      );

  if (!points.length) {
    return null;
  }

  const xs =
    points.map(
      (point) =>
        point.x
    );

  const ys =
    points.map(
      (point) =>
        point.y
    );

  const left =
    Math.min(...xs);

  const right =
    Math.max(...xs);

  const top =
    Math.min(...ys);

  const bottom =
    Math.max(...ys);

  return {
    left,
    top,
    right,
    bottom,
    width:
      Math.max(
        1,
        right - left
      ),
    height:
      Math.max(
        1,
        bottom - top
      ),
    centerX:
      (left + right) /
      2,
    centerY:
      (top + bottom) /
      2
  };
};


const getVerticalOverlapRatio = (
  a,
  b
) => {
  const top =
    Math.max(
      a.top,
      b.top
    );

  const bottom =
    Math.min(
      a.bottom,
      b.bottom
    );

  const overlap =
    Math.max(
      0,
      bottom - top
    );

  const minHeight =
    Math.min(
      a.height,
      b.height
    );

  if (
    minHeight <= 0
  ) {
    return 0;
  }

  return (
    overlap /
    minHeight
  );
};


const getHorizontalOverlapRatio = (
  a,
  b
) => {
  const left =
    Math.max(
      a.left,
      b.left
    );

  const right =
    Math.min(
      a.right,
      b.right
    );

  const overlap =
    Math.max(
      0,
      right - left
    );

  const minWidth =
    Math.min(
      a.width,
      b.width
    );

  if (
    minWidth <= 0
  ) {
    return 0;
  }

  return (
    overlap /
    minWidth
  );
};


const isSameTextRow = (
  a,
  b
) => {
  const verticalOverlap =
    getVerticalOverlapRatio(
      a,
      b
    );

  if (
    verticalOverlap >=
    0.35
  ) {
    return true;
  }

  const centerDistance =
    Math.abs(
      a.centerY -
        b.centerY
    );

  const referenceHeight =
    Math.min(
      a.height,
      b.height
    );

  return (
    centerDistance <=
    Math.max(
      8,
      referenceHeight *
        0.55
    )
  );
};


const buildVisualRows = (
  lines
) => {
  const rows = [];

  const sorted =
    [...lines].sort(
      (a, b) => {
        if (
          Math.abs(
            a.centerY -
              b.centerY
          ) > 4
        ) {
          return (
            a.top -
            b.top
          );
        }

        return (
          a.left -
          b.left
        );
      }
    );

  sorted.forEach(
    (line) => {
      let bestRow =
        null;

      let bestScore =
        -Infinity;

      rows.forEach(
        (row) => {
          const representative =
            row.lines[0];

          if (
            !isSameTextRow(
              line,
              representative
            )
          ) {
            return;
          }

          const verticalDistance =
            Math.abs(
              line.centerY -
                row.centerY
            );

          const score =
            -verticalDistance;

          if (
            score >
            bestScore
          ) {
            bestScore =
              score;

            bestRow =
              row;
          }
        }
      );

      if (!bestRow) {
        rows.push({
          lines: [line],
          top: line.top,
          bottom:
            line.bottom,
          centerY:
            line.centerY
        });

        return;
      }

      bestRow.lines.push(
        line
      );

      bestRow.top =
        Math.min(
          bestRow.top,
          line.top
        );

      bestRow.bottom =
        Math.max(
          bestRow.bottom,
          line.bottom
        );

      bestRow.centerY =
        (bestRow.top +
          bestRow.bottom) /
        2;
    }
  );

  rows.forEach(
    (row) => {
      row.lines.sort(
        (a, b) =>
          a.left -
          b.left
      );
    }
  );

  rows.sort(
    (a, b) =>
      a.top - b.top
  );

  return rows;
};


const detectLikelyColumns = (
  lines
) => {
  if (
    lines.length < 6
  ) {
    return null;
  }

  const pageLeft =
    Math.min(
      ...lines.map(
        (line) =>
          line.left
      )
    );

  const pageRight =
    Math.max(
      ...lines.map(
        (line) =>
          line.right
      )
    );

  const pageWidth =
    pageRight -
    pageLeft;

  if (
    pageWidth <= 0
  ) {
    return null;
  }

  const centers =
    lines.map(
      (line) =>
        line.centerX
    );

  const sortedCenters =
    [...centers].sort(
      (a, b) =>
        a - b
    );

  let largestGap =
    0;

  let largestGapIndex =
    -1;

  for (
    let i = 1;
    i <
    sortedCenters.length;
    i += 1
  ) {
    const gap =
      sortedCenters[i] -
      sortedCenters[
        i - 1
      ];

    if (
      gap >
      largestGap
    ) {
      largestGap =
        gap;

      largestGapIndex =
        i;
    }
  }

  if (
    largestGap <
    pageWidth * 0.18
  ) {
    return null;
  }

  const leftCenters =
    sortedCenters.slice(
      0,
      largestGapIndex
    );

  const rightCenters =
    sortedCenters.slice(
      largestGapIndex
    );

  if (
    leftCenters.length <
      3 ||
    rightCenters.length <
      3
  ) {
    return null;
  }

  const leftBoundary =
    (
      leftCenters[
        leftCenters.length -
          1
      ] +
      rightCenters[0]
    ) / 2;

  const leftLines =
    lines.filter(
      (line) =>
        line.centerX <
        leftBoundary
    );

  const rightLines =
    lines.filter(
      (line) =>
        line.centerX >=
        leftBoundary
    );

  if (
    leftLines.length <
      3 ||
    rightLines.length <
      3
  ) {
    return null;
  }

  const leftWidth =
    Math.max(
      ...leftLines.map(
        (line) =>
          line.right
      )
    ) -
    Math.min(
      ...leftLines.map(
        (line) =>
          line.left
      )
    );

  const rightWidth =
    Math.max(
      ...rightLines.map(
        (line) =>
          line.right
      )
    ) -
    Math.min(
      ...rightLines.map(
        (line) =>
          line.left
      )
    );

  if (
    leftWidth <
      pageWidth * 0.2 ||
    rightWidth <
      pageWidth * 0.2
  ) {
    return null;
  }

  return {
    left:
      leftLines,
    right:
      rightLines,
    boundary:
      leftBoundary
  };
};


const sortColumnLines = (
  lines
) => {
  const rows =
    buildVisualRows(
      lines
    );

  const result = [];

  rows.forEach(
    (row) => {
      row.lines.forEach(
        (line) => {
          result.push(
            line
          );
        }
      );
    }
  );

  return result;
};


const buildSpatialReadingOrder = (
  lines
) => {
  if (
    !lines.length
  ) {
    return [];
  }

  const columns =
    detectLikelyColumns(
      lines
    );

  if (!columns) {
    return sortColumnLines(
      lines
    );
  }

  const allLeft =
    Math.min(
      ...lines.map(
        (line) =>
          line.left
      )
    );

  const allRight =
    Math.max(
      ...lines.map(
        (line) =>
          line.right
      )
    );

  const pageWidth =
    allRight -
    allLeft;

  const fullWidthLines =
    lines.filter(
      (line) => {
        const widthRatio =
          line.width /
          pageWidth;

        return (
          widthRatio >=
          0.65
        );
      }
    );

  const columnLines =
    lines.filter(
      (line) =>
        !fullWidthLines.includes(
          line
        )
    );

  const leftColumn =
    columnLines.filter(
      (line) =>
        line.centerX <
        columns.boundary
    );

  const rightColumn =
    columnLines.filter(
      (line) =>
        line.centerX >=
        columns.boundary
    );

  const fullWidthOrdered =
    sortColumnLines(
      fullWidthLines
    );

  const leftOrdered =
    sortColumnLines(
      leftColumn
    );

  const rightOrdered =
    sortColumnLines(
      rightColumn
    );

  return [
    ...fullWidthOrdered,
    ...leftOrdered,
    ...rightOrdered
  ];
};


const buildOCRBlocks = (
  orderedLines
) => {
  if (
    !orderedLines.length
  ) {
    return [];
  }

  const blocks = [];

  orderedLines.forEach(
    (line) => {
      let bestBlock =
        null;

      let bestScore =
        -Infinity;

      blocks.forEach(
        (block) => {
          const lastLine =
            block.lines[
              block.lines.length -
                1
            ];

          const verticalGap =
            line.top -
            lastLine.bottom;

          const horizontalOverlap =
            getHorizontalOverlapRatio(
              line,
              lastLine
            );

          const xDistance =
            Math.min(
              Math.abs(
                line.left -
                  lastLine.right
              ),
              Math.abs(
                lastLine.left -
                  line.right
              )
            );

          const reasonableVerticalGap =
            verticalGap <=
            Math.max(
              80,
              lastLine.height *
                2.8
            );

          const reasonableHorizontalGap =
            xDistance <=
            Math.max(
              120,
              lastLine.height *
                5
            );

          if (
            !reasonableVerticalGap
          ) {
            return;
          }

          if (
            horizontalOverlap >=
              0.15 ||
            reasonableHorizontalGap
          ) {
            const score =
              horizontalOverlap *
                10 -
              Math.max(
                0,
                verticalGap
              ) /
                Math.max(
                  1,
                  lastLine.height
                );

            if (
              score >
              bestScore
            ) {
              bestScore =
                score;

              bestBlock =
                block;
            }
          }
        }
      );

      if (!bestBlock) {
        blocks.push({
          lines: [line],
          left: line.left,
          top: line.top,
          right: line.right,
          bottom: line.bottom
        });

        return;
      }

      bestBlock.lines.push(
        line
      );

      bestBlock.left =
        Math.min(
          bestBlock.left,
          line.left
        );

      bestBlock.top =
        Math.min(
          bestBlock.top,
          line.top
        );

      bestBlock.right =
        Math.max(
          bestBlock.right,
          line.right
        );

      bestBlock.bottom =
        Math.max(
          bestBlock.bottom,
          line.bottom
        );
    }
  );

  return blocks.map(
    (block, index) => ({
      id:
        index + 1,

      text:
        block.lines
          .map(
            (line) =>
              line.text
          )
          .join('\n'),

      lines:
        block.lines,

      bbox: {
        left:
          block.left,
        top:
          block.top,
        right:
          block.right,
        bottom:
          block.bottom,
        width:
          block.right -
          block.left,
        height:
          block.bottom -
          block.top
      }
    })
  );
};


// ============================================================
// Extract PaddleOCR Structure
// ============================================================

const extractPaddleOCRStructure = (
  ocrResult
) => {
  const items =
    Array.isArray(
      ocrResult?.items
    )
      ? ocrResult.items
      : [];

  const rawLines = [];

  items.forEach(
    (item, index) => {
      const text =
        typeof item?.text ===
        'string'
          ? item.text.trim()
          : '';

      if (!text) {
        return;
      }

      const score =
        typeof item?.score ===
        'number'
          ? item.score
          : null;

      const poly =
        item?.poly ||
        null;

      const bbox =
        getPolygonBounds(
          poly
        );

      const safeBBox =
        bbox || {
          left:
            index * 10,
          top:
            index * 10,
          right:
            index * 10 +
            100,
          bottom:
            index * 10 +
            20,
          width:
            100,
          height:
            20,
          centerX:
            index * 10 +
            50,
          centerY:
            index * 10 +
            10
        };

      rawLines.push({
        id: index,

        text,

        confidence:
          score !== null
            ? score * 100
            : null,

        bbox: poly,

        left:
          safeBBox.left,

        top:
          safeBBox.top,

        right:
          safeBBox.right,

        bottom:
          safeBBox.bottom,

        width:
          safeBBox.width,

        height:
          safeBBox.height,

        centerX:
          safeBBox.centerX,

        centerY:
          safeBBox.centerY
      });
    }
  );

  const orderedLines =
    buildSpatialReadingOrder(
      rawLines
    );

  const blocks =
    buildOCRBlocks(
      orderedLines
    );

  const finalLines =
    orderedLines.map(
      (line, index) => ({
        ...line,
        readingOrder:
          index + 1
      })
    );

  return {
    lines:
      finalLines,
    blocks,
    rawLines
  };
};

// ============================================================
// Critical Field Detection
//
// We deliberately keep this conservative.
// The goal is NOT to classify the whole document.
// The goal is to find lines where a second OCR pass
// is valuable because numbers/dates/IDs matter.
// ============================================================

const getCriticalFieldType = (
  text
) => {
  const value =
    String(
      text || ''
    ).trim();

  if (!value) {
    return null;
  }

  const lower =
    value.toLowerCase();

  if (
    /\$\s?\d[\d,]*(?:\.\d{0,2})?/.test(
      value
    ) ||
    /\b(?:amount|balance|total|payment|charge|fee|premium|due)\b/i.test(
      value
    )
  ) {
    return 'AMOUNT';
  }

  if (
    /\b(?:due\s*date|date|dated|effective|expires?|expiration)\b/i.test(
      value
    ) ||
    /\b\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}\b/.test(
      value
    ) ||
    /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2},?\s+\d{4}\b/i.test(
      value
    )
  ) {
    return 'DATE';
  }

  if (
    /\b(?:account|acct|invoice|claim|case|policy|member|subscriber|reference|ref|parcel|routing|medicare|license|id|number|no\.|#)\b/i.test(
      value
    ) &&
    digitCount(value) >= 2
  ) {
    return 'IDENTIFIER';
  }

  if (
    /\b(?:phone|telephone|tel|mobile|cell)\b/i.test(
      value
    ) ||
    /\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/.test(
      value
    )
  ) {
    return 'PHONE';
  }

  if (
    /\b[A-Z]{2}\s*,?\s+\d{5}(?:-\d{4})?\b/.test(
      value
    ) ||
    /\b\d{5}(?:-\d{4})?\b/.test(
      value
    )
  ) {
    return 'ZIP';
  }

  const digits =
    digitCount(value);

  const alphaNumeric =
    alphaNumericCount(
      value
    );

  if (
    digits >= 4 &&
    alphaNumeric > 0 &&
    digits /
      Math.max(
        1,
        alphaNumeric
      ) >= 0.35
  ) {
    return 'NUMERIC';
  }

  return null;
};


const getCriticalPriority = (
  fieldType,
  text,
  confidence
) => {
  let score = 0;

  if (
    fieldType ===
    'AMOUNT'
  ) {
    score += 100;
  } else if (
    fieldType ===
    'DATE'
  ) {
    score += 95;
  } else if (
    fieldType ===
    'IDENTIFIER'
  ) {
    score += 92;
  } else if (
    fieldType ===
    'PHONE'
  ) {
    score += 80;
  } else if (
    fieldType ===
    'ZIP'
  ) {
    score += 65;
  } else if (
    fieldType ===
    'NUMERIC'
  ) {
    score += 55;
  }

  const numeric =
    digitCount(text);

  score += Math.min(
    30,
    numeric * 2
  );

  if (
    typeof confidence ===
      'number' &&
    confidence < 80
  ) {
    score +=
      (80 -
        confidence) *
      1.5;
  }

  return score;
};



// ============================================================
// App
// ============================================================

export default function App() {
  // ==========================================================
  // Core State
  // ==========================================================

  const [
    imagePreview,
    setImagePreview
  ] = useState(null);

  const [
    loading,
    setLoading
  ] = useState(false);

  const [
    loadingText,
    setLoadingText
  ] = useState('');

  const [
    isScanning,
    setIsScanning
  ] = useState(false);

  const [
    showAnalysisResults,
    setShowAnalysisResults
  ] = useState(false);

  const [
    showCancelModal,
    setShowCancelModal
  ] = useState(false);

  const [
    error,
    setError
  ] = useState(null);


  // ==========================================================
  // OCR State
  // ==========================================================

  const [
    ocrText,
    setOcrText
  ] = useState('');

  const [
    ocrLines,
    setOcrLines
  ] = useState([]);

  const [
    ocrBlocks,
    setOcrBlocks
  ] = useState([]);

  const [
    ocrConfidence,
    setOcrConfidence
  ] = useState(null);

  const [
    ocrProgress,
    setOcrProgress
  ] = useState(0);

  const [
    ocrRuntime,
    setOcrRuntime
  ] = useState(null);

  const [
    ocrMetrics,
    setOcrMetrics
  ] = useState(null);

  const [
    ocrWorkerActive,
    setOcrWorkerActive
  ] = useState(null);

  const [
    ocrModelVersion,
    setOcrModelVersion
  ] = useState(null);

  const [
    imagePrepReport,
    setImagePrepReport
  ] = useState(null);

  const [
    letterFields,
    setLetterFields
  ] = useState(null);

  const [
    translatable,
    setTranslatable
  ] = useState(null);

  /*
   * 预览用彩色图（只做了透视矫正/去斜，没有转灰度）。
   * 跟喂给 OCR 的那张图几何坐标完全一致（processImagePrivacy 里的
   * 注释也是这么写的），所以 OCR 行的 bbox 可以直接画在这张图上，
   * 打码图片实验就是拿它当画布。
   */
  const [
    preparedDisplayBlob,
    setPreparedDisplayBlob
  ] = useState(null);

  // ----------------------------------------------------------
  // 实验性：本地脱敏之后再发给 AI 读懂全文
  //
  // 两种模式，用户二选一：
  //   'text'  —— 发 translatable.payloadText（挡下的行整行从文字里拿掉）
  //   'image' —— 发一张本地画了黑框的图片（挡下的行在像素上被涂黑，
  //               图片本身从没发出去过，只有涂黑之后的版本会发）
  //
  // 两种模式挡什么行用的是同一套判定（buildTranslatablePayload 算出来的
  // translatable.withheld），区别只是「拿掉整行文字」还是「涂黑那行像素」。
  // 默认关闭。用户手动打开开关、选模式、再手动点确认发送，
  // 每次发送都是当次的显式动作，不会自动或悄悄发出去。
  // 这里拿到的 amount / due_date 只作为「AI 怎么理解」展示，
  // 绝不会覆盖上面 letterFields 里本地抽取出来的金额和日期。
  // ----------------------------------------------------------
  const [
    experimentalEnabled,
    setExperimentalEnabled
  ] = useState(
    () => localStorage.getItem('mama-helper-experimental-llm') === '1'
  );

  const [
    experimentMode,
    setExperimentMode
  ] = useState(
    () => localStorage.getItem('mama-helper-experimental-mode') || 'text'
  );

  const [
    experimentResult,
    setExperimentResult
  ] = useState(null);

  const [
    experimentLoading,
    setExperimentLoading
  ] = useState(false);

  const [
    experimentError,
    setExperimentError
  ] = useState(null);

  const [
    maskedPreviewUrl,
    setMaskedPreviewUrl
  ] = useState(null);

  const toggleExperimental = (checked) => {
    setExperimentalEnabled(checked);
    localStorage.setItem('mama-helper-experimental-llm', checked ? '1' : '0');
    if (!checked) {
      setExperimentResult(null);
      setExperimentError(null);
    }
  };

  const changeExperimentMode = (mode) => {
    setExperimentMode(mode);
    localStorage.setItem('mama-helper-experimental-mode', mode);
    setExperimentResult(null);
    setExperimentError(null);
  };

  /*
   * 打码图片：在 preparedDisplayBlob（预览图，跟 OCR 坐标系完全一致）
   * 上，把 translatable.withheld 里每一行的 bbox 涂黑，导出成新 Blob。
   * 全程在本地 canvas 完成，涂黑之前的原图不会被这个函数发送到任何地方。
   */
  const buildMaskedImageBlob = async () => {
    if (!preparedDisplayBlob) {
      return null;
    }

    const bitmap = await createImageBitmap(preparedDisplayBlob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;

    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);

    const PAD = 4;
    ctx.fillStyle = '#000000';

    translatable.withheld.forEach((item) => {
      const line = ocrLines[item.index];
      if (!line) return;

      const left = Math.max(0, (line.left ?? 0) - PAD);
      const top = Math.max(0, (line.top ?? 0) - PAD);
      const right = Math.min(canvas.width, (line.right ?? 0) + PAD);
      const bottom = Math.min(canvas.height, (line.bottom ?? 0) + PAD);

      if (right > left && bottom > top) {
        ctx.fillRect(left, top, right - left, bottom - top);
      }
    });

    return new Promise((resolve) => {
      canvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.9);
    });
  };

  const runExperimentalUnderstanding = async () => {
    if (experimentMode === 'image') {
      return runExperimentalMaskedImage();
    }

    if (!translatable?.payloadText) return;

    setExperimentLoading(true);
    setExperimentError(null);
    setExperimentResult(null);

    try {
      const backendUrl =
        import.meta.env.VITE_BACKEND_URL || 'http://localhost:8000';

      const res = await fetch(
        `${backendUrl}/api/experimental/understand-text`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: translatable.payloadText })
        }
      );

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || `请求失败（${res.status}）`);
      }

      const body = await res.json();
      setExperimentResult(body.data);
    } catch (err) {
      setExperimentError(
        err.message || '连不上后端，实验功能暂时用不了'
      );
    } finally {
      setExperimentLoading(false);
    }
  };

  const runExperimentalMaskedImage = async () => {
    setExperimentLoading(true);
    setExperimentError(null);
    setExperimentResult(null);

    try {
      const maskedBlob = await buildMaskedImageBlob();
      if (!maskedBlob) {
        throw new Error('打码图片生成失败，请重新拍照再试');
      }

      if (maskedPreviewUrl) {
        URL.revokeObjectURL(maskedPreviewUrl);
      }
      setMaskedPreviewUrl(URL.createObjectURL(maskedBlob));

      const backendUrl =
        import.meta.env.VITE_BACKEND_URL || 'http://localhost:8000';

      const formData = new FormData();
      formData.append('file', maskedBlob, 'masked_letter.jpg');

      const res = await fetch(
        `${backendUrl}/api/experimental/understand-masked-image`,
        {
          method: 'POST',
          body: formData
        }
      );

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || `请求失败（${res.status}）`);
      }

      const body = await res.json();
      setExperimentResult(body.data);
    } catch (err) {
      setExperimentError(
        err.message || '连不上后端，实验功能暂时用不了'
      );
    } finally {
      setExperimentLoading(false);
    }
  };


  // ==========================================================
  // 无障碍：字号 + 朗读
  // ==========================================================

  /*
   * 字号三档。用 CSS zoom 而不是改 font-size ——
   * 界面全是 Tailwind 的绝对字号（text-2xl 之类），
   * 在父层改 font-size 对它们没有任何作用，只有 zoom 能整体放大。
   */
  const [
    fontScale,
    setFontScale
  ] = useState(1);

  const [
    speaking,
    setSpeaking
  ] = useState(false);

  // 0.75 慢 / 0.9 正常 —— 默认就比系统默认慢，老人听得跟得上
  const [
    speechRate,
    setSpeechRate
  ] = useState(0.85);

  const [
    voiceInfo,
    setVoiceInfo
  ] = useState(null);

  /*
   * 语音列表在部分浏览器里是异步加载的，
   * 第一次 getVoices() 可能返回空数组，要等 voiceschanged。
   */
  useEffect(() => {
    if (typeof window === 'undefined' || !window.speechSynthesis) return;

    const load = () => setVoiceInfo(pickChineseVoice());
    load();
    window.speechSynthesis.addEventListener('voiceschanged', load);

    return () => {
      window.speechSynthesis.removeEventListener('voiceschanged', load);
      window.speechSynthesis.cancel();
    };
  }, []);

  const stopSpeaking = () => {
    if (typeof window === 'undefined' || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    setSpeaking(false);
  };

  const speakLayer0 = () => {
    if (typeof window === 'undefined' || !window.speechSynthesis) return;
    if (!letterFields || !letterFields.layer0) return;

    if (speaking) {
      stopSpeaking();
      return;
    }

    const text = buildSpeechText(letterFields.layer0);
    if (!text) return;

    window.speechSynthesis.cancel();

    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-CN';
    u.rate = speechRate;
    // 音调压低一点，比默认好懂
    u.pitch = 0.95;
    if (voiceInfo && voiceInfo.voice) u.voice = voiceInfo.voice;

    u.onend = () => setSpeaking(false);
    u.onerror = () => setSpeaking(false);

    setSpeaking(true);
    window.speechSynthesis.speak(u);
  };

  /*
   * 换了一封信就停止朗读 —— 否则还在念上一封信的内容。
   */
  useEffect(() => {
    stopSpeaking();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [letterFields]);


  // ==========================================================
  // PII
  // ==========================================================

  const [
    piiResults,
    setPiiResults
  ] = useState([]);

  const [
    redactedOcrText,
    setRedactedOcrText
  ] = useState('');


  // ==========================================================
  // Camera
  // ==========================================================

  const [
    isCameraActive,
    setIsCameraActive
  ] = useState(false);

  const [
    facingMode,
    setFacingMode
  ] = useState(
    'environment'
  );


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

  const safeSet = (
    setter,
    value
  ) => {
    if (
      mountedRef.current
    ) {
      setter(value);
    }
  };


  // ==========================================================
  // Object URL Cleanup
  // ==========================================================

  const revokePreviewUrl =
    () => {
      if (
        imagePreviewUrlRef.current
      ) {
        URL.revokeObjectURL(
          imagePreviewUrlRef.current
        );

        imagePreviewUrlRef.current =
          null;
      }
    };


  // ==========================================================
  // Stop Camera
  // ==========================================================

  const stopCamera = () => {
    if (
      streamRef.current
    ) {
      streamRef.current
        .getTracks()
        .forEach(
          (track) => {
            track.stop();
          }
        );

      streamRef.current =
        null;
    }

    if (
      videoRef.current
    ) {
      videoRef.current.srcObject =
        null;
    }

    safeSet(
      setIsCameraActive,
      false
    );
  };


  // ==========================================================
  // Initialize PaddleOCR
  // ==========================================================

  const getOCREngine =
    async () => {
      if (
        ocrEngineRef.current
      ) {
        return ocrEngineRef.current;
      }

      if (
        ocrInitializingRef.current
      ) {
        const maxWaitMs =
          20000;

        let waited = 0;

        while (
          ocrInitializingRef.current &&
          !ocrEngineRef.current &&
          mountedRef.current
        ) {
          await new Promise(
            (resolve) =>
              setTimeout(
                resolve,
                100
              )
          );

          waited +=
            100;

          if (
            waited >=
            maxWaitMs
          ) {
            throw new Error(
              'PaddleOCR 初始化超时，请刷新页面重试。'
            );
          }
        }

        return ocrEngineRef.current;
      }

      ocrInitializingRef.current =
        true;

      try {
        safeSet(
          setLoadingText,
          '正在准备本地 PaddleOCR...'
        );

        safeSet(
          setOcrProgress,
          5
        );

        /*
         * 模型选择
         *
         * 原来写死 ocrVersion: 'PP-OCRv5'，
         * 而 lang: 'en' 在 v5 下会映射到 PP-OCRv5_mobile
         * —— 是这套里最小、最省算力、也最不准的一档。
         *
         * PP-OCRv6 会映射到 PP-OCRv6_small，
         * 在英文账单/政府信函这种印刷体上明显更稳。
         *
         * 万一某个浏览器或网络环境拿不到 v6 模型，
         * 会自动回落到 v5，功能绝不中断。
         */
        const buildConfig = (
          ocrVersion
        ) => ({
          lang: 'en',

          ocrVersion,

          ortOptions: {
            backend: 'auto',
            numThreads: 2,
            simd: true
          }
        });

        /*
         * 依次尝试：
         *   v6 + worker
         *   v6 + 主线程
         *   v5 + worker
         *   v5 + 主线程
         */
        const attempts = [
          {
            version: 'PP-OCRv6',
            worker: true
          },
          {
            version: 'PP-OCRv6',
            worker: false
          },
          {
            version: 'PP-OCRv5',
            worker: true
          },
          {
            version: 'PP-OCRv5',
            worker: false
          }
        ];

        let ocr = null;

        let workerActuallyUsed =
          true;

        let activeVersion =
          'PP-OCRv6';

        let lastInitError =
          null;

        for (
          let i = 0;
          i < attempts.length;
          i += 1
        ) {
          const attempt =
            attempts[i];

          try {
            ocr =
              await PaddleOCR.create(
                {
                  ...buildConfig(
                    attempt.version
                  ),
                  worker:
                    attempt.worker
                }
              );

            workerActuallyUsed =
              attempt.worker;

            activeVersion =
              attempt.version;

            break;
          } catch (
            attemptErr
          ) {
            lastInitError =
              attemptErr;

            console.warn(
              '[PaddleOCR] 初始化失败，尝试下一种组合：',
              attempt.version,
              'worker:',
              attempt.worker,
              attemptErr
            );
          }
        }

        if (!ocr) {
          throw (
            lastInitError ||
            new Error(
              'PaddleOCR 初始化失败'
            )
          );
        }

        safeSet(
          setOcrModelVersion,
          activeVersion
        );

        if (
          ocrCancelledRef.current ||
          !mountedRef.current
        ) {
          await ocr.dispose();

          return null;
        }

        ocrEngineRef.current =
          ocr;

        safeSet(
          setOcrWorkerActive,
          workerActuallyUsed
        );

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
          ocr,
          'worker:',
          workerActuallyUsed
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
        ocrInitializingRef.current =
          false;
      }
    };


  // ==========================================================
  // Component Mount / Unmount
  // ==========================================================

  useEffect(() => {
    mountedRef.current =
      true;

    return () => {
      mountedRef.current =
        false;

      revokePreviewUrl();

      stopCamera();

      ocrCancelledRef.current =
        true;

      if (
        ocrEngineRef.current
      ) {
        ocrEngineRef.current
          .dispose()
          .catch(() => {});

        ocrEngineRef.current =
          null;
      }
    };
  }, []);


  // ==========================================================
  // Reset
  // ==========================================================

  const handleClose = () => {
    ocrCancelledRef.current =
      true;

    revokePreviewUrl();

    stopCamera();

    setImagePreview(null);

    setError(null);

    setLoading(false);

    setLoadingText('');

    setIsScanning(false);

    setShowAnalysisResults(
      false
    );

    setShowCancelModal(
      false
    );

    setOcrText('');

    setOcrLines([]);

    setOcrBlocks([]);

    setOcrConfidence(
      null
    );

    setOcrProgress(0);

    setOcrRuntime(null);

    setOcrMetrics(null);

    setImagePrepReport(null);

    setLetterFields(null);

    setTranslatable(null);

    setPiiResults([]);

    setRedactedOcrText('');
  };


  // ==========================================================
  // Request Close
  // ==========================================================

  const handleRequestClose =
    () => {
      if (
        loading ||
        isScanning
      ) {
        setShowCancelModal(
          true
        );
      } else {
        handleClose();
      }
    };


  // ==========================================================
  // Confirm Cancel
  // ==========================================================

  const handleConfirmCancel =
    () => {
      ocrCancelledRef.current =
        true;

      setShowCancelModal(
        false
      );

      handleClose();
    };


  // ==========================================================
  // Resume
  // ==========================================================

  const handleResumeScan =
    () => {
      setShowCancelModal(
        false
      );
    };


  // ==========================================================
  // Camera
  // ==========================================================

  const startCamera =
    async (
      targetMode = facingMode
    ) => {
      setError(null);

      stopCamera();

      if (
        !navigator.mediaDevices ||
        !navigator.mediaDevices
          .getUserMedia
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
            await navigator.mediaDevices.getUserMedia(
              {
                video: {
                  facingMode: {
                    exact:
                      targetMode
                  }
                },
                audio: false
              }
            );
        } catch {
          stream =
            await navigator.mediaDevices.getUserMedia(
              {
                video: {
                  facingMode:
                    targetMode
                },
                audio: false
              }
            );
        }

        if (
          !mountedRef.current
        ) {
          stream
            .getTracks()
            .forEach(
              (track) =>
                track.stop()
            );

          return;
        }

        streamRef.current =
          stream;

        setFacingMode(
          targetMode
        );

        setIsCameraActive(
          true
        );

        requestAnimationFrame(
          () => {
            if (
              videoRef.current
            ) {
              videoRef.current.srcObject =
                stream;

              videoRef.current
                .play()
                .catch(
                  () => {}
                );
            }
          }
        );
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

  const toggleCameraFacing =
    () => {
      const nextMode =
        facingMode ===
        'environment'
          ? 'user'
          : 'environment';

      startCamera(
        nextMode
      );
    };


  // ==========================================================
  // Capture Photo
  // ==========================================================

  const capturePhoto = () => {
    const video =
      videoRef.current;

    if (!video) {
      setError(
        '没有找到摄像头画面，请重新打开摄像头。'
      );

      return;
    }

    const width =
      video.videoWidth ||
      1920;

    const height =
      video.videoHeight ||
      1080;

    const canvas =
      document.createElement(
        'canvas'
      );

    canvas.width =
      width;

    canvas.height =
      height;

    const ctx =
      canvas.getContext(
        '2d'
      );

    if (!ctx) {
      setError(
        '拍照失败，请重新尝试。'
      );

      return;
    }

    if (
      facingMode ===
      'user'
    ) {
      ctx.translate(
        width,
        0
      );

      ctx.scale(
        -1,
        1
      );
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
      async (
        blob
      ) => {
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
              type:
                'image/jpeg'
            }
          );

        await handleProcessFile(
          file
        );
      },
      'image/jpeg',
      0.94
    );
  };


  // ==========================================================
  // Local Image Processing
  // ==========================================================

  const processImagePrivacy =
    async (
      file
    ) => {
      setLoadingText(
        '正在本地处理照片，请稍候...'
      );

      let imageFile =
        file;

      if (
        file.type ===
          'image/heic' ||
        file.type ===
          'image/heif' ||
        file.name
          .toLowerCase()
          .endsWith(
            '.heic'
          ) ||
        file.name
          .toLowerCase()
          .endsWith(
            '.heif'
          )
      ) {
        const convertedBlob =
          await heic2any(
            {
              blob: file,
              toType:
                'image/jpeg',
              quality:
                0.92
            }
          );

        imageFile =
          Array.isArray(
            convertedBlob
          )
            ? convertedBlob[0]
            : convertedBlob;
      }

      /*
       * ==================================================
       * 本地文档图像预处理
       *
       * 以前这里只做了两件事：
       *   1. 缩放到长边 2200
       *   2. 重新编码成 JPEG 0.92
       *
       * 也就是说，老人拿手机拍的信 —— 透视变形、纸面弯曲、
       * 台灯阴影、低对比度 —— 全部原封不动地喂给了 OCR。
       * 这是识别错字的第一大来源。
       *
       * PP-StructureV3 里负责干这件事的是 doc-preprocessor
       * （文档方向分类 + 文档矫正），但 paddleocr-js 浏览器包
       * 只打包了 det + rec，没有这个模块。
       * utils/imagePrep.js 就是在浏览器里把它补回来：
       *
       *   纸张四角检测 -> 透视矫正
       *   投影剖面法    -> 去斜
       *   底色场估计    -> 去阴影 / 光照归一化
       *   百分位拉伸    -> 对比度增强 + 轻度锐化
       *
       * 全部在本地内存完成，原图依然不会离开浏览器。
       * 每一步都有置信度闸门，判断不可靠就跳过，
       * 整体失败则回退到「只缩放」的旧行为。
       * ==================================================
       */

      const prepared =
        await enhanceDocumentImage(
          imageFile,
          {
            maxDimension:
              2200,

            onStage: (
              _stage,
              text
            ) => {
              setLoadingText(
                text
              );
            }
          }
        );

      setImagePrepReport(
        prepared.report
      );

      console.log(
        '[imagePrep] 预处理结果：',
        prepared.report
      );

      revokePreviewUrl();

      /*
       * 预览用彩色图（只做了几何矫正），
       * OCR 用灰度增强图。
       * 两张图几何完全一致，
       * 所以 OCR 返回的坐标以后可以直接画在预览上。
       */
      const previewUrl =
        URL.createObjectURL(
          prepared.displayBlob
        );

      imagePreviewUrlRef.current =
        previewUrl;

      setImagePreview(
        previewUrl
      );

      return {
        blob:
          prepared.ocrBlob,

        displayBlob:
          prepared.displayBlob,

        previewUrl,

        width:
          prepared.width,

        height:
          prepared.height,

        report:
          prepared.report
      };
    };


  // ==========================================================
  // Run Local OCR
  // ==========================================================

  const runLocalOCR =
    async (
      imageBlob
    ) => {
      ocrCancelledRef.current =
        false;

      setOcrProgress(
        15
      );

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

        setOcrProgress(
          25
        );

        setLoadingText(
          'PaddleOCR 正在检测信件文字位置...'
        );

        const results =
          await ocr.predict(
            imageBlob,
            {
              textDetLimitSideLen:
                2200,

              textDetLimitType:
                'max',

              /*
               * 检测阈值调优
               *
               * 账单上的金额、到期日常常是贴边小字，
               * 默认的 unclip ratio 偏紧，容易把 '$' 或末位数字
               * 切在框外，识别出来就少一位。
               *
               * textDetUnclipRatio 调大 = 文字框向外扩，
               * 宁可多框一点空白，也不要切字。
               * textDetBoxThresh 略降 = 别丢掉浅色/小号的行。
               */
              textDetThresh:
                0.28,

              textDetBoxThresh:
                0.50,

              textDetUnclipRatio:
                2.2,

              /*
               * 第一遍：
               * 尽量不要漏掉低置信度字符。
               */
              textRecScoreThresh:
                0.20
            }
          );

        if (
          ocrCancelledRef.current
        ) {
          return null;
        }

        setOcrProgress(
          65
        );

        setLoadingText(
          '正在分析文字位置和关键字段...'
        );

        const result =
          results?.[0];

        if (!result) {
          throw new Error(
            'PaddleOCR 没有返回识别结果。'
          );
        }

        const {
          lines:
            firstPassLines,
          blocks:
            firstPassBlocks,
          rawLines
        } =
          extractPaddleOCRStructure(
            result
          );

        /*
         * 这里原来有一遍「关键区域二次 OCR」：把金额、日期所在的行
         * 裁出来放大，再认一次，分数更高就替换原来那行。
         *
         * 删掉了，三条理由：
         *   1. 实测从来没有改善过任何一行（improved: 0）
         *   2. 有确认的污染机制 —— 上下各扩 0.65 倍行高会吃到相邻行，
         *      裁出来的所有文字被 join(' ') 拼成一串替换掉原行，
         *      为了修一个金额，可能把邻行文字塞进金额那一行
         *   3. 它想解决的场景，实测它解决不了 —— WM 那封垃圾账单上
         *      「Your Payment is Due」被照片边缘切掉了上半截字母，
         *      裁出来放大 4 倍认出来的是「YourPayueitisvue」。
         *      放大救不回不在图里的像素，只是把残缺放大。
         *
         * 正确的应对是告诉用户重拍（见 fieldExtractor 的 retakeHint），
         * 而不是自己偷偷猜。
         */

        const orderedFinalLines =
          buildSpatialReadingOrder(
            firstPassLines
          );

        const finalLines =
          orderedFinalLines.map(
            (line, index) => ({
              ...line,
              readingOrder:
                index + 1
            })
          );

        const finalBlocks =
          buildOCRBlocks(
            finalLines
          );

        const text =
          finalLines
            .map(
              (line) =>
                line.text
            )
            .join('\n');

        const scores =
          finalLines
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
                (
                  sum,
                  value
                ) =>
                  sum +
                  value,
                0
              ) /
              scores.length
            : null;

        const metrics =
          result?.metrics ||
          null;

        const runtime =
          result?.runtime ||
          null;

        console.group(
          '[PaddleOCR] Local OCR V5'
        );

        console.log(
          'Raw result:',
          result
        );

        console.log(
          'Raw OCR lines:',
          rawLines
        );

        console.log(
          'First-pass lines:',
          firstPassLines
        );

        console.log(
          'Final lines:',
          finalLines
        );

        console.log(
          'Final blocks:',
          finalBlocks
        );

        console.log(
          'Final text:',
          text
        );

        console.log(
          'Final confidence:',
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

        setOcrText(
          text
        );

        setOcrLines(
          finalLines
        );

        setOcrBlocks(
          finalBlocks
        );

        setOcrConfidence(
          confidence
        );

        setOcrRuntime(
          runtime
        );

        setOcrMetrics(
          metrics
        );

        setOcrProgress(
          100
        );

        return {
          text,
          lines:
            finalLines,
          blocks:
            finalBlocks,
          rawLines,
          confidence,
          metrics,
          runtime,
          imageBlob
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

  const buildLineOffsetMap =
    (lines) => {
      const map = [];

      let cursor = 0;

      lines.forEach(
        (line) => {
          const start =
            cursor;

          const end =
            start +
            (
              line?.text
                ?.length ||
              0
            );

          map.push({
            line,
            start,
            end
          });

          cursor =
            end + 1;
        }
      );

      return map;
    };


  const associatePIIWithOCRLines =
    (
      detections,
      lines
    ) => {
      const lineOffsetMap =
        buildLineOffsetMap(
          lines || []
        );

      return detections.map(
        (detection) => {
          const hasOffsets =
            typeof detection.start ===
              'number' &&
            typeof detection.end ===
              'number';

          const relatedWords =
            hasOffsets
              ? lineOffsetMap
                  .filter(
                    ({
                      start,
                      end
                    }) =>
                      detection.start <
                        end &&
                      start <
                        detection.end
                  )
                  .map(
                    ({
                      line
                    }) =>
                      line
                  )
              : [];

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
      lines = []
    ) => {
      setLoadingText(
        '正在本地检查可能的个人信息...'
      );

      if (
        !text ||
        !text.trim()
      ) {
        setPiiResults([]);

        setRedactedOcrText(
          ''
        );

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
          detectLocalPII(
            text,
            lines
          );

        const detectionsWithWords =
          associatePIIWithOCRLines(
            detections,
            lines
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
    async (
      file
    ) => {
      if (!file) {
        return;
      }

      ocrCancelledRef.current =
        false;

      setError(null);

      setOcrText('');

      setOcrLines([]);

      setOcrBlocks([]);

      setPreparedDisplayBlob(null);

      if (maskedPreviewUrl) {
        URL.revokeObjectURL(maskedPreviewUrl);
        setMaskedPreviewUrl(null);
      }

      setExperimentResult(null);

      setExperimentError(null);

      setOcrConfidence(
        null
      );

      setOcrProgress(
        0
      );

      setOcrRuntime(null);

      setOcrMetrics(null);

      setImagePrepReport(null);

      setLetterFields(null);

      setTranslatable(null);

      setPiiResults([]);

      setRedactedOcrText('');

      revokePreviewUrl();

      setImagePreview(
        null
      );

      setShowAnalysisResults(
        false
      );

      setLoading(true);

      try {
        // ------------------------------------------------------
        // STEP 1
        // Local image processing
        // ------------------------------------------------------

        const {
          blob,
          displayBlob,
          width:
            preparedWidth,
          height:
            preparedHeight
        } =
          await processImagePrivacy(
            file
          );

        setPreparedDisplayBlob(
          displayBlob
        );

        if (
          ocrCancelledRef.current
        ) {
          return;
        }

        setLoading(false);

        setIsScanning(
          true
        );

        // ------------------------------------------------------
        // STEP 2
        // Full-page local OCR
        // ------------------------------------------------------

        const ocrResult =
          await runLocalOCR(
            blob
          );

        if (
          !ocrResult ||
          ocrCancelledRef.current
        ) {
          setIsScanning(
            false
          );

          return;
        }

        // ------------------------------------------------------
        // STEP 3
        // Local PII
        // ------------------------------------------------------

        await runLocalPIIDetection(
          ocrResult.text,
          ocrResult.lines
        );

        if (
          ocrCancelledRef.current
        ) {
          setIsScanning(
            false
          );

          return;
        }

        // ------------------------------------------------------
        // STEP 3.5
        // 第 0 层：本地关键字段抽取
        //
        // 这一步完全不联网、不调模型。
        // 它回答老人对一封信真正关心的五个问题：
        //   这是什么 / 谁寄的 / 大意 / 交多少 / 几号之前
        //
        // 抽取结果必须先通过交叉校验（分项求和、锚点一致性、
        // OCR 置信度）才会被标记为可信。
        // 校验不过就明确说「没看准」，绝不硬猜 ——
        // 对着老人自信地报错一个金额，比说不知道糟糕得多。
        // ------------------------------------------------------

        const extraction =
          extractLetterFields(
            ocrResult.lines,
            {
              imageWidth:
                preparedWidth,
              imageHeight:
                preparedHeight
            }
          );

        setLetterFields(
          extraction
        );

        console.group(
          '[Field Extraction]'
        );

        console.log(
          'Trustworthy:',
          extraction.trustworthy
        );

        console.log(
          'Fields:',
          extraction.fields
        );

        console.log(
          'Checks:',
          extraction.checks
        );

        console.log(
          '白名单载荷（唯一允许外发）：',
          extraction.safePayload
        );

        console.groupEnd();

        // ------------------------------------------------------
        // STEP 3.6
        // 逐行判定：哪些内容可以交给外部模型
        //
        // 第 0 层的模板只会说词典里有的话，
        // 想让老人读懂整封信的大意，就必须把内容交给模型。
        //
        // 但老人看不懂英文，没法替我们把关，
        // 所以不能「先发出去、漏了再说」，
        // 必须让漏检的代价落在「少发几句」而不是「泄露账号」。
        //
        // 这一步只是**算出来**可以发什么，并不发送。
        // ------------------------------------------------------

        const payload =
          buildTranslatablePayload(
            ocrResult.lines,
            {
              detectPII:
                detectLocalPII,

              imageHeight:
                preparedHeight,

              /*
               * 把已经认出来的寄件机构行号传进去。
               * 有了这个确定的机构锚点，就能分清
               * 「机构的地址电话」和「老人自己的地址电话」。
               *
               * 2026-08-30 修的 bug：这里原来直接传 box.id——但 .id 是
               * OCR 引擎给这一行的原始检测顺序号，不是它在 ocrResult.lines
               * 这个（已经按 buildSpatialReadingOrder 重排过版面顺序的）
               * 数组里的下标。contentRedactor.js 的 nearOrg/nearPerson 全部
               * 是按数组下标做位置比较的，传错了等于把机构锚点错误地
               * 指到了随便哪一行——真实账单里 id 和下标对不上的行经常
               * 占到四成，一直没被发现是因为所有回归测试的 fixture 都是
               * 手写的、id 顺序天然等于数组下标，只有真实 OCR 重排过的
               * 数据才会暴露。改成先按 id 找到这一行在数组里的真实下标。
               */
              senderLineIndex:
                (() => {
                  const senderId =
                    extraction
                      ?.fields
                      ?.sender
                      ?.box
                      ?.id;
                  if (senderId === undefined || senderId === null) return null;
                  const idx = ocrResult.lines.findIndex(
                    (l) => l && l.id === senderId
                  );
                  return idx >= 0 ? idx : null;
                })()
            }
          );

        setTranslatable(
          payload
        );

        console.group(
          '[可外发内容判定]'
        );

        console.log(
          '统计:',
          payload.stats
        );

        console.log(
          '被拦下的行:',
          payload.withheld
        );

        console.log(
          '会发出去的文本:\n' +
            payload.payloadText
        );

        console.groupEnd();

        // ------------------------------------------------------
        // STEP 4
        // Done
        // ------------------------------------------------------

        setIsScanning(
          false
        );

        setShowAnalysisResults(
          true
        );
      } catch (err) {
        console.error(
          '[Process] Failed:',
          err
        );

        if (
          ocrCancelledRef.current
        ) {
          setLoading(false);

          setIsScanning(
            false
          );

          return;
        }

        setError(
          err?.message ||
            '照片处理失败，请重新拍一张。'
        );

        setLoading(false);

        setIsScanning(
          false
        );

        setShowAnalysisResults(
          true
        );
      }
    };


  // ==========================================================
  // Upload
  // ==========================================================

  const handleImageUpload =
    (
      event
    ) => {
      const file =
        event.target
          .files?.[0];

      if (file) {
        handleProcessFile(
          file
        );
      }

      event.target.value =
        '';
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
      !(
        'speechSynthesis' in
        window
      )
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

    utterance.lang =
      'zh-CN';

    utterance.rate =
      0.85;

    window.speechSynthesis.speak(
      utterance
    );
  };


  // ==========================================================
  // Render
  // ==========================================================

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900 p-4 md:p-8 font-sans relative">

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


      <main className="max-w-xl mx-auto bg-white rounded-3xl shadow-xl p-6 border-4 border-slate-200 relative overflow-hidden">

        {/* ====================================================
            CAMERA
        ===================================================== */}

        {isCameraActive && (
          <div className="relative bg-black rounded-3xl overflow-hidden flex flex-col items-center p-2 mb-4 z-20">

            <button
              onClick={
                stopCamera
              }
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
                facingMode ===
                'user'
                  ? '-scale-x-100'
                  : ''
              }`}
            />

            <div className="w-full text-center py-2 bg-slate-900/90 text-amber-300 font-bold text-base md:text-lg flex items-center justify-center">
              请把整封信放进画面里
            </div>

            <div className="flex items-center justify-center gap-6 w-full my-4 px-3">

              <button
                onClick={
                  capturePhoto
                }
                className="bg-red-600 hover:bg-red-700 text-white font-bold text-xl py-3 px-8 rounded-full shadow-2xl flex items-center space-x-2 border-4 border-white animate-pulse shrink-0 active:scale-95 transition-all"
              >
                <Camera
                  size={26}
                />

                <span>
                  拍照
                </span>
              </button>

              <button
                onClick={
                  toggleCameraFacing
                }
                className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-3 rounded-2xl flex items-center space-x-1.5 text-base font-bold shadow-md shrink-0 active:scale-95 transition-all"
              >
                <SwitchCamera
                  size={20}
                />

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
              onClick={
                handleRequestClose
              }
              className="bg-slate-200 hover:bg-slate-300 text-slate-700 font-bold px-6 py-2 rounded-full text-lg"
            >
              取消处理
            </button>

          </div>
        )}


        {/* ====================================================
            IMAGE + RESULTS
        ===================================================== */}

        {imagePreview &&
          !loading && (
            <div className="space-y-6">

              <div className="relative rounded-2xl overflow-hidden border-2 border-slate-300 bg-transparent shadow-inner">

                <button
                  onClick={
                    handleRequestClose
                  }
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
                    第一遍 OCR、二次关键区域 OCR 和 PII 检测都在浏览器本地执行。
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
                        第 0 层：老人真正要看的那张卡
                        全部由本机模板拼成，没有联网，没有调模型
                    ================================================== */}

                    {letterFields &&
                      letterFields.layer0 && (
                      <>

                        {/* ================================================
                          * 无障碍控制条
                          *
                          * 放在卡片**上面**而不是里面 —— 卡片会被 zoom 放大，
                          * 控制条跟着放大就会挤出屏幕。
                          *
                          * 按钮做得很大：目标用户手抖、老花，小按钮点不中。
                          * ================================================ */}
                        <div className="flex flex-wrap items-center gap-3 mb-3">

                          <button
                            onClick={speakLayer0}
                            className={
                              'flex items-center gap-2 px-6 py-4 rounded-2xl text-2xl font-black border-4 transition ' +
                              (speaking
                                ? 'bg-red-600 text-white border-red-700'
                                : 'bg-blue-600 text-white border-blue-700 hover:bg-blue-700')
                            }
                          >
                            {speaking ? '■ 停止' : '🔊 读给我听'}
                          </button>

                          {speaking && (
                            <div className="flex items-center gap-2">
                              <span className="text-lg font-bold text-slate-600">
                                语速
                              </span>
                              {[
                                ['慢', 0.7],
                                ['正常', 0.85],
                                ['快', 1.05]
                              ].map(([label, rate]) => (
                                <button
                                  key={label}
                                  onClick={() => {
                                    setSpeechRate(rate);
                                    // 语速改了要重念，否则要等这一句念完
                                    stopSpeaking();
                                    setTimeout(speakLayer0, 60);
                                  }}
                                  className={
                                    'px-4 py-2 rounded-xl text-lg font-black border-2 ' +
                                    (Math.abs(speechRate - rate) < 0.01
                                      ? 'bg-slate-800 text-white border-slate-800'
                                      : 'bg-white text-slate-700 border-slate-300')
                                  }
                                >
                                  {label}
                                </button>
                              ))}
                            </div>
                          )}

                          <div className="flex items-center gap-2 ml-auto">
                            <span className="text-lg font-bold text-slate-600">
                              字号
                            </span>
                            {[
                              ['标准', 1],
                              ['大', 1.25],
                              ['特大', 1.55]
                            ].map(([label, scale]) => (
                              <button
                                key={label}
                                onClick={() => setFontScale(scale)}
                                className={
                                  'px-4 py-3 rounded-xl font-black border-2 ' +
                                  (fontScale === scale
                                    ? 'bg-slate-800 text-white border-slate-800'
                                    : 'bg-white text-slate-700 border-slate-300')
                                }
                                style={{
                                  fontSize:
                                    scale === 1
                                      ? '1.05rem'
                                      : scale === 1.25
                                        ? '1.3rem'
                                        : '1.6rem'
                                }}
                              >
                                {label}
                              </button>
                            ))}
                          </div>

                        </div>

                        {/*
                          * 只有在挑不到本地中文语音时才出现。
                          * 如实说清楚，而不是偷偷把文字发到云端念。
                          */}
                        {voiceInfo &&
                          !voiceInfo.isLocal && (
                          <p className="text-base text-amber-800 bg-amber-50 border-2 border-amber-300 rounded-xl px-4 py-2 mb-3">
                            这台设备上只找到了联网的中文语音。点「读给我听」会把
                            <b>小助手写的中文说明</b>（不含姓名地址）发给语音服务。
                            介意的话就不要点，文字都在下面。
                          </p>
                        )}

                        {!voiceInfo && (
                          <p className="text-base text-slate-500 mb-3">
                            这台设备上没有找到中文语音，朗读可能读不出来。
                          </p>
                        )}

                        <div
                          className="bg-white border-4 border-slate-800 rounded-2xl p-6 space-y-4"
                          style={{ zoom: fontScale }}
                        >

                          {/* ---- 诈骗警告：压在最上面，比什么都优先 ---- */}
                          {letterFields
                            .layer0
                            .scamWarning && (
                            <div className="bg-red-600 text-white rounded-2xl p-5 space-y-3">

                              <div className="flex items-center gap-3">

                                <AlertTriangle
                                  size={40}
                                  className="text-white shrink-0"
                                />

                                <p className="text-3xl font-black">
                                  {
                                    letterFields
                                      .layer0
                                      .scamWarning
                                      .title
                                  }
                                </p>

                              </div>

                              <ul className="space-y-1">
                                {letterFields.layer0.scamWarning.reasons.map(
                                  (
                                    reason,
                                    index
                                  ) => (
                                    <li
                                      key={index}
                                      className="text-lg font-bold"
                                    >
                                      · {reason}
                                    </li>
                                  )
                                )}
                              </ul>

                              <p className="text-xl font-black bg-white/15 rounded-xl p-3">
                                {
                                  letterFields
                                    .layer0
                                    .scamWarning
                                    .advice
                                }
                              </p>

                            </div>
                          )}

                          {/* ---- 紧急标记：红橙黄绿，最紧急再加感叹号 ---- */}
                          <div className="flex items-baseline gap-2 flex-wrap">

                            {letterFields
                              .layer0
                              .urgency && (
                              <span className="text-3xl">
                                {
                                  letterFields
                                    .layer0
                                    .urgency
                                    .flag
                                }
                                {
                                  letterFields
                                    .layer0
                                    .urgency
                                    .symbol
                                }
                              </span>
                            )}

                            <h2 className="text-3xl font-black text-slate-900">
                              这封信说什么
                            </h2>

                            {letterFields
                              .layer0
                              .urgency && (
                              <span className="text-2xl font-black text-slate-600">
                                （
                                {
                                  letterFields
                                    .layer0
                                    .urgency
                                    .cn
                                }
                                ）
                              </span>
                            )}

                          </div>

                          {letterFields
                            .layer0
                            .urgency &&
                            letterFields
                              .layer0
                              .urgency
                              .hint && (
                              <p
                                className={
                                  'text-xl font-black ' +
                                  (letterFields
                                    .layer0
                                    .urgency
                                    .level ===
                                  'red'
                                    ? 'text-red-700'
                                    : letterFields
                                          .layer0
                                          .urgency
                                          .level ===
                                      'orange'
                                      ? 'text-orange-700'
                                      : 'text-slate-600')
                                }
                              >
                                {
                                  letterFields
                                    .layer0
                                    .urgency
                                    .hint
                                }
                              </p>
                            )}

                          <div className="space-y-3 text-2xl leading-relaxed text-slate-900 font-bold">

                            <p>
                              {
                                letterFields
                                  .layer0
                                  .whatIsIt
                              }
                            </p>

                            {letterFields
                              .layer0
                              .whoSentIt && (
                              <p>
                                {
                                  letterFields
                                    .layer0
                                    .whoSentIt
                                }
                              </p>
                            )}

                            {letterFields
                              .layer0
                              .gist && (
                              <p className="text-xl font-medium text-slate-700">
                                {
                                  letterFields
                                    .layer0
                                    .gist
                                }
                              </p>
                            )}

                          </div>

                          {(letterFields
                            .layer0
                            .howMuch ||
                            letterFields
                              .layer0
                              .whenDue ||
                            letterFields
                              .layer0
                              .sentOn) && (
                            <div className="grid gap-3 sm:grid-cols-2 pt-2">

                              {letterFields
                                .layer0
                                .howMuch && (
                                <div className="bg-amber-50 border-4 border-amber-400 rounded-2xl p-5">

                                  <p className="text-base font-black text-amber-800 mb-1">
                                    金额
                                  </p>

                                  <p className="text-2xl font-black text-slate-900">
                                    {
                                      letterFields
                                        .layer0
                                        .howMuch
                                    }
                                  </p>

                                </div>
                              )}

                              {letterFields
                                .layer0
                                .whenDue && (
                                <div className="bg-rose-50 border-4 border-rose-400 rounded-2xl p-5">

                                  <p className="text-base font-black text-rose-800 mb-1">
                                    截止日期
                                  </p>

                                  <p className="text-sm font-bold text-rose-700 mb-1">
                                    要在这天之前办
                                  </p>

                                  <p className="text-2xl font-black text-slate-900">
                                    {
                                      letterFields
                                        .layer0
                                        .whenDue
                                    }
                                  </p>

                                  {/*
                                    * 过期了会怎么样 —— 就贴在截止日期下面。
                                    *
                                    * 只说「这天已经过去了」是把话说了一半，
                                    * 老人真正会问的是「那会怎么样、要不要多交钱」。
                                    * 这里的数字全部照抄信上的原文，信上没写就不出现。
                                    */}
                                  {letterFields
                                    .layer0
                                    .lateConsequence && (
                                    <p className="mt-3 pt-3 border-t-2 border-rose-200 text-lg font-bold text-rose-900">
                                      ⚠️ {
                                        letterFields
                                          .layer0
                                          .lateConsequence
                                      }
                                    </p>
                                  )}

                                </div>
                              )}

                              {/*
                                * 发信日期单独一个框，而且刻意做得比上面两个「安静」——
                                * 灰底、细边框、小字号。
                                *
                                * 两个日期挨在一起，老人很容易把
                                * 「信是 10月19日 写的」看成「10月19日 之前要交」。
                                * 所以除了分框，还写明「不用在这天之前办什么」——
                                * 光靠标题「发信日期」四个字不够，那是行话。
                                */}
                              {letterFields
                                .layer0
                                .sentOn && (
                                <div className="bg-slate-100 border-2 border-slate-300 rounded-2xl p-5">

                                  <p className="text-base font-black text-slate-600 mb-1">
                                    发信日期
                                  </p>

                                  <p className="text-sm font-bold text-slate-500 mb-1">
                                    不用在这天之前办什么
                                  </p>

                                  <p className="text-xl font-black text-slate-700">
                                    {
                                      letterFields
                                        .layer0
                                        .sentOn
                                    }
                                  </p>

                                </div>
                              )}

                            </div>
                          )}

                          {/*
                            * 重拍提示。
                            *
                            * 只会为「金额」和「截止日期」出现 —— 姓名、地址、账号
                            * 缺了一个字都不说，因为老人很可能是**故意**不拍的。
                            * 一个卖点是「你的隐私归你」的 app，不能反过来催用户
                            * 把隐私拍进来。见 journal 决定 05「默认不问」。
                            *
                            * 做成蓝色而不是黄色/红色：这不是警告，是一件
                            * 老人做一下就能解决的事。
                            */}
                          {letterFields
                            .layer0
                            .retakeHints &&
                            letterFields
                              .layer0
                              .retakeHints
                              .length > 0 && (
                            <div className="bg-sky-50 border-4 border-sky-400 rounded-2xl p-5">

                              <p className="text-lg font-black text-sky-800 mb-2">
                                📷 再拍一次就能看清
                              </p>

                              {letterFields.layer0.retakeHints.map(
                                (hint, i) => (
                                  <p
                                    key={i}
                                    className="text-lg text-slate-800 leading-relaxed"
                                  >
                                    {hint.cn}
                                  </p>
                                )
                              )}

                            </div>
                          )}

                          {letterFields
                            .layer0
                            .uncertain &&
                            letterFields
                              .layer0
                              .uncertain
                              .length > 0 && (
                            <div className="bg-yellow-50 border-4 border-yellow-500 rounded-2xl p-5">

                              <div className="flex items-center gap-2 mb-2">

                                <AlertTriangle
                                  size={28}
                                  className="text-yellow-700"
                                />

                                <p className="text-xl font-black text-yellow-900">
                                  这几项小助手没看准
                                </p>

                              </div>

                              <ul className="space-y-1">
                                {letterFields.layer0.uncertain.map(
                                  (
                                    item,
                                    index
                                  ) => (
                                    <li
                                      key={index}
                                      className="text-lg font-bold text-yellow-900"
                                    >
                                      · {item}
                                    </li>
                                  )
                                )}
                              </ul>

                            </div>
                          )}

                          <p className="text-lg font-bold text-slate-700">
                            {
                              letterFields
                                .layer0
                                .advice
                            }
                          </p>

                          <div className="flex items-center gap-2 pt-2 border-t-2 border-slate-200">

                            <ShieldCheck
                              size={20}
                              className="text-green-600"
                            />

                            {/*
                              * 原来这里写的是「没有联网，也没有交给任何 AI 模型」。
                              *
                              * 那句话把一个**架构选择**说成了**产品承诺**，
                              * 等于自己把手脚捆住 —— 将来接 AI 帮老人读懂长尾内容时，
                              * 这句话就成了打自己的脸。
                              *
                              * 用户真正怕的从来不是「AI」这个词，是
                              * 「我的信、地址、账号会不会被传走」。
                              * 所以要卖的是**边界**，不是**禁用**。
                              */}
                            <p className="text-sm font-bold text-slate-500">
                              信件照片不会上传。姓名、地址、账号这些个人信息，
                              先在您自己的设备上处理掉。将来接上 AI 时，
                              也只有去掉身份信息之后的内容才会发出去。
                            </p>

                          </div>

                        </div>
                      </>
                      )}

                    {/* =================================================
                        可外发内容判定
                        目前只计算、不发送
                    ================================================== */}

                    {translatable && (
                      <div className="bg-indigo-50 border-4 border-indigo-400 rounded-2xl p-5 space-y-3">

                        <div className="flex items-center gap-3">

                          <ShieldCheck
                            size={32}
                            className="text-indigo-700"
                          />

                          <h3 className="text-2xl font-black text-indigo-950">
                            信件大意翻译
                          </h3>

                        </div>

                        <p className="text-lg font-bold text-indigo-900">
                          本地已挡下{' '}
                          {
                            translatable
                              .stats
                              .withheldCount
                          }{' '}
                          处可能含个人信息的内容，其余{' '}
                          {
                            translatable
                              .stats
                              .sendableCount
                          }{' '}
                          处可以交给 AI 翻译成中文大意。
                        </p>

                        <div className="w-full bg-indigo-100 rounded-full h-4 overflow-hidden">
                          <div
                            className="bg-indigo-500 h-full"
                            style={{
                              width: `${translatable.stats.coverage}%`
                            }}
                          />
                        </div>

                        <p className="text-base font-bold text-indigo-800">
                          可外发比例{' '}
                          {
                            translatable
                              .stats
                              .coverage
                          }
                          %
                        </p>

                        <details className="bg-white border-2 border-indigo-200 rounded-xl p-4">

                          <summary className="cursor-pointer text-lg font-black text-indigo-900">
                            看看到底会发出去什么
                          </summary>

                          <pre className="whitespace-pre-wrap break-words text-sm text-slate-700 mt-3 leading-relaxed">
                            {
                              translatable
                                .payloadText
                            }
                          </pre>

                        </details>

                        {translatable
                          .withheld
                          .length > 0 && (
                          <details className="bg-white border-2 border-orange-200 rounded-xl p-4">

                            <summary className="cursor-pointer text-lg font-black text-orange-900">
                              被挡下的{' '}
                              {
                                translatable
                                  .withheld
                                  .length
                              }{' '}
                              处（只列原因，内容不外传）
                            </summary>

                            <ul className="mt-3 space-y-1">
                              {translatable.withheld.map(
                                (
                                  item,
                                  index
                                ) => (
                                  <li
                                    key={index}
                                    className="text-base text-slate-700"
                                  >
                                    · 第 {item.index + 1} 行 ——{' '}
                                    {item.reasons.join('、')}
                                  </li>
                                )
                              )}
                            </ul>

                          </details>
                        )}

                        <p className="text-sm font-bold text-slate-500">
                          注意：上面这段文字是「一旦发送、会发出去的全部内容」，
                          你可以先核对有没有漏掉的个人信息。
                        </p>

                        {/* =========================================
                            实验：脱敏文字 -> AI 理解全文
                            默认关闭，需要用户主动打开开关 + 手动确认发送
                        ========================================== */}

                        <div className="bg-yellow-50 border-2 border-yellow-400 rounded-xl p-4 space-y-3">

                          <label className="flex items-start gap-3 cursor-pointer">
                            <input
                              type="checkbox"
                              className="mt-1 w-5 h-5"
                              checked={experimentalEnabled}
                              onChange={(e) =>
                                toggleExperimental(e.target.checked)
                              }
                            />
                            <span className="text-base font-bold text-yellow-900">
                              实验功能：打开后，可以把本地已经挡掉个人信息的
                              内容发给 AI，让它读懂全文大意。金额和到期日
                              仍然只认本地识别的结果，这里 AI 给出的只作参考。
                            </span>
                          </label>

                          {experimentalEnabled && (
                            <>
                              <div className="flex gap-4">
                                <label className="flex items-center gap-2 text-sm font-bold text-yellow-900 cursor-pointer">
                                  <input
                                    type="radio"
                                    name="experimentMode"
                                    checked={experimentMode === 'text'}
                                    onChange={() => changeExperimentMode('text')}
                                  />
                                  发脱敏后的文字（挡下的行整行拿掉）
                                </label>
                                <label className="flex items-center gap-2 text-sm font-bold text-yellow-900 cursor-pointer">
                                  <input
                                    type="radio"
                                    name="experimentMode"
                                    checked={experimentMode === 'image'}
                                    onChange={() => changeExperimentMode('image')}
                                    disabled={!preparedDisplayBlob}
                                  />
                                  发打码后的图片（挡下的行涂黑）
                                </label>
                              </div>

                              {experimentMode === 'image' && !preparedDisplayBlob && (
                                <p className="text-sm font-bold text-red-700">
                                  这张照片还没有可用的预处理图片，暂时用不了打码模式。
                                </p>
                              )}

                              <button
                                type="button"
                                onClick={runExperimentalUnderstanding}
                                disabled={
                                  experimentLoading ||
                                  (experimentMode === 'image' && !preparedDisplayBlob)
                                }
                                className="w-full py-3 rounded-xl bg-yellow-500 hover:bg-yellow-600 disabled:opacity-50 text-white font-black text-lg"
                              >
                                {experimentLoading
                                  ? experimentMode === 'image'
                                    ? '正在打码并发送图片给 AI……'
                                    : '正在发送脱敏文字给 AI……'
                                  : experimentMode === 'image'
                                    ? `确认打码 ${translatable.withheld.length} 处后发图片给 AI`
                                    : `确认发送这 ${translatable.stats.sendableCount} 处脱敏后的文字给 AI`}
                              </button>

                              {experimentMode === 'image' && maskedPreviewUrl && (
                                <details className="bg-white border-2 border-indigo-200 rounded-xl p-4">
                                  <summary className="cursor-pointer text-base font-black text-indigo-900">
                                    看看打码之后发出去的是这张图
                                  </summary>
                                  <img
                                    src={maskedPreviewUrl}
                                    alt="打码后的信件"
                                    className="mt-3 w-full rounded-lg border border-indigo-200"
                                  />
                                </details>
                              )}

                              {experimentError && (
                                <p className="text-base font-bold text-red-700">
                                  {experimentError}
                                </p>
                              )}

                              {experimentResult && (
                                <div className="bg-white border-2 border-yellow-300 rounded-xl p-4 space-y-2">

                                  <p className="text-sm font-black text-yellow-700 uppercase">
                                    实验性 · AI 理解结果 · 未经本地验算
                                  </p>

                                  <p className="text-lg font-bold text-slate-900">
                                    {experimentResult.summary_cn}
                                  </p>

                                  <p className="text-base text-slate-800">
                                    第一步该做什么：{experimentResult.action_cn}
                                  </p>

                                  <p className="text-base text-slate-800">
                                    不处理的风险：{experimentResult.risk_reason_cn}
                                  </p>

                                  {(experimentResult.amount != null ||
                                    experimentResult.due_date) && (
                                    <p className="text-sm text-slate-500">
                                      AI 读到的金额/日期（仅供参考，不是本地
                                      结果）：
                                      {experimentResult.amount != null
                                        ? ` $${experimentResult.amount}`
                                        : ''}
                                      {experimentResult.due_date
                                        ? ` · ${experimentResult.due_date}`
                                        : ''}
                                    </p>
                                  )}

                                  {experimentResult.confidence_note_cn && (
                                    <p className="text-sm font-bold text-orange-700">
                                      AI 自己说不确定的地方：
                                      {experimentResult.confidence_note_cn}
                                    </p>
                                  )}

                                </div>
                              )}
                            </>
                          )}

                        </div>

                      </div>
                    )}

                    {/* OCR STATUS */}

                    <div className="bg-green-50 border-4 border-green-400 p-5 rounded-2xl">

                      <div className="flex items-center gap-3 mb-3">

                        <CheckCircle
                          size={40}
                          className="text-green-600"
                        />

                        <div>

                          <h2 className="text-2xl font-black text-green-950">
                            本地 OCR + 关键字段二次识别完成
                          </h2>

                          <p className="text-green-800 font-medium">
                            原始照片和 OCR 文字都没有上传。只有在你自己打开
                            上面的实验开关、并手动确认发送之后，脱敏后的文字
                            或打码后的图片才会发给后端。
                          </p>

                        </div>

                      </div>

                      {ocrConfidence !==
                        null && (
                        <div className="bg-white rounded-xl p-4 mb-3">

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


                    {/* PII */}

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

                          {
                            piiResults.length
                          }

                          <span className="text-xl ml-2">
                            个可能的个人信息
                          </span>

                        </p>

                      </div>

                      {piiResults.length >
                        0 && (
                        <div className="mt-4 space-y-3">

                          <h3 className="font-black text-lg text-orange-950">
                            检测结果
                          </h3>

                          {piiResults.map(
                            (
                              item,
                              index
                            ) => (
                              <div
                                key={`${item.type || 'pii'}-${item.start ?? index}-${index}`}
                                className="bg-white border-2 border-orange-200 rounded-xl p-4"
                              >

                                <p className="text-sm text-orange-700 font-bold">
                                  {
                                    item.type ||
                                    'PII'
                                  }
                                </p>

                                <p className="font-black text-slate-900 break-all">
                                  {
                                    item.value ||
                                    '[检测到信息]'
                                  }
                                </p>

                                {item.placeholder && (
                                  <p className="text-sm text-slate-500 mt-1">
                                    Redaction：
                                    {
                                      item.placeholder
                                    }
                                  </p>
                                )}

                              </div>
                            )
                          )}

                        </div>
                      )}

                      {piiResults.length ===
                        0 && (
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


                    {/* REDACTED OCR */}

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
                            {
                              redactedOcrText
                            }
                          </pre>
                        ) : (
                          <p className="text-slate-500">
                            没有可显示的脱敏文字。
                          </p>
                        )}

                      </div>

                    </div>


                    {/* ORIGINAL OCR */}

                    <details className="bg-white border-4 border-slate-300 rounded-2xl p-5 shadow-sm">

                      <summary className="cursor-pointer font-black text-xl text-slate-900">
                        查看最终 OCR 文字
                      </summary>

                      <div className="flex items-center justify-between gap-3 mt-4 mb-3">

                        <p className="text-sm text-slate-500">
                          本地 OCR 的最终结果
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
                            {
                              ocrText
                            }
                          </pre>
                        ) : (
                          <p className="text-red-600 font-bold">
                            没有读取到文字。
                          </p>
                        )}

                      </div>

                    </details>


                    {/* TECHNICAL INFORMATION */}

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
                            {ocrModelVersion ||
                              '初始化中'}
                          </strong>
                        </p>

                        <p>
                          Preprocess：
                          <strong className="text-green-300">
                            {' '}
                            {imagePrepReport
                              ? imagePrepReport
                                  .fellBack
                                ? '仅缩放（回退）'
                                : imagePrepReport
                                    .steps
                                    .length
                                  ? imagePrepReport.steps.join(
                                      ' + '
                                    )
                                  : '无需矫正'
                              : 'N/A'}
                          </strong>
                        </p>

                        {imagePrepReport && (
                          <>
                            <p>
                              Perspective Fix：
                              <strong>
                                {' '}
                                {imagePrepReport
                                  .warp &&
                                imagePrepReport
                                  .warp.applied
                                  ? '已应用'
                                  : `跳过（${
                                      imagePrepReport
                                        .warp
                                        ?.reason ||
                                      'n/a'
                                    }）`}
                              </strong>
                            </p>

                            <p>
                              Deskew：
                              <strong>
                                {' '}
                                {typeof imagePrepReport.deskewDeg ===
                                'number'
                                  ? `${imagePrepReport.deskewDeg}°`
                                  : 'N/A'}
                              </strong>
                            </p>

                            <p>
                              Illumination：
                              <strong>
                                {' '}
                                {imagePrepReport
                                  .photometric
                                  ?.applied
                                  ? '已归一化'
                                  : `跳过（${
                                      imagePrepReport
                                        .photometric
                                        ?.reason ||
                                      'n/a'
                                    }）`}
                              </strong>
                            </p>

                            <p>
                              Preprocess Time：
                              <strong>
                                {' '}
                                {imagePrepReport.elapsedMs}{' '}
                                ms
                              </strong>
                            </p>
                          </>
                        )}

                        <p>
                          Execution：
                          <strong className="text-green-300">
                            {' '}
                            Browser Local
                          </strong>
                        </p>

                        <p>
                          First Pass：
                          <strong className="text-green-300">
                            {' '}
                            Full-page OCR
                          </strong>
                        </p>

                        <p>
                          Second Pass：
                          <strong className="text-green-300">
                            {' '}
                            Critical-region Re-OCR
                          </strong>
                        </p>

                        <p>
                          Worker：
                          <strong
                            className={
                              ocrWorkerActive ===
                              false
                                ? 'text-amber-300'
                                : 'text-green-300'
                            }
                          >
                            {' '}
                            {ocrWorkerActive ===
                            null
                              ? '—'
                              : ocrWorkerActive
                                ? 'Web Worker'
                                : 'Main Thread (Fallback)'}
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
                            {
                              piiResults.length
                            }
                          </strong>
                        </p>

                        <p>
                          Original OCR Text：
                          <strong>
                            {' '}
                            {
                              ocrText.length
                            }
                          </strong>{' '}
                          characters
                        </p>

                        <p>
                          Redacted OCR Text：
                          <strong>
                            {' '}
                            {
                              redactedOcrText.length
                            }
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


                    {/* PII JSON */}

                    {piiResults.length >
                      0 && (
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


                    {/* OCR LINES */}

                    {ocrLines.length >
                      0 && (
                      <details className="bg-slate-50 border-2 border-slate-300 rounded-2xl p-4">

                        <summary className="cursor-pointer font-bold text-lg text-slate-800">
                          查看 PaddleOCR Lines + Bounding Box
                        </summary>

                        <div className="mt-4 overflow-x-auto">

                          <pre className="text-xs text-slate-700 whitespace-pre-wrap break-all">
                            {JSON.stringify(
                              ocrLines,
                              null,
                              2
                            )}
                          </pre>

                        </div>

                      </details>
                    )}


                    {/* OCR BLOCKS */}

                    {ocrBlocks.length >
                      0 && (
                      <details className="bg-slate-50 border-2 border-slate-300 rounded-2xl p-4">

                        <summary className="cursor-pointer font-bold text-lg text-slate-800">
                          查看 OCR Layout Blocks
                        </summary>

                        <div className="mt-4 space-y-3">

                          {ocrBlocks.map(
                            (
                              block
                            ) => (
                              <div
                                key={
                                  block.id
                                }
                                className="bg-white border border-slate-200 rounded-xl p-4"
                              >

                                <p className="font-black text-slate-900 mb-2">
                                  Block{' '}
                                  {
                                    block.id
                                  }
                                </p>

                                <pre className="text-sm text-slate-700 whitespace-pre-wrap break-words">
                                  {
                                    block.text
                                  }
                                </pre>

                                <p className="text-xs text-slate-400 mt-2">
                                  bbox:{' '}
                                  {JSON.stringify(
                                    block.bbox
                                  )}
                                </p>

                              </div>
                            )
                          )}

                        </div>

                      </details>
                    )}


                    {/* SECURITY NOTE */}

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

                            第一遍 OCR 读取整张信件。

                            <br />
                            <br />

                            读不准的时候，小助手会告诉您该重拍哪一块，而不是自己猜。

                            <br />
                            <br />

                            PII Detection 使用本地正则和 Luhn 校验。

                            <br />
                            <br />

                            目前还没有把照片或 OCR 文字发送给 AI。

                            <br />
                            <br />

                            注意：当前 PII Detection 是规则型检测，不代表能够发现照片中的全部个人信息。

                          </p>

                        </div>

                      </div>

                    </div>


                    {/* BUTTONS */}

                    <div className="flex gap-4">

                      <button
                        onClick={
                          handleClose
                        }
                        className="flex-1 bg-slate-200 hover:bg-slate-300 text-slate-800 font-bold text-xl py-4 rounded-2xl flex items-center justify-center space-x-2"
                      >
                        <X
                          size={24}
                        />

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

        {error &&
          !loading && (
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
                  onClick={
                    handleClose
                  }
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