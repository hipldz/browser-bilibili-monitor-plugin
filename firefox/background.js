// 后台只协调当前浏览器会话的任务；用户配置保存在 storage.local。
const extensionApi = globalThis.browser || chrome;
const runtimeStorage = extensionApi.storage.session;
const trackedTabs = new Set();
let maskElementSelector = "";
let maskElementEnabled = false;

function updateMaskSettings(settings) {
  maskElementSelector =
    typeof settings.maskElementSelector === "string"
      ? settings.maskElementSelector.trim()
      : "";
  maskElementEnabled = !!settings.maskElementEnabled;
}

async function saveRuntimeState() {
  if (runtimeStorage) {
    await runtimeStorage.set({ trackedTabs: [...trackedTabs] });
  }
}

async function initializeRuntime() {
  const [settings, state] = await Promise.all([
    extensionApi.storage.local.get([
      "maskElementSelector",
      "maskElementEnabled",
    ]),
    runtimeStorage ? runtimeStorage.get("trackedTabs") : Promise.resolve({}),
    // 迁移旧版：仅删除永久保存的任务状态，保留用户规则和偏好。
    extensionApi.storage.local.remove("checkedTabs"),
  ]);
  updateMaskSettings(settings);

  // Chrome 的会话存储能跨后台休眠保留状态，浏览器退出后自动清空。
  // 旧版 Firefox 没有会话存储，由持久后台页在内存中维护当前任务。
  if (Array.isArray(state.trackedTabs) && state.trackedTabs.length > 0) {
    const tabs = await extensionApi.tabs.query({});
    const openTabIds = new Set(tabs.map((tab) => tab.id));
    for (const tabId of state.trackedTabs) {
      if (Number.isInteger(tabId) && openTabIds.has(tabId)) {
        trackedTabs.add(tabId);
      }
    }
  }
  await saveRuntimeState();
}

const runtimeReady = initializeRuntime();
runtimeReady.catch((error) => console.error("运行状态初始化失败:", error));
let pendingOperation = Promise.resolve();

// 串行更新，避免同时操作多个标签页时覆盖会话状态。
function queueRuntimeOperation(operation) {
  const result = pendingOperation.then(() => runtimeReady).then(operation);
  pendingOperation = result.catch(() => {});
  return result;
}

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

async function sendMonitoringSettings(tabId, enable) {
  const response = await extensionApi.tabs.sendMessage(tabId, {
    action: "setMonitoring",
    enable,
    maskElementSelector,
    maskElementEnabled,
  });
  if (!response?.success) {
    throw new Error(response?.error || "标签页未确认监控状态");
  }
}

async function setTabMonitoring(tabId, enable) {
  if (enable) {
    await injectContentScript(tabId);
    await sendMonitoringSettings(tabId, true);
  } else {
    // 页面关闭或导航后，旧内容脚本及其任务已经销毁。
    await sendMonitoringSettings(tabId, false).catch(() => {});
  }
}

async function toggleTracking(tabId, enable) {
  const wasTracked = trackedTabs.has(tabId);
  await setTabMonitoring(tabId, enable);
  if (enable) trackedTabs.add(tabId);
  else trackedTabs.delete(tabId);

  try {
    await saveRuntimeState();
  } catch (error) {
    if (wasTracked) trackedTabs.add(tabId);
    else trackedTabs.delete(tabId);
    await setTabMonitoring(tabId, wasTracked).catch((rollbackError) => {
      console.error("监控状态回退失败:", rollbackError);
    });
    throw error;
  }
}

// 弹窗只读取、修改后台实际任务，不再自行持久化标签页勾选状态。
extensionApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (
    message?.action !== "getTrackingState" &&
    message?.action !== "toggleTrack" &&
    message?.action !== "restoreMonitoring"
  ) {
    return false;
  }

  queueRuntimeOperation(async () => {
    if (message.action === "toggleTrack") {
      if (
        !Number.isInteger(message.tabId) ||
        typeof message.enable !== "boolean"
      ) {
        throw new Error("无效的监控请求");
      }
      await toggleTracking(message.tabId, message.enable);
    } else if (message.action === "restoreMonitoring") {
      if (!Number.isInteger(sender.tab?.id)) {
        throw new Error("无法识别恢复监控的标签页");
      }
      await sendMonitoringSettings(
        sender.tab.id,
        trackedTabs.has(sender.tab.id)
      );
    }
    return { success: true, trackedTabIds: [...trackedTabs] };
  }).then(
    sendResponse,
    (error) => {
      console.error("监控操作失败:", error);
      sendResponse({ success: false, error: error.message });
    }
  );
  return true;
});

// 导航后只为本次会话中已开启的标签页重新安装任务。
extensionApi.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "complete") return;
  queueRuntimeOperation(async () => {
    if (!trackedTabs.has(tabId)) return;
    try {
      await setTabMonitoring(tabId, true);
    } catch (error) {
      trackedTabs.delete(tabId);
      await saveRuntimeState();
      console.error("标签页监控恢复失败:", error);
    }
  }).catch((error) => console.error("标签页更新处理失败:", error));
});

extensionApi.tabs.onRemoved.addListener((tabId) => {
  queueRuntimeOperation(async () => {
    if (trackedTabs.delete(tabId)) await saveRuntimeState();
  }).catch((error) => console.error("标签页任务清理失败:", error));
});

extensionApi.storage.onChanged.addListener((changes, areaName) => {
  if (
    areaName !== "local" ||
    (!Object.prototype.hasOwnProperty.call(changes, "maskElementSelector") &&
      !Object.prototype.hasOwnProperty.call(changes, "maskElementEnabled"))
  ) {
    return;
  }

  queueRuntimeOperation(async () => {
    updateMaskSettings({
      maskElementSelector: Object.prototype.hasOwnProperty.call(
        changes,
        "maskElementSelector"
      )
        ? changes.maskElementSelector.newValue
        : maskElementSelector,
      maskElementEnabled: Object.prototype.hasOwnProperty.call(
        changes,
        "maskElementEnabled"
      )
        ? changes.maskElementEnabled.newValue
        : maskElementEnabled,
    });
    for (const tabId of trackedTabs) {
      await sendMonitoringSettings(tabId, true).catch((error) => {
        console.error("标签页遮罩设置更新失败:", error);
      });
    }
  }).catch((error) => console.error("遮罩设置更新失败:", error));
});
