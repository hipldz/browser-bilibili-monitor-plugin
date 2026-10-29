// 内容脚本仅在手动开启监控后创建定时任务，随页面生命周期结束。
(function () {
  const extensionRuntime =
    (globalThis.browser || globalThis.chrome)?.runtime;
  if (!extensionRuntime || globalThis.__mediaPlaybackMonitorInitialized) return;
  globalThis.__mediaPlaybackMonitorInitialized = true;

  const CHECK_INTERVAL = 1000;
  let intervalId = null;
  let maskElementSelector = "";
  let maskElementEnabled = false;

  function getMediaInfo() {
    const elements = document.querySelectorAll("audio, video");
    return {
      hasMedia: elements.length > 0,
      playing: [...elements].some((media) => !media.paused && !media.muted),
    };
  }

  function stopMonitoring() {
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  }

  function checkMediaPlaybackAndResume() {
    // 扩展被禁用、重载或更新后，停止旧页面上下文中的任务。
    try {
      if (!extensionRuntime.id) {
        stopMonitoring();
        return;
      }
    } catch {
      stopMonitoring();
      return;
    }

    try {
      const selector = maskElementEnabled ? maskElementSelector : "";
      document.querySelectorAll("audio, video").forEach((media) => {
        if (!media.paused) return;
        if (selector) {
          try {
            const mask = document.querySelector(selector);
            if (mask) mask.style.display = "none";
          } catch (error) {
            console.error("遮罩元素查询失败:", error);
          }
        }
        try {
          const result = media.play();
          if (result && typeof result.catch === "function") {
            result.catch((error) => console.error("播放恢复失败:", error));
          }
        } catch (error) {
          console.error("播放恢复失败:", error);
        }
      });
    } catch (error) {
      console.error("监控媒体播放失败:", error);
    }
  }

  extensionRuntime.onMessage.addListener((message, sender, sendResponse) => {
    try {
      if (message?.action === "getStatus") {
        sendResponse(getMediaInfo());
      } else if (message?.action === "setMonitoring") {
        maskElementSelector =
          typeof message.maskElementSelector === "string"
            ? message.maskElementSelector.trim()
            : "";
        maskElementEnabled = !!message.maskElementEnabled;
        if (message.enable) {
          if (intervalId === null) {
            // 在页面中执行，关闭弹窗或后台休眠不影响已启动的监控。
            intervalId = setInterval(checkMediaPlaybackAndResume, CHECK_INTERVAL);
          }
          checkMediaPlaybackAndResume();
        } else {
          stopMonitoring();
        }
        sendResponse({ success: true });
      }
    } catch (error) {
      console.error("媒体监控消息处理失败:", error);
      sendResponse({ success: false, hasMedia: false, error: error.message });
    }
    return false;
  });

  window.addEventListener("pagehide", stopMonitoring);
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted) return;
    // 返回缓存页面时重新确认当前任务，避免恢复已经被用户关闭的监控。
    try {
      extensionRuntime.sendMessage({ action: "restoreMonitoring" }).catch(
        (error) => console.error("缓存页面监控恢复失败:", error)
      );
    } catch (error) {
      console.error("缓存页面监控恢复失败:", error);
    }
  });
})();
