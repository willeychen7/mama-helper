/**
 * 从 App.jsx 里原样搬过来的几个纯函数（getVerticalOverlapRatio /
 * isSameTextRow / buildVisualRows / detectLikelyColumns /
 * sortColumnLines / buildSpatialReadingOrder），只为了让
 * fixture-regen 工具重建 demo_ocr_pp.json 时，行的排列顺序
 * 跟真实用户在主应用里看到的一致（多栏版面、跨栏对齐这些细节
 * 靠这套逻辑处理，不是简单按 y 坐标排序就够）。
 *
 * 没有从 App.jsx import——那是个 React 组件文件，不适合被独立工具
 * 当库用；这里是逐字复制，没有改动任何判断逻辑。如果以后
 * App.jsx 里这几个函数改了，这里也要跟着同步，不然两边会分叉。
 */

const getVerticalOverlapRatio = (a, b) => {
  const top = Math.max(a.top, b.top);
  const bottom = Math.min(a.bottom, b.bottom);
  const overlap = Math.max(0, bottom - top);
  const minHeight = Math.min(a.height, b.height);
  if (minHeight <= 0) return 0;
  return overlap / minHeight;
};

const isSameTextRow = (a, b) => {
  const verticalOverlap = getVerticalOverlapRatio(a, b);
  if (verticalOverlap >= 0.35) return true;
  const centerDistance = Math.abs(a.centerY - b.centerY);
  const referenceHeight = Math.min(a.height, b.height);
  return centerDistance <= Math.max(8, referenceHeight * 0.55);
};

const buildVisualRows = (lines) => {
  const rows = [];
  const sorted = [...lines].sort((a, b) => {
    if (Math.abs(a.centerY - b.centerY) > 4) return a.top - b.top;
    return a.left - b.left;
  });

  sorted.forEach((line) => {
    let bestRow = null;
    let bestScore = -Infinity;

    rows.forEach((row) => {
      const representative = row.lines[0];
      if (!isSameTextRow(line, representative)) return;
      const verticalDistance = Math.abs(line.centerY - row.centerY);
      const score = -verticalDistance;
      if (score > bestScore) {
        bestScore = score;
        bestRow = row;
      }
    });

    if (!bestRow) {
      rows.push({ lines: [line], top: line.top, bottom: line.bottom, centerY: line.centerY });
      return;
    }

    bestRow.lines.push(line);
    bestRow.top = Math.min(bestRow.top, line.top);
    bestRow.bottom = Math.max(bestRow.bottom, line.bottom);
    bestRow.centerY = (bestRow.top + bestRow.bottom) / 2;
  });

  rows.forEach((row) => row.lines.sort((a, b) => a.left - b.left));
  rows.sort((a, b) => a.top - b.top);
  return rows;
};

const detectLikelyColumns = (lines) => {
  if (lines.length < 6) return null;

  const pageLeft = Math.min(...lines.map((line) => line.left));
  const pageRight = Math.max(...lines.map((line) => line.right));
  const pageWidth = pageRight - pageLeft;
  if (pageWidth <= 0) return null;

  const centers = lines.map((line) => line.centerX);
  const sortedCenters = [...centers].sort((a, b) => a - b);

  let largestGap = 0;
  let largestGapIndex = -1;
  for (let i = 1; i < sortedCenters.length; i += 1) {
    const gap = sortedCenters[i] - sortedCenters[i - 1];
    if (gap > largestGap) {
      largestGap = gap;
      largestGapIndex = i;
    }
  }

  if (largestGap < pageWidth * 0.18) return null;

  const leftCenters = sortedCenters.slice(0, largestGapIndex);
  const rightCenters = sortedCenters.slice(largestGapIndex);
  if (leftCenters.length < 3 || rightCenters.length < 3) return null;

  const leftBoundary = (leftCenters[leftCenters.length - 1] + rightCenters[0]) / 2;
  const leftLines = lines.filter((line) => line.centerX < leftBoundary);
  const rightLines = lines.filter((line) => line.centerX >= leftBoundary);
  if (leftLines.length < 3 || rightLines.length < 3) return null;

  const leftWidth = Math.max(...leftLines.map((l) => l.right)) - Math.min(...leftLines.map((l) => l.left));
  const rightWidth = Math.max(...rightLines.map((l) => l.right)) - Math.min(...rightLines.map((l) => l.left));
  if (leftWidth < pageWidth * 0.2 || rightWidth < pageWidth * 0.2) return null;

  return { left: leftLines, right: rightLines, boundary: leftBoundary };
};

const sortColumnLines = (lines) => {
  const rows = buildVisualRows(lines);
  const result = [];
  rows.forEach((row) => row.lines.forEach((line) => result.push(line)));
  return result;
};

export const buildSpatialReadingOrder = (lines) => {
  if (!lines.length) return [];

  const columns = detectLikelyColumns(lines);
  if (!columns) return sortColumnLines(lines);

  const allLeft = Math.min(...lines.map((line) => line.left));
  const allRight = Math.max(...lines.map((line) => line.right));
  const pageWidth = allRight - allLeft;

  const fullWidthLines = lines.filter((line) => line.width / pageWidth >= 0.65);
  const columnLines = lines.filter((line) => !fullWidthLines.includes(line));
  const leftColumn = columnLines.filter((line) => line.centerX < columns.boundary);
  const rightColumn = columnLines.filter((line) => line.centerX >= columns.boundary);

  return [...sortColumnLines(fullWidthLines), ...sortColumnLines(leftColumn), ...sortColumnLines(rightColumn)];
};
