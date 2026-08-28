// Protocol adapters live here, one FOLDER per protocol (blend/, kinetic/),
// each implementing the Adapter interface from @stenion/core. A folder's
// index.ts is its whole public surface; index/fetch/score/types beside it are
// internal wiring.
export * from './blend/index.ts';
export * from './kinetic/index.ts';
