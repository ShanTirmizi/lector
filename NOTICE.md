# Third-party software and models

Lector's own code is MIT licensed (see `LICENSE`). The built extension also
contains or downloads the following, each under its own licence.

| What | Used for | Licence |
| --- | --- | --- |
| [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) voice model and voices, in the [ONNX export with timestamps](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX-timestamped) | The voice. Downloaded on first use, then stored in the browser. | Apache-2.0 |
| [kokoro-js](https://www.npmjs.com/package/kokoro-js) | Turning text into phonemes and running the model. Voice files are copied from this package at build time. | Apache-2.0 |
| [transformers.js](https://github.com/huggingface/transformers.js) | Model loading and inference in the browser. | Apache-2.0 |
| [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) | The WebGPU and WebAssembly inference engine. | MIT |
| [phonemizer](https://www.npmjs.com/package/phonemizer), which contains eSpeak NG | Text to phonemes. | Apache-2.0 (phonemizer), GPL-3.0-or-later (eSpeak NG) |
| [PDF.js](https://github.com/mozilla/pdf.js) | Drawing PDF pages and reading their text. | Apache-2.0 |

eSpeak NG is licensed under the GPL. It is included as an unmodified
WebAssembly build through the `phonemizer` package. If you redistribute a
built copy of this extension, you are redistributing that component too and
need to meet its licence terms.
