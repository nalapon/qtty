// Mutation testing of the engine (reading, catalog, saving) against the Docker PostgreSQL (`bun run db:up`).
// Runs on demand: each mutant re-runs the integration tests.
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: "command",
  commandRunner: { command: "bun test test/db.test.ts" },
  mutate: ["src/db/Rows.ts", "src/db/Catalog.ts", "src/db/Edits.ts"],
  coverageAnalysis: "off",
  concurrency: 4,
  reporters: ["clear-text", "progress"],
  tempDirName: ".stryker-tmp",
  // Stryker rewrites tsconfig through the TypeScript JS API, which TypeScript 7 no
  // longer ships. Bun does not need the rewrite, so point it at a file that is not there.
  tsconfigFile: "tsconfig.stryker-skip.json",
}
