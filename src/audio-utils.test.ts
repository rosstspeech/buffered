import { describe, it, expect } from 'vitest';
import {
  floatTo16BitPCM,
  resampleTo16k,
  int16ToLittleEndian,
  createWavFile,
  dequeueChunk,
  trimSlidingBuffer
} from './audio-utils';

const CHUNK_SAMPLES = 800; // 50ms at 16kHz

// ---------------------------------------------------------------------------
// floatTo16BitPCM
// ---------------------------------------------------------------------------
describe('floatTo16BitPCM', () => {
  it('converts 0.0 to 0', () => {
    expect(floatTo16BitPCM(new Float32Array([0]))[0]).toBe(0);
  });

  it('converts 1.0 to 32767', () => {
    expect(floatTo16BitPCM(new Float32Array([1]))[0]).toBe(0x7fff);
  });

  it('converts -1.0 to -32768', () => {
    expect(floatTo16BitPCM(new Float32Array([-1]))[0]).toBe(-0x8000);
  });

  it('clamps values above 1', () => {
    expect(floatTo16BitPCM(new Float32Array([2]))[0]).toBe(0x7fff);
  });

  it('clamps values below -1', () => {
    expect(floatTo16BitPCM(new Float32Array([-2]))[0]).toBe(-0x8000);
  });

  it('preserves length', () => {
    const input = new Float32Array(100);
    expect(floatTo16BitPCM(input).length).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// dequeueChunk
// ---------------------------------------------------------------------------
describe('dequeueChunk', () => {
  it('returns null when there are not enough samples', () => {
    expect(dequeueChunk([new Int16Array(400)], 400, CHUNK_SAMPLES)).toBeNull();
  });

  it('returns null for an empty queue', () => {
    expect(dequeueChunk([], 0, CHUNK_SAMPLES)).toBeNull();
  });

  it('dequeues an exact-size buffer', () => {
    const data = new Int16Array(CHUNK_SAMPLES).fill(42);
    const result = dequeueChunk([data], CHUNK_SAMPLES, CHUNK_SAMPLES);

    expect(result).not.toBeNull();
    expect(result!.chunk.length).toBe(CHUNK_SAMPLES);
    expect(result!.chunk[0]).toBe(42);
    expect(result!.remaining).toHaveLength(0);
    expect(result!.remainingSamples).toBe(0);
  });

  it('dequeues across multiple buffers', () => {
    // 500 samples of 1s + 500 samples of 2s → chunk takes 500+300, leaves 200
    const a = new Int16Array(500).fill(1);
    const b = new Int16Array(500).fill(2);
    const result = dequeueChunk([a, b], 1000, CHUNK_SAMPLES);

    expect(result).not.toBeNull();
    expect(result!.chunk[0]).toBe(1);       // came from buffer a
    expect(result!.chunk[500]).toBe(2);     // came from buffer b
    expect(result!.remaining).toHaveLength(1);
    expect(result!.remaining[0].length).toBe(200);
    expect(result!.remainingSamples).toBe(200);
  });

  it('leaves a leftover slice when a buffer is larger than the chunk', () => {
    const data = new Int16Array(1000).fill(7);
    const result = dequeueChunk([data], 1000, CHUNK_SAMPLES);

    expect(result!.remaining[0].length).toBe(200);
    expect(result!.remaining[0][0]).toBe(7);
  });

  it('does not mutate the input buffers array', () => {
    const data = new Int16Array(CHUNK_SAMPLES).fill(1);
    const input = [data];
    dequeueChunk(input, CHUNK_SAMPLES, CHUNK_SAMPLES);
    expect(input).toHaveLength(1);
  });

  it('drains multiple full buffers in sequence', () => {
    const buffers = [
      new Int16Array(400).fill(1),
      new Int16Array(400).fill(2),
    ];
    // First chunk: 400 from buf[0] + 400 from buf[1]
    const result = dequeueChunk(buffers, 800, CHUNK_SAMPLES);
    expect(result).not.toBeNull();
    expect(result!.remaining).toHaveLength(0);
    expect(result!.remainingSamples).toBe(0);
    expect(result!.chunk[0]).toBe(1);
    expect(result!.chunk[400]).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// trimSlidingBuffer
// ---------------------------------------------------------------------------
describe('trimSlidingBuffer', () => {
  const entry = (timestamp: number) => ({ chunk: new Int16Array(800), timestamp });

  it('removes entries strictly before lastTranscriptEndTime', () => {
    const buf = [entry(0), entry(0.05), entry(0.1)];
    const result = trimSlidingBuffer(buf, 0.08);
    expect(result).toHaveLength(1);
    expect(result[0].timestamp).toBe(0.1);
  });

  it('keeps entries at exactly lastTranscriptEndTime', () => {
    const buf = [entry(0), entry(1.0)];
    const result = trimSlidingBuffer(buf, 1.0);
    expect(result).toHaveLength(1);
    expect(result[0].timestamp).toBe(1.0);
  });

  it('returns empty array when all entries are before the threshold', () => {
    expect(trimSlidingBuffer([entry(0), entry(0.5)], 2.0)).toHaveLength(0);
  });

  it('returns all entries when none are before the threshold', () => {
    expect(trimSlidingBuffer([entry(1.0), entry(2.0)], 0.5)).toHaveLength(2);
  });

  it('does not mutate the input array', () => {
    const buf = [entry(0), entry(0.05)];
    trimSlidingBuffer(buf, 0.03);
    expect(buf).toHaveLength(2);
  });

  it('handles an empty buffer', () => {
    expect(trimSlidingBuffer([], 1.0)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// createWavFile
// ---------------------------------------------------------------------------
describe('createWavFile', () => {
  it('starts with RIFF/WAVE header', () => {
    const bytes = new Uint8Array(createWavFile(new Int16Array(100), 16000));
    expect(String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3])).toBe('RIFF');
    expect(String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11])).toBe('WAVE');
  });

  it('has correct total file size', () => {
    const buf = createWavFile(new Int16Array(100), 16000);
    expect(buf.byteLength).toBe(44 + 100 * 2);
  });

  it('encodes sample rate at offset 24', () => {
    const view = new DataView(createWavFile(new Int16Array(10), 16000));
    expect(view.getUint32(24, true)).toBe(16000);
  });

  it('encodes data chunk size at offset 40', () => {
    const samples = new Int16Array(50);
    const view = new DataView(createWavFile(samples, 16000));
    expect(view.getUint32(40, true)).toBe(50 * 2);
  });

  it('round-trips sample values', () => {
    const samples = new Int16Array([100, -200, 32767, -32768]);
    const view = new DataView(createWavFile(samples, 16000));
    expect(view.getInt16(44, true)).toBe(100);
    expect(view.getInt16(46, true)).toBe(-200);
    expect(view.getInt16(48, true)).toBe(32767);
    expect(view.getInt16(50, true)).toBe(-32768);
  });
});

// ---------------------------------------------------------------------------
// resampleTo16k
// ---------------------------------------------------------------------------
describe('resampleTo16k', () => {
  it('passes through without resampling when rates match', () => {
    const input = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const result = resampleTo16k(input, 16000, 16000);
    expect(result.length).toBe(input.length);
  });

  it('halves sample count when downsampling 2:1', () => {
    const result = resampleTo16k(new Float32Array(32), 32000, 16000);
    expect(result.length).toBe(16);
  });

  it('averages pairs when downsampling 2:1', () => {
    // Two pairs: [0.5, 0.5] → avg 0.5, [-0.5, -0.5] → avg -0.5
    const input = new Float32Array([0.5, 0.5, -0.5, -0.5]);
    const result = resampleTo16k(input, 32000, 16000);
    expect(result.length).toBe(2);
    // 0.5 * 0x7fff ≈ 16383
    expect(result[0]).toBeCloseTo(16383, -1);
    expect(result[1]).toBeCloseTo(-16384, -1);
  });
});

// ---------------------------------------------------------------------------
// int16ToLittleEndian
// ---------------------------------------------------------------------------
describe('int16ToLittleEndian', () => {
  it('produces a byte array twice the length of the input', () => {
    const result = int16ToLittleEndian(new Int16Array(10));
    expect(result.length).toBe(20);
  });

  it('encodes a known value in little-endian order', () => {
    // 0x0102 → low byte 0x02, high byte 0x01
    const result = int16ToLittleEndian(new Int16Array([0x0102]));
    expect(result[0]).toBe(0x02);
    expect(result[1]).toBe(0x01);
  });

  it('round-trips through DataView', () => {
    const input = new Int16Array([1000, -1000, 32767]);
    const bytes = int16ToLittleEndian(input);
    const view = new DataView(bytes.buffer);
    expect(view.getInt16(0, true)).toBe(1000);
    expect(view.getInt16(2, true)).toBe(-1000);
    expect(view.getInt16(4, true)).toBe(32767);
  });
});
