/* MarsTalk — background service worker.
   Opens the full-tab experience when the toolbar icon is clicked. */
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('index.html') });
});
