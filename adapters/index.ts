// Protocol adapters live here, one FOLDER per protocol (blend/, kinetic/,
// aquarius/), each implementing the Adapter interface from @stenion/core. A
// folder's index.ts is its whole public surface; index/fetch/score/types beside
// it are internal wiring.
//
// `aquarius/` is the first `dex` adapter: it fetches, scores against
// methodology/dex.md's two factors, and publishes `operationalState` (#101,
// #103). One market is registered to it — `AQUARIUS_POOLS`, iterated by the
// indexer's buildTargets the same way BLEND_POOLS is (#104).
export * from './blend/index.ts';
export * from './kinetic/index.ts';
export * from './aquarius/index.ts';
