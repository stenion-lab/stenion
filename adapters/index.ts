// Protocol adapters live here, one FOLDER per protocol (blend/, kinetic/,
// aquarius/), each implementing the Adapter interface from @stenion/core. A
// folder's index.ts is its whole public surface; index/fetch/score/types beside
// it are internal wiring.
//
// `aquarius/` is the first `dex` adapter and it FETCHES ONLY — its scoring
// methods throw, because the dex rulebook publishes no weight table yet. It is
// exported so the fixture-capture script can reach it; nothing registers it as
// an indexer target. See adapters/aquarius/index.ts and issue #101.
export * from './blend/index.ts';
export * from './kinetic/index.ts';
export * from './aquarius/index.ts';
