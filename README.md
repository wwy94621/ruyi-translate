# ruyi-translate

用于翻译网页核心内容的浏览器插件。

## 当前实现范围

- Chrome / Chromium Manifest V3 扩展
- 点击扩展图标后，在当前页面注入可拖动悬浮按钮
- 使用启发式规则识别正文内容，跳过菜单、页眉页脚、链接密集区和代码块
- 只按视口附近内容懒翻译，不一次性翻整页
- 原文保留，译文以“原文一段 + 译文一段”的形式插入
- 支持 OpenAI 兼容接口
- 支持流式响应，逐段回填译文

## 配置项

在扩展配置页中填写以下信息：

- API URL：OpenAI 兼容接口地址，默认指向 `/v1/chat/completions`
- API Key
- Model
- 目标语言
- 请求超时
- 单批最大字符数

其中：

- 普通配置保存在 `chrome.storage.sync`
- API Key 保存在 `chrome.storage.local`

## 开发方式

当前版本不依赖构建工具，直接以原生 JavaScript 组织。

1. 打开 Chrome 扩展管理页
2. 打开“开发者模式”
3. 选择“加载已解压的扩展程序”
4. 选择当前仓库目录

## 使用方式

1. 先打开扩展的配置页并填写模型配置
2. 在任意网页点击扩展图标
3. 页面右下角会出现悬浮按钮
4. 点击“开始翻译”后，仅翻译当前视口附近的核心正文
5. 再次点击可隐藏译文并恢复原始阅读状态，已翻译内容会保留在当前页面缓存中

## 目录结构

- `manifest.json`：扩展清单
- `src/background/service-worker.js`：后台服务、注入逻辑、流式翻译请求
- `src/content/content-script.js`：页面识别、悬浮按钮、懒翻译、译文渲染
- `src/content/content.css`：页面内 UI 与译文样式
- `src/options/options.html`：配置页
- `src/options/options.js`：配置读写逻辑
- `src/options/options.css`：配置页样式
