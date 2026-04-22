import { RealtimeClient } from '@speechmatics/real-time-client';
import {
  PCMRecorder,
  type InputAudioEvent
} from '@speechmatics/browser-audio-input';
import PCMAudioWorkletUrl from '@speechmatics/browser-audio-input/pcm-audio-worklet.min.js?url';
import {
  resampleTo16k,
  int16ToLittleEndian,
  createWavFile,
  dequeueChunk as dequeueChunkPure,
  trimSlidingBuffer as trimSlidingBufferPure
} from './audio-utils';

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
let currentSpeaker = '';
let isReconnecting = false;
let recordedAudio: Int16Array[] = [];

const TARGET_SAMPLE_RATE = 16000;
const CHUNK_DURATION_MS = 50;
const CHUNK_SAMPLES = Math.round((TARGET_SAMPLE_RATE * CHUNK_DURATION_MS) / 1000);
const ACK_TIMEOUT_MS = 3000;
const MAX_DELAY = 1;
const HEALTH_CHECK_INTERVAL_MS = 1000;
const CHUNK_DURATION_S = CHUNK_DURATION_MS / 1000;
const GET_SPEAKERS_INTERVAL_MS = 30000;

let audioBufferQueue: Int16Array[] = [];
let queuedSamples = 0;
let nextSeqNo = 1;
let pendingChunks: Map<number, { chunk: Int16Array; sentAt: number }> = new Map();
let healthCheckIntervalId: number | null = null;
let getSpeakersIntervalId: number | null = null;
let sessionStopped = true;
let savedQueuedSamples = 0;
let slidingBuffer: { chunk: Int16Array; timestamp: number }[] = [];
let lastTranscriptEndTime = 0;
let currentAudioTimestamp = 0;

let sessionGeneration = 0;
let enrolledSpeakers: { label: string; speaker_identifiers: string[] }[] = [];

function formatSpeakerLabel(speaker: string): string {
  const match = speaker.match(/^S(\d+)$/);
  return match ? `Speaker ${match[1]}` : speaker;
}

function appendStatus(message: string) {
  transcriptEl.textContent += `\n[status] ${message}`;
}

async function fetchJwt(): Promise<string> {
  const MAX_ATTEMPTS = 10;
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch('/speechmatics-jwt');
      if (!response.ok) {
        throw new Error(`JWT request failed with status ${response.status}`);
      }
      const data = (await response.json()) as { jwt?: string };
      if (!data.jwt) {
        throw new Error('JWT response did not contain a jwt field');
      }
      return data.jwt;
    } catch (err: any) {
      lastError = err;
      if (attempt < MAX_ATTEMPTS) {
        console.warn(`JWT fetch attempt ${attempt} failed, retrying…`, err);
        await new Promise(resolve => setTimeout(resolve, 500 * attempt));
      }
    }
  }
  throw lastError;
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
    currentSpeaker = '';
    enrolledSpeakers = [];
    transcriptEl.textContent = '';
    recordedAudio = [];
    downloadButton.disabled = true;

    client.addEventListener('receiveMessage', handleReceiveMessage);
    client.addEventListener('socketStateChange', createSocketStateHandler(url, language, sessionGeneration));

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
    startSpeakersPolling();

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
  stopSpeakersPolling();

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
      const alt = result.alternatives?.[0];
      const content = alt?.content;
      if (content) {
        const speaker: string = alt?.speaker ?? '';
        if (result.type === 'punctuation') {
          finalText = `${finalText}${content}`;
        } else {
          if (speaker && speaker !== currentSpeaker) {
            currentSpeaker = speaker;
            finalText = `${finalText}\n${formatSpeakerLabel(speaker)}: ${content}`;
          } else {
            finalText = `${finalText} ${content}`;
          }
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
    if (typeof ackSeqNo === 'number') {
      for (let i = 1; i <= ackSeqNo; i++) {
        pendingChunks.delete(i);
      }
    }
  } else if (data.message === 'SpeakersResult') {
    if (Array.isArray(data.speakers) && data.speakers.length > 0) {
      enrolledSpeakers = data.speakers.map((s: { label: string; speaker_identifiers: string[] }) => ({
        ...s,
        label: formatSpeakerLabel(s.label),
      }));
      console.log('SpeakersResult: enrolled speakers updated', enrolledSpeakers);
    }
  } else if (data.message === 'RecognitionStarted') {
    console.log('RecognitionStarted received');
  } else if (data.message === 'Error') {
    console.error('Server error:', data);
  }
}

function createSocketStateHandler(url: string, language: string, generation: number) {
  return (e: any) => {
    console.log('socket state:', e.socketState);
    if (generation !== sessionGeneration) return;
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
      max_delay: MAX_DELAY,
      diarization: 'speaker',
      speaker_diarization_config: {
        get_speakers: true,
        speaker_sensitivity: 0.5,
        ...(enrolledSpeakers.length > 0 ? { speakers: enrolledSpeakers } : {})
      }
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


async function reconnectSession(url: string, language: string) {
  if (isReconnecting) {
    console.log('Already reconnecting, skipping duplicate reconnect');
    return;
  }
  isReconnecting = true;
  sessionGeneration++;

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
  client.addEventListener('socketStateChange', createSocketStateHandler(url, language, sessionGeneration));

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
  startSpeakersPolling();
}

function startSpeakersPolling() {
  if (getSpeakersIntervalId !== null) clearInterval(getSpeakersIntervalId);
  getSpeakersIntervalId = window.setInterval(async () => {
    if (!client || sessionStopped || isReconnecting) return;
    try {
      const result = await client.getSpeakers();
      if (result.speakers.length > 0) {
        enrolledSpeakers = result.speakers.map((s: { label: string; speaker_identifiers: string[] }) => ({
          ...s,
          label: formatSpeakerLabel(s.label),
        }));
      }
    } catch (e) {
      console.warn('GetSpeakers request failed:', e);
    }
  }, GET_SPEAKERS_INTERVAL_MS);
}

function stopSpeakersPolling() {
  if (getSpeakersIntervalId !== null) {
    clearInterval(getSpeakersIntervalId);
    getSpeakersIntervalId = null;
  }
}

function addToSlidingBuffer(chunk: Int16Array) {
  slidingBuffer.push({ chunk, timestamp: currentAudioTimestamp });
  currentAudioTimestamp += CHUNK_DURATION_S;
}

function trimSlidingBuffer() {
  slidingBuffer = trimSlidingBufferPure(slidingBuffer, lastTranscriptEndTime);
}

function enqueueAudio(samples: Int16Array) {
  if (samples.length === 0) return;
  audioBufferQueue.push(samples);
  queuedSamples += samples.length;

  // if (!client || sessionStopped || isReconnecting) {
  //   console.log('enqueueAudio: skipping send', { hasClient: !!client, sessionStopped, isReconnecting, queuedSamples });
  //   return;
  // }

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
  const result = dequeueChunkPure(audioBufferQueue, queuedSamples, CHUNK_SAMPLES);
  if (!result) return null;
  audioBufferQueue = result.remaining;
  queuedSamples = result.remainingSamples;
  return result.chunk;
}


async function switchToLanguage(newLang: string, audioWindow: Int16Array) {
  const prevLang = languageInput.value.trim() || 'en';
  finalText += `\n[Language: ${prevLang} → ${newLang}]`;
  transcriptEl.textContent = finalText;
  appendStatus(`Language changed: ${prevLang} → ${newLang}, retranscribing buffer…`);
  languageInput.value = newLang;

  // Replace sliding buffer with the window audio so reconnect replays it
  slidingBuffer = [];
  lastTranscriptEndTime = 0;
  currentAudioTimestamp = 0;
  for (let i = 0; i < audioWindow.length; i += CHUNK_SAMPLES) {
    const chunk = audioWindow.slice(i, Math.min(i + CHUNK_SAMPLES, audioWindow.length));
    slidingBuffer.push({ chunk, timestamp: currentAudioTimestamp });
    currentAudioTimestamp += CHUNK_DURATION_S;
  }

  await reconnectSession(urlInput.value.trim(), newLang);
}

