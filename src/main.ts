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
const transcriptEl = document.getElementById('transcript') as HTMLPreElement;

let audioContext: AudioContext | null = null;
let pcmRecorder: PCMRecorder | null = null;
let client: RealtimeClient | null = null;
let finalText = '';

const TARGET_SAMPLE_RATE = 16000;
const CHUNK_DURATION_MS = 50;
const CHUNK_SAMPLES = Math.round((TARGET_SAMPLE_RATE * CHUNK_DURATION_MS) / 1000);
const ACK_TIMEOUT_MS = 3000;
const MAX_DELAY = 1;
const HEALTH_CHECK_INTERVAL_MS = 1000;

let audioBufferQueue: Int16Array[] = [];
let queuedSamples = 0;
let nextSeqNo = 1;
let pendingChunks: Map<number, { chunk: Int16Array; sentAt: number }> = new Map();
let healthCheckIntervalId: number | null = null;
let sessionStopped = true;

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

    client.addEventListener('receiveMessage', ({ data }) => {
      
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
      } else if (data.message === 'EndOfTranscript') {
        appendStatus('End of transcript');
      } else if (data.message === 'AudioAdded') {
        const ackSeqNo = data.seq_no;
        if (typeof ackSeqNo === 'number') {
          for (let i = 1; i <= ackSeqNo; i++) {
            pendingChunks.delete(i);
          }
        }
      }
    });

    client.addEventListener('socketStateChange', (e: any) => {
      console.log('socket state:', e.socketState);
      if (!sessionStopped && (e.socketState === 'closed' || e.socketState === 'error')) {
        appendStatus('WebSocket closed, reconnecting...');
        void reconnectSession(url, language);
      }
    });

    await client.start(jwt, {
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
    } as any);

    // Set up PCMRecorder to capture browser PCM and forward as 16kHz pcm_s16le
    audioContext = new AudioContext();
    pcmRecorder = new PCMRecorder(PCMAudioWorkletUrl);

    pcmRecorder.addEventListener('audio', (event: InputAudioEvent) => {
      if (!client || !audioContext) return;
      const floats = event.data;
      const inputSampleRate = audioContext.sampleRate;

      const resampled = resampleTo16k(floats, inputSampleRate, TARGET_SAMPLE_RATE);
      enqueueAudio(resampled);
    });

    await pcmRecorder.startRecording({ audioContext });

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
          console.log('Health check: triggering reconnect due to missing AudioAdded ack for >5s');
          void reconnectSession(url, language);
          break;
        }
      }
    }, HEALTH_CHECK_INTERVAL_MS);

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

  if (healthCheckIntervalId !== null) {
    clearInterval(healthCheckIntervalId);
    healthCheckIntervalId = null;
  }

  startButton.disabled = false;
  stopButton.disabled = true;
  appendStatus('Session stopped');
}

startButton.addEventListener('click', () => {
  void startSession();
});

stopButton.addEventListener('click', () => {
  void stopSession();
});

void populateLanguagesFromDiscovery();

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
  const unsentChunks: Int16Array[] = [];
  for (const { chunk } of pendingChunks.values()) {
    unsentChunks.push(chunk);
  }

  console.log('reconnectSession: starting reconnect', {
    url,
    language,
    unsentChunkCount: unsentChunks.length
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

  client.addEventListener('receiveMessage', ({ data }) => {
    if (data.message === 'AddTranscript') {
      const results = data.results || [];
      for (const result of results) {
        const content = result.alternatives?.[0]?.content;
        if (content) {
          if (result.is_eos) {
            finalText = `${finalText}${content}`;
          } else {
            finalText = `${finalText} ${content}`;
          }
        }
      }
      finalText = finalText.trim();
      transcriptEl.textContent = finalText;
    } else if (data.message === 'EndOfTranscript') {
      appendStatus('End of transcript');
    } else if (data.message === 'AudioAdded') {
      const ackSeqNo = data.seq_no;
      if (typeof ackSeqNo === 'number') {
        for (let i = 1; i <= ackSeqNo; i++) {
          pendingChunks.delete(i);
        }
      }
    }
  });

  client.addEventListener('socketStateChange', (e: any) => {
    console.log('socket state (reconnect):', e.socketState);
    if (!sessionStopped && (e.socketState === 'closed' || e.socketState === 'error')) {
      appendStatus('WebSocket closed after reconnect, reconnecting again...');
      void reconnectSession(url, language);
    }
  });

  await client.start(jwt, {
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
  } as any);

  if (healthCheckIntervalId !== null) {
    clearInterval(healthCheckIntervalId);
  }

  healthCheckIntervalId = window.setInterval(() => {
    if (!client) return;
    if (sessionStopped) return;
    const now = Date.now();
    for (const { sentAt } of pendingChunks.values()) {
      if (now - sentAt > ACK_TIMEOUT_MS) {
        appendStatus('No AudioAdded ack for >5s, reconnecting...');
        void reconnectSession(url, language);
        break;
      }
    }
  }, HEALTH_CHECK_INTERVAL_MS);

  for (const chunk of unsentChunks) {
    if (!client) break;
    const seqNo = nextSeqNo++;
    const now = Date.now();
    pendingChunks.set(seqNo, { chunk, sentAt: now });
    const pcmBytes = int16ToLittleEndian(chunk);
    client.sendAudio(pcmBytes);
  }
}

function enqueueAudio(samples: Int16Array) {
  if (samples.length === 0) return;
  audioBufferQueue.push(samples);
  queuedSamples += samples.length;

  if (!client || sessionStopped) return;

  while (queuedSamples >= CHUNK_SAMPLES) {
    const chunk = dequeueChunk();
    if (!chunk) break;
    const seqNo = nextSeqNo++;
    const now = Date.now();
    pendingChunks.set(seqNo, { chunk, sentAt: now });
    const pcmBytes = int16ToLittleEndian(chunk);
    client.sendAudio(pcmBytes);
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
