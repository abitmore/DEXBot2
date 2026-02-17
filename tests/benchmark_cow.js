/**
 * COW Performance Benchmarks
 */

const { WorkingGrid } = require('../modules/order/working_grid');
const { buildIndexes } = require('../modules/order/utils/order');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');

function createTestOrder(id, type, state, price, amount, orderId = null) {
    return {
        id,
        type,
        state,
        price,
        amount,
        orderId,
        gridIndex: parseInt(id.replace(/\D/g, '')) || 0
    };
}

function generateTestGrid(size) {
    const grid = new Map();
    for (let i = 0; i < size; i++) {
        grid.set(`order${i}`, {
            id: `order${i}`,
            type: i % 2 === 0 ? ORDER_TYPES.BUY : ORDER_TYPES.SELL,
            state: ORDER_STATES.ACTIVE,
            price: 100 + Math.random() * 100,
            amount: 10 + Math.random() * 100,
            orderId: `chain${i}`,
            gridIndex: i
        });
    }
    return grid;
}

function benchmark(name, fn, iterations = 100) {
    const start = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) {
        fn();
    }
    const end = process.hrtime.bigint();
    const avgMs = Number(end - start) / iterations / 1e6;
    console.log(`${name}: ${avgMs.toFixed(3)}ms avg (${iterations} iterations)`);
    return avgMs;
}

async function runBenchmarks() {
    console.log('=== COW Performance Benchmarks ===\n');
    
    const sizes = [100, 500, 1000, 5000];
    
    for (const size of sizes) {
        console.log(`\n--- Grid Size: ${size} orders ---`);
        const master = generateTestGrid(size);
        
        console.log('\nClone benchmark:');
        benchmark('Clone grid', () => {
            new WorkingGrid(master);
        });
        
        console.log('\nIndex building benchmark:');
        benchmark('Build indexes', () => {
            buildIndexes(master);
        });
        
        console.log('\nDelta building benchmark:');
        const working = new WorkingGrid(master);
        working.set('order0', { ...working.get('order0'), price: 999 });
        working.delete('order1');
        working.set('newOrder', { id: 'newOrder', type: ORDER_TYPES.BUY, state: ORDER_STATES.VIRTUAL, price: 150, amount: 50, orderId: null, gridIndex: size + 1 });
        
        benchmark('Build delta', () => {
            working.buildDelta(master);
        });
        
        console.log('\nMemory stats benchmark:');
        benchmark('Get memory stats', () => {
            working.getMemoryStats();
        });
        
        const memUsage = working.getMemoryStats();
        console.log(`  Estimated memory: ${Math.round(memUsage.estimatedBytes / 1024)}KB for ${size} orders`);
    }
    
    console.log('\n=== Benchmark Complete ===');
}

runBenchmarks();
