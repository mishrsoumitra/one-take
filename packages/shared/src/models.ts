/**
 * The model files One Take fetches once for the voice check, the lip check and the camera cleanup. The noise model
 * (DeepFilterNet3) ships inside its npm package and needs no download.
 *
 * `npm run models` puts them in `packages/client/public/models`, where the client finds them first;
 * a client without them fetches each from `url` on first use and keeps it in the browser's cache
 * storage, so a machine is only ever asked once. Either way the bytes are checked against `sha256`.
 */
export interface ModelFile {
  /** The file name, under `/models` on the client. */
  name: string;
  /** Where it is published. */
  url: string;
  sha256: string;
  bytes: number;
  /** What it is for, for messages. */
  what: string;
}

export const MODELS = {
  speaker: {
    name: 'wespeaker_en_voxceleb_resnet34_LM.onnx',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_resnet34_LM.onnx',
    sha256: 'e9848563da86f263117134dfd7ad63c92355b37de492b55e325400c9d9c39012',
    bytes: 26_530_550,
    what: 'the voice check (WeSpeaker ResNet34, trained on VoxCeleb, as published by sherpa-onnx)',
  },
  face: {
    name: 'face_landmarker.task',
    url: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
    sha256: '64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff',
    bytes: 3_758_596,
    what: 'the lip check (MediaPipe Face Landmarker)',
  },
  segmenter: {
    name: 'selfie_segmenter.tflite',
    url: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite',
    sha256: '191ac9529ae506ee0beefa6b2c945a172dab9d07d1e802a290a4e4038226658b',
    bytes: 249_537,
    what: 'the camera cleanup (MediaPipe Image Segmenter, the selfie model)',
  },
} as const satisfies Record<string, ModelFile>;

/** The path the client serves the model files under. */
export const MODELS_PATH = '/models';
