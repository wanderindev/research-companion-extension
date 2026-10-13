// Message type constants shared by the service worker and the popup.
// Content scripts are classic scripts (no ES module support in MV3
// content_scripts), so they inline these literals — keep them in sync:
//   src/content/admin-token.js   -> pic:token-captured
//   src/content/claude/main.js   -> pic:claude:ping / :compose / :check
//   src/content/grammarly/main.js -> pic:grammarly:ping / :prepare / :paste /
//                                    :wait-analysis / :accept / :extract, and it
//                                    emits pic:grammarly:progress to the worker
export const MSG = {
  tokenCaptured: 'pic:token-captured',
  getAuth: 'pic:get-auth',
  listSuggestions: 'pic:list-suggestions',
  startRun: 'pic:start-run',
  getRun: 'pic:get-run',
  getFactCheckPending: 'pic:get-fact-check-pending',
  getGrammarPending: 'pic:get-grammar-pending',
  grammarProgress: 'pic:grammarly:progress',
  cancelRun: 'pic:cancel-run',
  patchSettings: 'pic:patch-settings',
};
