/**
 * YourAIGuard - Vendor Script
 * Downloads the MiniLM-L6-v2 ONNX model files from Hugging Face
 * into models/Xenova/all-MiniLM-L6-v2/ for local bundling.
 *
 * Run once during development: node vendor.js
 * Files are then committed and shipped inside the extension zip.
 */

const https = require("https");
const fs    = require("fs");
const path  = require("path");

const MODEL_DIR = path.join(__dirname, "models", "Xenova", "all-MiniLM-L6-v2");
const ONNX_DIR  = path.join(MODEL_DIR, "onnx");

const BASE = "https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main";

// Exact files transformers.js v2.x needs for feature-extraction + quantized ONNX
const FILES = [
  "config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "special_tokens_map.json",
  "onnx/model_quantized.onnx",
];

fs.mkdirSync(ONNX_DIR, { recursive: true });

function download(url, dest) {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(dest)) {
      console.log(`  skip (exists)  ${path.relative(__dirname, dest)}`);
      return resolve();
    }
    console.log(`  downloading    ${path.relative(__dirname, dest)} ...`);
    const tmp = dest + ".tmp";
    const file = fs.createWriteStream(tmp);
    function get(url) {
      https.get(url, res => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          const location = res.headers.location;
          const next = location.startsWith("http") ? location : new URL(location, url).href;
          return get(next);
        }
        if (res.statusCode !== 200) {
          fs.unlinkSync(tmp);
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        res.pipe(file);
        file.on("finish", () => {
          file.close(() => {
            fs.renameSync(tmp, dest);
            console.log(`  done           ${path.relative(__dirname, dest)}`);
            resolve();
          });
        });
      }).on("error", err => { fs.unlinkSync(tmp); reject(err); });
    }
    get(url);
  });
}

(async () => {
  console.log("Downloading Xenova/all-MiniLM-L6-v2 model files...\n");
  for (const file of FILES) {
    const url  = `${BASE}/${file}`;
    const dest = path.join(MODEL_DIR, ...file.split("/"));
    await download(url, dest);
  }
  console.log("\nDone. Run `node build.js` to package the extension.");
})();
