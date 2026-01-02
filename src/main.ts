import { RealtimeClient } from '@speechmatics/real-time-client';
import {
  PCMRecorder,
  type InputAudioEvent
} from '@speechmatics/browser-audio-input';
import PCMAudioWorkletUrl from '@speechmatics/browser-audio-input/pcm-audio-worklet.min.js?url';

const urlInput = document.getElementById('rt-url') as HTMLInputElement;
const languageInput = document.getElementById('language') as HTMLInputElement;
const languageDatalist = document.getElementById(
  'language-options'
) as HTMLDataListElement | null;
const startButton = document.getElementById('start') as HTMLButtonElement;
const stopButton = document.getElementById('stop') as HTMLButtonElement;
const downloadButton = document.getElementById('download') as HTMLButtonElement;
const transcriptEl = document.getElementById('transcript') as HTMLPreElement;

let audioContext: AudioContext | null = null;
let pcmRecorder: PCMRecorder | null = null;
let client: RealtimeClient | null = null;
let finalText = '';
let isReconnecting = false;
let recordedAudio: Int16Array[] = [];

const TARGET_SAMPLE_RATE = 16000;
const CHUNK_DURATION_MS = 50;
const CHUNK_SAMPLES = Math.round((TARGET_SAMPLE_RATE * CHUNK_DURATION_MS) / 1000);
const ACK_TIMEOUT_MS = 3000;
const MAX_DELAY = 1;
const HEALTH_CHECK_INTERVAL_MS = 1000;
const CHUNK_DURATION_S = CHUNK_DURATION_MS / 1000;

let audioBufferQueue: Int16Array[] = [];
let queuedSamples = 0;
let nextSeqNo = 1;
let pendingChunks: Map<number, { chunk: Int16Array; sentAt: number }> = new Map();
let healthCheckIntervalId: number | null = null;
let sessionStopped = true;
let savedQueuedSamples = 0;
let slidingBuffer: { chunk: Int16Array; timestamp: number }[] = [];
let lastTranscriptEndTime = 0;
let currentAudioTimestamp = 0;

function appendStatus(message: string) {
  transcriptEl.textContent += `\n[status] ${message}`;
}

async function fetchJwt(): Promise<string> {
  const response = await fetch('/speechmatics-jwt');
  if (!response.ok) {
    throw new Error(`JWT request failed with status ${response.status}`);
  }
  const data = (await response.json()) as { jwt?: string };
  if (!data.jwt) {
    throw new Error('JWT response did not contain a jwt field');
  }
  return data.jwt;
}

async function populateLanguagesFromDiscovery() {
  try {
    const response = await fetch(
      'https://neu.rt.speechmatics.com/v1/discovery/features'
    );
    if (!response.ok) {
      console.warn(
        'Failed to fetch discovery features for languages:',
        response.status
      );
      return;
    }
    const json = (await response.json()) as unknown;

    const languages = new Set<string>();

    function walk(obj: any) {
      if (!obj || typeof obj !== 'object') return;
      if (Array.isArray(obj)) {
        for (const item of obj) {
          walk(item);
        }
        return;
      }

      for (const [key, value] of Object.entries(obj)) {
        if (/^[a-z]{2,5}$/i.test(key)) {
          languages.add(key.toLowerCase());
        }
        if (value && typeof value === 'object') {
          walk(value);
        }
      }
    }

    walk(json);

    if (!languageDatalist || languages.size === 0) {
      return;
    }

    languageDatalist.innerHTML = '';
    const sorted = Array.from(languages).sort();
    for (const code of sorted) {
      const option = document.createElement('option');
      option.value = code;
      languageDatalist.appendChild(option);
    }

    if (!languageInput.value && sorted.includes('en')) {
      languageInput.value = 'en';
    }
  } catch (e) {
    console.warn('Error populating languages from discovery endpoint', e);
  }
}

async function startSession() {
  const url = urlInput.value.trim();
  const language = languageInput.value.trim() || 'en';

  if (!url) {
    alert('Please provide the real-time URL');
    return;
  }

  try {
    const jwt = await fetchJwt();
    client = new RealtimeClient({ url });
    finalText = '';
    transcriptEl.textContent = '';
    recordedAudio = [];
    downloadButton.disabled = true;

    client.addEventListener('receiveMessage', handleReceiveMessage);
    client.addEventListener('socketStateChange', createSocketStateHandler(url, language));

    await client.start(jwt, getStartConfig(language));

    // Set up PCMRecorder to capture browser PCM and forward as 16kHz pcm_s16le
    audioContext = new AudioContext();
    pcmRecorder = new PCMRecorder(PCMAudioWorkletUrl);

    pcmRecorder.addEventListener('audio', (event: InputAudioEvent) => {
      if (sessionStopped || !audioContext) {
        console.log('audio event ignored:', { sessionStopped, hasAudioContext: !!audioContext });
        return;
      }
      const floats = event.data;
      const inputSampleRate = audioContext.sampleRate;

      const resampled = resampleTo16k(floats, inputSampleRate, TARGET_SAMPLE_RATE);
      recordedAudio.push(resampled);
      enqueueAudio(resampled);
    });

    await pcmRecorder.startRecording({ audioContext });

    startHealthCheck(url, language);

    sessionStopped = false;
    startButton.disabled = true;
    stopButton.disabled = false;
    appendStatus('Session started');
  } catch (err: any) {
    console.error(err);
    alert(`Failed to start session: ${err?.message || err}`);
  }
}

async function stopSession() {
  sessionStopped = true;
  if (client) {
    client.stopRecognition({ noTimeout: true } as any);
  }

  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }

  if (pcmRecorder) {
    pcmRecorder.stopRecording();
    pcmRecorder = null;
  }

  audioBufferQueue = [];
  queuedSamples = 0;
  pendingChunks.clear();
  nextSeqNo = 1;
  isReconnecting = false;
  slidingBuffer = [];
  lastTranscriptEndTime = 0;
  currentAudioTimestamp = 0;

  if (healthCheckIntervalId !== null) {
    clearInterval(healthCheckIntervalId);
    healthCheckIntervalId = null;
  }

  startButton.disabled = false;
  stopButton.disabled = true;
  downloadButton.disabled = recordedAudio.length === 0;
  appendStatus('Session stopped');
}

startButton.addEventListener('click', () => {
  void startSession();
});

stopButton.addEventListener('click', () => {
  void stopSession();
});

downloadButton.addEventListener('click', () => {
  downloadWavFile();
});

void populateLanguagesFromDiscovery();

function handleReceiveMessage({ data }: { data: any }) {
  // console.log('receiveMessage:', data.message, data);
  if (data.message === 'AddTranscript') {
    const results = data.results || [];
    for (const result of results) {
      const content = result.alternatives?.[0]?.content;
      if (content) {
        if (result.type === 'punctuation') {
          finalText = `${finalText}${content}`;
        } else {
          finalText = `${finalText} ${content}`;
        }
      }
    }
    finalText = finalText.trim();
    transcriptEl.textContent = finalText;

    // Update last transcript end time and trim sliding buffer
    const endTime = data.metadata?.end_time;
    if (typeof endTime === 'number' && endTime > lastTranscriptEndTime) {
      lastTranscriptEndTime = endTime;
      trimSlidingBuffer();
    }
  } else if (data.message === 'EndOfTranscript') {
    appendStatus('End of transcript');
  } else if (data.message === 'AudioAdded') {
    const ackSeqNo = data.seq_no;
    // console.log(`AudioAdded ack: seq_no=${ackSeqNo}, pendingChunks before=${pendingChunks.size}`);
    if (typeof ackSeqNo === 'number') {
      for (let i = 1; i <= ackSeqNo; i++) {
        pendingChunks.delete(i);
      }
    }
    // console.log(`AudioAdded ack: pendingChunks after=${pendingChunks.size}`);
  } else if (data.message === 'RecognitionStarted') {
    console.log('RecognitionStarted received');
  } else if (data.message === 'Error') {
    console.error('Server error:', data);
  }
}

function createSocketStateHandler(url: string, language: string) {
  return (e: any) => {
    console.log('socket state:', e.socketState);
    if (!sessionStopped && (e.socketState === 'closed' || e.socketState === 'error')) {
      appendStatus('WebSocket closed, reconnecting...');
      void reconnectSession(url, language);
    }
  };
}

function getStartConfig(language: string) {
  return {
    audio_format: {
      type: 'raw',
      encoding: 'pcm_s16le',
      sample_rate: TARGET_SAMPLE_RATE
    },
    transcription_config: {
      language,
      operating_point: 'enhanced',
      enable_partials: true,
      max_delay: MAX_DELAY
    }
  } as any;
}

function startHealthCheck(url: string, language: string) {
  if (healthCheckIntervalId !== null) {
    clearInterval(healthCheckIntervalId);
  }

  healthCheckIntervalId = window.setInterval(() => {
    if (!client) return;
    if (sessionStopped) return;
    const now = Date.now();
    for (const { sentAt } of pendingChunks.values()) {
      if (now - sentAt > ACK_TIMEOUT_MS) {
        appendStatus('No AudioAdded ack for >3s, reconnecting...');
        void reconnectSession(url, language);
        break;
      }
    }
  }, HEALTH_CHECK_INTERVAL_MS);
}

function downloadWavFile() {
  if (recordedAudio.length === 0) {
    alert('No audio recorded');
    return;
  }

  const totalSamples = recordedAudio.reduce((sum, arr) => sum + arr.length, 0);
  const combinedAudio = new Int16Array(totalSamples);
  let offset = 0;
  for (const chunk of recordedAudio) {
    combinedAudio.set(chunk, offset);
    offset += chunk.length;
  }

  const wavBuffer = createWavFile(combinedAudio, TARGET_SAMPLE_RATE);
  const blob = new Blob([wavBuffer], { type: 'audio/wav' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `recording-${new Date().toISOString().replace(/[:.]/g, '-')}.wav`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  appendStatus('WAV file downloaded');
}

function createWavFile(samples: Int16Array, sampleRate: number): ArrayBuffer {
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

function resampleTo16k(
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

async function reconnectSession(url: string, language: string) {
  if (isReconnecting) {
    console.log('Already reconnecting, skipping duplicate reconnect');
    return;
  }
  isReconnecting = true;

  // Use sliding buffer for replay - this includes audio after the last transcribed end_time
  const replayChunks = slidingBuffer.map(entry => entry.chunk);
  slidingBuffer = [];
  lastTranscriptEndTime = 0;
  currentAudioTimestamp = 0;

  const savedQueue = [...audioBufferQueue];
  savedQueuedSamples = queuedSamples;
  audioBufferQueue = [];
  queuedSamples = 0;

  console.log('reconnectSession: starting reconnect', {
    url,
    language,
    replayChunkCount: replayChunks.length,
    queuedBuffers: savedQueue.length,
    queuedSamples: savedQueuedSamples,
    pendingChunksBeforeClear: pendingChunks.size
  });

  pendingChunks.clear();
  nextSeqNo = 1;

  if (healthCheckIntervalId !== null) {
    clearInterval(healthCheckIntervalId);
    healthCheckIntervalId = null;
  }

  if (client) {
    try {
      client.stopRecognition({ noTimeout: true } as any);
    } catch (e) {
      console.error('Error stopping client during reconnect', e);
    }
  }

  const jwt = await fetchJwt();

  client = new RealtimeClient({ url });

  client.addEventListener('receiveMessage', handleReceiveMessage);
  client.addEventListener('socketStateChange', createSocketStateHandler(url, language));

  await client.start(jwt, getStartConfig(language));

  await new Promise(resolve => setTimeout(resolve, 100));

  console.log('Reconnect: session started, restoring queue and sending buffered chunks', {
    replayChunks: replayChunks.length,
    savedQueueBuffers: savedQueue.length,
    savedQueuedSamples: savedQueuedSamples
  });

  audioBufferQueue = [...savedQueue, ...audioBufferQueue];
  queuedSamples = savedQueuedSamples + queuedSamples;

  isReconnecting = false;

  // Send replay chunks (sliding buffer) first
  let replayCount = 0;
  for (const chunk of replayChunks) {
    if (!client) break;
    const seqNo = nextSeqNo++;
    const now = Date.now();
    pendingChunks.set(seqNo, { chunk, sentAt: now });
    const pcmBytes = int16ToLittleEndian(chunk);
    client.sendAudio(pcmBytes);
    addToSlidingBuffer(chunk);
    replayCount++;
  }
  console.log(`Reconnect: sent ${replayCount} replay chunks from sliding buffer`);

  let queueSentCount = 0;
  while (queuedSamples >= CHUNK_SAMPLES) {
    const chunk = dequeueChunk();
    if (!chunk || !client) break;
    const seqNo = nextSeqNo++;
    const now = Date.now();
    pendingChunks.set(seqNo, { chunk, sentAt: now });
    const pcmBytes = int16ToLittleEndian(chunk);
    client.sendAudio(pcmBytes);
    queueSentCount++;
  }
  console.log(`Reconnect: sent ${queueSentCount} chunks from restored queue`);
  console.log(`Reconnect: complete, remaining queued samples: ${queuedSamples}`);

  startHealthCheck(url, language);
}

function addToSlidingBuffer(chunk: Int16Array) {
  slidingBuffer.push({ chunk, timestamp: currentAudioTimestamp });
  currentAudioTimestamp += CHUNK_DURATION_S;
}

function trimSlidingBuffer() {
  // Remove chunks that have been transcribed (timestamp < lastTranscriptEndTime)
  while (slidingBuffer.length > 0 && slidingBuffer[0].timestamp < lastTranscriptEndTime) {
    slidingBuffer.shift();
  }
}

function enqueueAudio(samples: Int16Array) {
  if (samples.length === 0) return;
  audioBufferQueue.push(samples);
  queuedSamples += samples.length;

  if (!client || sessionStopped || isReconnecting) {
    console.log('enqueueAudio: skipping send', { hasClient: !!client, sessionStopped, isReconnecting, queuedSamples });
    return;
  }

  let chunksSent = 0;
  while (queuedSamples >= CHUNK_SAMPLES) {
    const chunk = dequeueChunk();
    if (!chunk) break;
    const seqNo = nextSeqNo++;
    const now = Date.now();
    pendingChunks.set(seqNo, { chunk, sentAt: now });
    const pcmBytes = int16ToLittleEndian(chunk);
    client.sendAudio(pcmBytes);
    addToSlidingBuffer(chunk);
    chunksSent++;
  }
  if (chunksSent > 0) {
    // console.log(`enqueueAudio: sent ${chunksSent} chunks, nextSeqNo=${nextSeqNo}, pendingChunks=${pendingChunks.size}, remainingQueuedSamples=${queuedSamples}`);
  }
}

function dequeueChunk(): Int16Array | null {
  if (queuedSamples < CHUNK_SAMPLES) {
    return null;
  }

  const chunk = new Int16Array(CHUNK_SAMPLES);
  let filled = 0;

  while (filled < CHUNK_SAMPLES && audioBufferQueue.length > 0) {
    const current = audioBufferQueue[0];
    const remainingInCurrent = current.length;
    const needed = CHUNK_SAMPLES - filled;

    if (remainingInCurrent <= needed) {
      chunk.set(current, filled);
      filled += remainingInCurrent;
      audioBufferQueue.shift();
    } else {
      const slice = current.subarray(0, needed);
      chunk.set(slice, filled);
      const leftover = current.subarray(needed);
      audioBufferQueue[0] = leftover;
      filled += needed;
    }
  }

  queuedSamples -= CHUNK_SAMPLES;
  if (queuedSamples < 0) queuedSamples = 0;

  return chunk;
}

function floatTo16BitPCM(input: Float32Array): Int16Array {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    let s = input[i];
    // clamp
    if (s < -1) s = -1;
    if (s > 1) s = 1;
    output[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return output;
}

function int16ToLittleEndian(input: Int16Array): Uint8Array {
  const buffer = new ArrayBuffer(input.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < input.length; i++) {
    view.setInt16(i * 2, input[i], true); // little-endian
  }
  return new Uint8Array(buffer);
}
