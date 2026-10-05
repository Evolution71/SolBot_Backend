/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  testMatch: ["**/__tests__/**/*.test.ts"],
  setupFiles: ["<rootDir>/src/__tests__/setupEnv.ts"],
  collectCoverageFrom: ["src/**/*.ts", "!src/index.ts", "!src/**/__tests__/**"],
  clearMocks: true,
};
