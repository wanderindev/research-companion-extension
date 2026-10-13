// Waiting primitives for the claude.ai content scripts.

(() => {
  const PIC = (window.PIC ??= {});

  PIC.wait = {
    sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    },

    /** Polls `fn` until it returns a truthy value; throws on exhaustion. */
    async until(fn, { retries = 20, delay = 500, desc = 'condition' } = {}) {
      for (let attempt = 0; attempt < retries; attempt++) {
        const value = await fn();
        if (value) return value;
        await PIC.wait.sleep(delay);
      }
      throw new Error(`Timed out waiting for ${desc}`);
    },

    /** Resolves after `settleTime` ms without DOM mutations (hard cap `timeout`). */
    settle({ settleTime = 300, timeout = 10_000 } = {}) {
      return new Promise((resolve) => {
        let settleTimer;
        const observer = new MutationObserver(() => {
          clearTimeout(settleTimer);
          settleTimer = setTimeout(finish, settleTime);
        });
        const finish = () => {
          observer.disconnect();
          clearTimeout(hardTimer);
          resolve();
        };
        const hardTimer = setTimeout(finish, timeout);
        observer.observe(document.body, { childList: true, subtree: true, attributes: true });
        settleTimer = setTimeout(finish, settleTime);
      });
    },
  };
})();
