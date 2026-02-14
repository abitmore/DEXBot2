const FILL_PROCESSING = {
    MAX_FILL_BATCH_SIZE: 4,
    BATCH_STRESS_TIERS: [
        [15, 4],  // 15+ fills queued → batch of 4
        [6,  3],  // 6-14 fills queued → batch of 3
        [3,  2],  // 3-5 fills queued  → batch of 2
        [0,  1]   // 0-2 fills queued  → sequential (1-at-a-time)
    ]
};

function simulateBatching(totalFills) {
    const stressTiers = FILL_PROCESSING.BATCH_STRESS_TIERS || [[0, 1]];
    const maxBatch = Math.max(1, FILL_PROCESSING.MAX_FILL_BATCH_SIZE || 1);
    
    let adaptiveBatchSize = 1;
    for (const [minDepth, size] of stressTiers) {
        if (totalFills >= minDepth) {
            adaptiveBatchSize = Math.max(1, Math.min(size, maxBatch));
            break;
        }
    }

    const useUnifiedPlan = totalFills > 1 && totalFills <= maxBatch;
    
    const batches = [];
    let i = 0;
    while (i < totalFills) {
        const remaining = totalFills - i;
        let currentBatchSize;

        if (useUnifiedPlan) {
            currentBatchSize = remaining;
        } else {
            currentBatchSize = Math.min(adaptiveBatchSize, remaining);
            // Avoid ending with a singleton tail when possible.
            const tail = remaining - currentBatchSize;
            if (tail === 1 && currentBatchSize < maxBatch) {
                currentBatchSize = Math.min(maxBatch, currentBatchSize + 1);
            }
        }

        const batchEnd = Math.min(i + currentBatchSize, totalFills);
        batches.push(batchEnd - i);
        i = batchEnd;
    }
    return { adaptiveBatchSize, useUnifiedPlan, batches };
}

const testCases = [1, 2, 3, 4, 5, 6, 7, 8, 14, 15, 16, 17, 20];
console.log("Queue Depth | Adaptive Size | Unified? | Batch Sequence");
console.log("---------------------------------------------------------");
for (const depth of testCases) {
    const result = simulateBatching(depth);
    console.log(`${depth.toString().padEnd(12)}| ${result.adaptiveBatchSize.toString().padEnd(14)}| ${result.useUnifiedPlan.toString().padEnd(9)}| [${result.batches.join(", ")}]`);
}
