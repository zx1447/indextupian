// Obfuscation build script (optional)
// If javascript-obfuscator is not installed (e.g. on the deployment platform),
// this script does nothing - the index.js is already committed and obfuscated.
// To regenerate the obfuscated index.js locally, run: npm install --save-dev javascript-obfuscator
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'index.src.js');
const OUT = path.join(__dirname, 'index.js');

let JavaScriptObfuscator;
try {
    JavaScriptObfuscator = require('javascript-obfuscator');
} catch (e) {
    console.log('javascript-obfuscator not installed, skipping obfuscation.');
    console.log('The existing index.js will be used as-is.');
    console.log('To regenerate obfuscation locally, run:');
    console.log('  npm install --save-dev javascript-obfuscator');
    process.exit(0);
}

const code = fs.readFileSync(SRC, 'utf8');

const result = JavaScriptObfuscator.obfuscate(code, {
    compact: true,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.75,
    deadCodeInjection: true,
    deadCodeInjectionThreshold: 0.4,
    debugProtection: false,
    debugProtectionInterval: 0,
    disableConsoleOutput: true,
    identifierNamesGenerator: 'hexadecimal',
    log: false,
    numbersToExpressions: true,
    renameGlobals: false,
    selfDefending: true,
    simplify: true,
    splitStrings: true,
    splitStringsChunkLength: 5,
    stringArray: true,
    stringArrayCallsTransform: true,
    stringArrayCallsTransformThreshold: 0.75,
    stringArrayEncoding: ['base64'],
    stringArrayIndexShift: true,
    stringArrayRotate: true,
    stringArrayShuffle: true,
    stringArrayWrappersCount: 2,
    stringArrayWrappersChainedCalls: true,
    stringArrayWrappersParametersMaxCount: 2,
    stringArrayWrappersType: 'function',
    stringArrayThreshold: 0.75,
    transformObjectKeys: true,
    unicodeEscapeSequence: false
});

fs.writeFileSync(OUT, result.getObfuscatedCode(), 'utf8');
console.log(`Obfuscation done: ${OUT}`);
console.log(`   Source: ${code.length} bytes`);
console.log(`   Output: ${result.getObfuscatedCode().length} bytes`);
