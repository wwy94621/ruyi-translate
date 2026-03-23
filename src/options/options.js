const DEFAULTS = {
  endpointUrl: "https://api.openai.com/v1/chat/completions",
  model: "gpt-4.1-mini",
  targetLanguage: "简体中文",
  requestTimeoutMs: 45000,
  maxBatchChars: 2200,
  debug: false
};

const form = document.getElementById("settings-form");
const statusNode = document.getElementById("save-status");

await restoreForm();

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const formData = new FormData(form);
  const syncPayload = {
    endpointUrl: String(formData.get("endpointUrl") || DEFAULTS.endpointUrl).trim(),
    model: String(formData.get("model") || DEFAULTS.model).trim(),
    targetLanguage: String(formData.get("targetLanguage") || DEFAULTS.targetLanguage).trim(),
    requestTimeoutMs: Number(formData.get("requestTimeoutMs") || DEFAULTS.requestTimeoutMs),
    maxBatchChars: Number(formData.get("maxBatchChars") || DEFAULTS.maxBatchChars),
    debug: Boolean(formData.get("debug"))
  };

  const localPayload = {
    apiKey: String(formData.get("apiKey") || "").trim()
  };

  try {
    statusNode.textContent = "正在保存...";
    await chrome.storage.sync.set(syncPayload);
    await chrome.storage.local.set(localPayload);
    statusNode.textContent = "设置已保存。新的请求会自动使用最新配置。";
  } catch (error) {
    statusNode.textContent = `保存失败：${error.message}`;
  }
});

async function restoreForm() {
  try {
    const syncData = await chrome.storage.sync.get(Object.keys(DEFAULTS));
    const localData = await chrome.storage.local.get(["apiKey"]);
    const config = {
      ...DEFAULTS,
      ...syncData,
      apiKey: localData.apiKey || ""
    };

    form.endpointUrl.value = config.endpointUrl;
    form.apiKey.value = config.apiKey;
    form.model.value = config.model;
    form.targetLanguage.value = config.targetLanguage;
    form.requestTimeoutMs.value = String(config.requestTimeoutMs);
    form.maxBatchChars.value = String(config.maxBatchChars);
    form.debug.checked = Boolean(config.debug);
    statusNode.textContent = config.apiKey ? "已加载现有配置。" : "请先填写接口配置。";
  } catch (error) {
    statusNode.textContent = `读取配置失败：${error.message}`;
  }
}