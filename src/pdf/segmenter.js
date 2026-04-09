import { OPS } from "../vendor/pdf.mjs";

const MIN_SEGMENT_TEXT_LENGTH = 24;
const MAX_LINE_MERGE_GAP = 16;
const MIN_TABLE_ROWS = 2;
const TABLE_COLUMN_GAP_FACTOR = 1.8;
const TABLE_LAYOUT_TOLERANCE = 26;
const TABLE_LINE_MERGE_TOLERANCE = 3;
const TABLE_INTERSECTION_TOLERANCE = 4;
const MIN_RULED_TABLE_WIDTH = 120;
const MIN_RULED_TABLE_HEIGHT = 72;
const MIN_RULED_LINE_LENGTH = 26;
const MIN_RULED_RECT_SIDE = 18;
const TABLE_REGION_PADDING = 6;
const RASTER_DARK_THRESHOLD = 170;
const RASTER_GAP_TOLERANCE = 2;
const RASTER_NEIGHBOR_RADIUS = 1;
const DRAW_OP_MOVE_TO = 0;
const DRAW_OP_LINE_TO = 1;
const DRAW_OP_CURVE_TO = 2;
const DRAW_OP_QUADRATIC_CURVE_TO = 3;
const DRAW_OP_CLOSE_PATH = 4;
const IDENTITY_MATRIX = [1, 0, 0, 1, 0, 0];

export function buildPageSegments(textContent, viewport, operatorList, canvas) {
  const diagnostics = createSegmentationDiagnostics();
  const textItems = Array.isArray(textContent?.items) ? textContent.items : [];
  const positionedItems = textItems
    .map((item) => toPositionedItem(item, viewport))
    .filter(Boolean)
    .sort((left, right) => {
      if (Math.abs(left.top - right.top) > 2) {
        return left.top - right.top;
      }

      return left.left - right.left;
    });

  const lines = buildLines(positionedItems);
  const pageMetrics = buildPageMetrics(lines, viewport.width);
  diagnostics.pageMetrics = pageMetrics;
  diagnostics.lines = lines.map((line) => serializeLineForDiagnostics(line));
  const operatorTableRegions = detectRuledTableRegions(positionedItems, lines, viewport, operatorList);
  const rasterTableRegions = operatorTableRegions.length === 0
    ? detectRasterTableRegions(positionedItems, lines, viewport, canvas)
    : [];
  const ruledTableRegions = [...operatorTableRegions, ...rasterTableRegions];
  const tableRegions = detectTableRegions(lines).filter((region) => !overlapsRuledRegion(region, lines, ruledTableRegions));
  diagnostics.tableRegions = [
    ...tableRegions.map((region) => ({ type: "text", start: region.start, end: region.end })),
    ...ruledTableRegions.map((region) => ({ type: "ruled", start: region.start, end: region.end }))
  ];
  const segments = buildSegmentsWithTables(lines, pageMetrics, tableRegions, ruledTableRegions, diagnostics);
  diagnostics.segments = segments.map((segment) => serializeSegmentForDiagnostics(segment));
  return {
    segments,
    diagnostics
  };
}

function createSegmentationDiagnostics() {
  return {
    pageMetrics: null,
    lines: [],
    transitions: [],
    segments: [],
    tableRegions: []
  };
}

function toPositionedItem(item, viewport) {
  if (!item || typeof item.str !== "string") {
    return null;
  }

  const normalizedText = item.str.replace(/\s+/g, " ").trim();
  if (!normalizedText) {
    return null;
  }

  const [left, baselineY] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
  const roughHeight = Math.max(10, (item.height || 0) * viewport.scale || Math.abs(item.transform[0]) * viewport.scale || 12);
  const roughWidth = Math.max(6, (item.width || normalizedText.length * 6) * viewport.scale);
  const top = Math.max(0, baselineY - roughHeight);

  return {
    text: normalizedText,
    left,
    top,
    width: roughWidth,
    height: roughHeight,
    right: left + roughWidth,
    bottom: top + roughHeight,
    hasEol: Boolean(item.hasEOL)
  };
}

function buildLines(items) {
  const lines = [];

  for (const item of items) {
    const current = lines[lines.length - 1];
    if (!current || !belongsToLine(current, item)) {
      lines.push(createLine(item));
      continue;
    }

    appendItemToLine(current, item);
  }

  return lines
    .map(finalizeLine)
    .filter((line) => line.text.length > 0)
    .map((line, index) => ({
      ...line,
      sourceIndex: index
    }));
}

function belongsToLine(line, item) {
  const verticalDrift = Math.abs(item.top - line.top);
  return verticalDrift <= Math.max(8, line.height * 0.7);
}

function createLine(item) {
  return {
    items: [item],
    top: item.top,
    left: item.left,
    right: item.right,
    bottom: item.bottom,
    height: item.height
  };
}

function appendItemToLine(line, item) {
  line.items.push(item);
  line.top = Math.min(line.top, item.top);
  line.left = Math.min(line.left, item.left);
  line.right = Math.max(line.right, item.right);
  line.bottom = Math.max(line.bottom, item.bottom);
  line.height = Math.max(line.height, item.height);
}

function finalizeLine(line) {
  const ordered = line.items.slice().sort((left, right) => left.left - right.left);
  const parts = [];

  for (let index = 0; index < ordered.length; index += 1) {
    const item = ordered[index];
    const previous = ordered[index - 1];

    if (previous) {
      const gap = item.left - previous.right;
      if (gap > Math.max(previous.height * 0.28, 3)) {
        parts.push(" ");
      }
    }

    parts.push(item.text);
  }

  return {
    text: parts.join("").replace(/\s+/g, " ").trim(),
    items: ordered,
    top: line.top,
    left: line.left,
    right: line.right,
    bottom: line.bottom,
    width: Math.max(0, line.right - line.left),
    height: Math.max(0, line.bottom - line.top),
    endsParagraph: ordered.some((item) => item.hasEol),
    center: (line.left + line.right) / 2
  };
}

function buildSegments(lines, pageMetrics, diagnostics = null) {
  const segments = [];
  let current = null;

  for (const line of lines) {
    if (!line.text) {
      continue;
    }

    if (!current) {
      current = createSegment(line, segments.length + 1);
      segments.push(current);
      continue;
    }

    const decision = getSegmentBreakDecision(current, line, pageMetrics);
    recordSegmentationDecision(diagnostics, current, line, decision);
    if (decision.shouldBreak) {
      current = createSegment(line, segments.length + 1);
      segments.push(current);
      continue;
    }

    current.lines.push(line);
    current.textParts.push(joinLineText(current, line));
    current.top = Math.min(current.top, line.top);
    current.left = Math.min(current.left, line.left);
    current.right = Math.max(current.right, line.right);
    current.bottom = Math.max(current.bottom, line.bottom);
  }

  return segments
    .map((segment) => finalizeSegment(segment, pageMetrics))
    .filter((segment) => shouldKeepTextSegment(segment));
}

function getSegmentBreakDecision(current, line, pageMetrics) {
  const previous = current.lines[current.lines.length - 1];
  const verticalGap = line.top - previous.bottom;
  const pageWidth = pageMetrics.pageWidth;
  const typicalGap = pageMetrics.typicalGap;
  const typicalLineHeight = pageMetrics.typicalLineHeight;
  const currentLineHeight = median(current.lines.map((item) => item.height)) || previous.height || typicalLineHeight;
  const currentLeft = median(current.lines.map((item) => item.left)) || previous.left || 0;
  const oneLineBreakThreshold = Math.max(typicalLineHeight * 0.95, currentLineHeight * 0.95, previous.height * 0.95, 10);
  const fontChangeThreshold = Math.max(2.5, typicalLineHeight * 0.16);
  const indentThreshold = Math.max(currentLineHeight * 1.1, typicalLineHeight * 1.1, 12);
  const obviousFontChange = Math.abs(line.height - currentLineHeight) >= fontChangeThreshold;
  const obviousIndent = line.left - currentLeft >= indentThreshold;
  const metrics = {
    verticalGap: roundForDebug(verticalGap),
    oneLineBreakThreshold: roundForDebug(oneLineBreakThreshold),
    currentLineHeight: roundForDebug(currentLineHeight),
    nextLineHeight: roundForDebug(line.height),
    fontDifference: roundForDebug(Math.abs(line.height - currentLineHeight)),
    fontChangeThreshold: roundForDebug(fontChangeThreshold),
    indentDelta: roundForDebug(line.left - currentLeft),
    indentThreshold: roundForDebug(indentThreshold),
    typicalGap: roundForDebug(typicalGap),
    typicalLineHeight: roundForDebug(typicalLineHeight)
  };

  const titleContinuationMetrics = getTitleContinuationMetrics(current, line, pageWidth, typicalLineHeight, currentLineHeight);
  if (titleContinuationMetrics.shouldMerge) {
    return {
      shouldBreak: false,
      reason: "merge-title-continuation",
      metrics: {
        ...metrics,
        titleTopLimit: roundForDebug(titleContinuationMetrics.titleTopLimit),
        titleGapThreshold: roundForDebug(titleContinuationMetrics.titleGapThreshold),
        centerOffset: roundForDebug(titleContinuationMetrics.centerOffset),
        centerTolerance: roundForDebug(titleContinuationMetrics.centerTolerance),
        widthRatio: roundForDebug(titleContinuationMetrics.widthRatio)
      }
    };
  }

  if (verticalGap >= oneLineBreakThreshold) {
    return { shouldBreak: true, reason: "vertical-gap-exceeds-one-line", metrics };
  }

  if (obviousFontChange && verticalGap > Math.max(typicalGap * 0.4, 1)) {
    return { shouldBreak: true, reason: "font-size-changed", metrics };
  }

  if (obviousIndent && verticalGap > Math.max(typicalGap * 0.2, 0)) {
    return { shouldBreak: true, reason: "indent-detected", metrics };
  }

  if (looksLikeListItem(line.text) && !looksLikeListItem(previous.text)) {
    return { shouldBreak: true, reason: "list-item-start", metrics };
  }

  if (!looksLikeListItem(line.text) && looksLikeListItem(previous.text) && obviousIndent) {
    return { shouldBreak: true, reason: "list-item-to-indented-body", metrics };
  }

  return { shouldBreak: false, reason: "merge-same-paragraph", metrics };
}

function recordSegmentationDecision(diagnostics, current, line, decision) {
  if (!diagnostics) {
    return;
  }

  const previous = current.lines[current.lines.length - 1];
  diagnostics.transitions.push({
    previousLineIndex: previous.sourceIndex,
    currentLineIndex: line.sourceIndex,
    shouldBreak: decision.shouldBreak,
    reason: decision.reason,
    metrics: decision.metrics,
    previousText: truncateForDebug(previous.text),
    currentText: truncateForDebug(line.text)
  });
}

function createSegment(line, index) {
  return {
    index,
    lines: [line],
    textParts: [line.text],
    top: line.top,
    left: line.left,
    right: line.right,
    bottom: line.bottom
  };
}

function joinLineText(segment, line) {
  const previousText = segment.textParts[segment.textParts.length - 1] || "";
  if (!previousText) {
    return line.text;
  }

  if (/[-\u2010\u2011\u2012\u2013]$/.test(previousText)) {
    return line.text;
  }

  return ` ${line.text}`;
}

function finalizeSegment(segment, pageMetrics) {
  const lineCount = segment.lines.length || 1;
  const averageLineHeight = segment.lines.reduce((sum, line) => sum + line.height, 0) / lineCount;
  const kind = inferTextSegmentKind(segment, pageMetrics, averageLineHeight);

  return {
    index: segment.index,
    kind,
    text: segment.textParts.join("").replace(/\n{3,}/g, "\n\n").trim(),
    preview: segment.textParts.join(" ").replace(/\s+/g, " ").trim().slice(0, 180),
    lineCount,
    averageLineHeight,
    rect: {
      top: segment.top,
      left: segment.left,
      width: Math.max(24, segment.right - segment.left),
      height: Math.max(18, segment.bottom - segment.top)
    }
  };
}

function inferTextSegmentKind(segment, pageMetrics, averageLineHeight) {
  const lines = Array.isArray(segment.lines) ? segment.lines : [];
  const text = segment.textParts.join(" ").replace(/\s+/g, " ").trim();
  const pageWidth = pageMetrics?.pageWidth || 0;
  const typicalLineHeight = pageMetrics?.typicalLineHeight || averageLineHeight || 10;
  const titleTopLimit = Math.max(typicalLineHeight * 12, 180);
  const looksLikeList = looksLikeListItem(text);
  const endsWithSentence = /[。！？.!?；;：:]$/.test(text);
  const allTitleLike = lines.length > 0 && lines.every((line) => isTitleLikeLine(line, pageWidth));

  if (allTitleLike && !looksLikeList && segment.top <= titleTopLimit) {
    return lines.length >= 2 ? "title" : "heading";
  }

  if (!looksLikeList && !endsWithSentence && text.length > 0 && text.length <= 120 && lines.length <= 2) {
    return "heading";
  }

  if (looksLikeList) {
    return "list-item";
  }

  return "body";
}

function shouldKeepTextSegment(segment) {
  const kind = segment?.kind || "body";
  const textLength = String(segment?.text || "").trim().length;

  if (textLength >= MIN_SEGMENT_TEXT_LENGTH) {
    return true;
  }

  return kind === "list-item" || kind === "title" || kind === "heading";
}

function looksLikeListItem(text) {
  return /^[（(]?[0-9一二三四五六七八九十]+[)）.、]/.test(String(text || "").trim());
}

function getTitleContinuationMetrics(current, line, pageWidth, typicalLineHeight, currentLineHeight) {
  const currentLines = current.lines || [];
  const previous = currentLines[currentLines.length - 1];
  const allCurrentAreTitleLike = currentLines.length > 0 && currentLines.every((item) => isTitleLikeLine(item, pageWidth));
  const nextIsTitleLike = isTitleLikeLine(line, pageWidth);
  const verticalGap = line.top - previous.bottom;
  const titleGapThreshold = Math.max(currentLineHeight * 1.9, typicalLineHeight * 1.9, 18);
  const titleTopLimit = Math.max(typicalLineHeight * 10, 160);
  const centerOffset = Math.abs(line.center - pageWidth / 2);
  const centerTolerance = pageWidth * 0.18;
  const widthRatio = line.width / Math.max(pageWidth, 1);
  const fontDifference = Math.abs(line.height - previous.height);
  const shouldMerge = allCurrentAreTitleLike
    && nextIsTitleLike
    && current.top <= titleTopLimit
    && currentLines.length < 5
    && verticalGap <= titleGapThreshold
    && fontDifference <= Math.max(2, typicalLineHeight * 0.18)
    && centerOffset <= centerTolerance
    && widthRatio <= 0.82;

  return {
    shouldMerge,
    titleGapThreshold,
    titleTopLimit,
    centerOffset,
    centerTolerance,
    widthRatio
  };
}

function isTitleLikeLine(line, pageWidth) {
  if (!line?.text) {
    return false;
  }

  const normalized = line.text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return false;
  }

  const centerOffset = Math.abs(line.center - pageWidth / 2);
  const centered = centerOffset <= pageWidth * 0.18;
  const shortLine = normalized.length <= 120;
  const widthRatio = line.width / Math.max(pageWidth, 1);
  const noSentenceEnd = !/[。！？.!?；;：:]$/.test(normalized);
  const noListMarker = !looksLikeListItem(normalized);

  return centered && shortLine && widthRatio <= 0.82 && noSentenceEnd && noListMarker;
}

function buildPageMetrics(lines, pageWidth) {
  const heights = lines.map((line) => line.height).filter((value) => Number.isFinite(value) && value > 0);
  const gaps = [];

  for (let index = 1; index < lines.length; index += 1) {
    const previous = lines[index - 1];
    const current = lines[index];
    const gap = current.top - previous.bottom;
    if (Number.isFinite(gap) && gap >= 0) {
      gaps.push(gap);
    }
  }

  return {
    pageWidth,
    typicalLineHeight: median(heights) || 14,
    typicalGap: Math.max(2, median(gaps) || 4)
  };
}

function median(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return 0;
  }

  const sorted = values.slice().sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle];
  }

  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function detectRuledTableRegions(items, lines, viewport, operatorList) {
  const rawLineSegments = extractRuledLineSegments(operatorList, viewport);
  if (rawLineSegments.length === 0) {
    return [];
  }

  const horizontal = normalizeAxisLines(rawLineSegments.filter((line) => line.axis === "h"));
  const vertical = normalizeAxisLines(rawLineSegments.filter((line) => line.axis === "v"));
  if (horizontal.length === 0 || vertical.length === 0) {
    return [];
  }

  const components = buildLineComponents(horizontal, vertical);
  const tables = [];

  for (const component of components) {
    const grid = buildGridFromComponent(component);
    if (!grid) {
      continue;
    }

    const table = buildRuledTableRegion(items, lines, grid);
    if (table) {
      tables.push(table);
    }
  }

  return tables.sort((left, right) => left.start - right.start);
}

function detectRasterTableRegions(items, lines, viewport, canvas) {
  const rawLineSegments = extractRasterLineSegments(canvas, viewport);
  if (rawLineSegments.length === 0) {
    return [];
  }

  const horizontal = normalizeAxisLines(rawLineSegments.filter((line) => line.axis === "h"));
  const vertical = normalizeAxisLines(rawLineSegments.filter((line) => line.axis === "v"));
  if (horizontal.length === 0 || vertical.length === 0) {
    return [];
  }

  const components = buildLineComponents(horizontal, vertical);
  const tables = [];

  for (const component of components) {
    const grid = buildGridFromComponent(component);
    if (!grid) {
      continue;
    }

    const table = buildRuledTableRegion(items, lines, grid);
    if (table) {
      tables.push(table);
    }
  }

  return tables.sort((left, right) => left.start - right.start);
}

function extractRuledLineSegments(operatorList, viewport) {
  if (!operatorList?.fnArray || !operatorList?.argsArray) {
    return [];
  }

  const segments = [];
  let currentTransform = IDENTITY_MATRIX.slice();
  const stack = [];

  for (let index = 0; index < operatorList.fnArray.length; index += 1) {
    const fnId = operatorList.fnArray[index];
    const fnArgs = operatorList.argsArray[index] || [];

    if (fnId === OPS.save) {
      stack.push(currentTransform.slice());
      continue;
    }

    if (fnId === OPS.restore) {
      currentTransform = stack.pop() || IDENTITY_MATRIX.slice();
      continue;
    }

    if (fnId === OPS.transform) {
      currentTransform = multiplyMatrices(currentTransform, fnArgs);
      continue;
    }

    if (fnId !== OPS.constructPath) {
      continue;
    }

    const [paintOp, data, minMax] = fnArgs;
    if (!isStrokePathOperation(paintOp)) {
      continue;
    }

    const pathData = Array.isArray(data) ? data[0] : null;
    if (Array.isArray(pathData) && pathData.length > 0) {
      segments.push(...extractAxisSegmentsFromPath(pathData, currentTransform, viewport));
    }

    if (Array.isArray(minMax) && minMax.length >= 4) {
      segments.push(...extractAxisSegmentsFromBounds(minMax, currentTransform, viewport));
    }
  }

  return segments;
}

function extractRasterLineSegments(canvas, viewport) {
  if (!canvas) {
    return [];
  }

  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    return [];
  }

  const width = canvas.width;
  const height = canvas.height;
  if (!width || !height) {
    return [];
  }

  const imageData = context.getImageData(0, 0, width, height);
  const horizontalSegments = extractRasterAxisSegments(imageData, viewport, "h");
  const verticalSegments = extractRasterAxisSegments(imageData, viewport, "v");
  return [...horizontalSegments, ...verticalSegments];
}

function extractRasterAxisSegments(imageData, viewport, axis) {
  const { data, width, height } = imageData;
  const segments = [];
  const majorLimit = axis === "h" ? height : width;
  const minorLimit = axis === "h" ? width : height;
  const minRunPx = Math.max(
    36,
    Math.round((MIN_RULED_LINE_LENGTH * (axis === "h" ? width : height)) / Math.max(axis === "h" ? viewport.width : viewport.height, 1))
  );

  for (let major = 0; major < majorLimit; major += 1) {
    let runStart = -1;
    let lastDark = -1;

    for (let minor = 0; minor < minorLimit; minor += 1) {
      const x = axis === "h" ? minor : major;
      const y = axis === "h" ? major : minor;
      const dark = hasDarkNeighborhood(data, width, height, x, y, axis);

      if (dark) {
        if (runStart === -1) {
          runStart = minor;
        }
        lastDark = minor;
        continue;
      }

      if (runStart !== -1 && minor - lastDark <= RASTER_GAP_TOLERANCE) {
        continue;
      }

      if (runStart !== -1) {
        pushRasterSegment(segments, axis, major, runStart, lastDark, minRunPx, width, height, viewport);
      }

      runStart = -1;
      lastDark = -1;
    }

    if (runStart !== -1) {
      pushRasterSegment(segments, axis, major, runStart, lastDark, minRunPx, width, height, viewport);
    }
  }

  return segments;
}

function hasDarkNeighborhood(data, width, height, x, y, axis) {
  for (let dy = -RASTER_NEIGHBOR_RADIUS; dy <= RASTER_NEIGHBOR_RADIUS; dy += 1) {
    for (let dx = -RASTER_NEIGHBOR_RADIUS; dx <= RASTER_NEIGHBOR_RADIUS; dx += 1) {
      if (axis === "h" && Math.abs(dy) > 0 && Math.abs(dx) > 0) {
        continue;
      }
      if (axis === "v" && Math.abs(dx) > 0 && Math.abs(dy) > 0) {
        continue;
      }

      const px = x + dx;
      const py = y + dy;
      if (px < 0 || py < 0 || px >= width || py >= height) {
        continue;
      }

      const offset = (py * width + px) * 4;
      const alpha = data[offset + 3];
      if (alpha < 200) {
        continue;
      }

      const luminance = (data[offset] * 0.2126) + (data[offset + 1] * 0.7152) + (data[offset + 2] * 0.0722);
      if (luminance <= RASTER_DARK_THRESHOLD) {
        return true;
      }
    }
  }

  return false;
}

function pushRasterSegment(segments, axis, major, runStart, runEnd, minRunPx, width, height, viewport) {
  if (runStart === -1 || runEnd - runStart + 1 < minRunPx) {
    return;
  }

  const scaleX = viewport.width / Math.max(width, 1);
  const scaleY = viewport.height / Math.max(height, 1);

  if (axis === "h") {
    segments.push({
      axis: "h",
      coord: major * scaleY,
      start: runStart * scaleX,
      end: runEnd * scaleX
    });
    return;
  }

  segments.push({
    axis: "v",
    coord: major * scaleX,
    start: runStart * scaleY,
    end: runEnd * scaleY
  });
}

function isStrokePathOperation(op) {
  return op === OPS.stroke
    || op === OPS.closeStroke
    || op === OPS.fillStroke
    || op === OPS.eoFillStroke
    || op === OPS.closeFillStroke
    || op === OPS.closeEOFillStroke;
}

function extractAxisSegmentsFromPath(pathData, transform, viewport) {
  const segments = [];
  let cursor = null;
  let subpathStart = null;

  for (let index = 0; index < pathData.length;) {
    const op = pathData[index++];

    if (op === DRAW_OP_MOVE_TO) {
      cursor = toViewportPoint(pathData[index++], pathData[index++], transform, viewport);
      subpathStart = cursor;
      continue;
    }

    if (op === DRAW_OP_LINE_TO) {
      const point = toViewportPoint(pathData[index++], pathData[index++], transform, viewport);
      if (cursor) {
        const axisSegment = toAxisSegment(cursor, point);
        if (axisSegment) {
          segments.push(axisSegment);
        }
      }
      cursor = point;
      continue;
    }

    if (op === DRAW_OP_CURVE_TO) {
      index += 4;
      cursor = toViewportPoint(pathData[index++], pathData[index++], transform, viewport);
      continue;
    }

    if (op === DRAW_OP_QUADRATIC_CURVE_TO) {
      index += 2;
      cursor = toViewportPoint(pathData[index++], pathData[index++], transform, viewport);
      continue;
    }

    if (op === DRAW_OP_CLOSE_PATH) {
      if (cursor && subpathStart) {
        const axisSegment = toAxisSegment(cursor, subpathStart);
        if (axisSegment) {
          segments.push(axisSegment);
        }
      }
      cursor = subpathStart;
    }
  }

  return segments;
}

function toViewportPoint(x, y, transform, viewport) {
  const applied = applyMatrix(transform, x, y);
  const [left, top] = viewport.convertToViewportPoint(applied.x, applied.y);
  return { x: left, y: top };
}

function applyMatrix(matrix, x, y) {
  return {
    x: matrix[0] * x + matrix[2] * y + matrix[4],
    y: matrix[1] * x + matrix[3] * y + matrix[5]
  };
}

function multiplyMatrices(left, right) {
  const next = Array.isArray(right) ? right : IDENTITY_MATRIX;
  return [
    left[0] * next[0] + left[2] * next[1],
    left[1] * next[0] + left[3] * next[1],
    left[0] * next[2] + left[2] * next[3],
    left[1] * next[2] + left[3] * next[3],
    left[0] * next[4] + left[2] * next[5] + left[4],
    left[1] * next[4] + left[3] * next[5] + left[5]
  ];
}

function toAxisSegment(start, end) {
  const dx = Math.abs(end.x - start.x);
  const dy = Math.abs(end.y - start.y);

  if (dy <= TABLE_INTERSECTION_TOLERANCE && dx >= MIN_RULED_LINE_LENGTH) {
    return {
      axis: "h",
      coord: (start.y + end.y) / 2,
      start: Math.min(start.x, end.x),
      end: Math.max(start.x, end.x)
    };
  }

  if (dx <= TABLE_INTERSECTION_TOLERANCE && dy >= MIN_RULED_LINE_LENGTH) {
    return {
      axis: "v",
      coord: (start.x + end.x) / 2,
      start: Math.min(start.y, end.y),
      end: Math.max(start.y, end.y)
    };
  }

  return null;
}

function extractAxisSegmentsFromBounds(minMax, transform, viewport) {
  const bounds = toViewportBounds(minMax, transform, viewport);
  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;

  if (height <= TABLE_INTERSECTION_TOLERANCE && width >= MIN_RULED_LINE_LENGTH) {
    return [{
      axis: "h",
      coord: (bounds.top + bounds.bottom) / 2,
      start: bounds.left,
      end: bounds.right
    }];
  }

  if (width <= TABLE_INTERSECTION_TOLERANCE && height >= MIN_RULED_LINE_LENGTH) {
    return [{
      axis: "v",
      coord: (bounds.left + bounds.right) / 2,
      start: bounds.top,
      end: bounds.bottom
    }];
  }

  if (width >= MIN_RULED_LINE_LENGTH && height >= MIN_RULED_RECT_SIDE) {
    return [
      {
        axis: "h",
        coord: bounds.top,
        start: bounds.left,
        end: bounds.right
      },
      {
        axis: "h",
        coord: bounds.bottom,
        start: bounds.left,
        end: bounds.right
      },
      {
        axis: "v",
        coord: bounds.left,
        start: bounds.top,
        end: bounds.bottom
      },
      {
        axis: "v",
        coord: bounds.right,
        start: bounds.top,
        end: bounds.bottom
      }
    ];
  }

  return [];
}

function toViewportBounds(minMax, transform, viewport) {
  const corners = [
    toViewportPoint(minMax[0], minMax[1], transform, viewport),
    toViewportPoint(minMax[0], minMax[3], transform, viewport),
    toViewportPoint(minMax[2], minMax[1], transform, viewport),
    toViewportPoint(minMax[2], minMax[3], transform, viewport)
  ];

  return {
    left: Math.min(...corners.map((point) => point.x)),
    right: Math.max(...corners.map((point) => point.x)),
    top: Math.min(...corners.map((point) => point.y)),
    bottom: Math.max(...corners.map((point) => point.y))
  };
}

function normalizeAxisLines(lines) {
  const sorted = lines.slice().sort((left, right) => {
    if (Math.abs(left.coord - right.coord) > TABLE_LINE_MERGE_TOLERANCE) {
      return left.coord - right.coord;
    }

    return left.start - right.start;
  });

  const merged = [];

  for (const line of sorted) {
    const current = merged[merged.length - 1];
    if (
      current
      && Math.abs(current.coord - line.coord) <= TABLE_LINE_MERGE_TOLERANCE
      && line.start <= current.end + TABLE_LINE_MERGE_TOLERANCE * 2
    ) {
      current.coord = (current.coord * current.weight + line.coord) / (current.weight + 1);
      current.start = Math.min(current.start, line.start);
      current.end = Math.max(current.end, line.end);
      current.weight += 1;
      continue;
    }

    merged.push({ ...line, weight: 1 });
  }

  return merged.map(({ weight, ...line }) => line);
}

function buildLineComponents(horizontal, vertical) {
  const nodes = [
    ...horizontal.map((line, index) => ({ id: `h-${index}`, axis: "h", line })),
    ...vertical.map((line, index) => ({ id: `v-${index}`, axis: "v", line }))
  ];
  const adjacency = new Map(nodes.map((node) => [node.id, new Set()]));

  horizontal.forEach((hLine, hIndex) => {
    vertical.forEach((vLine, vIndex) => {
      if (!linesIntersect(hLine, vLine)) {
        return;
      }

      adjacency.get(`h-${hIndex}`).add(`v-${vIndex}`);
      adjacency.get(`v-${vIndex}`).add(`h-${hIndex}`);
    });
  });

  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const visited = new Set();
  const components = [];

  for (const node of nodes) {
    if (visited.has(node.id) || adjacency.get(node.id).size === 0) {
      continue;
    }

    const queue = [node.id];
    const component = { horizontal: [], vertical: [] };
    visited.add(node.id);

    while (queue.length > 0) {
      const currentId = queue.shift();
      const current = nodeMap.get(currentId);
      if (!current) {
        continue;
      }

      if (current.axis === "h") {
        component.horizontal.push(current.line);
      } else {
        component.vertical.push(current.line);
      }

      for (const neighborId of adjacency.get(currentId)) {
        if (visited.has(neighborId)) {
          continue;
        }
        visited.add(neighborId);
        queue.push(neighborId);
      }
    }

    components.push(component);
  }

  return components;
}

function linesIntersect(horizontal, vertical) {
  return vertical.coord >= horizontal.start - TABLE_INTERSECTION_TOLERANCE
    && vertical.coord <= horizontal.end + TABLE_INTERSECTION_TOLERANCE
    && horizontal.coord >= vertical.start - TABLE_INTERSECTION_TOLERANCE
    && horizontal.coord <= vertical.end + TABLE_INTERSECTION_TOLERANCE;
}

function buildGridFromComponent(component) {
  const rows = clusterCoordinates(component.horizontal.map((line) => line.coord));
  const columns = clusterCoordinates(component.vertical.map((line) => line.coord));
  if (rows.length < 3 || columns.length < 2) {
    return null;
  }

  const left = Math.min(...columns);
  const right = Math.max(...columns);
  const top = Math.min(...rows);
  const bottom = Math.max(...rows);
  if (right - left < MIN_RULED_TABLE_WIDTH || bottom - top < MIN_RULED_TABLE_HEIGHT) {
    return null;
  }

  const strongRows = rows.filter((row) => countAxisIntersections("h", row, component.vertical, component.horizontal) >= 2);
  const strongColumns = columns.filter((column) => countAxisIntersections("v", column, component.horizontal, component.vertical) >= 2);
  if (strongRows.length < 3 || strongColumns.length < 2) {
    return null;
  }

  return {
    rows: strongRows,
    columns: strongColumns,
    bbox: { top, bottom, left, right }
  };
}

function clusterCoordinates(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return [];
  }

  const sorted = values.slice().sort((left, right) => left - right);
  const groups = [[sorted[0]]];

  for (let index = 1; index < sorted.length; index += 1) {
    const value = sorted[index];
    const current = groups[groups.length - 1];
    const average = current.reduce((sum, item) => sum + item, 0) / current.length;
    if (Math.abs(average - value) <= TABLE_LINE_MERGE_TOLERANCE) {
      current.push(value);
    } else {
      groups.push([value]);
    }
  }

  return groups.map((group) => group.reduce((sum, item) => sum + item, 0) / group.length);
}

function countAxisIntersections(axis, coord, crossLines, sameAxisLines) {
  const baseLine = sameAxisLines.find((line) => Math.abs(line.coord - coord) <= TABLE_LINE_MERGE_TOLERANCE);
  if (!baseLine) {
    return 0;
  }

  let count = 0;
  for (const cross of crossLines) {
    const intersects = axis === "h"
      ? linesIntersect(baseLine, cross)
      : linesIntersect(cross, baseLine);
    if (intersects) {
      count += 1;
    }
  }

  return count;
}

function buildRuledTableRegion(items, lines, grid) {
  const rowBands = buildBands(grid.rows);
  const columnBands = buildBands(grid.columns);
  if (rowBands.length === 0 || columnBands.length === 0) {
    return null;
  }

  const relevantLineIndexes = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.bottom >= grid.bbox.top - TABLE_REGION_PADDING && line.top <= grid.bbox.bottom + TABLE_REGION_PADDING && line.right >= grid.bbox.left - TABLE_REGION_PADDING && line.left <= grid.bbox.right + TABLE_REGION_PADDING)
    .map(({ index }) => index);
  if (relevantLineIndexes.length === 0) {
    return null;
  }

  const tableRows = rowBands.map((rowBand) => {
    return columnBands.map((columnBand) => {
      const cellItems = items.filter((item) => itemBelongsToCell(item, rowBand, columnBand));
      return serializeCellText(cellItems);
    });
  });

  const meaningfulRows = tableRows.some((row) => row.some((cell) => cell));
  if (!meaningfulRows) {
    return null;
  }

  return {
    start: relevantLineIndexes[0],
    end: relevantLineIndexes[relevantLineIndexes.length - 1],
    top: grid.bbox.top,
    bottom: grid.bbox.bottom,
    segment: buildStructuredTableSegment(tableRows, grid.bbox, {
      rowHeights: rowBands.map((band) => band.end - band.start),
      columnWidths: columnBands.map((band) => band.end - band.start),
      source: "ruled"
    })
  };
}

function buildBands(points) {
  const bands = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    if (end - start < 8) {
      continue;
    }
    bands.push({ start, end });
  }
  return bands;
}

function itemBelongsToCell(item, rowBand, columnBand) {
  const centerX = (item.left + item.right) / 2;
  const centerY = (item.top + item.bottom) / 2;
  return centerX >= columnBand.start - TABLE_REGION_PADDING
    && centerX <= columnBand.end + TABLE_REGION_PADDING
    && centerY >= rowBand.start - TABLE_REGION_PADDING
    && centerY <= rowBand.end + TABLE_REGION_PADDING;
}

function serializeCellText(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return "";
  }

  const cellLines = buildLines(items).map((line) => line.text).filter(Boolean);
  return cellLines.join("\n").trim();
}

function buildStructuredTableSegment(rows, bbox, layout = null) {
  const text = serializeStructuredTable(rows);
  const preview = rows.flat().filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  const normalizedLayout = normalizeTableLayout(layout, rows, bbox);

  return {
    index: 0,
    text,
    preview: (preview || "表格").slice(0, 180),
    lineCount: rows.length,
    averageLineHeight: (bbox.bottom - bbox.top) / Math.max(rows.length, 1),
    kind: "table",
    columnCount: Math.max(...rows.map((row) => row.length)),
    tableRows: rows,
    tableLayout: normalizedLayout,
    rect: {
      top: bbox.top,
      left: bbox.left,
      width: Math.max(24, bbox.right - bbox.left),
      height: Math.max(18, bbox.bottom - bbox.top)
    }
  };
}

function overlapsRuledRegion(region, lines, ruledRegions) {
  const startLine = lines[region.start];
  const endLine = lines[region.end];
  if (!startLine || !endLine) {
    return false;
  }

  return ruledRegions.some((table) => region.end >= table.start && region.start <= table.end && endLine.bottom >= table.top && startLine.top <= table.bottom);
}

function splitLineToCells(line) {
  if (!line.items || line.items.length < 2) {
    return [{ text: line.text, left: line.left, right: line.right }];
  }

  const cells = [];
  let cellItems = [line.items[0]];

  for (let i = 1; i < line.items.length; i += 1) {
    const prev = line.items[i - 1];
    const curr = line.items[i];
    const gap = curr.left - prev.right;
    const threshold = Math.max(line.height * TABLE_COLUMN_GAP_FACTOR, 20);

    if (gap > threshold) {
      cells.push(cellFromItems(cellItems));
      cellItems = [curr];
    } else {
      cellItems.push(curr);
    }
  }

  cells.push(cellFromItems(cellItems));
  return cells;
}

function cellFromItems(items) {
  return {
    text: items.map((item) => item.text).join(" ").trim(),
    left: Math.min(...items.map((item) => item.left)),
    right: Math.max(...items.map((item) => item.right))
  };
}

function detectTableRegions(lines) {
  const regions = [];
  let start = -1;
  let signature = null;

  for (let i = 0; i < lines.length; i += 1) {
    const cells = splitLineToCells(lines[i]);
    const rowSignature = buildRowSignature(cells);
    if (cells.length >= 2) {
      if (start === -1) {
        start = i;
        signature = rowSignature;
      } else if (!isCompatibleTableRow(signature, rowSignature)) {
        if (i - start >= MIN_TABLE_ROWS) {
          regions.push({ start, end: i - 1 });
        }
        start = i;
        signature = rowSignature;
      }
    } else {
      if (start !== -1 && i - start >= MIN_TABLE_ROWS) {
        regions.push({ start, end: i - 1 });
      }
      start = -1;
      signature = null;
    }
  }

  if (start !== -1 && lines.length - start >= MIN_TABLE_ROWS) {
    regions.push({ start, end: lines.length - 1 });
  }

  return regions;
}

function buildTableSegment(lines, region) {
  const tableLines = lines.slice(region.start, region.end + 1);
  const rows = tableLines.map((line) => splitLineToCells(line));
  const maxCols = Math.max(...rows.map((r) => r.length));
  const normalizedRows = rows.map((row) => {
    const cells = row.map((cell) => cell.text);
    while (cells.length < maxCols) {
      cells.push("");
    }
    return cells;
  });
  const text = serializeStructuredTable(normalizedRows);
  const top = Math.min(...tableLines.map((l) => l.top));
  const left = Math.min(...tableLines.map((l) => l.left));
  const right = Math.max(...tableLines.map((l) => l.right));
  const bottom = Math.max(...tableLines.map((l) => l.bottom));
  const avgHeight = tableLines.reduce((sum, l) => sum + l.height, 0) / tableLines.length;
  const preview = normalizedRows.flat().filter(Boolean).join(" ").replace(/\s+/g, " ").trim();

  return {
    index: 0,
    text,
    preview: (preview || "表格").slice(0, 180),
    lineCount: tableLines.length,
    averageLineHeight: avgHeight,
    kind: "table",
    columnCount: maxCols,
    tableRows: normalizedRows,
    tableLayout: normalizeTableLayout({
      rowHeights: tableLines.map((line) => Math.max(18, line.bottom - line.top)),
      columnWidths: buildInferredColumnWidths(rows, maxCols),
      source: "text"
    }, normalizedRows, { top, left, right, bottom }),
    rect: {
      top,
      left,
      width: Math.max(24, right - left),
      height: Math.max(18, bottom - top)
    }
  };
}

function normalizeTableLayout(layout, rows, bbox) {
  const rowCount = rows.length;
  const columnCount = Math.max(...rows.map((row) => row.length), 0);
  const fallbackRowHeight = Math.max(18, (bbox.bottom - bbox.top) / Math.max(rowCount, 1));
  const fallbackColumnWidth = Math.max(24, (bbox.right - bbox.left) / Math.max(columnCount, 1));
  const rowHeights = (layout?.rowHeights || []).slice(0, rowCount);
  const columnWidths = (layout?.columnWidths || []).slice(0, columnCount);

  while (rowHeights.length < rowCount) {
    rowHeights.push(fallbackRowHeight);
  }

  while (columnWidths.length < columnCount) {
    columnWidths.push(fallbackColumnWidth);
  }

  const totalHeight = rowHeights.reduce((sum, value) => sum + Math.max(1, value), 0) || rowCount;
  const totalWidth = columnWidths.reduce((sum, value) => sum + Math.max(1, value), 0) || columnCount;

  return {
    rowHeights,
    columnWidths,
    rowRatios: rowHeights.map((value) => Math.max(1, value) / totalHeight),
    columnRatios: columnWidths.map((value) => Math.max(1, value) / totalWidth),
    source: layout?.source || "unknown"
  };
}

function buildInferredColumnWidths(rows, maxCols) {
  const widths = new Array(maxCols).fill(0);

  for (const row of rows) {
    row.forEach((cell, index) => {
      const cellWidth = Math.max(36, (cell.right || 0) - (cell.left || 0));
      widths[index] = Math.max(widths[index], cellWidth);
    });
  }

  return widths.map((value) => value || 72);
}

function serializeLineForDiagnostics(line) {
  return {
    index: line.sourceIndex,
    text: truncateForDebug(line.text, 160),
    top: roundForDebug(line.top),
    bottom: roundForDebug(line.bottom),
    left: roundForDebug(line.left),
    right: roundForDebug(line.right),
    height: roundForDebug(line.height),
    width: roundForDebug(line.width)
  };
}

function serializeSegmentForDiagnostics(segment) {
  return {
    index: segment.index,
    kind: segment.kind || "text",
    preview: truncateForDebug(segment.preview, 200),
    lineCount: segment.lineCount,
    top: roundForDebug(segment.rect?.top || 0),
    height: roundForDebug(segment.rect?.height || 0)
  };
}

function truncateForDebug(value, maxLength = 120) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 3)}...`;
}

function roundForDebug(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
}

function buildSegmentsWithTables(lines, pageMetrics, tableRegions, ruledTableRegions = [], diagnostics = null) {
  if (tableRegions.length === 0 && ruledTableRegions.length === 0) {
    return buildSegments(lines, pageMetrics, diagnostics);
  }

  const allTableRegions = [
    ...tableRegions.map((region) => ({
      start: region.start,
      end: region.end,
      segment: buildTableSegment(lines, region)
    })),
    ...ruledTableRegions
  ].sort((left, right) => {
    if (left.start !== right.start) {
      return left.start - right.start;
    }

    return right.end - left.end;
  });

  const allSegments = [];
  let lineStart = 0;

  for (const region of allTableRegions) {
    if (region.start < lineStart) {
      continue;
    }

    if (lineStart < region.start) {
      const textLines = lines.slice(lineStart, region.start);
      const textSegments = buildSegments(textLines, pageMetrics, diagnostics);
      allSegments.push(...textSegments);
    }

    allSegments.push(region.segment);
    lineStart = region.end + 1;
  }

  if (lineStart < lines.length) {
    const textLines = lines.slice(lineStart);
    const textSegments = buildSegments(textLines, pageMetrics, diagnostics);
    allSegments.push(...textSegments);
  }

  allSegments.forEach((seg, i) => { seg.index = i + 1; });
  return allSegments;
}

function buildRowSignature(cells) {
  return cells.map((cell) => ({
    left: cell.left,
    right: cell.right,
    center: (cell.left + cell.right) / 2
  }));
}

function isCompatibleTableRow(baseSignature, nextSignature) {
  if (!baseSignature || !nextSignature) {
    return false;
  }

  if (baseSignature.length !== nextSignature.length) {
    return false;
  }

  const deltas = baseSignature.map((cell, index) => {
    return Math.abs(cell.center - nextSignature[index].center);
  });

  return deltas.every((delta) => delta <= TABLE_LAYOUT_TOLERANCE);
}

function serializeStructuredTable(rows) {
  const body = rows.map((cells) => {
    const serializedCells = cells.map((cell) => `<CELL>${escapeXml(cell)}</CELL>`).join("");
    return `<ROW>${serializedCells}</ROW>`;
  }).join("");

  return `<TABLE>${body}</TABLE>`;
}

function escapeXml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
