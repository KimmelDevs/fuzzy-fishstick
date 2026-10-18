// Pick the best recording format this browser supports.
export function pickMime() {
  if (typeof MediaRecorder === 'undefined') return '';
  const types = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
  ];
  return types.find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

export function extFor(mime = '') {
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('mp4')) return 'm4a';
  return 'webm';
}

export function fmtTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function stamp(date) {
  return date.toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

export function downloadUrl(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// Build a reverb impulse response: decaying stereo noise that gets darker as it fades.
// roomSize 0-100 maps to a 0.4s-4s tail, like StarMaker's "Room size".
export function makeImpulse(ctx, roomSize) {
  const seconds = 0.4 + (roomSize / 100) * 3.6;
  const preDelay = Math.floor(ctx.sampleRate * (0.005 + (roomSize / 100) * 0.03));
  const length = Math.floor(ctx.sampleRate * seconds) + preDelay;
  const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const data = impulse.getChannelData(c);
    let lp = 0;
    for (let i = preDelay; i < length; i++) {
      const t = (i - preDelay) / (length - preDelay);
      const noise = (Math.random() * 2 - 1) * Math.pow(1 - t, 3);
      const damp = 0.15 + 0.8 * t; // high frequencies die out first, like a real room
      lp += (noise - lp) * (1 - damp);
      data[i] = lp;
    }
  }
  return impulse;
}

function encodeWav(audio) {
  const channels = audio.numberOfChannels;
  const rate = audio.sampleRate;
  const length = audio.length;
  const dataSize = length * channels * 2;
  const view = new DataView(new ArrayBuffer(44 + dataSize));

  const write = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  write(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, dataSize, true);

  const data = Array.from({ length: channels }, (_, c) => audio.getChannelData(c));
  let offset = 44;
  for (let i = 0; i < length; i++) {
    for (let c = 0; c < channels; c++) {
      const s = Math.max(-1, Math.min(1, data[c][i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([view], { type: 'audio/wav' });
}

// Convert any recorded blob (webm/ogg/mp4) to a WAV blob.
export async function blobToWav(blob) {
  const buffer = await blob.arrayBuffer();
  const ctx = new AudioContext();
  try {
    const audio = await ctx.decodeAudioData(buffer);
    return encodeWav(audio);
  } finally {
    ctx.close();
  }
}
