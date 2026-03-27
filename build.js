/**
 * YourAIGuard - Build Script
 * Creates a clean submission-ready zip containing only extension files.
 * Run: node build.js
 */

const fs   = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT = __dirname;

// Static files included in the submission package (always forward slashes)
const INCLUDE = [
  "manifest.json",
  "background.html",
  "background.js",
  "content_script.js",
  "popup.html",
  "criteria_model.json",
  "instability_params.json",
  "transformers.min.js",
  "THIRD_PARTY_LICENSES.txt",
  "icons/icon48.png",
  "icons/icon96.png",
  "icons/icon128.png",
];

// Glob all bundled model files
const MODEL_BASE = path.join(ROOT, "models");
function globModels(dir, base) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel  = (base ? base + "/" : "") + entry.name;
    if (entry.isDirectory()) results.push(...globModels(full, rel));
    else results.push({ name: "models/" + rel, src: full });
  }
  return results;
}

// ─── Minimal ZIP writer ──────────────────────────────────────────────────────
// Writes a ZIP file with forward-slash entry names, no compression (store),
// which avoids any platform path-separator issues and is valid for AMO/Firefox.

function writeZip(outPath, entries) {
  const bufs = [];
  const centralDir = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBuf  = Buffer.from(name, "utf8");
    const crc      = crc32(data);
    const local    = Buffer.alloc(30 + nameBuf.length);

    // Local file header
    local.writeUInt32LE(0x04034b50, 0);   // signature
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(0, 6);             // flags
    local.writeUInt16LE(0, 8);             // compression: store
    local.writeUInt16LE(0, 10);            // mod time
    local.writeUInt16LE(0, 12);            // mod date
    local.writeUInt32LE(crc >>> 0, 14);   // CRC-32
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26); // file name length
    local.writeUInt16LE(0, 28);            // extra field length
    nameBuf.copy(local, 30);

    // Central directory entry
    const cd = Buffer.alloc(46 + nameBuf.length);
    cd.writeUInt32LE(0x02014b50, 0);      // signature
    cd.writeUInt16LE(20, 4);              // version made by
    cd.writeUInt16LE(20, 6);              // version needed
    cd.writeUInt16LE(0, 8);              // flags
    cd.writeUInt16LE(0, 10);             // compression: store
    cd.writeUInt16LE(0, 12);             // mod time
    cd.writeUInt16LE(0, 14);             // mod date
    cd.writeUInt32LE(crc >>> 0, 16);    // CRC-32
    cd.writeUInt32LE(data.length, 20);  // compressed size
    cd.writeUInt32LE(data.length, 24);  // uncompressed size
    cd.writeUInt16LE(nameBuf.length, 28); // file name length
    cd.writeUInt16LE(0, 30);             // extra field length
    cd.writeUInt16LE(0, 32);             // comment length
    cd.writeUInt16LE(0, 34);             // disk number start
    cd.writeUInt16LE(0, 36);             // internal attrs
    cd.writeUInt32LE(0, 38);            // external attrs
    cd.writeUInt32LE(offset, 42);       // local header offset
    nameBuf.copy(cd, 46);

    bufs.push(local, data);
    centralDir.push(cd);
    offset += local.length + data.length;
  }

  const cdBuf   = Buffer.concat(centralDir);
  const eocd    = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);       // signature
  eocd.writeUInt16LE(0, 4);               // disk number
  eocd.writeUInt16LE(0, 6);               // disk with CD
  eocd.writeUInt16LE(entries.length, 8);  // entries on disk
  eocd.writeUInt16LE(entries.length, 10); // total entries
  eocd.writeUInt32LE(cdBuf.length, 12);  // CD size
  eocd.writeUInt32LE(offset, 16);        // CD offset
  eocd.writeUInt16LE(0, 20);             // comment length

  fs.writeFileSync(outPath, Buffer.concat([...bufs, cdBuf, eocd]));
}

// CRC-32 table
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF);
}

// ─── Main ────────────────────────────────────────────────────────────────────

// Extension zip
const entries = [];
for (const rel of INCLUDE) {
  const src = path.join(ROOT, ...rel.split("/"));
  if (!fs.existsSync(src)) {
    console.error(`MISSING: ${rel}`);
    process.exit(1);
  }
  entries.push({ name: rel, data: fs.readFileSync(src) });
  console.log(`  added   ${rel}`);
}
for (const { name, src } of globModels(MODEL_BASE, "")) {
  entries.push({ name, data: fs.readFileSync(src) });
  console.log(`  added   ${name}`);
}

const zipPath = path.join(ROOT, "YourAIGuard.zip");
writeZip(zipPath, entries);
const kb = (fs.statSync(zipPath).size / 1024).toFixed(1);
console.log(`\nExtension: YourAIGuard.zip (${kb} KB)`);

// Source zip — uploaded to AMO "source code" field so reviewers can verify
// transformers.min.js against the declared @xenova/transformers@2.17.2 package.
const SOURCE_INCLUDE = [
  "manifest.json",
  "background.html",
  "background.js",
  "content_script.js",
  "popup.html",
  "criteria_model.json",
  "instability_params.json",
  "package.json",
  "build.js",
  "vendor.js",
  "retrain_criteria.py",
  "BUILD.md",
  "PRIVACY.md",
  "THIRD_PARTY_LICENSES.txt",
];

const srcEntries = [];
for (const rel of SOURCE_INCLUDE) {
  const src = path.join(ROOT, ...rel.split("/"));
  if (!fs.existsSync(src)) { console.warn(`  skip (missing): ${rel}`); continue; }
  srcEntries.push({ name: rel, data: fs.readFileSync(src) });
}

const srcZipPath = path.join(ROOT, "YourAIGuard-sources.zip");
writeZip(srcZipPath, srcEntries);
const skb = (fs.statSync(srcZipPath).size / 1024).toFixed(1);
console.log(`Sources:   YourAIGuard-sources.zip (${skb} KB)  ← upload this to AMO "source code" field`);
