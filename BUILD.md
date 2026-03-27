# YourAIGuard 3.0.0 — Build Instructions for Mozilla Reviewers

## Prerequisites

- Node.js 18 or later (https://nodejs.org)
- Python 3.9 or later with scikit-learn, numpy, sentence-transformers
  (only needed to reproduce the model JSON files from the training dataset; see step 3)
- Internet access (only needed for the one-time vendor step)

## Steps to reproduce YourAIGuard.zip

### 1. Install Node dependencies

```
npm install
```

This installs `@xenova/transformers@2.17.2`, which provides `transformers.min.js`.

### 2. Copy and patch the pre-built library bundle

```
cp node_modules/@xenova/transformers/dist/transformers.min.js .
```

Then apply the two patches described in **Third-party patches** below.
The sha256 of the patched file shipped in the XPI is:

```
sha256sum transformers.min.js
# expected: 0434f8757959aa8fd3bdfa2c7b839292711928d4211c5b5b83f6c64c809b5268
```

The sha256 of the unmodified upstream file is:

```
# unpatched: bcf7cf304e51f470ed59409622b9d6ffbad80dfcf5baf6a40c919e4b9c4ff812
```

### 3. Reproduce the model JSON files (optional)

`criteria_model.json` and `instability_params.json` are pre-generated and
committed to the repo. To regenerate them from scratch:

```
pip install scikit-learn numpy sentence-transformers
python retrain_criteria.py      # regenerates criteria_model.json + instability_params.json
```

Both scripts train logistic regression classifiers on MiniLM-L6-v2 embeddings
using the paper's dataset (`reasoning_7d_balanced_augmented.csv`).

### 4. Download the MiniLM model (one-time)

```
node vendor.js
```

Downloads these files from Hugging Face into `models/Xenova/all-MiniLM-L6-v2/`:

- config.json
- tokenizer.json
- tokenizer_config.json
- special_tokens_map.json
- onnx/model_quantized.onnx

```
sha256sum models/Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx
# expected: afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1
```

### 5. Build the extension zip

```
node build.js
```

Produces `YourAIGuard.zip` (the submitted XPI).

---

## Human-written source files

All extension logic is unminified and human-written:

| File | Description |
|---|---|
| `background.js` | Background page: gate model, 7-criterion scoring, instability pipeline |
| `content_script.js` | UI injection: indicator, timeline SVG, response detection |
| `popup.html` | Toolbar popup |
| `criteria_model.json` | 7-criterion logistic regression weights (JSON, human-readable) |
| `instability_params.json` | Instability pipeline parameters: tau, PCA weights, K-means centroids |
| `retrain_criteria.py` | Trains criteria_model.json + instability_params.json from dataset |

---

## Third-party code

See `THIRD_PARTY_LICENSES.txt` for full provenance, license, and checksums.

---

## Third-party patches

Two minimal patches were applied to `transformers.min.js` to satisfy the
Mozilla AMO policy against `eval` and `Function` constructor usage.
Both patched code paths are Node.js-only dead code that never executes
in a Firefox browser extension.

### Patch 1 — protobufjs `inquire` module (1 occurrence)

The `inquire` helper in protobufjs uses an obfuscated `require()` call:

```
eval("quire".replace(/^/,"re"))
```

This is inside a `try/catch` that returns `null` on failure. In browsers
`require` does not exist, so it always throws and returns `null`.

**Replaced with:**

```
(function(){throw new Error("require not available in browser")})()
```

Net behavior is identical: throws, caught, returns `null`.

### Patch 2 — ONNX Runtime Web Node.js Worker `importScripts` (2 occurrences)

Inside a block guarded by `if (typeof process !== "undefined" && process.versions.node)`,
the Node.js Worker polyfill uses:

```
(0,eval)(o.readFileSync(e,"utf8"))
```

This block is never entered in Firefox (no `process.versions.node`).

**Replaced with:**

```
(function(){throw new Error("importScripts dynamic execution not available in browser")})()
```

### Patch 3 — webpack globalThis shim (2 occurrences)

Multiple webpack chunks use this pattern to locate the global object:

```
new Function("return this")()
```

This is only reached if `typeof globalThis === "object"` returns false.
Firefox 142+ always provides `globalThis`, so this is unreachable dead code.

**Replaced with:**

```
(function(){return typeof self!="undefined"?self:{}})()
```
