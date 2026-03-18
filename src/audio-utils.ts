export function floatTo16BitPCM(input: Float32Array): Int16Array {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    let s = input[i];
    if (s < -1) s = -1;
    if (s > 1) s = 1;
    output[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return output;
}

export function resampleTo16k(
  input: Float32Array,
  inputSampleRate: number,
  targetSampleRate: number
): Int16Array {
  if (inputSampleRate === targetSampleRate) {
    return floatTo16BitPCM(input);
  }

  const ratio = inputSampleRate / targetSampleRate;
  const newLength = Math.round(input.length / ratio);
  const resampled = new Float32Array(newLength);

  let offsetResult = 0;
  let offsetBuffer = 0;
  while (offsetResult < newLength) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
    let accum = 0;
    let count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer && i < input.length; i++) {
      accum += input[i];
      count++;
    }
    resampled[offsetResult] = count > 0 ? accum / count : 0;
    offsetResult++;
    offsetBuffer = nextOffsetBuffer;
  }

  return floatTo16BitPCM(resampled);
}

export function int16ToLittleEndian(input: Int16Array): Uint8Array {
  const buffer = new ArrayBuffer(input.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < input.length; i++) {
    view.setInt16(i * 2, input[i], true);
  }
  return new Uint8Array(buffer);
}

export function createWavFile(samples: Int16Array, sampleRate: number): ArrayBuffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  for (let i = 0; i < samples.length; i++) {
    view.setInt16(44 + i * 2, samples[i], true);
  }

  return buffer;
}

export interface DequeueResult {
  chunk: Int16Array;
  remaining: Int16Array[];
  remainingSamples: number;
}

/**
 * Dequeues one fixed-size chunk from a buffer queue without mutating the input arrays.
 * Returns null if there are not enough samples.
 */
export function dequeueChunk(
  buffers: Int16Array[],
  totalSamples: number,
  chunkSamples: number
): DequeueResult | null {
  if (totalSamples < chunkSamples) return null;

  const chunk = new Int16Array(chunkSamples);
  const queue = [...buffers];
  let filled = 0;

  while (filled < chunkSamples && queue.length > 0) {
    const current = queue[0];
    const needed = chunkSamples - filled;

    if (current.length <= needed) {
      chunk.set(current, filled);
      filled += current.length;
      queue.shift();
    } else {
      chunk.set(current.subarray(0, needed), filled);
      queue[0] = current.subarray(needed);
      filled += needed;
    }
  }

  return {
    chunk,
    remaining: queue,
    remainingSamples: Math.max(0, totalSamples - chunkSamples)
  };
}

/**
 * Returns a new sliding buffer with all entries whose timestamp is strictly
 * less than lastTranscriptEndTime removed. Does not mutate the input.
 */
export function trimSlidingBuffer(
  buffer: { chunk: Int16Array; timestamp: number }[],
  lastTranscriptEndTime: number
): { chunk: Int16Array; timestamp: number }[] {
  let i = 0;
  while (i < buffer.length && buffer[i].timestamp < lastTranscriptEndTime) i++;
  return buffer.slice(i);
}
