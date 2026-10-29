// 弹窗读取持久配置和当前会话任务；关闭弹窗不停止页面中的监控。
const extensionApi = globalThis.browser || chrome;

async function injectContentScript(tabId) {
  if (extensionApi.scripting?.executeScript) {
    await extensionApi.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
  } else {
    await extensionApi.tabs.executeScript(tabId, { file: "content.js" });
  }
}

async function getTabMediaInfo(tabId) {
  try {
    const response = await extensionApi.tabs.sendMessage(tabId, {
      action: "getStatus",
    });
    return { hasMedia: !!response?.hasMedia };
  } catch {
    try {
      await injectContentScript(tabId);
      const response = await extensionApi.tabs.sendMessage(tabId, {
        action: "getStatus",
      });
      return { hasMedia: !!response?.hasMedia };
    } catch {
      return { hasMedia: false };
    }
  }
}

async function requestTrackingState(message = { action: "getTrackingState" }) {
  const response = await extensionApi.runtime.sendMessage(message);
  if (!response?.success || !Array.isArray(response.trackedTabIds)) {
    throw new Error(response?.error || "无法获取监控状态");
  }
  return new Set(response.trackedTabIds);
}

document.addEventListener("DOMContentLoaded", async () => {
  const tabsContainer = document.getElementById("tabs");
  const errorBox = document.getElementById("error");
  const maskInput = document.getElementById("mask-selector");
  const maskCheckbox = document.getElementById("mask-enabled");
  tabsContainer.innerHTML = "<p>加载中...</p>";

  try {
    const [tabs, settings, trackedTabIds] = await Promise.all([
      extensionApi.tabs.query({}),
      extensionApi.storage.local.get([
        "maskElementSelector",
        "maskElementEnabled",
      ]),
      requestTrackingState(),
    ]);
    const maskElementSelector =
      typeof settings.maskElementSelector === "string"
        ? settings.maskElementSelector.trim()
        : "";
    const maskElementEnabled = !!settings.maskElementEnabled;

    if (maskInput) maskInput.value = maskElementSelector;
    if (maskCheckbox) maskCheckbox.checked = maskElementEnabled;

    const persistMaskSettings = async (selectorValue, enabled) => {
      const normalizedSelector = (selectorValue || "").trim();
      try {
        await extensionApi.storage.local.set({
          maskElementSelector: normalizedSelector,
          maskElementEnabled: enabled,
        });
      } catch {
        errorBox.textContent = "遮罩设置保存失败，请重试。";
        errorBox.style.display = "block";
      }
    };

    if (maskInput) {
      maskInput.addEventListener("input", (event) => {
        void persistMaskSettings(
          event.target.value,
          maskCheckbox ? maskCheckbox.checked : maskElementEnabled
        );
      });
    }
    if (maskCheckbox) {
      maskCheckbox.addEventListener("change", (event) => {
        void persistMaskSettings(
          maskInput ? maskInput.value : maskElementSelector,
          event.target.checked
        );
      });
    }

    if (!tabs || tabs.length === 0) {
      tabsContainer.innerHTML = "<p>未发现标签页。</p>";
      return;
    }
    tabs.sort((a, b) => a.index - b.index);
    tabsContainer.innerHTML = "";

    for (let idx = 0; idx < tabs.length; idx++) {
      const tab = tabs[idx];
      const { hasMedia } = await getTabMediaInfo(tab.id);
      const div = document.createElement("div");
      div.className = "tab";

      const left = document.createElement("div");
      left.className = "tab-left";
      const num = document.createElement("span");
      num.className = "tab-number";
      num.textContent = idx + 1;
      const info = document.createElement("div");
      info.className = "tab-info";
      info.textContent = tab.title || tab.url;
      left.append(num, info);

      const right = document.createElement("div");
      right.className = "tab-right";
      // 媒体暂时消失时，仍允许关闭已经启动的任务。
      if (hasMedia || trackedTabIds.has(tab.id)) {
        const label = document.createElement("label");
        label.className = "switch";
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = trackedTabIds.has(tab.id);
        const slider = document.createElement("span");
        slider.className = "slider";
        label.append(checkbox, slider);
        checkbox.addEventListener("change", async () => {
          const wasTracked = trackedTabIds.has(tab.id);
          const enable = checkbox.checked;
          checkbox.disabled = true;
          try {
            const updated = await requestTrackingState({
              action: "toggleTrack",
              tabId: tab.id,
              enable,
            });
            checkbox.checked = updated.has(tab.id);
            if (checkbox.checked) trackedTabIds.add(tab.id);
            else trackedTabIds.delete(tab.id);
          } catch {
            checkbox.checked = wasTracked;
            errorBox.textContent = "操作失败，请重试。";
            errorBox.style.display = "block";
          } finally {
            checkbox.disabled = false;
          }
        });
        right.append(label);
      }

      div.append(left, right);
      tabsContainer.append(div);
    }
  } catch {
    errorBox.textContent = "加载失败，请刷新。";
    errorBox.style.display = "block";
    tabsContainer.innerHTML = "";
  }
});
