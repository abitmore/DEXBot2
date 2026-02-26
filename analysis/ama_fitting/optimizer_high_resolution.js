'use strict';

const fs   = require('fs');
const path = require('path');
const { calculateAMA } = require('./ama');

/**
 * AMA GEOMETRIC OPTIMIZER
 *
 * Finds AMA parameters (ER, Fast, Slow) using geometric metrics only.
 *
 * Primary winners:
 *   - MAX AREA/MAXDIST      = area.total / maxDist
 *   - MAX PROD/MAXDIST      = (above * below) / maxDist
 *
 * Capped winners:
 *   - MAX AREA/MAXDIST (capped)
 *   - MAX PROD/MAXDIST (capped)
 *
 * Cap is derived from each base winner's band factor:
 *   areaCapPct = BAND_CAP_RATIO * bandFactorPct(bestAreaMaxDist)
 *   prodCapPct = BAND_CAP_RATIO * bandFactorPct(bestProdMaxDist)
 *
 * Usage:
 *   node optimizer_high_resolution.js --data ../../market_adapter/data/lp_pool_133_4h.json
 *
 * Capped variants use 75% of each base winner's Band Factor:
 *   areaCapPct = 0.75 × bandFactorPct(bestAreaMaxDist)
 *   prodCapPct = 0.75 × bandFactorPct(bestProdMaxDist)
 */

const DATA_DIR = path.join(__dirname, 'data');

// ── Geometric analysis constants ──────────────────────────────────────────────
const REPOS_THRESHOLD      = 0.004;                          // 0.4% candle-to-candle AMA move
const BAND_CAP_RATIO       = 0.75;                           // 75% of base winner's band factor

// ── Parameter ranges ──────────────────────────────────────────────────────────
function range(min, max, step) {
    const out = [];
    for (let v = min; v <= max + 1e-9; v += step) out.push(parseFloat(v.toFixed(2)));
    return [...new Set(out)];
}

const ER_VALUES        = range(5,  200, 5);   // 40 values
const FAST_VALUES      = range(2,  10,  0.5); // 17 values
const SLOW_VALUES_AREA = range(5,  100, 2.5); // 39 values  (for MAX AREA — no repos gate)

// ── Data loaders ──────────────────────────────────────────────────────────────

function toCandles(arr) {
    return arr.map(c => ({ timestamp: c[0], open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] }));
}

function loadMexc() {
    const bts = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'BTS_USDT.json')));
    const xrp = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'XRP_USDT.json')));
    const btsC = toCandles(bts);
    const xrpM = new Map(toCandles(xrp).map(c => [c.timestamp, c]));
    return btsC
        .filter(b => xrpM.has(b.timestamp))
        .map(b => { const x = xrpM.get(b.timestamp); return { timestamp: b.timestamp, open: b.open / x.open, high: b.high / x.low, low: b.low / x.high, close: b.close / x.close }; })
        .sort((a, b) => a.timestamp - b.timestamp);
}

function loadLp(filePath) {
    const json = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return { candles: toCandles(json.candles ?? json), meta: json.meta ?? null };
}

// ── AMA Reposition Rate ───────────────────────────────────────────────────────

function calcReposRate(amaValues) {
    const skip = Math.max(20, Math.floor(amaValues.length * 0.1));
    let repos = 0;
    for (let i = skip + 1; i < amaValues.length; i++) {
        if (Math.abs(amaValues[i] - amaValues[i - 1]) / amaValues[i - 1] > REPOS_THRESHOLD) repos++;
    }
    return repos / (amaValues.length - 1 - skip);
}

// ── Informational: area above/below AMA ──────────────────────────────────────

function calcArea(amaValues, candles) {
    const skip = Math.max(20, Math.floor(candles.length * 0.1));
    let above = 0, below = 0, maxUp = 0, maxDown = 0;
    for (let i = skip; i < candles.length; i++) {
        const ama = amaValues[i];
        if (candles[i].high > ama) {
            const d = (candles[i].high - ama) / ama;
            above += d;
            if (d > maxUp) maxUp = d;
        }
        if (candles[i].low < ama) {
            const d = (ama - candles[i].low) / ama;
            below += d;
            if (d > maxDown) maxDown = d;
        }
    }
    const total   = above + below;
    const maxDist = Math.max(maxUp, maxDown);
    return { above, below, total, maxUp, maxDown, maxDist };
}

// ── Main ───────────────────────────────────────────────────────────────────────

function run() {
    const dataArgIdx = process.argv.indexOf('--data');
    const dataFile   = dataArgIdx !== -1 ? process.argv[dataArgIdx + 1] : null;

    const totalCombos = ER_VALUES.length * FAST_VALUES.length * SLOW_VALUES_AREA.length;

    console.log('================================================================================');
    console.log(' AMA GEOMETRIC OPTIMIZER');
    console.log('================================================================================');
    console.log(`  4 AMAs — pure geometric, no grid or bot settings`);
    console.log(`  MAX AREA/MAXDIST:  area.total / maxDist              (linear band penalty)`);
    console.log(`  MAX PROD/MAXDIST:  (above × below) / maxDist         (product per band)`);
    console.log(`  MAX AREA/MAXDIST (BAND≤75% of base AREA): constrained area winner`);
    console.log(`  MAX PROD/MAXDIST (BAND≤75% of base PROD): constrained product winner`);
    console.log(`  Ranges:     ER ${ER_VALUES[0]}–${ER_VALUES[ER_VALUES.length-1]}  Fast ${FAST_VALUES[0]}–${FAST_VALUES[FAST_VALUES.length-1]}  Slow ${SLOW_VALUES_AREA[0]}–${SLOW_VALUES_AREA[SLOW_VALUES_AREA.length-1]}`);
    console.log(`  Combos:     ${totalCombos}\n`);

    // Load data
    let candles, dataLabel;
    if (dataFile) {
        const loaded = loadLp(path.resolve(dataFile));
        candles   = loaded.candles;
        const m   = loaded.meta;
        dataLabel = m ? `LP Pool ${m.pool} (${m.assetA?.symbol}/${m.assetB?.symbol})` : path.basename(dataFile);
    } else {
        candles   = loadMexc();
        dataLabel = 'MEXC Synthetic XRP/BTS';
    }
    const closes = candles.map(c => c.close);
    console.log(`  Data:       ${dataLabel}  (${candles.length} candles)\n`);

    // ── Run: pure geometric search — no grid settings ─────────────────────────
    let bestAreaMaxDist = null, bestProdMaxDist = null, bestAreaMaxDistCapped = null, bestProdMaxDistCapped = null;
    const allEntries = [];

    for (const er of ER_VALUES) {
        for (const fast of FAST_VALUES) {
            for (const slow of SLOW_VALUES_AREA) {
                if (fast >= slow) continue;

                const ama           = calculateAMA(closes, { erPeriod: er, fastPeriod: fast, slowPeriod: slow });
                const area          = calcArea(ama, candles);
                const reposRate     = calcReposRate(ama);
                const repos         = reposRate * 100;
                // Metric 1: area / maxDist — linear band penalty
                const areaMaxDist   = area.total / area.maxDist;
                // Metric 2: (above × below) / maxDist — product per band
                const prodMaxDist   = (area.above * area.below) / area.maxDist;
                const bandFactorPct = area.maxDist * 200;
                const entry         = { er, fast, slow, area, repos, reposRate, bandFactorPct, areaMaxDist, prodMaxDist };
                allEntries.push(entry);

                if (!bestAreaMaxDist || areaMaxDist > bestAreaMaxDist.areaMaxDist)   bestAreaMaxDist = entry;
                if (!bestProdMaxDist || prodMaxDist > bestProdMaxDist.prodMaxDist)   bestProdMaxDist = entry;
            }
        }
    }

    function bestUnderCap(capPct, key) {
        let best = null;
        for (const e of allEntries) {
            if (e.bandFactorPct <= capPct && (!best || e[key] > best[key])) best = e;
        }
        return best;
    }

    const areaCapPct = bestAreaMaxDist ? bestAreaMaxDist.bandFactorPct * BAND_CAP_RATIO : null;
    const prodCapPct = bestProdMaxDist ? bestProdMaxDist.bandFactorPct * BAND_CAP_RATIO : null;
    const areaCapLabel = areaCapPct === null ? 'n/a' : areaCapPct.toFixed(1);
    const prodCapLabel = prodCapPct === null ? 'n/a' : prodCapPct.toFixed(1);
    bestAreaMaxDistCapped = areaCapPct ? bestUnderCap(areaCapPct, 'areaMaxDist') : null;
    bestProdMaxDistCapped = prodCapPct ? bestUnderCap(prodCapPct, 'prodMaxDist') : null;

    function detail(label, r, optimisedFor) {
        if (!r) {
            console.log(`  ${label}`);
            console.log('  └─ No valid candidate under constraint\n');
            return;
        }
        const asymmetry = Math.abs(r.area.above - r.area.below);
        const bias      = r.area.above > r.area.below ? 'AMA below price' : 'AMA above price';
        console.log(`  ${label}`);
        console.log(`  ├─ Optimised for:  ${optimisedFor}`);
        console.log(`  ├─ Params:         ER=${r.er}  Fast=${r.fast}  Slow=${r.slow}`);
        console.log(`  ├─ Area total:     ${r.area.total.toFixed(2)}  (above ${r.area.above.toFixed(2)}  below ${r.area.below.toFixed(2)})`);
        console.log(`  ├─ Asymmetry:      ${asymmetry.toFixed(2)}  (${bias})`);
        console.log(`  └─ Repos rate:     ${r.repos.toFixed(1)}%  (${Math.round(r.repos / 100 * candles.length)} events)\n`);
    }

    console.log('================================================================================');
    console.log(` 4 AMAs  —  pure geometric  (${ER_VALUES.length}×${FAST_VALUES.length}×${SLOW_VALUES_AREA.length} combinations)`);
    console.log('================================================================================\n');

    detail('MAX AREA/MAXDIST   — linear band penalty',
        bestAreaMaxDist, `area(${bestAreaMaxDist.area.total.toFixed(2)}) / maxDist(${(bestAreaMaxDist.area.maxDist * 100).toFixed(1)}%) = ${bestAreaMaxDist.areaMaxDist.toFixed(2)}`);
    detail('MAX PROD/MAXDIST   — product per band',
        bestProdMaxDist, `(above(${bestProdMaxDist.area.above.toFixed(2)}) × below(${bestProdMaxDist.area.below.toFixed(2)})) / maxDist(${(bestProdMaxDist.area.maxDist * 100).toFixed(1)}%) = ${bestProdMaxDist.prodMaxDist.toFixed(2)}`);
    detail(`MAX AREA/MAXDIST   — constrained (Band Factor <= ${areaCapLabel}%)`,
        bestAreaMaxDistCapped,
        bestAreaMaxDistCapped
            ? `area(${bestAreaMaxDistCapped.area.total.toFixed(2)}) / maxDist(${(bestAreaMaxDistCapped.area.maxDist * 100).toFixed(1)}%) = ${bestAreaMaxDistCapped.areaMaxDist.toFixed(2)}`
            : 'n/a');
    detail(`MAX PROD/MAXDIST   — constrained (Band Factor <= ${prodCapLabel}%)`,
        bestProdMaxDistCapped,
        bestProdMaxDistCapped
            ? `(above(${bestProdMaxDistCapped.area.above.toFixed(2)}) × below(${bestProdMaxDistCapped.area.below.toFixed(2)})) / maxDist(${(bestProdMaxDistCapped.area.maxDist * 100).toFixed(1)}%) = ${bestProdMaxDistCapped.prodMaxDist.toFixed(2)}`
            : 'n/a');

    // ── Side-by-side summary ───────────────────────────────────────────────────
    console.log('================================================================================');
    console.log(' SUMMARY');
    console.log('================================================================================\n');
    console.log('                |  ER  | Fast | Slow | Area    | Above  | Below  | MaxDist | Repos%');
    console.log('────────────────┼──────┼──────┼──────┼─────────┼────────┼────────┼─────────┼───────');
    for (const [name, r] of [['MAX AREA/MAXDIST', bestAreaMaxDist], ['MAX PROD/MAXDIST', bestProdMaxDist], [`MAX AREA/MAXDIST (<=${areaCapLabel}%)`, bestAreaMaxDistCapped], [`MAX PROD/MAXDIST (<=${prodCapLabel}%)`, bestProdMaxDistCapped]]) {
        if (!r) continue;
        console.log(
            `${name.padEnd(15)} | ` +
            `${r.er.toString().padStart(4)} | ` +
            `${r.fast.toFixed(1).padStart(4)} | ` +
            `${r.slow.toFixed(1).padStart(4)} | ` +
            `${r.area.total.toFixed(2).padStart(7)} | ` +
            `${r.area.above.toFixed(2).padStart(6)} | ` +
            `${r.area.below.toFixed(2).padStart(6)} | ` +
            `${(r.area.maxDist * 100).toFixed(1).padStart(7)}% | ` +
            `${r.repos.toFixed(1).padStart(6)}`
        );
    }
    console.log();

    // ── Save ──────────────────────────────────────────────────────────────────
    const outName = dataFile
        ? `optimization_results_${path.basename(dataFile, '.json')}.json`
        : 'optimization_results_high_resolution.json';
    const outPath = path.join(__dirname, outName);
    fs.writeFileSync(outPath, JSON.stringify({
        meta: { dataLabel, candles: candles.length, totalCombos, bandCapRatio: BAND_CAP_RATIO, areaCapPct, prodCapPct, bestAreaMaxDist, bestProdMaxDist, bestAreaMaxDistCapped, bestProdMaxDistCapped },
    }, null, 2));
    console.log(`================================================================================`);
    console.log(`  Saved: ${outName}\n`);
}

run();
