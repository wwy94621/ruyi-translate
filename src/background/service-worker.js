const DEFAULT_CONFIG = {
  endpointUrl: "https://api.openai.com/v1/chat/completions",
  model: "gpt-5.4-mini",
  targetLanguage: "简体中文",
  requestTimeoutMs: 45000,
  maxBatchChars: 2200,
  debug: false
};

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

  try {
    await ensureContentScript(tab.id);
    await chrome.tabs.sendMessage(tab.id, { type: "ruyi/reveal-panel" });
  } catch (error) {
    console.error("Failed to activate content script", error);
  }
});

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

  if (message.type === "ruyi/translate-batch") {
    const tabId = sender.tab?.id;

    if (!tabId) {
      sendResponse({ ok: false, error: "Missing tab id." });
      return;
    }

    streamTranslationBatch(tabId, message)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        console.error("Translation batch failed", error);
        sendResponse({ ok: false, error: error.message });
      });

    return true;
  }
});

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "ruyi/ping" });
    return;
  } catch (error) {
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ["src/content/content.css"]
    });

    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["src/content/content-script.js"]
    });
  }
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

async function streamTranslationBatch(tabId, message) {
  const config = await getConfig();

  if (!config.endpointUrl || !config.apiKey || !config.model) {
    await chrome.tabs.sendMessage(tabId, {
      type: "ruyi/translation-error",
      batchId: message.batchId,
      unitIds: message.units.map((unit) => unit.id),
      error: "请先在配置页填写 API URL、API Key 和模型名。"
    });
    return;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort("timeout"), config.requestTimeoutMs);
  const parser = createSegmentParser((segment) => {
    chrome.tabs.sendMessage(tabId, {
      type: "ruyi/translation-segment",
      batchId: message.batchId,
      unitId: segment.id,
      text: segment.text
    }).catch(() => {});
  });

  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "ruyi/translation-started",
      batchId: message.batchId,
      unitIds: message.units.map((unit) => unit.id)
    });

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

    await chrome.tabs.sendMessage(tabId, {
      type: "ruyi/translation-complete",
      batchId: message.batchId,
      unitIds: message.units.map((unit) => unit.id)
    });
  } catch (error) {
    await chrome.tabs.sendMessage(tabId, {
      type: "ruyi/translation-error",
      batchId: message.batchId,
      unitIds: message.units.map((unit) => unit.id),
      error: toUserMessage(error)
    }).catch(() => {});
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
          "不要翻译代码、命令、URL、邮箱地址、路径、类名、函数名、变量名。",
          "输入中形如 __RUYI_PRESERVE_1__ 的占位符表示必须原样保留的内联代码或术语。",
          "你必须在译文对应位置逐字保留这些占位符，不要翻译、不要改写、不要丢失、不要新增空格。",
          "不要添加解释、前言或总结。",
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