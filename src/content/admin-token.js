// Runs on the PIC admin panel. Reads the magic-link session token the admin
// SPA stores in sessionStorage (see docs/pic-api.md) and hands it to the
// service worker, which verifies and caches it. The extension never sees or
// handles credentials — only the already-issued 7-day token.
//
// Classic script (MV3 content scripts can't be ES modules): message type
// literals are inlined; keep in sync with src/shared/messages.js.

(() => {
  let lastSent = null;

  const captureToken = () => {
    const token = sessionStorage.getItem('adminToken');
    if (!token || token === lastSent) return;
    lastSent = token;
    chrome.runtime
      .sendMessage({
        type: 'pic:token-captured',
        token,
        email: sessionStorage.getItem('adminEmail'),
        origin: location.origin,
      })
      .catch(() => {
        // Service worker not ready — the next poll retries.
        lastSent = null;
      });
  };

  captureToken();
  // The SPA writes the token after verifying the magic link, which can happen
  // well after document_idle — poll cheaply until the tab closes.
  setInterval(captureToken, 10_000);
})();
