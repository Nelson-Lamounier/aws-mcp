/** @type {import('ts-jest').JestConfigWithTsJest} */
export default {
  // Run ts-jest in ESM mode to match package.json "type": "module"
  extensionsToTreatAsEsm: ['.ts'],
  silent: true,

  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        useESM: true,
        tsconfig: 'tsconfig.test.json',
        diagnostics: {
          // Suppress TS151002 — NodeNext hybrid-module warning in ts-jest
          ignoreCodes: [151002],
        },
      },
    ],
  },

  // Map .js → .ts so Jest resolves ESM imports with .js extensions
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },

  testEnvironment: 'node',
  testMatch: ['**/src/**/*.test.ts'],
  clearMocks: true,
  restoreMocks: true,

  // Make jest / describe / it / expect available globally (no explicit import needed)
  injectGlobals: true,

  // Show verbose pass/fail per test
  verbose: true,

  // Coverage settings
  collectCoverageFrom: ['src/**/*.ts', '!src/client.ts', '!src/server.ts'],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov'],
};
