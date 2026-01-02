/**
 * Jest configuration for DEXBot2 unit tests
 *
 * Run tests with:
 *   npm run test:unit          - Run all unit tests
 *   npm run test:unit:watch    - Run in watch mode
 *   npm run test:unit -- --coverage - Generate coverage report
 */

module.exports = {
    testEnvironment: 'node',
    collectCoverageFrom: [
        'modules/order/**/*.js',
        '!modules/order/index.js',
        '!modules/order/runner.js',
        '!**/node_modules/**'
    ],
    testMatch: [
        '**/tests/unit/**/*.test.js'
    ],
    verbose: true,
    testTimeout: 10000,
    coveragePathIgnorePatterns: [
        '/node_modules/',
        '/tests/'
    ],
    coverageThreshold: {
        global: {
            branches: 50,
            functions: 60,
            lines: 60,
            statements: 60
        }
    }
};
