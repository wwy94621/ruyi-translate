const DEFAULT_CONFIG = {
  endpointUrl: "https://api.openai.com/v1/chat/completions",
  model: "gpt-5.4-mini",
  targetLanguage: "简体中文",
  requestTimeoutMs: 45000,
  maxBatchChars: 2200,
  debug: false
};
const PDF_VIEWER_PATH = "src/pdf/viewer.html";
const PDF_VIEWER_QUERY_KEYS = ["file", "src", "url", "source"];
const PDF_VIEWER_URL = chrome.runtime.getURL(PDF_VIEWER_PATH);
const DEBUG_LOG_KEY = "ruyiDebugLog";
const DEBUG_LOG_LIMIT = 120;
const DEBUG_LAST_EVENT_KEY = "ruyiDebugLastEvent";

void debugLog("service-worker-started", {
  version: chrome.runtime.getManifest().version,
  startedAt: new Date().toISOString()
});
void setDebugBadge("SW", "#6b7280");

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  const existing = await chrome.storage.sync.get(Object.keys(DEFAULT_CONFIG));
  const nextConfig = {};

  for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
    if (existing[key] === undefined) {
      nextConfig[key] = value;
    }
  }

  if (Object.keys(nextConfig).length > 0) {
    await chrome.storage.sync.set(nextConfig);
  }

  if (reason === chrome.runtime.OnInstalledReason.INSTALL) {
    chrome.runtime.openOptionsPage();
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) {
    return;
  }

  await activateForTab(tab, "action");
});

async function activateForTab(tab, trigger) {
  try {
    await setDebugBadge("CLK", "#2563eb");
    await debugLog("activate-start", {
      trigger,
      tab: summarizeTab(tab)
    });

    const refreshedTab = await chrome.tabs.get(tab.id).catch(() => null);
    const currentTab = mergeTabSnapshot(tab, refreshedTab);
    await debugLog("activate-tab-resolved", {
      trigger,
      tab: summarizeTab(currentTab)
    });

    const pdfSource = await resolvePdfSourceForTab(currentTab);
    if (pdfSource) {
      await setDebugBadge("PDF", "#7c3aed");
      await debugLog("activate-pdf-detected", {
        trigger,
        tabId: currentTab.id,
        pdfSource
      });
      await openPdfViewer(currentTab, pdfSource);
      return { ok: true, mode: "pdf", source: pdfSource };
    }

    await ensureContentScript(tab.id);
    await setDebugBadge("HTML", "#059669");
    await debugLog("activate-content-script-ready", {
      trigger,
      tabId: tab.id
    });
    await chrome.tabs.sendMessage(tab.id, { type: "ruyi/reveal-panel" });
    await debugLog("activate-panel-revealed", {
      trigger,
      tabId: tab.id
    });
    return { ok: true, mode: "html" };
  } catch (error) {
    await setDebugBadge("ERR", "#dc2626");
    await debugLog("activate-primary-failed", {
      trigger,
      tabId: tab.id,
      error: serializeError(error)
    });

    try {
      const fallbackTab = await chrome.tabs.get(tab.id).catch(() => tab);
      const fallbackPdfSource = await resolvePdfSourceForTab(fallbackTab);
      if (fallbackPdfSource) {
        await debugLog("activate-fallback-pdf-detected", {
          trigger,
          tabId: fallbackTab.id,
          pdfSource: fallbackPdfSource
        });
        await openPdfViewer(fallbackTab, fallbackPdfSource);
        return { ok: true, mode: "pdf", source: fallbackPdfSource, fallback: true };
      }

      await debugLog("activate-fallback-no-pdf", {
        trigger,
        tab: summarizeTab(fallbackTab)
      });
    } catch (fallbackError) {
      await debugLog("activate-fallback-failed", {
        trigger,
        tabId: tab.id,
        error: serializeError(fallbackError)
      });
      console.error("Failed to open PDF viewer fallback", fallbackError);
    }

    console.error("Failed to activate content script", error);
    return {
      ok: false,
      error: error?.message || "Activation failed."
    };
  }
}

async function resolvePdfSourceForTab(tab) {
  const direct = getPdfSourceUrl(tab);
  if (direct) {
    await debugLog("pdf-source-direct-hit", {
      tab: summarizeTab(tab),
      pdfSource: direct
    });
    return direct;
  }

  if (!tab?.id) {
    await debugLog("pdf-source-miss-no-tab-id", {
      tab: summarizeTab(tab)
    });
    return null;
  }

  const probed = await probePdfSourceFromTab(tab.id);
  await debugLog("pdf-source-probed", {
    tabId: tab.id,
    pdfSource: probed || null
  });
  return probed || null;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") {
    return;
  }

  if (message.type === "ruyi/open-options") {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return;
  }

  if (message.type === "ruyi/get-config") {
    getConfig()
      .then((config) => sendResponse({ ok: true, config: sanitizeConfig(config) }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "ruyi/open-pdf-viewer") {
    const tabId = sender.tab?.id;
    const sourceUrl = typeof message.sourceUrl === "string" ? message.sourceUrl.trim() : "";

    if (!tabId) {
      sendResponse({ ok: false, error: "Missing sender tab id." });
      return;
    }

    if (!sourceUrl) {
      sendResponse({ ok: false, error: "Missing PDF source url." });
      return;
    }

    chrome.tabs.get(tabId)
      .then(async (tab) => {
        const targetTab = {
          ...tab,
          title: typeof message.title === "string" && message.title.trim() ? message.title.trim() : tab.title
        };
        await debugLog("content-open-pdf-viewer", {
          tab: summarizeTab(targetTab),
          sourceUrl
        });
        await openPdfViewer(targetTab, sourceUrl);
        sendResponse({ ok: true });
      })
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "ruyi/get-debug-log") {
    getDebugLog()
      .then((entries) => sendResponse({ ok: true, entries }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "ruyi/clear-debug-log") {
    clearDebugLog()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "ruyi/translate-batch") {
    const tabId = sender.tab?.id;

    if (!tabId) {
      sendResponse({ ok: false, error: "Missing tab id." });
      return;
    }

    streamTranslationBatchToTab(tabId, message)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        console.error("Translation batch failed", error);
        sendResponse({ ok: false, error: error.message });
      });

    return true;
  }

  if (message.type === "ruyi/pdf-translate-batch") {
    if (!message.viewerSessionId) {
      sendResponse({ ok: false, error: "Missing viewer session id." });
      return;
    }

    streamTranslationBatchToViewer(message.viewerSessionId, message)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        console.error("PDF translation batch failed", error);
        sendResponse({ ok: false, error: error.message });
      });

    return true;
  }
});

async function openPdfViewer(tab, sourceUrl) {
  const viewerUrl = new URL(chrome.runtime.getURL(PDF_VIEWER_PATH));
  viewerUrl.searchParams.set("source", sourceUrl);
  viewerUrl.searchParams.set("autostart", "1");

  const title = String(tab.title || "").trim();
  if (title) {
    viewerUrl.searchParams.set("title", title);
  }

  const viewerUrlString = viewerUrl.toString();
  if (isPdfViewerTab(tab)) {
    await chrome.tabs.update(tab.id, { url: viewerUrlString });
    await debugLog("pdf-viewer-updated-existing-viewer-tab", {
      tabId: tab.id,
      viewerUrl: viewerUrlString,
      sourceUrl
    });
    return;
  }

  const reusableViewerTab = await findReusablePdfViewerTab(sourceUrl, tab.id);
  if (reusableViewerTab?.id) {
    await chrome.tabs.update(reusableViewerTab.id, {
      url: viewerUrlString,
      active: true
    });
    await debugLog("pdf-viewer-reused-existing-tab", {
      sourceTabId: tab.id,
      viewerTabId: reusableViewerTab.id,
      viewerUrl: viewerUrlString,
      sourceUrl
    });
    return;
  }

  const createdTab = await chrome.tabs.create({
    url: viewerUrlString,
    index: typeof tab.index === "number" ? tab.index + 1 : undefined,
    openerTabId: tab.id,
    active: true
  });

  await debugLog("pdf-viewer-opened-new-tab", {
    sourceTabId: tab.id,
    viewerTabId: createdTab?.id ?? null,
    viewerUrl: viewerUrlString,
    sourceUrl
  });
}

async function findReusablePdfViewerTab(sourceUrl, excludedTabId) {
  const tabs = await chrome.tabs.query({ url: `${PDF_VIEWER_URL}*` }).catch(() => []);
  for (const candidate of tabs) {
    if (!candidate?.id || candidate.id === excludedTabId) {
      continue;
    }

    const candidateSource = getPdfSourceUrl(candidate);
    if (candidateSource === sourceUrl) {
      return candidate;
    }
  }

  return null;
}

function isPdfViewerTab(tab) {
  const url = normalizePossibleUrl(tab?.url);
  return Boolean(url && url.startsWith(PDF_VIEWER_URL));
}

function getPdfSourceUrl(tab) {
  const candidates = [tab.url, tab.pendingUrl]
    .map((value) => normalizePossibleUrl(value))
    .filter(Boolean);

  for (const candidate of candidates) {
    if (candidate.startsWith(PDF_VIEWER_URL)) {
      const parsedViewer = safeParseUrl(candidate);
      const viewerSource = extractNestedPdfUrl(parsedViewer, 0);
      if (viewerSource) {
        return viewerSource;
      }

      continue;
    }

    const resolved = resolvePdfSourceFromUrl(candidate, 0);
    if (resolved) {
      return resolved;
    }
  }

  const title = String(tab.title || "").trim();
  if (/\.pdf$/i.test(title) && candidates.length > 0) {
    const fallback = candidates.find((value) => /^https?:/i.test(value) || /^file:/i.test(value));
    if (fallback) {
      return fallback;
    }
  }

  return null;
}

async function probePdfSourceFromTab(tabId) {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const candidates = [window.location.href, window.location.search, window.location.hash];
        const selectors = [
          'embed[type="application/pdf"]',
          'iframe[src*=".pdf"]',
          'embed[src*=".pdf"]',
          'object[data*=".pdf"]'
        ];

        for (const selector of selectors) {
          const node = document.querySelector(selector);
          if (!(node instanceof Element)) {
            continue;
          }

          const source = node.getAttribute("src") || node.getAttribute("data");
          if (source) {
            candidates.push(source);
          }
        }

        const documentContentType = document.contentType || "";
        const bodyType = document.body?.getAttribute("type") || "";

        return {
          candidates,
          documentContentType,
          bodyType
        };
      }
    });

    const payload = result?.result;
    if (!payload) {
      await debugLog("pdf-probe-empty-result", {
        tabId
      });
      return null;
    }

    await debugLog("pdf-probe-result", {
      tabId,
      payload: {
        candidates: (payload.candidates || []).slice(0, 8),
        documentContentType: payload.documentContentType || "",
        bodyType: payload.bodyType || ""
      }
    });

    for (const candidate of payload.candidates || []) {
      const resolved = resolvePdfSourceFromUrl(candidate, 0);
      if (resolved) {
        await debugLog("pdf-probe-candidate-hit", {
          tabId,
          candidate,
          pdfSource: resolved
        });
        return resolved;
      }
    }

    if (String(payload.documentContentType).toLowerCase().includes("pdf")) {
      const fallback = normalizePossibleUrl(payload.candidates?.[0]);
      if (fallback) {
        await debugLog("pdf-probe-content-type-hit", {
          tabId,
          pdfSource: fallback
        });
        return fallback;
      }
    }

    if (String(payload.bodyType).toLowerCase().includes("pdf")) {
      const fallback = normalizePossibleUrl(payload.candidates?.find(Boolean));
      if (fallback) {
        await debugLog("pdf-probe-body-type-hit", {
          tabId,
          pdfSource: fallback
        });
        return fallback;
      }
    }

    await debugLog("pdf-probe-no-hit", {
      tabId
    });
    return null;
  } catch (error) {
    await debugLog("pdf-probe-failed", {
      tabId,
      error: serializeError(error)
    });
    return null;
  }
}

function resolvePdfSourceFromUrl(rawUrl, depth) {
  if (!rawUrl || depth > 3) {
    return null;
  }

  const parsed = safeParseUrl(rawUrl);
  if (!parsed) {
    return null;
  }

  if (rawUrl.startsWith(PDF_VIEWER_URL)) {
    return extractNestedPdfUrl(parsed, depth);
  }

  if ((parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "file:") && looksLikePdfResource(parsed)) {
    return parsed.toString();
  }

  return extractNestedPdfUrl(parsed, depth);
}

function extractNestedPdfUrl(parsed, depth) {
  if (!parsed) {
    return null;
  }

  const searchParams = collectCandidateParams(parsed);
  for (const key of PDF_VIEWER_QUERY_KEYS) {
    const nested = normalizePossibleUrl(searchParams.get(key));
    if (!nested) {
      continue;
    }

    const resolved = resolvePdfSourceFromUrl(nested, depth + 1);
    if (resolved) {
      return resolved;
    }
  }

  return null;
}

function collectCandidateParams(parsed) {
  const params = new URLSearchParams(parsed.search);
  const hash = parsed.hash.startsWith("#") ? parsed.hash.slice(1) : parsed.hash;
  if (hash.includes("=")) {
    const hashParams = new URLSearchParams(hash);
    for (const [key, value] of hashParams.entries()) {
      if (!params.has(key)) {
        params.set(key, value);
      }
    }
  }

  return params;
}

function looksLikePdfResource(url) {
  const pathname = url.pathname || "";
  const search = url.search || "";

  return /\.pdf($|[?#])/i.test(`${pathname}${search}`);
}

function safeParseUrl(rawUrl) {
  try {
    return new URL(rawUrl);
  } catch (error) {
    return null;
  }
}

function normalizePossibleUrl(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return decodeURIComponent(trimmed);
  } catch (error) {
    return trimmed;
  }
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "ruyi/ping" });
    await debugLog("content-script-already-ready", {
      tabId
    });
    return;
  } catch (error) {
    await debugLog("content-script-ping-missed", {
      tabId,
      error: serializeError(error)
    });

    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ["src/content/content.css"]
    });

    await debugLog("content-script-css-inserted", {
      tabId
    });

    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["src/content/content-script.js"]
    });

    await debugLog("content-script-js-executed", {
      tabId
    });
  }
}

async function debugLog(event, details = {}) {
  const entry = {
    time: new Date().toISOString(),
    event,
    details
  };

  console.info("[Ruyi Translate][debug]", event, details);

  try {
    const data = await chrome.storage.local.get([DEBUG_LOG_KEY]);
    const entries = Array.isArray(data[DEBUG_LOG_KEY]) ? data[DEBUG_LOG_KEY] : [];
    entries.unshift(entry);
    if (entries.length > DEBUG_LOG_LIMIT) {
      entries.length = DEBUG_LOG_LIMIT;
    }
    await chrome.storage.local.set({
      [DEBUG_LOG_KEY]: entries,
      [DEBUG_LAST_EVENT_KEY]: entry
    });
  } catch (error) {
    console.warn("Failed to persist debug log", error);
  }
}

async function getDebugLog() {
  const data = await chrome.storage.local.get([DEBUG_LOG_KEY]);
  return Array.isArray(data[DEBUG_LOG_KEY]) ? data[DEBUG_LOG_KEY] : [];
}

async function clearDebugLog() {
  await chrome.storage.local.remove([DEBUG_LOG_KEY]);
}

function sanitizeTabSnapshot(tab) {
  if (!tab || typeof tab !== "object") {
    return null;
  }

  const id = Number(tab.id);
  if (!Number.isInteger(id) || id <= 0) {
    return null;
  }

  return {
    id,
    url: typeof tab.url === "string" ? tab.url : "",
    pendingUrl: typeof tab.pendingUrl === "string" ? tab.pendingUrl : "",
    title: typeof tab.title === "string" ? tab.title : "",
    status: typeof tab.status === "string" ? tab.status : "",
    discarded: Boolean(tab.discarded),
    index: Number.isInteger(tab.index) ? tab.index : undefined
  };
}

function mergeTabSnapshot(primary, secondary) {
  if (!primary && !secondary) {
    return null;
  }

  if (!secondary) {
    return primary;
  }

  if (!primary) {
    return secondary;
  }

  return {
    ...secondary,
    ...primary,
    url: primary.url || secondary.url || "",
    pendingUrl: primary.pendingUrl || secondary.pendingUrl || "",
    title: primary.title || secondary.title || "",
    status: secondary.status || primary.status || "",
    discarded: Boolean(primary.discarded || secondary.discarded),
    index: Number.isInteger(secondary.index) ? secondary.index : primary.index
  };
}

async function setDebugBadge(text, color) {
  try {
    await chrome.action.setBadgeBackgroundColor({ color });
    await chrome.action.setBadgeText({ text });
  } catch (error) {
    console.warn("Failed to update debug badge", error);
  }
}

function summarizeTab(tab) {
  if (!tab) {
    return null;
  }

  return {
    id: tab.id ?? null,
    url: tab.url || "",
    pendingUrl: tab.pendingUrl || "",
    title: tab.title || "",
    status: tab.status || "",
    discarded: Boolean(tab.discarded)
  };
}

function serializeError(error) {
  if (!error) {
    return null;
  }

  return {
    name: error.name || "Error",
    message: error.message || String(error),
    stack: typeof error.stack === "string" ? error.stack.split("\n").slice(0, 6).join("\n") : ""
  };
}

async function getConfig() {
  const syncConfig = await chrome.storage.sync.get(Object.keys(DEFAULT_CONFIG));
  const localConfig = await chrome.storage.local.get(["apiKey"]);

  return {
    ...DEFAULT_CONFIG,
    ...syncConfig,
    apiKey: localConfig.apiKey || ""
  };
}

function sanitizeConfig(config) {
  return {
    endpointUrl: config.endpointUrl,
    model: config.model,
    targetLanguage: config.targetLanguage,
    requestTimeoutMs: config.requestTimeoutMs,
    maxBatchChars: config.maxBatchChars,
    debug: Boolean(config.debug),
    hasApiKey: Boolean(config.apiKey)
  };
}

async function streamTranslationBatchToTab(tabId, message) {
  return streamTranslationBatch(message, {
    started(unitIds) {
      return chrome.tabs.sendMessage(tabId, {
        type: "ruyi/translation-started",
        batchId: message.batchId,
        unitIds
      });
    },
    segment(unitId, text) {
      return chrome.tabs.sendMessage(tabId, {
        type: "ruyi/translation-segment",
        batchId: message.batchId,
        unitId,
        text
      }).catch(() => {});
    },
    complete(unitIds) {
      return chrome.tabs.sendMessage(tabId, {
        type: "ruyi/translation-complete",
        batchId: message.batchId,
        unitIds
      });
    },
    error(unitIds, errorMessage) {
      return chrome.tabs.sendMessage(tabId, {
        type: "ruyi/translation-error",
        batchId: message.batchId,
        unitIds,
        error: errorMessage
      }).catch(() => {});
    }
  });
}

async function streamTranslationBatchToViewer(viewerSessionId, message) {
  const sendToViewer = (payload) => {
    return chrome.runtime.sendMessage({
      ...payload,
      viewerSessionId
    }).catch(() => {});
  };

  return streamTranslationBatch(message, {
    started(unitIds) {
      return sendToViewer({
        type: "ruyi/pdf-translation-started",
        batchId: message.batchId,
        unitIds
      });
    },
    segment(unitId, text) {
      return sendToViewer({
        type: "ruyi/pdf-translation-segment",
        batchId: message.batchId,
        unitId,
        text
      });
    },
    complete(unitIds) {
      return sendToViewer({
        type: "ruyi/pdf-translation-complete",
        batchId: message.batchId,
        unitIds
      });
    },
    error(unitIds, errorMessage) {
      return sendToViewer({
        type: "ruyi/pdf-translation-error",
        batchId: message.batchId,
        unitIds,
        error: errorMessage
      });
    }
  });
}

async function streamTranslationBatch(message, emitter) {
  const config = await getConfig();
  const unitIds = message.units.map((unit) => unit.id);

  if (!config.endpointUrl || !config.apiKey || !config.model) {
    await emitter.error(unitIds, "请先在配置页填写 API URL、API Key 和模型名。");
    return;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort("timeout"), config.requestTimeoutMs);
  const parser = createSegmentParser((segment) => emitter.segment(segment.id, segment.text));

  try {
    await emitter.started(unitIds);

    const response = await fetch(config.endpointUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`
      },
      body: JSON.stringify(buildRequestPayload(config, message.units)),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    if (!response.body) {
      throw new Error("响应不支持流式读取。");
    }

    await consumeOpenAiStream(response.body, parser);
    parser.flush();

    await emitter.complete(unitIds);
  } catch (error) {
    await emitter.error(unitIds, toUserMessage(error));
  } finally {
    clearTimeout(timeoutId);
  }
}

function buildRequestPayload(config, units) {
  const segmentList = units
    .map((unit) => `<SOURCE id="${unit.id}">\n${unit.text}\n</SOURCE>`)
    .join("\n\n");

  return {
    model: config.model,
    stream: true,
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content: [
          "你是一个网页正文翻译助手。",
          `把输入内容翻译成${config.targetLanguage}。`,
          "必须保持每个段落与输入一一对应。",
          "如果输入段落中包含 <TABLE>、<ROW>、<CELL> 结构，必须完整保留这些标签以及行列数量，只翻译 CELL 标签内部的文字内容。",
          "不要合并、拆分、删除、重排任何 TABLE/ROW/CELL。空单元格保持为空。",
          "不要翻译代码、命令、URL、邮箱地址、路径、类名、函数名、变量名。",
          "输入中形如 __RUYI_PRESERVE_1__ 的占位符表示必须原样保留的内联代码或术语。",
          "你必须在译文对应位置逐字保留这些占位符，不要翻译、不要改写、不要丢失、不要新增空格。",
          "不要添加解释、前言或总结。",
          "如果输入包含 Markdown 表格（以 | 分隔的列），翻译时保持表格的行列结构不变，只翻译单元格中的文本。",
          "输出时仅使用以下格式，可重复多次：",
          '<SEGMENT id="原始id">',
          '翻译内容',
          '</SEGMENT>'
        ].join("\n")
      },
      {
        role: "user",
        content: segmentList
      }
    ]
  };
}

async function consumeOpenAiStream(stream, parser) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();

    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() || "";

    for (const part of parts) {
      const lines = part.split("\n");

      for (const line of lines) {
        if (!line.startsWith("data:")) {
          continue;
        }

        const payload = line.slice(5).trim();

        if (!payload || payload === "[DONE]") {
          continue;
        }

        const parsed = JSON.parse(payload);
        const delta = parsed.choices?.[0]?.delta?.content;

        if (typeof delta === "string" && delta.length > 0) {
          parser.push(delta);
        }
      }
    }
  }
}

function createSegmentParser(onSegment) {
  let buffer = "";
  let consumedUntil = 0;

  return {
    push(chunk) {
      buffer += chunk;
      consumeCompletedSegments();
    },
    flush() {
      consumeCompletedSegments();
    }
  };

  function consumeCompletedSegments() {
    const pattern = /<SEGMENT id="([^"]+)">([\s\S]*?)<\/SEGMENT>/g;
    pattern.lastIndex = consumedUntil;

    let match;
    let lastEnd = consumedUntil;

    while ((match = pattern.exec(buffer))) {
      const [, id, text] = match;
      lastEnd = pattern.lastIndex;
      onSegment({ id, text: text.trim() });
    }

    if (lastEnd > 0) {
      buffer = buffer.slice(lastEnd);
      consumedUntil = 0;
    }
  }
}

function toUserMessage(error) {
  if (error === "timeout" || error?.message === "timeout") {
    return "翻译请求超时，请稍后重试。";
  }

  if (error?.name === "AbortError") {
    return "翻译请求已中止。";
  }

  if (typeof error?.message === "string") {
    if (error.message.includes("401")) {
      return "鉴权失败，请检查 API Key。";
    }

    if (error.message.includes("429")) {
      return "请求过于频繁，请稍后再试。";
    }

    return error.message;
  }

  return "翻译失败，请稍后重试。";
}