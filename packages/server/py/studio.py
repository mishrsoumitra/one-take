#!/usr/bin/env python3
"""
The studio worker: the heavy audio models, run by the One Take server at export time (and from the
editor, one clip at a time). It is a long-lived process: the server starts it on first use, talks
to it over one JSON object per line on stdin, reads one JSON object per line on stdout, and stops
it after a while of nothing to do. Loading a model takes seconds and a few hundred megabytes, so
each one is loaded once, the first time it is asked for, and kept.

The models come from ClearerVoice-Studio (Alibaba, Apache 2.0), installed as the `clearvoice`
package in the studio's own Python environment (`npm run studio`):

- **denoise**: MossFormer2_SE_48K, speech enhancement at 48 kHz. Takes the whole recording, not a
  frame at a time like the live filter, so it can hear what the room sounds like over seconds and
  take it out from under the voice without touching the voice.
- **voice** (keep only your voice):
  - with the speaker's face: AV_MossFormer2_TSE_16K, audio-visual target speaker extraction. The
    mouth crops tell it which voice is yours; it pulls that one out, even where two people talk
    over each other.
  - without a face: MossFormer2_SS_16K separates the recording into two voices, and the one closer
    to the enrolled voice profile (WeSpeaker ResNet34 through onnxruntime, the same model and the
    same features as the browser's voice check) is kept. Without a profile, the louder one is.
  Both work at 16 kHz. The result is brought back to the recording's rate by adding what the
  16 kHz path cannot carry (the band above 8 kHz) from the recording itself, scaled frame by frame
  by how much of the low band the model kept, so a stretch the model silenced stays silent up top.
  The same run also measures how much the second voice overlaps the first, so a phrase where two
  people talk at once can be flagged.

Requests (one per line):
  {"op": "hello"}
  {"op": "denoise", "id": "...", "audio": "<pcm16 mono>", "rate": 48000, "out": "<pcm16>"}
  {"op": "voice", "id": "...", "audio": "<pcm16>", "rate": 48000, "out": "<pcm16>",
   "faces": "<frames file>" | null, "profile": [256 floats] | null, "measure": false}
  {"op": "quit"}
Answers: {"event": "hello", ...}, {"event": "progress", "id", "progress"}, {"event": "done", "id", ...},
{"event": "error", "id", "message"}. Audio files are raw 16-bit little-endian mono PCM. The faces file
is a run of JPEG mouth crops, each preceded by its length as a little-endian uint32, 25 a second,
112×112, as `vision/lips.ts` cuts them.
"""

from __future__ import annotations

import argparse
import io
import json
import math
import os
import struct
import sys
import time
import traceback

import numpy as np

MODEL_NAMES = {
    "denoise": "MossFormer2_SE_48K",
    "separate": "MossFormer2_SS_16K",
    "extract": "AV_MossFormer2_TSE_16K",
}
SPEAKER_MODEL = "wespeaker_en_voxceleb_resnet34_LM.onnx"
SE_RATE = 48000
LOW_RATE = 16000
FACE_FPS = 25
FACE_SIZE = 112
# the extraction model was trained on crops normalised like this (ClearerVoice's video pipeline)
VISUAL_MEAN = 0.4161
VISUAL_STD = 0.1688
# the band merge: frames of 20 ms, the gain smoothed over three of them
MERGE_FRAME_SEC = 0.02
MERGE_SMOOTH = 3
# the overlap measure: 50 ms frames; a frame is active within this much of the stream's loud frames
OVERLAP_FRAME_SEC = 0.05
OVERLAP_ACTIVE_UNDER_DB = 25
OVERLAP_FLOOR_DBFS = -50
# a pause this short inside a second voice's stretch still counts as the same stretch
OVERLAP_BRIDGE_SEC = 0.3
PROGRESS_EVERY_SEC = 0.25
MAX_WAV_VALUE = 32768.0


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def log(message: str) -> None:
    sys.stderr.write(message + "\n")
    sys.stderr.flush()


def read_pcm(path: str) -> np.ndarray:
    data = np.fromfile(path, dtype="<i2")
    return data.astype(np.float32) / MAX_WAV_VALUE


def write_pcm(path: str, samples: np.ndarray) -> int:
    clipped = np.clip(samples, -1.0, 1.0)
    pcm = np.where(clipped < 0, clipped * 32768, clipped * 32767).astype("<i2")
    pcm.tofile(path)
    return int(pcm.shape[0])


def resample(x: np.ndarray, src: int, dst: int) -> np.ndarray:
    if src == dst:
        return x
    from scipy.signal import resample_poly

    g = math.gcd(src, dst)
    return resample_poly(x, dst // g, src // g).astype(np.float32)


def frame_rms(x: np.ndarray, frame: int) -> np.ndarray:
    n = (len(x) // frame) * frame
    if n == 0:
        return np.zeros(1, dtype=np.float32)
    blocks = x[:n].reshape(-1, frame)
    return np.sqrt(np.mean(blocks * blocks, axis=1) + 1e-12)


class Progress:
    """Rate-limited progress lines for one request."""

    def __init__(self, request_id: str):
        self.id = request_id
        self.last = 0.0

    def __call__(self, fraction: float, force: bool = False) -> None:
        now = time.time()
        if not force and now - self.last < PROGRESS_EVERY_SEC:
            return
        self.last = now
        emit({"event": "progress", "id": self.id, "progress": max(0.0, min(1.0, float(fraction)))})


class Studio:
    def __init__(self, models_dir: str, speaker_path: str | None):
        self.models_dir = models_dir
        self.speaker_path = speaker_path
        self.loaded: dict[str, tuple[object, object]] = {}
        self.speaker_session = None
        self._device = None

    # ------------------------------------------------------------------ loading

    @property
    def device(self):
        if self._device is None:
            import torch

            if torch.backends.mps.is_available():
                self._device = torch.device("mps")
            elif torch.cuda.is_available():
                self._device = torch.device("cuda")
            else:
                self._device = torch.device("cpu")
        return self._device

    def has(self, kind: str) -> bool:
        return os.path.isfile(os.path.join(self.models_dir, MODEL_NAMES[kind], "last_best_checkpoint.pt"))

    def load(self, kind: str):
        """The model and its arguments for `kind`, loaded once."""
        if kind in self.loaded:
            return self.loaded[kind]
        name = MODEL_NAMES[kind]
        if not self.has(kind):
            raise RuntimeError(f"{name} is not installed; run `npm run studio` to fetch it")
        from clearvoice.network_wrapper import network_wrapper

        started = time.time()
        wrapper = network_wrapper()
        wrapper.model_name = name
        if kind == "denoise":
            wrapper.load_args_se()
            task = "speech_enhancement"
        elif kind == "separate":
            wrapper.load_args_ss()
            task = "speech_separation"
        else:
            wrapper.load_args_tse()
            task = "target_speaker_extraction"
        args = wrapper.args
        args.task = task
        args.network = name
        args.checkpoint_dir = os.path.join(self.models_dir, name)
        if kind == "denoise":
            from clearvoice.networks import CLS_MossFormer2_SE_48K as CLS
        elif kind == "separate":
            from clearvoice.networks import CLS_MossFormer2_SS_16K as CLS
        else:
            patch_overlap_and_add()
            from clearvoice.networks import CLS_AV_MossFormer2_TSE_16K as CLS
        holder = CLS(args)
        args.device = holder.device
        log(f"{name} loaded in {time.time() - started:.1f} s on {holder.device}")
        self.loaded[kind] = (holder.model, args)
        return self.loaded[kind]

    # ------------------------------------------------------------------ denoise

    def denoise(self, audio: np.ndarray, progress: Progress) -> np.ndarray:
        """MossFormer2_SE_48K over the whole recording (48 kHz floats in [-1, 1])."""
        import torch
        import torchaudio
        from clearvoice.utils.misc import compute_fbank, istft, stft

        model, args = self.load("denoise")
        device = args.device
        inputs = audio.astype(np.float32) * MAX_WAV_VALUE
        input_len = inputs.shape[0]

        def fbanks_of(segment: torch.Tensor) -> torch.Tensor:
            fb = compute_fbank(segment.unsqueeze(0), args)
            tr = torch.transpose(fb, 0, 1)
            d1 = torchaudio.functional.compute_deltas(tr)
            d2 = torchaudio.functional.compute_deltas(d1)
            return torch.cat([fb, torch.transpose(d1, 0, 1), torch.transpose(d2, 0, 1)], dim=1).unsqueeze(0).to(device)

        def run(segment: torch.Tensor) -> torch.Tensor:
            out_list = model(fbanks_of(segment))
            mask = out_list[-1].permute(2, 1, 0).detach().cpu()
            spectrum = stft(segment, args)
            masked = spectrum.cpu() * mask
            complex_spec = masked[:, :, 0] + 1j * masked[:, :, 1]
            return istft(complex_spec, args, len(segment))

        with torch.no_grad():
            if input_len > args.sampling_rate * args.one_time_decode_length:
                window = int(args.sampling_rate * args.decode_window)
                stride = int(window * 0.75)
                t = inputs.shape[0]
                if t < window:
                    inputs = np.concatenate([inputs, np.zeros(window - t)], 0)
                elif t < window + stride:
                    inputs = np.concatenate([inputs, np.zeros(window + stride - t)], 0)
                elif (t - window) % stride != 0:
                    inputs = np.concatenate([inputs, np.zeros(t - (t - window) // stride * stride)], 0)
                tape = torch.from_numpy(inputs).type(torch.FloatTensor)
                t = tape.shape[0]
                outputs = torch.zeros(t, dtype=torch.float64)
                give_up = (window - stride) // 2
                steps = max(1, (t - window) // stride + 1)
                current = 0
                step = 0
                while current + window <= t:
                    segment = tape[current : current + window]
                    out = run(segment)
                    if current == 0:
                        outputs[current : current + window - give_up] = out[:-give_up]
                    else:
                        out = out[-window:]
                        outputs[current + give_up : current + window - give_up] = out[give_up:-give_up]
                    current += stride
                    step += 1
                    progress(step / steps)
            else:
                tape = torch.from_numpy(inputs).type(torch.FloatTensor)
                outputs = run(tape)
        result = outputs.numpy()[:input_len] / MAX_WAV_VALUE
        return result.astype(np.float32)

    # ------------------------------------------------------------------ separation and extraction

    def separate(self, audio16: np.ndarray, progress: Progress) -> list[np.ndarray]:
        """MossFormer2_SS_16K: the recording as two voices, each at the recording's level."""
        import torch

        model, args = self.load("separate")
        device = args.device
        normed, scalar = audio_norm(audio16.astype(np.float64))
        inputs = np.reshape(normed.astype(np.float32), [1, -1])
        window = int(args.sampling_rate * args.decode_window)
        stride = int(window * 0.75)
        b, t = inputs.shape
        segmented = t > args.sampling_rate * args.one_time_decode_length
        if t < window:
            inputs = np.concatenate([inputs, np.zeros((1, window - t))], axis=1)
        elif t < window + stride:
            inputs = np.concatenate([inputs, np.zeros((1, window + stride - t))], axis=1)
        elif (t - window) % stride != 0:
            inputs = np.concatenate([inputs, np.zeros((1, t - (t - window) // stride * stride))], axis=1)
        tape = torch.from_numpy(np.float32(inputs)).to(device)
        _, t = tape.shape
        out: list[np.ndarray] = []
        with torch.no_grad():
            if segmented:
                outputs = np.zeros((args.num_spks, t))
                give_up = (window - stride) // 2
                steps = max(1, (t - window) // stride + 1)
                current = 0
                step = 0
                while current + window <= t:
                    parts = model(tape[:, current : current + window])
                    for spk in range(args.num_spks):
                        piece = parts[spk][0, :].detach().cpu().numpy()
                        if current == 0:
                            outputs[spk, current : current + window - give_up] = piece[:-give_up]
                        else:
                            outputs[spk, current + give_up : current + window - give_up] = piece[give_up:-give_up]
                    current += stride
                    step += 1
                    progress(step / steps)
                for spk in range(args.num_spks):
                    out.append(outputs[spk, :])
            else:
                parts = model(tape)
                for spk in range(args.num_spks):
                    out.append(parts[spk][0, :].detach().cpu().numpy())
        # The model was trained with a scale-invariant loss, so each stream comes out at an arbitrary
        # level. The level that is right is the one at which the stream best explains the mixture
        # (least squares), which also keeps a faint second voice faint instead of lifting it to the
        # mixture's level as ClearerVoice's own decoder does.
        n = audio16.shape[0]
        result = []
        for spk in range(args.num_spks):
            stream = out[spk][:n].astype(np.float64)
            power = float(np.dot(stream, stream))
            gain = float(np.dot(normed[:n], stream) / power) if power > 0 else 0.0
            result.append((stream * max(0.0, gain) * scalar).astype(np.float32))
        return result

    def extract(self, audio16: np.ndarray, visual: np.ndarray, progress: Progress) -> np.ndarray:
        """AV_MossFormer2_TSE_16K: the voice of the face in `visual` (frames × 112 × 112, normalised)."""
        import torch

        model, args = self.load("extract")
        device = args.device
        audio = audio16.astype(np.float32)
        peak = float(np.max(np.abs(audio))) if audio.size else 0.0
        scale = peak if peak > 1e-6 else 1.0
        audio = audio / scale
        length = int(len(audio) / LOW_RATE * FACE_FPS)
        if visual.shape[0] < length:
            visual = np.pad(visual, ((0, length - visual.shape[0]), (0, 0), (0, 0)), mode="edge")
        elif visual.shape[0] > length:
            visual = visual[:length]
        t = audio.shape[0]
        a = torch.from_numpy(np.expand_dims(audio, 0)).to(device)
        v = torch.from_numpy(np.expand_dims(visual.astype(np.float32), 0)).to(device)
        with torch.no_grad():
            if t > args.sampling_rate * args.one_time_decode_length:
                outputs = np.zeros(t)
                window = args.sampling_rate * args.decode_window
                window_v = FACE_FPS * args.decode_window
                stride = int(window * 0.6)
                give_up = (window - stride) // 2
                steps = max(1, math.ceil((t - window) / stride) + 1)
                current = 0
                step = 0
                while current + window < t:
                    seg_a = a[:, current : current + window]
                    at_v = int(current / args.sampling_rate * FACE_FPS)
                    seg_v = v[:, at_v : at_v + window_v, :, :]
                    piece = model(seg_a, seg_v).detach().squeeze().cpu().numpy()
                    if current == 0:
                        outputs[current : current + window - give_up] = piece[:-give_up]
                    else:
                        outputs[current + give_up : current + window - give_up] = piece[give_up:-give_up]
                    current += stride
                    step += 1
                    progress(step / steps)
                piece = model(a[:, -window:], v[:, -window_v:, :, :]).detach().squeeze().cpu().numpy()
                outputs[-window + give_up :] = piece[give_up:]
            else:
                outputs = model(a, v).detach().squeeze().cpu().numpy()
        return (outputs[:t] * scale).astype(np.float32)

    # ------------------------------------------------------------------ the speaker model

    def embed(self, audio16: np.ndarray) -> np.ndarray | None:
        """The voice vector of a 16 kHz clip through WeSpeaker, as the browser computes it; None without the model."""
        if not self.speaker_path or not os.path.isfile(self.speaker_path):
            return None
        import onnxruntime as ort
        import torch
        import torchaudio

        if self.speaker_session is None:
            self.speaker_session = ort.InferenceSession(self.speaker_path, providers=["CPUExecutionProvider"])
        wave = torch.from_numpy(audio16.astype(np.float32) * MAX_WAV_VALUE).unsqueeze(0)
        feats = torchaudio.compliance.kaldi.fbank(
            wave,
            num_mel_bins=80,
            frame_length=25.0,
            frame_shift=10.0,
            dither=0.0,
            window_type="povey",
            sample_frequency=LOW_RATE,
            low_freq=20.0,
            high_freq=-400.0,
            snip_edges=False,
            use_energy=False,
        )
        feats = feats - feats.mean(dim=0, keepdim=True)
        inputs = feats.unsqueeze(0).numpy().astype(np.float32)
        (embedding,) = self.speaker_session.run(["embs"], {"feats": inputs})
        vector = np.asarray(embedding, dtype=np.float32).reshape(-1)
        norm = float(np.linalg.norm(vector))
        return vector / norm if norm > 0 else vector


def audio_norm(x: np.ndarray) -> tuple[np.ndarray, float]:
    """ClearerVoice's two-stage level normalisation for the separation model, and the factor that undoes it."""
    eps = 1e-6
    rms = float((x**2).mean() ** 0.5)
    scalar = 10 ** (-25 / 20) / (rms + eps)
    x = x * scalar
    pow_x = x**2
    avg = pow_x.mean()
    loud = pow_x[pow_x > avg]
    rmsx = float(loud.mean() ** 0.5) if loud.size else rms
    scalarx = 10 ** (-25 / 20) / (rmsx + eps)
    x = x * scalarx
    return x, 1 / (scalar * scalarx + eps)


def patch_overlap_and_add() -> None:
    """The AV model's overlap-add has a hard-coded `.cuda()`; this one follows the tensor's device."""
    import torch
    from clearvoice.models.av_mossformer2_tse import av_mossformer2 as avm

    def overlap_and_add(signal, frame_step):
        outer = signal.size()[:-2]
        frames, frame_length = signal.size()[-2:]
        sub_len = math.gcd(frame_length, frame_step)
        sub_step = frame_step // sub_len
        subs_per_frame = frame_length // sub_len
        output_size = frame_step * (frames - 1) + frame_length
        output_subframes = output_size // sub_len
        sub_signal = signal.view(*outer, -1, sub_len)
        frame = torch.arange(0, output_subframes).unfold(0, subs_per_frame, sub_step)
        frame = frame.long().to(signal.device).contiguous().view(-1)
        result = signal.new_zeros(*outer, output_subframes, sub_len)
        result.index_add_(-2, frame, sub_signal)
        return result.view(*outer, -1)

    avm.overlap_and_add = overlap_and_add


def cosine(a: np.ndarray, b: np.ndarray) -> float:
    na = float(np.linalg.norm(a))
    nb = float(np.linalg.norm(b))
    return float(np.dot(a, b) / (na * nb)) if na > 0 and nb > 0 else 0.0


def read_faces(path: str) -> np.ndarray:
    """The mouth crops as the model wants them: frames × 112 × 112, grey, normalised."""
    from PIL import Image

    data = np.fromfile(path, dtype=np.uint8)
    frames = []
    at = 0
    while at + 4 <= data.size:
        (length,) = struct.unpack_from("<I", data, at)
        at += 4
        if length == 0 or at + length > data.size:
            break
        with Image.open(io.BytesIO(data[at : at + length].tobytes())) as image:
            grey = image.convert("L")
            if grey.size != (FACE_SIZE, FACE_SIZE):
                grey = grey.resize((FACE_SIZE, FACE_SIZE), Image.BILINEAR)
            frames.append(np.asarray(grey, dtype=np.float32))
        at += length
    if not frames:
        return np.zeros((0, FACE_SIZE, FACE_SIZE), dtype=np.float32)
    stack = np.stack(frames) / 255.0
    return ((stack - VISUAL_MEAN) / VISUAL_STD).astype(np.float32)


def band_merge(mix: np.ndarray, rate: int, low: np.ndarray) -> np.ndarray:
    """
    A 16 kHz result brought back to `rate`: the result's own band, plus the recording's band above 8 kHz
    scaled frame by frame by the share of the low band the model kept.
    """
    n = mix.shape[0]
    up = resample(low, LOW_RATE, rate)[:n]
    if up.shape[0] < n:
        up = np.pad(up, (0, n - up.shape[0]))
    mix_low = resample(resample(mix, rate, LOW_RATE), LOW_RATE, rate)[:n]
    if mix_low.shape[0] < n:
        mix_low = np.pad(mix_low, (0, n - mix_low.shape[0]))
    high = mix - mix_low
    frame = max(1, int(rate * MERGE_FRAME_SEC))
    kept = frame_rms(up, frame)
    had = frame_rms(mix_low, frame)
    gain = np.clip(kept / (had + 1e-6), 0.0, 1.0)
    if gain.size >= MERGE_SMOOTH:
        kernel = np.ones(MERGE_SMOOTH) / MERGE_SMOOTH
        gain = np.convolve(gain, kernel, mode="same")
    # one gain per frame, held across the frame, stretched to the sample count
    per_sample = np.repeat(gain, frame)
    if per_sample.shape[0] < n:
        per_sample = np.pad(per_sample, (0, n - per_sample.shape[0]), mode="edge")
    return (up + high * per_sample[:n]).astype(np.float32)


def overlap_measure(picked: np.ndarray, other: np.ndarray, rate: int) -> dict:
    """How much the other voice talks over the kept one, and how loud it is beside it."""
    frame = max(1, int(rate * OVERLAP_FRAME_SEC))
    p = 20 * np.log10(frame_rms(picked, frame) + 1e-9)
    o = 20 * np.log10(frame_rms(other, frame) + 1e-9)
    n = min(p.size, o.size)
    p, o = p[:n], o[:n]
    p_active = p > max(float(np.percentile(p, 95)) - OVERLAP_ACTIVE_UNDER_DB, OVERLAP_FLOOR_DBFS)
    o_active = o > max(float(np.percentile(o, 95)) - OVERLAP_ACTIVE_UNDER_DB, OVERLAP_FLOOR_DBFS)
    both = int(np.sum(p_active & o_active))
    # how loud each voice is while it speaks: the mean level over its own active frames
    level_p = float(np.mean(p[p_active])) if np.any(p_active) else -120.0
    level_o = float(np.mean(o[o_active])) if np.any(o_active) else -120.0
    return {
        "overlap": both / max(1, int(np.sum(p_active))),
        "otherShare": int(np.sum(o_active)) / max(1, n),
        "otherLevelDb": level_o - level_p,
        "otherRunSec": longest_run(o_active, int(round(OVERLAP_BRIDGE_SEC / OVERLAP_FRAME_SEC))) * OVERLAP_FRAME_SEC,
    }


def longest_run(active: np.ndarray, bridge: int) -> int:
    """The longest run of active frames, with gaps of up to `bridge` frames counted as part of the run."""
    best = 0
    run = 0
    gap = 0
    for on in active:
        if on:
            run += gap + 1
            gap = 0
            best = max(best, run)
        elif run > 0:
            gap += 1
            if gap > bridge:
                run = 0
                gap = 0
    return best


def handle(studio: Studio, request: dict) -> None:
    op = request.get("op")
    request_id = str(request.get("id", ""))
    if op == "hello":
        emit(
            {
                "event": "hello",
                "device": str(studio.device),
                "models": {kind: studio.has(kind) for kind in MODEL_NAMES},
                "speaker": bool(studio.speaker_path and os.path.isfile(studio.speaker_path)),
            }
        )
        return
    if op == "quit":
        emit({"event": "bye"})
        raise SystemExit(0)
    progress = Progress(request_id)
    try:
        rate = int(request["rate"])
        audio = read_pcm(request["audio"])
        if op == "denoise":
            at_rate = resample(audio, rate, SE_RATE)
            cleaned = studio.denoise(at_rate, progress)
            back = resample(cleaned, SE_RATE, rate)[: audio.shape[0]]
            if back.shape[0] < audio.shape[0]:
                back = np.pad(back, (0, audio.shape[0] - back.shape[0]))
            samples = write_pcm(request["out"], back)
            emit({"event": "done", "id": request_id, "samples": samples})
        elif op == "voice":
            low = resample(audio, rate, LOW_RATE)
            faces_path = request.get("faces")
            profile = request.get("profile")
            measure_only = bool(request.get("measure", False))
            result: dict = {"event": "done", "id": request_id}
            visual = read_faces(faces_path) if faces_path else None
            if visual is not None and visual.shape[0] > 0 and not measure_only:
                kept = studio.extract(low, visual, progress)
                result["method"] = "faces"
                result["faceFrames"] = int(visual.shape[0])
            else:
                streams = studio.separate(low, progress)
                sims = None
                if profile:
                    target = np.asarray(profile, dtype=np.float32)
                    vectors = [studio.embed(s) for s in streams]
                    if all(v is not None for v in vectors):
                        sims = [cosine(v, target) for v in vectors]
                if sims is not None:
                    pick = int(np.argmax(sims))
                    result["method"] = "profile"
                    result["similarity"] = [float(s) for s in sims]
                else:
                    levels = [float(np.sqrt(np.mean(s**2))) for s in streams]
                    pick = int(np.argmax(levels))
                    result["method"] = "energy"
                kept = streams[pick]
                result.update(overlap_measure(kept, streams[1 - pick], LOW_RATE))
            if not measure_only:
                merged = band_merge(audio, rate, kept)
                result["samples"] = write_pcm(request["out"], merged)
            emit(result)
        else:
            emit({"event": "error", "id": request_id, "message": f"unknown op {op!r}"})
    except Exception as error:  # noqa: BLE001 - every failure goes back to the server as a line
        log(traceback.format_exc())
        emit({"event": "error", "id": request_id, "message": f"{type(error).__name__}: {error}"})


def main() -> None:
    parser = argparse.ArgumentParser(description="One Take studio worker")
    parser.add_argument("--models", required=True, help="folder with one subfolder per ClearerVoice model")
    parser.add_argument("--speaker", default=None, help="the WeSpeaker ONNX file, for picking a voice by profile")
    parser.add_argument("--check", action="store_true", help="print what is installed as JSON and exit")
    args = parser.parse_args()
    studio = Studio(args.models, args.speaker)
    if args.check:
        info = {"models": {kind: studio.has(kind) for kind in MODEL_NAMES}, "speaker": bool(args.speaker and os.path.isfile(args.speaker))}
        try:
            import torch

            info["torch"] = torch.__version__
            info["device"] = str(studio.device)
            import clearvoice  # noqa: F401

            info["clearvoice"] = True
        except Exception as error:  # noqa: BLE001
            info["error"] = f"{type(error).__name__}: {error}"
        emit(info)
        return
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError as error:
            emit({"event": "error", "id": "", "message": f"bad request line: {error}"})
            continue
        handle(studio, request)


if __name__ == "__main__":
    main()
