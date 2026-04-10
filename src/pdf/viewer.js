import { GlobalWorkerOptions, getDocument } from "../vendor/pdf.mjs";
import { buildPageSegments } from "./segmenter.js";

installMapUpsertPolyfill();

const MAX_BATCH_SIZE = 6;
const PAGE_RENDER_MARGIN = "150% 0px 150% 0px";
const CURRENT_PAGE_THRESHOLD = [0.2, 0.45, 0.7];
const THUMBNAIL_WIDTH = 164;

const state = {
  viewerSessionId: crypto.randomUUID(),
  source: "",
  title: "",
  autoStartRequested: false,
  enabled: false,
  pdfDocument: null,
  documentCapabilities: {
    hasStructTree: false,
    markInfo: null,
    metadataLoaded: false,
    metadataError: false
  },
  outlineItems: [],
  currentPage: 1,
  sidebarView: "pages",
  pages: new Map(),
  units: new Map(),
  queue: new Set(),
  flushTimer: null,
  busyCount: 0,
  config: {
    targetLanguage: "简体中文",
    maxBatchChars: 2200,
    hasApiKey: false
  },
  observers: {
    page: null,
    segment: null,
    currentPage: null
  },
  nodes: {
    workspace: document.getElementById("workspace"),
    sidebar: document.getElementById("sidebar"),
    sidebarToggle: document.getElementById("sidebar-toggle"),
    sidebarPagesTab: document.getElementById("sidebar-pages-tab"),
    sidebarOutlineTab: document.getElementById("sidebar-outline-tab"),
    pageNavList: document.getElementById("page-nav-list"),
    outlineList: document.getElementById("outline-list"),
    root: document.getElementById("viewer-root"),
    documentTitle: document.getElementById("document-title"),
    currentPageInput: document.getElementById("current-page-input"),
    prevPageButton: document.getElementById("prev-page-button"),
    nextPageButton: document.getElementById("next-page-button"),
    pageCount: document.getElementById("page-count"),
    translatedCount: document.getElementById("translated-count"),
    chip: document.getElementById("toolbar-chip"),
    toggleButton: document.getElementById("toggle-button"),
    optionsButton: document.getElementById("options-button"),
    pageTemplate: document.getElementById("page-template"),
    noteTemplate: document.getElementById("note-template")
  }
};

GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("src/vendor/pdf.worker.min.mjs");

bootstrap().catch((error) => {
  console.error("Failed to bootstrap PDF viewer", error);
  setStatus(`PDF 加载失败：${error.message}`);
  state.nodes.chip.textContent = "错误";
});

installPdfDebugHelpers();

async function bootstrap() {
  const search = new URLSearchParams(window.location.search);
  state.source = search.get("source") || "";
  state.title = search.get("title") || "";
  state.autoStartRequested = search.get("autostart") === "1";

  if (!state.source) {
    throw new Error("缺少 PDF 来源地址。");
  }

  bindToolbar();
  bindRuntimeMessages();
  await loadConfig();
  await loadDocument();
}

function bindToolbar() {
  state.nodes.toggleButton.addEventListener("click", toggleTranslation);
  state.nodes.sidebarToggle.addEventListener("click", toggleSidebar);
  state.nodes.prevPageButton.addEventListener("click", () => {
    scrollToPage(Math.max(1, state.currentPage - 1));
  });
  state.nodes.nextPageButton.addEventListener("click", () => {
    scrollToPage(Math.min(state.pdfDocument?.numPages || state.currentPage, state.currentPage + 1));
  });
  state.nodes.currentPageInput.addEventListener("change", () => {
    const requested = Number(state.nodes.currentPageInput.value);
    if (!Number.isInteger(requested)) {
      state.nodes.currentPageInput.value = String(state.currentPage);
      return;
    }

    scrollToPage(requested);
  });
  state.nodes.sidebarPagesTab.addEventListener("click", () => setSidebarView("pages"));
  state.nodes.sidebarOutlineTab.addEventListener("click", () => setSidebarView("outline"));
  state.nodes.optionsButton.addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "ruyi/open-options" });
  });
}

function installMapUpsertPolyfill() {
  if (typeof Map.prototype.getOrInsertComputed === "function") {
    return;
  }

  Object.defineProperty(Map.prototype, "getOrInsertComputed", {
    configurable: true,
    writable: true,
    value(key, computeValue) {
      if (this.has(key)) {
        return this.get(key);
      }

      const resolvedValue = typeof computeValue === "function"
        ? computeValue(key)
        : computeValue;
      this.set(key, resolvedValue);
      return resolvedValue;
    }
  });
}

function bindRuntimeMessages() {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.viewerSessionId !== state.viewerSessionId) {
      return;
    }

    if (message.type === "ruyi/pdf-translation-started") {
      state.busyCount += 1;
      for (const unitId of message.unitIds) {
        const unit = state.units.get(unitId);
        if (!unit) {
          continue;
        }

        unit.status = "streaming";
        syncUnitPresentation(unit);
      }
      renderToolbarState();
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "ruyi/pdf-translation-segment") {
      applyTranslation(message.unitId, message.text);
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "ruyi/pdf-translation-complete") {
      state.busyCount = Math.max(0, state.busyCount - 1);
      for (const unitId of message.unitIds) {
        const unit = state.units.get(unitId);
        if (!unit) {
          continue;
        }

        if (unit.status === "streaming") {
          unit.status = unit.translation ? "translated" : "idle";
          syncUnitPresentation(unit);
        }
      }
      renderToolbarState();
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "ruyi/pdf-translation-error") {
      state.busyCount = Math.max(0, state.busyCount - 1);
      for (const unitId of message.unitIds) {
        const unit = state.units.get(unitId);
        if (!unit) {
          continue;
        }

        unit.status = "error";
        unit.error = message.error || "翻译失败";
        syncUnitPresentation(unit);
      }
      setStatus(message.error || "翻译失败");
      renderToolbarState();
      sendResponse({ ok: true });
    }
  });
}

async function loadConfig() {
  const response = await chrome.runtime.sendMessage({ type: "ruyi/get-config" });
  if (response?.ok && response.config) {
    state.config = {
      ...state.config,
      ...response.config
    };
  }
}

async function loadDocument() {
  document.title = state.title || getFilenameFromSource(state.source);
  state.nodes.documentTitle.textContent = state.title || getFilenameFromSource(state.source);
  setStatus("正在读取 PDF 文档...");

  const loadingTask = getDocument({ url: state.source, enableXfa: false, useSystemFonts: true });
  state.pdfDocument = await loadingTask.promise;
  const [{ data: metadata, error: metadataError }, markInfo] = await Promise.all([
    safeGetPdfMetadata(state.pdfDocument),
    safeGetPdfMarkInfo(state.pdfDocument)
  ]);
  state.documentCapabilities = {
    hasStructTree: Boolean(metadata?.hasStructTree),
    markInfo: markInfo || null,
    metadataLoaded: !metadataError,
    metadataError: Boolean(metadataError)
  };
  state.nodes.pageCount.textContent = String(state.pdfDocument.numPages);

  createObservers();
  createPageShells();
  buildPageNavigation();
  await loadOutline();
  updateCurrentPage(1);
  renderToolbarState();
  maybeAutoStartTranslation();
  setStatus(`文档已载入，共 ${state.pdfDocument.numPages} 页。点击“开始翻译”后，将按可视区域逐段处理。`);
}

function maybeAutoStartTranslation() {
  if (!state.autoStartRequested || state.enabled || !state.config.hasApiKey) {
    return;
  }

  toggleTranslation();
}

function createObservers() {
  state.observers.page = new IntersectionObserver(onPageIntersection, {
    root: null,
    rootMargin: PAGE_RENDER_MARGIN,
    threshold: 0.01
  });

  state.observers.segment = new IntersectionObserver(onSegmentIntersection, {
    root: null,
    rootMargin: "100% 0px 100% 0px",
    threshold: 0.01
  });

  state.observers.currentPage = new IntersectionObserver(onCurrentPageIntersection, {
    root: null,
    threshold: CURRENT_PAGE_THRESHOLD
  });
}

function createPageShells() {
  for (let pageNumber = 1; pageNumber <= state.pdfDocument.numPages; pageNumber += 1) {
    const fragment = state.nodes.pageTemplate.content.cloneNode(true);
    const shell = fragment.querySelector("[data-page-shell]");
    const stage = fragment.querySelector("[data-page-stage]");
    const canvas = fragment.querySelector("[data-page-canvas]");
    const overlay = fragment.querySelector("[data-page-overlay]");
    const fixedNotes = fragment.querySelector("[data-page-notes-fixed]");
    const notes = fragment.querySelector("[data-page-notes]");
    const translationSheet = fragment.querySelector("[data-translation-sheet]");
    const label = fragment.querySelector("[data-page-label]");
    const noteStats = fragment.querySelector("[data-page-note-stats]");

    label.textContent = `第 ${pageNumber} 页`;
    shell.dataset.pageNumber = String(pageNumber);

    const pageState = {
      pageNumber,
      shell,
      stage,
      canvas,
      overlay,
      fixedNotes,
      notes,
      translationSheet,
      noteStats,
      rendered: false,
      rendering: false,
      fitFrame: 0,
      segmentsReady: false,
      segmentSummary: {
        total: 0,
        tables: 0,
        text: 0
      },
      viewport: null,
      units: []
    };

    state.pages.set(pageNumber, pageState);
    state.nodes.root.append(fragment);
    state.observers.page.observe(shell);
    state.observers.currentPage.observe(shell);
  }
}

function buildPageNavigation() {
  state.nodes.pageNavList.replaceChildren();

  for (let pageNumber = 1; pageNumber <= state.pdfDocument.numPages; pageNumber += 1) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "pdf-sidebar__nav-button";
    button.dataset.pageNumber = String(pageNumber);
    button.innerHTML = `
      <span class="pdf-sidebar__nav-top">
        <span class="pdf-sidebar__nav-label">第 ${pageNumber} 页</span>
        <span class="pdf-sidebar__nav-meta">跳转</span>
      </span>
      <span class="pdf-sidebar__thumb" data-thumb-wrap>
        <span class="pdf-sidebar__thumb-placeholder">等待缩略图</span>
      </span>
    `;
    button.addEventListener("click", () => {
      scrollToPage(pageNumber);
    });
    state.nodes.pageNavList.append(button);
  }
}

async function loadOutline() {
  const outline = await state.pdfDocument.getOutline().catch(() => null);
  state.outlineItems = outline ? await flattenOutline(outline) : [];
  state.nodes.sidebarOutlineTab.disabled = state.outlineItems.length === 0;
  if (state.outlineItems.length === 0 && state.sidebarView === "outline") {
    setSidebarView("pages");
  }
  renderOutline();
}

async function flattenOutline(items, depth = 0, bucket = []) {
  for (const item of items || []) {
    const pageNumber = await resolveOutlinePageNumber(item.dest);
    bucket.push({
      title: String(item.title || "未命名目录").trim() || "未命名目录",
      depth,
      pageNumber
    });

    if (Array.isArray(item.items) && item.items.length > 0) {
      await flattenOutline(item.items, depth + 1, bucket);
    }
  }

  return bucket;
}

async function resolveOutlinePageNumber(dest) {
  if (!dest) {
    return null;
  }

  let target = dest;
  if (typeof dest === "string") {
    target = await state.pdfDocument.getDestination(dest).catch(() => null);
  }

  if (!Array.isArray(target) || target.length === 0) {
    return null;
  }

  const ref = target[0];
  if (typeof ref === "number" && Number.isInteger(ref)) {
    return ref + 1;
  }

  try {
    const pageIndex = await state.pdfDocument.getPageIndex(ref);
    return pageIndex + 1;
  } catch (error) {
    return null;
  }
}

function renderOutline() {
  state.nodes.outlineList.replaceChildren();

  if (state.outlineItems.length === 0) {
    return;
  }

  for (const item of state.outlineItems) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "pdf-sidebar__outline-button";
    button.style.paddingLeft = `${12 + item.depth * 16}px`;
    if (item.pageNumber) {
      button.dataset.pageNumber = String(item.pageNumber);
    }
    button.innerHTML = `<span>${escapeHtml(item.title)}</span>${item.pageNumber ? `<span class="pdf-sidebar__outline-meta">第 ${item.pageNumber} 页</span>` : ""}`;
    button.addEventListener("click", () => {
      if (item.pageNumber) {
        scrollToPage(item.pageNumber);
      }
    });
    state.nodes.outlineList.append(button);
  }
}

async function onPageIntersection(entries) {
  for (const entry of entries) {
    if (!entry.isIntersecting) {
      continue;
    }

    const pageNumber = Number(entry.target.dataset.pageNumber || 0);
    if (!pageNumber) {
      continue;
    }

    const pageState = state.pages.get(pageNumber);
    if (!pageState || pageState.rendered || pageState.rendering) {
      continue;
    }

    renderPage(pageState).catch((error) => {
      console.error(`Failed to render page ${pageNumber}`, error);
      pageState.noteStats.textContent = "本页渲染失败";
      setStatus(`第 ${pageNumber} 页渲染失败：${error.message}`);
    });
  }
}

async function renderPage(pageState) {
  pageState.rendering = true;
  pageState.noteStats.textContent = "正在渲染";

  const pdfPage = await state.pdfDocument.getPage(pageState.pageNumber);
  const baseViewport = pdfPage.getViewport({ scale: 1 });
  const scale = computeReadingScale(baseViewport.width);
  const viewport = pdfPage.getViewport({ scale });
  pageState.viewport = viewport;

  const outputScale = window.devicePixelRatio || 1;
  pageState.canvas.width = Math.floor(viewport.width * outputScale);
  pageState.canvas.height = Math.floor(viewport.height * outputScale);
  pageState.canvas.style.width = `${viewport.width}px`;
  pageState.canvas.style.height = `${viewport.height}px`;
  pageState.overlay.style.width = `${viewport.width}px`;
  pageState.overlay.style.height = `${viewport.height}px`;
  pageState.translationSheet.style.height = `${viewport.height}px`;
  pageState.translationSheet.style.minHeight = `${viewport.height}px`;
  pageState.translationSheet.style.maxHeight = `${viewport.height}px`;

  const context = pageState.canvas.getContext("2d", {
    alpha: false,
    willReadFrequently: true
  });
  context.setTransform(outputScale, 0, 0, outputScale, 0, 0);

  await pdfPage.render({
    canvasContext: context,
    viewport
  }).promise;

  syncPageThumbnail(pageState);

  const shouldLoadStructTree = state.documentCapabilities.hasStructTree
    || Boolean(state.documentCapabilities.markInfo?.Marked)
    || state.documentCapabilities.metadataError
    || pageState.pageNumber === 1;
  const [textContent, operatorList, structTree] = await Promise.all([
    pdfPage.getTextContent({ includeMarkedContent: true }),
    pdfPage.getOperatorList(),
    shouldLoadStructTree ? safeGetPageStructTree(pdfPage) : Promise.resolve(null)
  ]);
  if (structTree) {
    state.documentCapabilities.hasStructTree = true;
  }
  const segmentation = buildPageSegments(textContent, viewport, operatorList, pageState.canvas, {
    pageNumber: pageState.pageNumber,
    structTree,
    documentCapabilities: state.documentCapabilities
  });
  const segments = segmentation.segments;
  pageState.segmentationDebug = segmentation.diagnostics;
  pageState.segmentSummary = summarizeSegments(segments);
  hydratePageSegments(pageState, segments);
  publishPageDebug(pageState);
  logSegmentationDiagnostics(pageState);

  pageState.rendered = true;
  pageState.rendering = false;
  pageState.segmentsReady = true;
  updatePageNoteStats(pageState);

  if (state.enabled) {
    queueVisibleUnits();
  }
}

function hydratePageSegments(pageState, segments) {
  pageState.overlay.replaceChildren();
  pageState.fixedNotes.replaceChildren();
  pageState.notes.replaceChildren();
  pageState.units = [];
  const units = segments.map((segment, index) => {
    const unit = createUnit(pageState, segment, index + 1);
    pageState.units.push(unit.id);
    state.units.set(unit.id, unit);
    pageState.overlay.append(unit.anchorNode);
    state.observers.segment.observe(unit.anchorNode);
    return unit;
  });

  const flowInsets = computeFlowInsets(pageState, units);
  pageState.translationSheet.style.setProperty("--flow-top-inset", `${flowInsets.top.toFixed(3)}px`);
  pageState.translationSheet.style.setProperty("--flow-bottom-inset", `${flowInsets.bottom.toFixed(3)}px`);
  const flowLayout = prepareFlowLayout(pageState, units, flowInsets);

  for (const unit of units) {
    if (unit.placement === "fixed-top" || unit.placement === "fixed-bottom") {
      positionAnchoredUnit(unit);
      pageState.fixedNotes.append(unit.noteNode);
    } else {
      const track = getFlowTrack(unit, flowLayout);
      const previousBottom = flowLayout.previousBottomByTrack.get(track) ?? (flowLayout.trackStarts.get(track) || flowInsets.top);
      const sourceGap = Math.max(0, unit.rect.top - previousBottom);
      unit.noteNode.style.setProperty("--source-gap", `${sourceGap.toFixed(3)}px`);
      unit.noteNode.style.removeProperty("--anchor-top");
      unit.noteNode.dataset.track = track;
      flowLayout.containers.get(track).append(unit.noteNode);
      flowLayout.previousBottomByTrack.set(track, unit.rect.top + unit.rect.height);
    }

    syncUnitPresentation(unit);
  }

  schedulePageFit(pageState);

  if (segments.length === 0) {
    pageState.noteStats.textContent = "本页未检测到段落或表格";
  }
}

function summarizeSegments(segments) {
  const summary = {
    total: segments.length,
    tables: 0,
    text: 0
  };

  for (const segment of segments) {
    if (segment?.kind === "table") {
      summary.tables += 1;
    } else {
      summary.text += 1;
    }
  }

  return summary;
}

function createUnit(pageState, segment, index) {
  const unitId = `pdf-${pageState.pageNumber}-${index}-${Math.random().toString(36).slice(2, 8)}`;
  const anchor = document.createElement("button");
  anchor.type = "button";
  anchor.className = "pdf-segment-anchor";
  anchor.dataset.unitId = unitId;
  anchor.dataset.state = "idle";
  anchor.style.left = `${segment.rect.left}px`;
  anchor.style.top = `${segment.rect.top}px`;
  anchor.style.width = `${segment.rect.width}px`;
  anchor.style.height = `${segment.rect.height}px`;
  anchor.title = segment.preview;
  anchor.addEventListener("click", () => {
    unit.noteNode.scrollIntoView({ block: "nearest", behavior: "smooth" });
  });

  const noteFragment = state.nodes.noteTemplate.content.cloneNode(true);
  const noteNode = noteFragment.querySelector("[data-note]");
  const noteSourceNode = noteFragment.querySelector("[data-note-source]");
  const noteTranslationNode = noteFragment.querySelector("[data-note-translation]");

  noteSourceNode.textContent = segment.preview;
  noteNode.id = `${unitId}-note`;
  anchor.setAttribute("aria-controls", noteNode.id);

  const kind = segment.kind || classifySegmentKind(pageState, segment, index);
  const placement = detectSegmentPlacement(pageState, segment, kind, index);
  const role = detectSegmentRole(segment.text, kind);
  const alignment = detectSegmentAlignment(pageState, segment, role);
  noteNode.dataset.kind = kind;
  noteNode.dataset.placement = placement;
  noteNode.dataset.role = role;
  noteNode.dataset.align = alignment;
  applyTranslationTypography(noteTranslationNode, segment, kind, role);

  return {
    id: unitId,
    pageNumber: pageState.pageNumber,
    pageWidth: pageState.viewport?.width || 0,
    text: segment.text,
    preview: segment.preview,
    status: "idle",
    translation: "",
    error: "",
    anchorNode: anchor,
    noteNode,
    blockId: segment.blockId || "page",
    kind,
    placement,
    role,
    alignment,
    tableLayout: segment.tableLayout || null,
    noteTranslationNode,
    rect: segment.rect
  };
}

function onSegmentIntersection(entries) {
  if (!state.enabled) {
    return;
  }

  for (const entry of entries) {
    if (!entry.isIntersecting) {
      continue;
    }

    const unitId = entry.target.dataset.unitId;
    const unit = state.units.get(unitId);
    if (!unit || unit.status === "translated" || unit.status === "streaming") {
      continue;
    }

    state.queue.add(unitId);
  }

  scheduleFlush();
}

function toggleTranslation() {
  state.enabled = !state.enabled;
  if (state.enabled) {
    queueVisibleUnits();
  } else {
    resetQueuedUnits();
  }
  renderToolbarState();
}

function resetQueuedUnits() {
  if (state.flushTimer) {
    window.clearTimeout(state.flushTimer);
    state.flushTimer = null;
  }

  for (const unitId of state.queue) {
    const unit = state.units.get(unitId);
    if (!unit || unit.status !== "queued") {
      continue;
    }

    unit.status = "idle";
    syncUnitPresentation(unit);
  }

  state.queue.clear();
}

function queueVisibleUnits() {
  if (!state.enabled) {
    return;
  }

  for (const unit of state.units.values()) {
    if (unit.status === "translated" || unit.status === "streaming") {
      continue;
    }

    const rect = unit.anchorNode.getBoundingClientRect();
    if (rect.bottom >= -window.innerHeight && rect.top <= window.innerHeight * 2.2) {
      state.queue.add(unit.id);
    }
  }

  scheduleFlush();
}

function scheduleFlush() {
  if (state.flushTimer) {
    return;
  }

  state.flushTimer = window.setTimeout(flushQueue, 180);
}

async function flushQueue() {
  state.flushTimer = null;
  if (!state.enabled || state.queue.size === 0) {
    return;
  }

  const batch = [];
  let charCount = 0;

  for (const unitId of state.queue) {
    const unit = state.units.get(unitId);
    if (!unit) {
      state.queue.delete(unitId);
      continue;
    }

    if (unit.status === "translated" || unit.status === "streaming") {
      state.queue.delete(unitId);
      continue;
    }

    if (batch.length >= MAX_BATCH_SIZE) {
      break;
    }

    const projected = charCount + unit.text.length;
    if (batch.length > 0 && projected > state.config.maxBatchChars) {
      break;
    }

    unit.status = "queued";
    syncUnitPresentation(unit);
    batch.push({ id: unit.id, text: unit.text });
    charCount = projected;
    state.queue.delete(unitId);
  }

  if (batch.length === 0) {
    return;
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: "ruyi/pdf-translate-batch",
      viewerSessionId: state.viewerSessionId,
      batchId: createBatchId(),
      units: batch
    });

    if (!response?.ok) {
      throw new Error(response?.error || "翻译请求失败");
    }
  } catch (error) {
    for (const item of batch) {
      const unit = state.units.get(item.id);
      if (!unit) {
        continue;
      }

      unit.status = "error";
      unit.error = error.message;
      syncUnitPresentation(unit);
    }
    setStatus(error.message || "翻译失败");
    renderToolbarState();
  }

  if (state.queue.size > 0) {
    scheduleFlush();
  }
}

function applyTranslation(unitId, text) {
  const unit = state.units.get(unitId);
  if (!unit) {
    return;
  }

  unit.translation = normalizeTranslationText(text, unit.kind);
  unit.status = "translated";
  unit.error = "";
  syncUnitPresentation(unit);
  renderToolbarState();
}

function syncUnitPresentation(unit) {
  unit.anchorNode.dataset.state = unit.status;
  unit.noteNode.dataset.state = unit.status;
  unit.noteNode.dataset.kind = unit.kind;
  unit.noteNode.dataset.placement = unit.placement;
  unit.noteNode.dataset.role = unit.role;
  unit.noteNode.dataset.align = unit.alignment;

  if (unit.status === "idle" || unit.status === "translated") {
    if (unit.kind === "table" && unit.translation) {
      const rows = parseStructuredTable(unit.translation);
      if (rows.length > 0) {
        unit.noteTranslationNode.innerHTML = buildTableHtml(rows, unit.tableLayout);
      } else {
        unit.noteTranslationNode.textContent = unit.translation;
      }
    } else {
      unit.noteTranslationNode.textContent = unit.translation;
    }
  } else if (unit.status === "error") {
    unit.noteTranslationNode.textContent = unit.error || "翻译失败";
  }

  const pageState = state.pages.get(unit.pageNumber);
  if (pageState) {
    updatePageNoteStats(pageState);
    schedulePageFit(pageState);
  }
}

function schedulePageFit(pageState) {
  if (!pageState?.translationSheet || !pageState?.notes) {
    return;
  }

  if (pageState.fitFrame) {
    return;
  }

  pageState.fitFrame = window.requestAnimationFrame(() => {
    pageState.fitFrame = 0;
    fitPageTranslationLayout(pageState);
  });
}

function fitPageTranslationLayout(pageState) {
  const sheet = pageState.translationSheet;
  const notes = pageState.notes;
  if (!sheet || !notes) {
    return;
  }

  const sheetStyle = window.getComputedStyle(sheet);
  const paddingTop = parseFloat(sheetStyle.paddingTop) || 0;
  const paddingBottom = parseFloat(sheetStyle.paddingBottom) || 0;
  const availableHeight = Math.max(80, sheet.clientHeight - paddingTop - paddingBottom);

  let scale = 1;
  for (let index = 0; index < 3; index += 1) {
    sheet.style.setProperty("--page-fit-scale", String(scale));
    const contentHeight = notes.scrollHeight;
    if (!contentHeight) {
      break;
    }

    const nextScale = clamp(availableHeight / contentHeight, 0.72, 1);
    if (Math.abs(nextScale - scale) < 0.015) {
      scale = nextScale;
      break;
    }
    scale = nextScale;
  }

  sheet.style.setProperty("--page-fit-scale", scale.toFixed(4));
}

function updatePageNoteStats(pageState) {
  const units = pageState.units.map((unitId) => state.units.get(unitId)).filter(Boolean);
  const translated = units.filter((unit) => unit.status === "translated").length;
  const total = units.length;
  const { tables = 0, text = 0 } = pageState.segmentSummary || {};
  const summaryText = `识别 段落 ${text} · 表格 ${tables}`;

  if (total === 0) {
    pageState.noteStats.textContent = summaryText;
    return;
  }

  if (!state.enabled) {
    pageState.noteStats.textContent = `${summaryText} · 待命 ${translated}/${total}`;
    return;
  }

  const active = units.filter((unit) => unit.status === "queued" || unit.status === "streaming").length;
  if (active > 0) {
    pageState.noteStats.textContent = `${summaryText} · 处理中 ${translated}/${total}`;
    return;
  }

  pageState.noteStats.textContent = `${summaryText} · 已翻译 ${translated}/${total}`;
}

function onCurrentPageIntersection(entries) {
  let candidate = null;

  for (const entry of entries) {
    if (!entry.isIntersecting) {
      continue;
    }

    if (!candidate || entry.intersectionRatio > candidate.intersectionRatio) {
      candidate = entry;
    }
  }

  if (!candidate) {
    return;
  }

  const pageNumber = Number(candidate.target.dataset.pageNumber || 0);
  if (!pageNumber) {
    return;
  }

  updateCurrentPage(pageNumber);
}

function updateCurrentPage(pageNumber) {
  const bounded = Math.min(Math.max(1, pageNumber), state.pdfDocument?.numPages || 1);
  if (state.currentPage === bounded && state.nodes.currentPageInput.value === String(bounded)) {
    return;
  }

  state.currentPage = bounded;
  state.nodes.currentPageInput.value = String(bounded);
  state.nodes.prevPageButton.disabled = bounded <= 1;
  state.nodes.nextPageButton.disabled = bounded >= (state.pdfDocument?.numPages || bounded);

  for (const button of state.nodes.pageNavList.querySelectorAll("[data-page-number]")) {
    button.dataset.active = button.dataset.pageNumber === String(bounded) ? "true" : "false";
  }

  for (const button of state.nodes.outlineList.querySelectorAll("[data-page-number]")) {
    button.dataset.active = button.dataset.pageNumber === String(bounded) ? "true" : "false";
  }
}

function scrollToPage(pageNumber) {
  const bounded = Math.min(Math.max(1, pageNumber), state.pdfDocument?.numPages || 1);
  const pageState = state.pages.get(bounded);
  if (!pageState) {
    return;
  }

  updateCurrentPage(bounded);
  pageState.shell.scrollIntoView({ block: "start", behavior: "smooth" });
}

function toggleSidebar() {
  const next = state.nodes.workspace.dataset.sidebarOpen === "true" ? "false" : "true";
  state.nodes.workspace.dataset.sidebarOpen = next;
}

function setSidebarView(view) {
  if (view === "outline" && state.outlineItems.length === 0) {
    view = "pages";
  }

  state.sidebarView = view;
  const isPages = view === "pages";
  state.nodes.sidebarPagesTab.dataset.active = isPages ? "true" : "false";
  state.nodes.sidebarOutlineTab.dataset.active = isPages ? "false" : "true";
  state.nodes.pageNavList.hidden = !isPages;
  state.nodes.outlineList.hidden = isPages;
}

function renderToolbarState() {
  const translatedCount = Array.from(state.units.values()).filter((unit) => unit.status === "translated").length;
  const queueCount = Array.from(state.units.values()).filter((unit) => unit.status === "queued" || unit.status === "streaming").length;
  state.nodes.translatedCount.textContent = String(translatedCount);
  state.nodes.toggleButton.textContent = state.enabled ? "停" : "译";
  state.nodes.toggleButton.title = state.enabled ? "停止翻译" : "开始翻译";

  if (!state.config.hasApiKey) {
    state.nodes.chip.textContent = "未配置";
    setStatus("还没有配置模型信息。点击“设置”填写 API URL、Key 和模型名。", false);
    return;
  }

  if (!state.enabled) {
    state.nodes.chip.textContent = "待命";
    setStatus(`PDF 已加载，目标语言：${state.config.targetLanguage}。点击“开始翻译”后会按页按可视区域逐段处理。`, false);
    return;
  }

  if (state.busyCount > 0 || queueCount > 0) {
    state.nodes.chip.textContent = "翻译中";
    setStatus(`正在处理 PDF 内容。已完成 ${translatedCount} 段，队列中 ${queueCount} 段。`, false);
    return;
  }

  if (translatedCount > 0) {
    state.nodes.chip.textContent = "已翻译";
    setStatus(`已回填 ${translatedCount} 段译文。滚动到新页面时会继续懒翻译。`, false);
    return;
  }

  state.nodes.chip.textContent = "扫描中";
  setStatus("可视区域内还没有检测到满足规则的 PDF 段落。", false);
}

function classifySegmentKind(pageState, segment, index) {
  const text = String(segment.text || "").replace(/\s+/g, " ").trim();
  const lineCount = Math.max(1, Number(segment.lineCount) || 1);
  const pageHeight = pageState.viewport?.height || 0;
  const isNearTop = pageHeight > 0 && segment.rect.top < pageHeight * 0.22;
  const looksLikeListItem = /^[（(]?[0-9一二三四五六七八九十]+[)）.、]/.test(text);
  const endsWithSentence = /[。！？.!?；;：:]$/.test(text);
  const shortText = text.length > 0 && text.length <= 84;
  const mediumText = text.length > 0 && text.length <= 140;

  if (isNearTop && shortText && lineCount <= 3 && !endsWithSentence && index <= 4) {
    return index <= 2 ? "title" : "heading";
  }

  if (shortText && lineCount <= 2 && !looksLikeListItem && !endsWithSentence) {
    return "heading";
  }

  if (looksLikeListItem && mediumText) {
    return "list-item";
  }

  return "body";
}

function detectSegmentPlacement(pageState, segment, kind, index) {
  if (!segment?.rect || kind === "table") {
    return "flow";
  }

  const text = String(segment.text || "").replace(/\s+/g, " ").trim();
  const lineCount = Math.max(1, Number(segment.lineCount) || 1);
  const pageHeight = pageState.viewport?.height || 0;
  if (!pageHeight) {
    return "flow";
  }

  const bottom = segment.rect.top + segment.rect.height;
  const nearTop = segment.rect.top <= Math.max(pageHeight * 0.14, 96);
  const nearBottom = bottom >= pageHeight - Math.max(pageHeight * 0.14, 96);
  const compactBlock = lineCount <= 4 && text.length > 0 && text.length <= 220;
  const edgeMarker = kind === "title" || kind === "heading" || looksLikePageMarker(text);

  if (nearTop && index <= 4 && (compactBlock || edgeMarker)) {
    return "fixed-top";
  }

  if (nearBottom && (compactBlock || edgeMarker)) {
    return "fixed-bottom";
  }

  return "flow";
}

function looksLikePageMarker(text) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return false;
  }

  return /^(?:第\s*\d+\s*页|page\s*\d+|[-–—]?[\[(（]?\d+[\])）]?[-–—]?)$/i.test(normalized);
}

function detectSegmentRole(text, kind) {
  if (looksLikePageMarker(text)) {
    return "page-marker";
  }

  if (kind === "title" || kind === "heading") {
    return "header-like";
  }

  return "content";
}

function detectSegmentAlignment(pageState, segment, role) {
  const pageWidth = pageState.viewport?.width || 0;
  if (!pageWidth) {
    return "left";
  }

  const left = segment.rect.left;
  const right = segment.rect.left + segment.rect.width;
  const widthRatio = segment.rect.width / Math.max(pageWidth, 1);
  const center = left + segment.rect.width / 2;
  const centerOffset = Math.abs(center - pageWidth / 2);
  const nearLeft = left <= Math.max(48, pageWidth * 0.12);
  const nearRight = right >= pageWidth - Math.max(48, pageWidth * 0.12);
  const centerTolerance = Math.max(18, pageWidth * 0.06);
  const lineCount = Math.max(1, Number(segment.lineCount) || 1);
  const centeredNarrowBlock = centerOffset <= centerTolerance && widthRatio <= 0.62;

  if (role === "page-marker") {
    return "center";
  }

  if (role === "header-like" && centerOffset <= centerTolerance && widthRatio <= 0.88) {
    return "center";
  }

  if (centeredNarrowBlock && lineCount <= 2) {
    return "center";
  }

  if (nearRight && !nearLeft && widthRatio <= 0.6) {
    return "right";
  }

  return "left";
}

function computeFlowInsets(pageState, units) {
  const pageHeight = pageState.viewport?.height || 0;
  let topInset = 0;
  let bottomInset = 0;

  for (const unit of units) {
    if (unit.placement === "fixed-top") {
      topInset = Math.max(topInset, unit.rect.top + unit.rect.height + 12);
      continue;
    }

    if (unit.placement === "fixed-bottom") {
      bottomInset = Math.max(bottomInset, Math.max(0, pageHeight - unit.rect.top) + 12);
    }
  }

  return {
    top: topInset,
    bottom: bottomInset
  };
}

function prepareFlowLayout(pageState, units, flowInsets) {
  const notesRoot = pageState.notes;
  notesRoot.replaceChildren();

  const flowUnits = units.filter((unit) => unit.placement === "flow");
  const leftUnits = flowUnits.filter((unit) => unit.blockId === "left-column");
  const rightUnits = flowUnits.filter((unit) => unit.blockId === "right-column");
  const topUnits = flowUnits.filter((unit) => unit.blockId === "full-top");
  const bottomUnits = flowUnits.filter((unit) => unit.blockId === "full-bottom");
  const hasDualColumns = leftUnits.length > 0 && rightUnits.length > 0;

  notesRoot.dataset.layout = hasDualColumns ? "columns" : "single";

  if (!hasDualColumns) {
    return {
      containers: new Map([["default", notesRoot]]),
      trackStarts: new Map([["default", flowInsets.top]]),
      previousBottomByTrack: new Map([["default", flowInsets.top]])
    };
  }

  const topSection = document.createElement("div");
  topSection.className = "pdf-page-notes__section pdf-page-notes__section--top";
  const columns = document.createElement("div");
  columns.className = "pdf-page-notes__columns";
  const leftLane = document.createElement("div");
  leftLane.className = "pdf-page-notes__lane pdf-page-notes__lane--left";
  const rightLane = document.createElement("div");
  rightLane.className = "pdf-page-notes__lane pdf-page-notes__lane--right";
  const bottomSection = document.createElement("div");
  bottomSection.className = "pdf-page-notes__section pdf-page-notes__section--bottom";

  columns.append(leftLane, rightLane);
  notesRoot.append(topSection, columns, bottomSection);

  const leftBounds = getUnitBounds(leftUnits);
  const rightBounds = getUnitBounds(rightUnits);
  const topBounds = getUnitBounds(topUnits);
  const bottomBounds = getUnitBounds(bottomUnits);
  const columnStart = Math.min(leftBounds.top, rightBounds.top);
  const columnBottom = Math.max(leftBounds.bottom, rightBounds.bottom);
  const topStart = topUnits.length > 0 ? topBounds.top : columnStart;
  const topBottom = topUnits.length > 0 ? topBounds.bottom : flowInsets.top;
  const bottomStart = bottomUnits.length > 0 ? bottomBounds.top : columnBottom;
  const gutter = Math.max(18, rightBounds.left - leftBounds.right);

  topSection.style.setProperty("--section-gap", `${Math.max(0, topStart - flowInsets.top).toFixed(3)}px`);
  columns.style.setProperty("--section-gap", `${Math.max(0, columnStart - Math.max(flowInsets.top, topBottom)).toFixed(3)}px`);
  bottomSection.style.setProperty("--section-gap", `${Math.max(0, bottomStart - Math.max(columnBottom, topBottom, flowInsets.top)).toFixed(3)}px`);
  columns.style.gridTemplateColumns = `${Math.max(1, leftBounds.width).toFixed(3)}fr ${Math.max(1, rightBounds.width).toFixed(3)}fr`;
  columns.style.columnGap = `calc(${gutter.toFixed(3)}px * var(--page-fit-scale))`;

  return {
    containers: new Map([
      ["full-top", topSection],
      ["left-column", leftLane],
      ["right-column", rightLane],
      ["full-bottom", bottomSection],
      ["default", topSection]
    ]),
    trackStarts: new Map([
      ["full-top", topStart],
      ["left-column", columnStart],
      ["right-column", columnStart],
      ["full-bottom", bottomStart],
      ["default", topStart]
    ]),
    previousBottomByTrack: new Map([
      ["full-top", topStart],
      ["left-column", columnStart],
      ["right-column", columnStart],
      ["full-bottom", bottomStart],
      ["default", topStart]
    ])
  };
}

function getFlowTrack(unit, flowLayout) {
  if (!flowLayout.containers.has("left-column") || !flowLayout.containers.has("right-column")) {
    return "default";
  }

  if (flowLayout.containers.has(unit.blockId)) {
    return unit.blockId;
  }

  return "default";
}

function getUnitBounds(units) {
  if (!Array.isArray(units) || units.length === 0) {
    return {
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0
    };
  }

  const top = Math.min(...units.map((unit) => unit.rect.top));
  const left = Math.min(...units.map((unit) => unit.rect.left));
  const right = Math.max(...units.map((unit) => unit.rect.left + unit.rect.width));
  const bottom = Math.max(...units.map((unit) => unit.rect.top + unit.rect.height));

  return {
    top,
    left,
    right,
    bottom,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top)
  };
}

function positionAnchoredUnit(unit) {
  unit.noteNode.style.setProperty("--source-gap", "0px");
  unit.noteNode.style.setProperty("--anchor-top", `${unit.rect.top.toFixed(3)}px`);
  const frame = computeAnchoredFrame(unit);
  unit.noteNode.style.setProperty("--anchor-left", `${frame.left.toFixed(3)}px`);
  unit.noteNode.style.setProperty("--anchor-width", `${frame.width.toFixed(3)}px`);
}

function computeAnchoredFrame(unit) {
  const rect = unit.rect || { left: 0, width: 120 };
  const pageWidth = Math.max(120, unit.pageWidth || rect.left + rect.width);
  const horizontalInset = Math.max(20, pageWidth * 0.045);
  const maxWidth = Math.max(96, pageWidth - horizontalInset * 2);
  const center = rect.left + rect.width / 2;
  let width = Math.min(rect.width, maxWidth);
  let left = rect.left;

  if (unit.role === "page-marker") {
    width = Math.min(maxWidth, Math.max(64, rect.width + 20));
    left = (pageWidth - width) / 2;
  } else if (unit.alignment === "center") {
    width = Math.min(maxWidth, Math.max(rect.width * 1.12, 220));
    left = (pageWidth - width) / 2;
  }

  left = clamp(left, 0, Math.max(0, pageWidth - width));

  return {
    left,
    width: Math.max(48, Math.min(width, pageWidth))
  };
}

function applyTranslationTypography(node, segment, kind, role = "content") {
  const lineCount = Math.max(1, Number(segment.lineCount) || 1);
  const averageLineHeight = Math.max(10, Number(segment.averageLineHeight) || (segment.rect.height / lineCount) || 14);
  let fontSize = clamp(averageLineHeight * 0.84, 11.5, 23);

  if (role === "page-marker") {
    fontSize = clamp(averageLineHeight * 0.78, 10.5, 14);
  } else if (kind === "title") {
    fontSize = clamp(averageLineHeight * 0.98, 15, 24);
  } else if (kind === "heading") {
    fontSize = clamp(averageLineHeight * 0.9, 13.5, 20);
  } else if (kind === "table") {
    fontSize = clamp(averageLineHeight * 0.78, 10.5, 14.5);
  }

  const lineHeight = clamp(fontSize * 1.42, fontSize + 4, fontSize * 1.7);
  node.style.fontSize = `calc(var(--page-fit-scale, 1) * ${fontSize.toFixed(3)}px)`;
  node.style.lineHeight = `calc(var(--page-fit-scale, 1) * ${lineHeight.toFixed(3)}px)`;
}

function normalizeTranslationText(text, kind) {
  const value = String(text || "").replace(/\u00a0/g, " ").trim();
  if (!value) {
    return "";
  }

  if (kind === "table") {
    return value;
  }

  if (kind === "title" || kind === "heading") {
    return value.replace(/\s*\n+\s*/g, " ").replace(/\s{2,}/g, " ").trim();
  }

  return value
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function parseStructuredTable(text) {
  const source = String(text || "");
  const rowMatches = Array.from(source.matchAll(/<ROW>([\s\S]*?)<\/ROW>/g));
  const rows = [];

  for (const rowMatch of rowMatches) {
    const cellMatches = Array.from(rowMatch[1].matchAll(/<CELL>([\s\S]*?)<\/CELL>/g));
    const cells = cellMatches.map((match) => decodeXmlText(match[1]));
    if (cells.length > 0) {
      rows.push(cells);
    }
  }

  return rows;
}

function buildTableHtml(rows, layout = null) {
  if (rows.length === 0) {
    return "";
  }

  const maxCols = Math.max(...rows.map((row) => row.length));
  const columnRatios = Array.isArray(layout?.columnRatios) ? layout.columnRatios.slice(0, maxCols) : [];
  const rowRatios = Array.isArray(layout?.rowRatios) ? layout.rowRatios.slice(0, rows.length) : [];
  while (columnRatios.length < maxCols) {
    columnRatios.push(1 / Math.max(maxCols, 1));
  }
  while (rowRatios.length < rows.length) {
    rowRatios.push(1 / Math.max(rows.length, 1));
  }

  const colgroup = `<colgroup>${columnRatios.map((ratio) => `<col style="width:${(ratio * 100).toFixed(3)}%">`).join("")}</colgroup>`;
  const htmlRows = rows.map((cells, rowIndex) => {
    const padded = cells.slice();
    while (padded.length < maxCols) {
      padded.push("");
    }
    const rowStyle = ` style="height:${(rowRatios[rowIndex] * 100).toFixed(3)}%"`;
    return `<tr${rowStyle}>${padded.map((cell) => `<td>${escapeHtml(cell).replace(/\n/g, "<br>")}</td>`).join("")}</tr>`;
  });

  return `<table class="pdf-note__table pdf-note__table--preserved">${colgroup}<tbody>${htmlRows.join("")}</tbody></table>`;
}

function decodeXmlText(value) {
  return String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function setStatus(message, force = true) {
  document.title = `${state.currentPage}/${state.pdfDocument?.numPages || "-"} · ${state.title || getFilenameFromSource(state.source)}`;
}

function createBatchId() {
  return `pdf-batch-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}

function getFilenameFromSource(source) {
  try {
    const url = new URL(source);
    const pathname = url.pathname.split("/").filter(Boolean).pop();
    return pathname || source;
  } catch (error) {
    return source;
  }
}

function truncateMiddle(value, maxLength) {
  if (value.length <= maxLength) {
    return value;
  }

  const half = Math.floor((maxLength - 3) / 2);
  return `${value.slice(0, half)}...${value.slice(-half)}`;
}

function computeReadingScale(baseWidth) {
  const workspaceWidth = window.innerWidth - (state.nodes.workspace.dataset.sidebarOpen === "true" ? 310 : 36);
  const mainWidth = Math.max(980, workspaceWidth - 48);
  const perPageWidth = Math.max(520, Math.floor((mainWidth - 14) / 2) - 44);
  return perPageWidth / Math.max(baseWidth, 1);
}

function syncPageThumbnail(pageState) {
  const navButton = state.nodes.pageNavList.querySelector(`[data-page-number="${pageState.pageNumber}"]`);
  const thumbWrap = navButton?.querySelector("[data-thumb-wrap]");
  if (!thumbWrap) {
    return;
  }

  thumbWrap.replaceChildren();

  const thumbCanvas = document.createElement("canvas");
  const sourceWidth = pageState.canvas.width;
  const sourceHeight = pageState.canvas.height;
  const cssWidth = pageState.canvas.clientWidth || pageState.viewport?.width || 1;
  const cssHeight = pageState.canvas.clientHeight || pageState.viewport?.height || 1;
  const ratio = THUMBNAIL_WIDTH / Math.max(cssWidth, 1);

  thumbCanvas.width = Math.max(1, Math.round(sourceWidth * ratio / (window.devicePixelRatio || 1)));
  thumbCanvas.height = Math.max(1, Math.round(sourceHeight * ratio / (window.devicePixelRatio || 1)));

  const thumbContext = thumbCanvas.getContext("2d", { alpha: false });
  thumbContext.drawImage(pageState.canvas, 0, 0, thumbCanvas.width, thumbCanvas.height);
  thumbWrap.append(thumbCanvas);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function installPdfDebugHelpers() {
  globalThis.__ruyiPdfDebug = {
    getPageDiagnostics(pageNumber) {
      const pageState = state.pages.get(Number(pageNumber));
      return pageState?.segmentationDebug || null;
    },
    listPages() {
      return Array.from(state.pages.values()).map((pageState) => ({
        pageNumber: pageState.pageNumber,
        summary: pageState.segmentSummary,
        hasDiagnostics: Boolean(pageState.segmentationDebug)
      }));
    }
  };
}

function publishPageDebug(pageState) {
  if (!globalThis.__ruyiPdfDebugPages) {
    globalThis.__ruyiPdfDebugPages = new Map();
  }

  globalThis.__ruyiPdfDebugPages.set(pageState.pageNumber, pageState.segmentationDebug || null);
}

function logSegmentationDiagnostics(pageState) {
  const diagnostics = pageState.segmentationDebug;
  if (!diagnostics) {
    return;
  }

  const breakTransitions = diagnostics.transitions.filter((item) => item.shouldBreak);
  console.groupCollapsed(`[Ruyi PDF] Page ${pageState.pageNumber} segmentation`);
  console.info("Summary", {
    pageNumber: pageState.pageNumber,
    segmentSummary: pageState.segmentSummary,
    readingOrderStrategy: diagnostics.readingOrderStrategy,
    fallbackReason: diagnostics.fallbackReason,
    structTreeCoverage: diagnostics.structTreeCoverage,
    lineCount: diagnostics.lines.length,
    breakCount: breakTransitions.length,
    flowBlocks: diagnostics.flowBlocks,
    tableRegions: diagnostics.tableRegions
  });
  if (breakTransitions.length > 0) {
    console.table(breakTransitions);
  }
  console.groupEnd();
}

async function safeGetPdfMetadata(pdfDocument) {
  try {
    return {
      data: await pdfDocument.getMetadata(),
      error: null
    };
  } catch (error) {
    return {
      data: null,
      error
    };
  }
}

async function safeGetPdfMarkInfo(pdfDocument) {
  try {
    return await pdfDocument.getMarkInfo();
  } catch (error) {
    return null;
  }
}

async function safeGetPageStructTree(pdfPage) {
  try {
    return await pdfPage.getStructTree();
  } catch (error) {
    return null;
  }
}
