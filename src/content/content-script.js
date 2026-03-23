(function bootstrapRuyiTranslate() {
  if (globalThis.__ruyiTranslateController) {
    return;
  }

  const DISCOVERY_SELECTOR = [
    "p",
    "li",
    "blockquote",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "figcaption",
    "dd",
    "dt",
    "div",
    "section",
    "article",
    "td",
    "span"
  ].join(",");
  const BLOCK_ELEMENT_SELECTOR = [
    "p",
    "li",
    "blockquote",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "figcaption",
    "dd",
    "dt",
    "div",
    "section",
    "article",
    "td"
  ].join(",");
  const PRIMARY_ROOT_SELECTOR = [
    "article",
    "main",
    '[role="main"]',
    '[role="article"]',
    '[role="document"]',
    ".article",
    ".article-body",
    ".post",
    ".post-content",
    ".entry-content",
    ".content",
    ".main",
    ".markdown-body",
    ".prose",
    "section",
    "div"
  ].join(",");

  const SKIP_ANCESTOR_SELECTOR = [
    "nav",
    "header",
    "footer",
    "aside",
    "menu",
    "form",
    "button",
    "select",
    "textarea",
    "input",
    "dialog",
    "pre",
    "code",
    "kbd",
    "samp",
    "math",
    "svg",
    "canvas",
    "noscript"
  ].join(",");

  const INLINE_SKIP_SELECTOR = [
    "button",
    "code",
    "pre",
    "kbd",
    "samp",
    "math",
    "script",
    "style"
  ].join(",");

  const SEMANTIC_SKIP_PATTERN = /(nav|menu|header|footer|sidebar|comment|social|share|toolbar|breadcrumb|pagination|related|recommend|advert|ads|promo|banner|subscribe|cookie|consent|modal|popup|drawer|toc)/i;
  const DIV_SKIP_CHILD_SELECTOR = "p, li, blockquote, h1, h2, h3, h4, h5, h6, pre, code";
  const NESTED_TEXT_CONTAINER_SELECTOR = "blockquote, li, dd, dt, figcaption";
  const BLOCK_TRANSLATION_BOUNDARY_SELECTOR = "p, div, li, blockquote, h1, h2, h3, h4, h5, h6, figcaption, dd, dt, table, tr";
  const APP_CHROME_SELECTOR = [
    '[role="navigation"]',
    '[role="banner"]',
    '[role="complementary"]',
    '[role="search"]',
    '[role="tablist"]',
    '[role="tab"]',
    '[role="toolbar"]',
    '[role="tree"]',
    '[role="treeitem"]',
    '[role="listbox"]',
    '[role="option"]',
    '[role="menu"]',
    '[role="menubar"]',
    '[role="menuitem"]',
    '[role="grid"]',
    '[role="gridcell"]'
  ].join(',');
  const MAIL_BODY_ROOT_SELECTOR_GROUPS = [
    'div[role="document"]',
    'div[aria-label*="Message body"]',
    'div[aria-label*="邮件正文"]',
    'div[aria-label*="Reading pane"]',
    'div[data-app-section="MailReadCompose"]'
  ];
  const OWNED_SELECTOR = "[data-ruyi-owned='true']";
  const PANEL_AUTO_SHOW_DISABLED_KEY = "panelAutoShowDisabled";
  const MIN_TEXT_LENGTH = 36;
  const MIN_HEADING_LENGTH = 8;
  const MAX_BATCH_SIZE = 6;

  const state = {
    enabled: false,
    busyCount: 0,
    panel: null,
    panelVisible: false,
    autoShowDisabled: false,
    actionButton: null,
    settingsButton: null,
    closeButton: null,
    statusNode: null,
    chipNode: null,
    units: new Map(),
    elementToIds: new WeakMap(),
    queue: new Set(),
    flushTimer: null,
    observer: null,
    mutationObserver: null,
    drag: null,
    config: {
      maxBatchChars: 2200,
      targetLanguage: "简体中文",
      hasApiKey: false
    }
  };

  globalThis.__ruyiTranslateController = state;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== "string") {
      return;
    }

    if (message.type === "ruyi/ping") {
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "ruyi/toggle-translation") {
      toggleTranslation();
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "ruyi/reveal-panel") {
      showPanel();
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "ruyi/translation-started") {
      state.busyCount += 1;
      for (const unitId of message.unitIds) {
        const unit = state.units.get(unitId);
        if (!unit) {
          continue;
        }
        unit.status = "streaming";
        ensureTranslationNode(unit, "");
        unit.translationNode.dataset.state = "streaming";
        unit.translationNode.dataset.hidden = state.enabled ? "false" : "true";
      }
      renderStatus();
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "ruyi/translation-segment") {
      applyTranslation(message.unitId, message.text);
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "ruyi/translation-complete") {
      state.busyCount = Math.max(0, state.busyCount - 1);
      for (const unitId of message.unitIds) {
        const unit = state.units.get(unitId);
        if (unit && unit.status === "streaming") {
          unit.status = unit.translation ? "translated" : "idle";
          if (unit.translationNode) {
            unit.translationNode.dataset.state = unit.translation ? "translated" : "idle";
          }
        }
      }
      renderStatus();
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "ruyi/translation-error") {
      state.busyCount = Math.max(0, state.busyCount - 1);
      for (const unitId of message.unitIds) {
        const unit = state.units.get(unitId);
        if (!unit) {
          continue;
        }
        unit.status = "error";
        unit.error = message.error;
        ensureTranslationNode(unit, message.error || "翻译失败");
        unit.translationNode.dataset.state = "error";
        unit.translationNode.dataset.hidden = state.enabled ? "false" : "true";
      }
      renderStatus(message.error || "翻译失败");
      sendResponse({ ok: true });
    }
  });

  createFloatingPanel();
  watchDomMutations();
  loadConfig();
  loadPanelPreference();

  function toggleTranslation() {
    state.enabled = !state.enabled;

    if (state.enabled) {
      discoverUnits();
      ensureObserver();
      showTranslations();
      queueVisibleUnits();
    } else {
      hideTranslations();
    }

    renderStatus();
    renderActionLabel();
  }

  async function loadConfig() {
    try {
      const response = await chrome.runtime.sendMessage({ type: "ruyi/get-config" });
      if (response?.ok && response.config) {
        state.config = {
          ...state.config,
          ...response.config
        };
      }
    } catch (error) {
      console.warn("Failed to load config", error);
    } finally {
      renderStatus();
    }
  }

  async function loadPanelPreference() {
    try {
      const data = await chrome.storage.local.get([PANEL_AUTO_SHOW_DISABLED_KEY]);
      state.autoShowDisabled = Boolean(data[PANEL_AUTO_SHOW_DISABLED_KEY]);
    } catch (error) {
      console.warn("Failed to load panel preference", error);
      state.autoShowDisabled = false;
    } finally {
      if (!state.autoShowDisabled) {
        showPanel();
      } else {
        hidePanel();
      }
    }
  }

  function showPanel() {
    state.panelVisible = true;

    if (state.panel) {
      state.panel.hidden = false;
    }
  }

  function hidePanel() {
    state.panelVisible = false;

    if (state.panel) {
      state.panel.hidden = true;
    }
  }

  async function dismissPanel() {
    hidePanel();
    state.autoShowDisabled = true;

    try {
      await chrome.storage.local.set({
        [PANEL_AUTO_SHOW_DISABLED_KEY]: true
      });
    } catch (error) {
      console.warn("Failed to save panel preference", error);
    }
  }

  function createFloatingPanel() {
    const panel = document.createElement("section");
    panel.className = "ruyi-floating-panel";
    panel.dataset.ruyiOwned = "true";
    panel.dataset.busy = "false";
    panel.dataset.expanded = "false";
    panel.hidden = true;

    const compactBar = document.createElement("div");
    compactBar.className = "ruyi-compact-bar";

    const primaryButton = document.createElement("button");
    primaryButton.className = "ruyi-primary";
    primaryButton.type = "button";
    primaryButton.addEventListener("click", toggleTranslation);

    const expandButton = document.createElement("button");
    expandButton.className = "ruyi-expand";
    expandButton.type = "button";
    expandButton.title = "打开设置";
    expandButton.setAttribute("aria-label", "打开设置");
    expandButton.textContent = "⚙";
    expandButton.addEventListener("click", async () => {
      await chrome.runtime.sendMessage({ type: "ruyi/open-options" });
    });

    const closeButton = document.createElement("button");
    closeButton.className = "ruyi-close";
    closeButton.type = "button";
    closeButton.title = "关闭面板";
    closeButton.setAttribute("aria-label", "关闭面板");
    closeButton.textContent = "×";
    closeButton.addEventListener("click", dismissPanel);

    const sideButtons = document.createElement("div");
    sideButtons.className = "ruyi-side-buttons";
    sideButtons.append(closeButton, expandButton);

    compactBar.append(primaryButton, sideButtons);

    panel.append(compactBar);
    document.documentElement.append(panel);

    state.panel = panel;
    state.statusNode = null;
    state.actionButton = primaryButton;
    state.settingsButton = expandButton;
    state.closeButton = closeButton;
    state.chipNode = null;

    attachDragBehavior(compactBar, panel);
    renderActionLabel();
    renderStatus();
  }

  function attachDragBehavior(handle, panel) {
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) {
        return;
      }

      if (event.target instanceof Element && event.target.closest("button")) {
        return;
      }

      const rect = panel.getBoundingClientRect();
      state.drag = {
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top
      };

      panel.style.left = `${rect.left}px`;
      panel.style.top = `${rect.top}px`;
      panel.style.right = "auto";
      panel.style.bottom = "auto";
      handle.setPointerCapture(event.pointerId);
    });

    handle.addEventListener("pointermove", (event) => {
      if (!state.drag) {
        return;
      }

      const left = clamp(event.clientX - state.drag.offsetX, 12, window.innerWidth - state.panel.offsetWidth - 12);
      const top = clamp(event.clientY - state.drag.offsetY, 12, window.innerHeight - state.panel.offsetHeight - 12);
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
    });

    handle.addEventListener("pointerup", (event) => {
      if (!state.drag) {
        return;
      }

      state.drag = null;
      handle.releasePointerCapture(event.pointerId);
    });

    handle.addEventListener("pointercancel", (event) => {
      if (!state.drag) {
        return;
      }

      state.drag = null;
      if (handle.hasPointerCapture(event.pointerId)) {
        handle.releasePointerCapture(event.pointerId);
      }
    });
  }

  function watchDomMutations() {
    state.mutationObserver = new MutationObserver(() => {
      if (!state.enabled) {
        return;
      }

      queueMicrotask(() => {
        discoverUnits();
        queueVisibleUnits();
      });
    });

    state.mutationObserver.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  function discoverUnits() {
    const roots = getCandidateRoots();
    const candidates = collectCandidateElements(roots);
    const seenTextsByRoot = new WeakMap();

    for (const candidate of candidates) {
      const { root, element } = candidate;

      if (state.elementToIds.has(element)) {
        continue;
      }

      const extractions = getCandidateExtractions(element);
      const unitIds = [];

      for (const extraction of extractions) {
        if (!isCandidateElement(element, extraction)) {
          continue;
        }

        const text = extraction.text;
        if (!text) {
          continue;
        }

        if (shouldSkipDuplicateCandidate(root, element, extraction, seenTextsByRoot)) {
          continue;
        }

        rememberCandidateText(seenTextsByRoot, root, text);

        const unit = {
          id: createUnitId(),
          element,
          text,
          sourceMode: extraction.mode,
          boundaryAnchor: extraction.boundaryAnchor || null,
          insertionAnchor: extraction.insertionAnchor || null,
          translation: "",
          translationNode: null,
          status: "idle",
          error: ""
        };

        state.units.set(unit.id, unit);
        unitIds.push(unit.id);
      }

      if (unitIds.length === 0) {
        continue;
      }

      state.elementToIds.set(element, unitIds);

      if (state.observer) {
        state.observer.observe(element);
      }
    }
  }

  function collectCandidateElements(roots) {
    const candidates = [];

    for (const root of roots) {
      if (root.matches?.(DISCOVERY_SELECTOR)) {
        candidates.push({ root, element: root });
      }

      for (const element of root.querySelectorAll(DISCOVERY_SELECTOR)) {
        candidates.push({ root, element });
      }
    }

    return candidates;
  }

  function shouldSkipDuplicateCandidate(root, element, extraction, seenTextsByRoot) {
    const text = normalizeText(extraction.text);
    if (!text) {
      return true;
    }

    if (text.length > 220 && extraction.mode === "full") {
      return false;
    }

    const bucket = seenTextsByRoot.get(root);
    if (!bucket) {
      return false;
    }

    if (!bucket.has(text)) {
      return false;
    }

    return extraction.mode !== "full" || isHeadingElement(element) || isHeadingLikeElement(element, extraction.text) || text.length <= 220;
  }

  function rememberCandidateText(seenTextsByRoot, root, text) {
    let bucket = seenTextsByRoot.get(root);
    if (!bucket) {
      bucket = new Set();
      seenTextsByRoot.set(root, bucket);
    }

    bucket.add(normalizeText(text));
  }

  function isBasicCandidateElement(element, extraction) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    if (!isReadableBlockElement(element, extraction)) {
      return false;
    }

    const isHeading = isHeadingElement(element) || isHeadingLikeElement(element, extraction.text);

    if (element.closest(OWNED_SELECTOR)) {
      return false;
    }

    if (isMailAppPage() && element.closest(APP_CHROME_SELECTOR)) {
      return false;
    }

    if (element.closest(SKIP_ANCESTOR_SELECTOR)) {
      return false;
    }

    const semanticLabel = `${element.id} ${element.className} ${element.getAttribute("role") || ""}`;
    if (!isHeading && SEMANTIC_SKIP_PATTERN.test(semanticLabel)) {
      return false;
    }

    if (element.querySelector("pre, code, kbd, samp, math")) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    if (rect.width < 120 || rect.height < 16) {
      return false;
    }

    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") {
      return false;
    }

    const text = extraction.text;
    if (!text) {
      return false;
    }

    const minLength = isHeading ? MIN_HEADING_LENGTH : MIN_TEXT_LENGTH;
    if (text.length < minLength) {
      return false;
    }

    if (isProbablyCode(text)) {
      return false;
    }

    const punctuationCount = (text.match(/[，。！？；：,.!?;:]/g) || []).length;
    if (!isHeading && punctuationCount < 1) {
      return false;
    }

    const anchors = Array.from(element.querySelectorAll("a"));
    const anchorText = anchors
      .map((anchor) => anchor.textContent || "")
      .join("")
      .trim();

    if (!isHeading && shouldSkipLinkHeavyBlock(element, text, anchors, anchorText)) {
      return false;
    }

    return true;
  }

  function isCandidateElement(element, extraction) {
    if (!isBasicCandidateElement(element, extraction)) {
      return false;
    }

    const text = extraction.text;

    if (extraction.mode === "full" && hasEquivalentReadableChild(element, text)) {
      return false;
    }

    if (extraction.mode === "full" && hasReadableChildBlock(element)) {
      return false;
    }

    if (extraction.mode !== "full" && hasEquivalentDescendantExtraction(element, extraction)) {
      return false;
    }

    return true;
  }

  function isHeadingElement(element) {
    return /^H[1-6]$/.test(element.tagName);
  }

  function isHeadingLikeElement(element, text = "") {
    if (isHeadingElement(element)) {
      return true;
    }

    if (!/^(P|DIV|SPAN|A)$/.test(element.tagName)) {
      return false;
    }

    if (!text || text.length < MIN_HEADING_LENGTH || text.length > 120) {
      return false;
    }

    const style = window.getComputedStyle(element);
    const fontSize = Number.parseFloat(style.fontSize || "0");
    const fontWeight = Number.parseInt(style.fontWeight || "400", 10);
    const strongChild = element.querySelector("strong, b");
    const headingRole = element.getAttribute("role") === "heading";

    return Boolean(headingRole || strongChild || fontWeight >= 600 || fontSize >= 28);
  }

  function shouldSkipLinkHeavyBlock(element, text, anchors, anchorText) {
    if (anchors.length === 0 || anchorText.length === 0) {
      return false;
    }

    if (anchors.length === 1 && text.length >= 48) {
      return false;
    }

    const uniqueAnchorParents = new Set(anchors.map((anchor) => anchor.parentElement).filter(Boolean));
    if (uniqueAnchorParents.size <= 1 && text.length >= 36) {
      return false;
    }

    return anchorText.length / text.length > 0.45;
  }

  function getCandidateRoots() {
    const mailRoots = getMailBodyRoots();
    if (mailRoots.length > 0) {
      return mailRoots;
    }

    const root = findPrimaryContentRoot();
    return root ? [root] : [document.body];
  }

  function isMailAppPage() {
    return /(^|\.)outlook\.(live|office)\.com$/i.test(window.location.hostname);
  }

  function isEligibleRoot(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    if (element.closest(OWNED_SELECTOR)) {
      return false;
    }

    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") {
      return false;
    }

    const rect = element.getBoundingClientRect();
    if (rect.width < 240 || rect.height < 120) {
      return false;
    }

    return normalizeText(element.innerText || "").length >= 120;
  }

  function collapseNestedRoots(roots) {
    return roots.filter((root) => !roots.some((other) => other !== root && other.contains(root)));
  }

  function getMailBodyRoots() {
    if (!isMailAppPage()) {
      return [];
    }

    for (const selector of MAIL_BODY_ROOT_SELECTOR_GROUPS) {
      const roots = Array.from(document.querySelectorAll(selector)).filter(isEligibleRoot);
      if (roots.length > 0) {
        const bestRoot = pickBestRoot(roots);
        return bestRoot ? [bestRoot] : collapseNestedRoots(roots).slice(0, 1);
      }
    }

    return [];
  }

  function findPrimaryContentRoot() {
    const roots = Array.from(document.querySelectorAll(PRIMARY_ROOT_SELECTOR)).filter(isEligibleRoot);
    return pickBestRoot(roots) || null;
  }

  function pickBestRoot(roots) {
    const collapsed = collapseNestedRoots(roots);
    const scored = collapsed
      .map((root) => ({ root, score: scoreContentRoot(root) }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score);

    return scored[0]?.root || null;
  }

  function scoreContentRoot(element) {
    const text = normalizeText(element.innerText || "");
    const textLength = text.length;
    if (textLength < 120) {
      return 0;
    }

    const paragraphCount = element.querySelectorAll("p, li, blockquote").length;
    const headingCount = element.querySelectorAll("h1, h2, h3, h4, h5, h6, [role='heading']").length;
    const linkTextLength = normalizeText(Array.from(element.querySelectorAll("a")).map((anchor) => anchor.textContent || "").join(" ")).length;
    const chromePenalty = APP_CHROME_SELECTOR && element.matches?.(APP_CHROME_SELECTOR) ? 1200 : 0;

    return textLength + paragraphCount * 120 + headingCount * 180 - linkTextLength * 0.18 - chromePenalty;
  }

  function getCandidateExtractions(element) {
    const virtualBlocks = getVirtualInlineBlockExtractions(element);
    if (virtualBlocks.length > 1) {
      return virtualBlocks;
    }

    const boundaryAnchor = findBlockBoundary(element);
    if (boundaryAnchor) {
      const leadingText = extractLeadingInlineText(element);
      if (leadingText) {
        return [{
          text: leadingText,
          mode: "leading-inline",
          boundaryAnchor
        }];
      }
    }

    return [{
      text: extractTranslatableText(element),
      mode: "full",
      boundaryAnchor: null
    }];
  }

  function getVirtualInlineBlockExtractions(element) {
    if (!/^(DIV|SECTION|ARTICLE|TD|SPAN)$/.test(element.tagName)) {
      return [];
    }

    if (!element.querySelector("br")) {
      return [];
    }

    if (hasReadableChildBlock(element)) {
      return [];
    }

    const segments = extractVirtualInlineBlockSegments(element);
    if (segments.length < 2) {
      return [];
    }

    return segments.map((segment) => ({
      text: segment.text,
      mode: "virtual-block",
      boundaryAnchor: segment.boundaryAnchor || null,
      insertionAnchor: segment.insertionAnchor || null
    }));
  }

  function extractVirtualInlineBlockSegments(element) {
    const segments = [{ parts: [], insertionAnchor: null, boundaryAnchor: null }];
    collectInlineSegments(element, segments);

    return segments
      .map((segment) => ({
        text: segment.parts.join(" ").replace(/\s*\n\s*/g, " ").replace(/[ \t]+/g, " ").trim(),
        insertionAnchor: segment.insertionAnchor,
        boundaryAnchor: segment.boundaryAnchor
      }))
      .filter((segment) => segment.text.length > 0);
  }

  function collectInlineSegments(node, segments) {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        const value = child.nodeValue?.replace(/\s+/g, " ").trim();
        if (value) {
          segments[segments.length - 1].parts.push(value);
        }
        continue;
      }

      if (child.nodeType !== Node.ELEMENT_NODE) {
        continue;
      }

      const element = child;
      if (element.closest(OWNED_SELECTOR)) {
        continue;
      }

      if (element.matches(BLOCK_TRANSLATION_BOUNDARY_SELECTOR)) {
        if (segments[segments.length - 1].parts.length > 0) {
          segments[segments.length - 1].boundaryAnchor = element;
        }
        return true;
      }

      if (element.tagName === "BR") {
        if (segments[segments.length - 1].parts.length > 0) {
          segments[segments.length - 1].insertionAnchor = element;
          segments.push({ parts: [], insertionAnchor: null, boundaryAnchor: null });
        }
        continue;
      }

      if (element.matches(INLINE_SKIP_SELECTOR)) {
        continue;
      }

      if (collectInlineSegments(element, segments)) {
        return true;
      }
    }

    return false;
  }

  function findBlockBoundary(element) {
    if (!/^(DIV|SECTION|ARTICLE|TD|SPAN)$/.test(element.tagName)) {
      return null;
    }

    return Array.from(element.querySelectorAll(BLOCK_TRANSLATION_BOUNDARY_SELECTOR)).find((child) => !child.closest(OWNED_SELECTOR)) || null;
  }

  function extractLeadingInlineText(element) {
    const parts = [];
    collectLeadingInlineParts(element, parts);

    return parts
      .join(" ")
      .replace(/\s*\n\s*/g, "\n")
      .replace(/[ \t]+/g, " ")
      .trim();
  }

  function collectLeadingInlineParts(node, parts) {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        const value = child.nodeValue?.replace(/\s+/g, " ").trim();
        if (value) {
          parts.push(value);
        }
        continue;
      }

      if (child.nodeType !== Node.ELEMENT_NODE) {
        continue;
      }

      const element = child;
      if (element.closest(OWNED_SELECTOR)) {
        continue;
      }

      if (element.matches(BLOCK_TRANSLATION_BOUNDARY_SELECTOR)) {
        return true;
      }

      if (element.tagName === "BR") {
        if (parts.length > 0 && parts[parts.length - 1] !== "\n") {
          parts.push("\n");
        }
        continue;
      }

      if (element.matches(INLINE_SKIP_SELECTOR)) {
        continue;
      }

      if (collectLeadingInlineParts(element, parts)) {
        return true;
      }
    }

    return false;
  }

  function extractTranslatableText(element) {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) {
          return NodeFilter.FILTER_REJECT;
        }

        if (parent.closest(OWNED_SELECTOR)) {
          return NodeFilter.FILTER_REJECT;
        }

        if (parent.closest(INLINE_SKIP_SELECTOR)) {
          return NodeFilter.FILTER_REJECT;
        }

        const value = node.nodeValue?.replace(/\s+/g, " ").trim();
        if (!value) {
          return NodeFilter.FILTER_REJECT;
        }

        return NodeFilter.FILTER_ACCEPT;
      }
    });

    const parts = [];
    let node;
    while ((node = walker.nextNode())) {
      const value = node.nodeValue.replace(/\s+/g, " ").trim();
      if (value) {
        parts.push(value);
      }
    }

    return parts.join(" ").trim();
  }

  function normalizeText(text) {
    return text.replace(/\s+/g, " ").trim();
  }

  function isReadableBlockElement(element, extraction) {
    if (isHeadingElement(element)) {
      return true;
    }

    if (/^(P|LI|BLOCKQUOTE|H1|H2|H3|H4|H5|H6|FIGCAPTION|DD|DT|DIV|SECTION|ARTICLE|TD)$/.test(element.tagName)) {
      return true;
    }

    if (element.tagName === "SPAN") {
      return extraction.mode === "leading-inline";
    }

    const style = window.getComputedStyle(element);
    return !["inline", "contents", "none"].includes(style.display);
  }

  function hasReadableChildBlock(element) {
    for (const child of element.querySelectorAll(BLOCK_ELEMENT_SELECTOR)) {
      if (child === element || child.closest(OWNED_SELECTOR)) {
        continue;
      }

      if (child.closest(SKIP_ANCESTOR_SELECTOR)) {
        continue;
      }

      const style = window.getComputedStyle(child);
      if (style.display === "none" || style.visibility === "hidden") {
        continue;
      }

      const text = normalizeText(extractTranslatableText(child));
      const minLength = isHeadingElement(child) ? MIN_HEADING_LENGTH : MIN_TEXT_LENGTH;
      if (text.length >= minLength) {
        return true;
      }
    }

    return false;
  }

  function hasEquivalentReadableChild(element, text) {
    const normalized = normalizeText(text);
    if (!normalized) {
      return false;
    }

    for (const child of element.querySelectorAll(BLOCK_ELEMENT_SELECTOR)) {
      if (child === element || child.closest(OWNED_SELECTOR)) {
        continue;
      }

      if (child.closest(SKIP_ANCESTOR_SELECTOR)) {
        continue;
      }

      const style = window.getComputedStyle(child);
      if (style.display === "none" || style.visibility === "hidden") {
        continue;
      }

      const childText = normalizeText(extractTranslatableText(child));
      if (!childText) {
        continue;
      }

      const minLength = isHeadingElement(child) ? MIN_HEADING_LENGTH : MIN_TEXT_LENGTH;
      if (childText.length < minLength) {
        continue;
      }

      if (childText === normalized) {
        return true;
      }
    }

    return false;
  }

  function hasEquivalentDescendantExtraction(element, extraction) {
    const normalized = normalizeText(extraction.text);
    if (!normalized) {
      return false;
    }

    for (const child of element.querySelectorAll(DISCOVERY_SELECTOR)) {
      if (child === element || child.closest(OWNED_SELECTOR)) {
        continue;
      }

      if (child.closest(SKIP_ANCESTOR_SELECTOR)) {
        continue;
      }

      const style = window.getComputedStyle(child);
      if (style.display === "none" || style.visibility === "hidden") {
        continue;
      }

      const childExtractions = getCandidateExtractions(child);
      for (const childExtraction of childExtractions) {
        if (!isBasicCandidateElement(child, childExtraction)) {
          continue;
        }

        if (normalizeText(childExtraction.text) !== normalized) {
          continue;
        }

        return true;
      }
    }

    return false;
  }

  function isProbablyCode(text) {
    const symbolDensity = (text.match(/[{}()[\];_=<>/\\`$]/g) || []).length / Math.max(text.length, 1);
    const keywordHits = /\b(function|const|let|var|class|return|import|export|SELECT|INSERT|UPDATE|DELETE|npm|yarn|pnpm)\b/.test(text);
    const identifierHits = /[a-z]+[A-Z][a-zA-Z]+|[a-zA-Z]+_[a-zA-Z_]+/.test(text);
    return symbolDensity > 0.09 || (keywordHits && identifierHits);
  }

  function ensureObserver() {
    if (state.observer) {
      return;
    }

    state.observer = new IntersectionObserver(onIntersect, {
      root: null,
      rootMargin: "150% 0px 150% 0px",
      threshold: 0.05
    });

    for (const unit of state.units.values()) {
      state.observer.observe(unit.element);
    }
  }

  function onIntersect(entries) {
    if (!state.enabled) {
      return;
    }

    for (const entry of entries) {
      if (!entry.isIntersecting) {
        continue;
      }

      const unitIds = state.elementToIds.get(entry.target);
      if (!unitIds || unitIds.length === 0) {
        continue;
      }

      for (const unitId of unitIds) {
        const unit = state.units.get(unitId);
        if (!unit || unit.status === "translated" || unit.status === "streaming") {
          continue;
        }

        state.queue.add(unitId);
      }
    }

    scheduleFlush();
  }

  function queueVisibleUnits() {
    if (!state.enabled) {
      return;
    }

    for (const [unitId, unit] of state.units.entries()) {
      if (unit.status === "translated" || unit.status === "streaming") {
        continue;
      }

      const rect = unit.element.getBoundingClientRect();
      if (rect.bottom >= -window.innerHeight && rect.top <= window.innerHeight * 2.2) {
        state.queue.add(unitId);
      }
    }

    scheduleFlush();
  }

  function scheduleFlush() {
    if (state.flushTimer) {
      return;
    }

    state.flushTimer = window.setTimeout(flushQueue, 160);
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

      batch.push({ id: unit.id, text: unit.text });
      charCount = projected;
      unit.status = "queued";
      state.queue.delete(unitId);
    }

    if (batch.length === 0) {
      return;
    }

    try {
      const response = await chrome.runtime.sendMessage({
        type: "ruyi/translate-batch",
        batchId: createBatchId(),
        units: batch
      });

      if (!response?.ok) {
        throw new Error(response?.error || "翻译请求失败");
      }
    } catch (error) {
      for (const item of batch) {
        const unit = state.units.get(item.id);
        if (unit) {
          unit.status = "error";
          unit.error = error.message;
          ensureTranslationNode(unit, error.message);
          unit.translationNode.dataset.state = "error";
          unit.translationNode.dataset.hidden = state.enabled ? "false" : "true";
        }
      }
      renderStatus(error.message);
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

    unit.translation = text;
    unit.status = "translated";
    unit.error = "";
    ensureTranslationNode(unit, text);
    unit.translationNode.dataset.state = "translated";
    unit.translationNode.dataset.hidden = state.enabled ? "false" : "true";
    renderStatus();
  }

  function ensureTranslationNode(unit, content) {
    if (!unit.translationNode) {
      const placement = getTranslationPlacement(unit);
      const block = document.createElement(placement.tagName);
      block.className = "ruyi-translation-block";
      block.dataset.ruyiOwned = "true";
      block.dataset.hidden = state.enabled ? "false" : "true";
      block.dataset.placement = placement.mode;
      applyPresentationStyle(unit.element, block);

      if (placement.mode === "append") {
        unit.element.append(block);
      } else if ((placement.mode === "before-boundary" || placement.mode === "before-anchor") && placement.anchor) {
        placement.anchor.before(block);
      } else {
        unit.element.insertAdjacentElement("afterend", block);
      }

      unit.translationNode = block;
    }

    unit.translationNode.textContent = content;
  }

  function getTranslationPlacement(unit) {
    const element = unit.element;

    if (unit.sourceMode === "leading-inline" && unit.boundaryAnchor) {
      return {
        tagName: isHeadingElement(element) || isHeadingLikeElement(element, unit.text) ? "p" : "div",
        mode: "before-boundary",
        anchor: unit.boundaryAnchor
      };
    }

    if (unit.sourceMode === "virtual-block") {
      if (unit.insertionAnchor) {
        return {
          tagName: "div",
          mode: "before-anchor",
          anchor: unit.insertionAnchor
        };
      }

      if (unit.boundaryAnchor) {
        return {
          tagName: "div",
          mode: "before-boundary",
          anchor: unit.boundaryAnchor
        };
      }

      if (element.tagName === "TD") {
        return {
          tagName: "div",
          mode: "append"
        };
      }

      return {
        tagName: "div",
        mode: "afterend"
      };
    }

    if (element.tagName === "LI") {
      return {
        tagName: "div",
        mode: "append"
      };
    }

    if (element.tagName === "TD") {
      return {
        tagName: "div",
        mode: "append"
      };
    }

    if (element.tagName === "SPAN") {
      return {
        tagName: "div",
        mode: "afterend"
      };
    }

    return {
      tagName: element.tagName,
      mode: "afterend"
    };
  }

  function applyPresentationStyle(source, target) {
    const style = window.getComputedStyle(source);
    const whiteList = [
      "fontSize",
      "lineHeight",
      "fontWeight",
      "fontStyle",
      "fontFamily",
      "color",
      "textAlign",
      "textTransform",
      "textIndent",
      "direction",
      "letterSpacing",
      "wordSpacing",
      "listStyleType",
      "listStylePosition"
    ];

    for (const property of whiteList) {
      target.style[property] = style[property];
    }

    target.style.whiteSpace = "pre-wrap";
    target.style.marginTop = target.dataset.placement === "append" ? "0.2em" : "0.35em";
    target.style.marginBottom = target.dataset.placement === "append" ? "0" : style.marginBottom;
  }

  function hideTranslations() {
    for (const unit of state.units.values()) {
      if (unit.translationNode) {
        unit.translationNode.dataset.hidden = "true";
      }
    }
  }

  function showTranslations() {
    for (const unit of state.units.values()) {
      if (unit.translationNode && (unit.translation || unit.status === "streaming" || unit.status === "error")) {
        unit.translationNode.dataset.hidden = "false";
      }
    }
  }

  function renderActionLabel() {
    if (!state.actionButton) {
      return;
    }

    state.actionButton.textContent = state.enabled ? "中" : "英";
  }

  function renderStatus(overrideMessage) {
    if (!state.panel) {
      return;
    }

    const translatedCount = Array.from(state.units.values()).filter((unit) => unit.status === "translated").length;
    const queueCount = Array.from(state.units.values()).filter((unit) => unit.status === "queued" || unit.status === "streaming").length;
    const hasConfig = state.config.hasApiKey;

    state.panel.dataset.busy = state.busyCount > 0 ? "true" : "false";

    if (!state.statusNode || !state.chipNode) {
      return;
    }

    if (overrideMessage) {
      state.statusNode.textContent = overrideMessage;
    } else if (!hasConfig) {
      state.statusNode.textContent = "还没有配置模型信息。点击右侧设置按钮填写 API URL、Key 和模型名。";
    } else if (!state.enabled) {
      state.statusNode.textContent = `当前显示原文。目标语言：${state.config.targetLanguage}。点击后会开始翻译视口附近正文。`;
    } else if (state.busyCount > 0 || queueCount > 0) {
      state.statusNode.textContent = `正在处理正文。已完成 ${translatedCount} 段，队列中 ${queueCount} 段。译文会逐段出现。`;
    } else if (translatedCount > 0) {
      state.statusNode.textContent = `已显示 ${translatedCount} 段译文。再次点击可切回原文，当前页面缓存会保留。`;
    } else if (isMailAppPage() && getCandidateRoots().length === 0) {
      state.statusNode.textContent = "当前是邮件应用页面。请先打开一封邮件正文，再点击按钮开始翻译。";
    } else {
      state.statusNode.textContent = "未发现可翻译正文，或当前视口附近还没有满足启发式规则的内容。";
    }

    if (!state.enabled) {
      state.chipNode.textContent = "待命";
    } else if (state.busyCount > 0 || queueCount > 0) {
      state.chipNode.textContent = "翻译中";
    } else if (translatedCount > 0) {
      state.chipNode.textContent = "已翻译";
    } else {
      state.chipNode.textContent = "扫描中";
    }
  }

  function createUnitId() {
    return `unit-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
  }

  function createBatchId() {
    return `batch-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }
})();