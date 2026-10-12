# Silero VAD model

`silero_vad.onnx` is the voice activity detection model from
[snakers4/silero-vad](https://github.com/snakers4/silero-vad) (version 5 of the model, the file in
`src/silero_vad/data/` of that repository as of release v6.2.3), used unchanged under its MIT
license (`LICENSE` in this folder).

It takes 16 kHz mono audio in frames of 512 samples, each with the previous frame's last 64 samples
in front, and returns a score from 0 to 1 for "a human voice is speaking". `core/silero.ts` drives it;
`audio/speech-model.ts` loads it in the browser through ONNX Runtime's WebAssembly build.

SHA-256: `1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3`
