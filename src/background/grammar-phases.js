// Constants shared by run.js and grammar-run.js. Kept dependency-free so the
// two modules can import each other without a TDZ error: run.js spreads
// GRAMMAR_PHASES into WORKER_BOUND_PHASES at module top level, which blew up
// when grammar-run.js (importing run.js) was still initialising.

export const GRAMMAR_PHASES = [
  'fetching_source',
  'opening_grammarly',
  'pasting',
  'analysing',
  'accepting',
  'humanizing',
  'extracting',
  'applying',
];
