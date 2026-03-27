# YourAIGuard — Privacy Policy

**Last updated: March 2026**

## Summary

YourAIGuard makes **no external network requests**. All processing happens
entirely on your device using models bundled inside the extension.

## What this extension does

YourAIGuard analyses AI responses on ChatGPT to help you assess their
trustworthiness. The MiniLM-L6-v2 sentence-embedding model and the
ONNX runtime are both shipped inside the extension package — nothing is
downloaded after installation.

## Data collected

**None.** YourAIGuard does not collect, store, transmit, or share any
personal data, browsing history, or ChatGPT content.

## What stays on your device

- Text of ChatGPT responses (read locally, never transmitted)
- Rung scores and instability metrics computed from those responses
- Conversation history used for temporal analysis (held in memory only,
  cleared when you close the tab or browser)

## External network requests

**None.** The extension operates entirely offline after installation.

## Third-party code bundled locally

| Component | Version | License |
|---|---|---|
| @xenova/transformers | 2.17.2 | Apache 2.0 |
| all-MiniLM-L6-v2 (ONNX) | Xenova export | Apache 2.0 |
| ONNX Runtime Web | bundled in transformers | MIT |

See `THIRD_PARTY_LICENSES.txt` for full provenance and checksums.

## Contact

For questions, email siddhu.pendyala@outlook.com or open an issue at https://github.com/VPyndyala/YourAIGuard
