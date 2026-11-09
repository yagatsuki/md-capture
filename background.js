// Manual trigger: clicking the toolbar button asks the content script
// in the active tab to capture the page.
chrome.action.onClicked.addListener((tab) => {
  if (tab && tab.id) {
    chrome.tabs.sendMessage(tab.id, { type: "mdcapture" }, () => {
      // Ignore errors on pages where the content script cannot run.
      void chrome.runtime.lastError;
    });
  }
});
