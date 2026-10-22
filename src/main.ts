import { PCMRecorder, type InputAudioEvent } from '@speechmatics/browser-audio-input';
import PCMAudioWorkletUrl from '@speechmatics/browser-audio-input/pcm-audio-worklet.min.js?url';
import { resampleTo16k, createWavFile } from './audio-utils';
import { RtSession } from './rt';

const TARGET_SAMPLE_RATE = 16000;
const BATCH_DURATION_S = Number(import.meta.env.VITE_BATCH_DURATION_S) || 30;
const BATCH_SAMPLES = TARGET_SAMPLE_RATE * BATCH_DURATION_S;
const POLL_INTERVAL_MS = 2000;
const MAX_POLL_ATTEMPTS = 20;
// Server-side `wait` (seconds) on job submit; 0 disables it and falls back to polling
const SYNC_WAIT_S: number = 30;
// Server-side `wait` (seconds) on each status poll after a sync submit times out
const POLL_WAIT_S = 5;

const RT_URL = 'wss://neu.rt.speechmatics.com/v2';
const RT_LANGUAGE = 'en';
// Consecutive real-time failures before we fall back to batch for the rest of the session
const RT_MAX_FAILURES = 3;

const recBtn = document.getElementById('rec-btn') as HTMLButtonElement;
const downloadBtn = document.getElementById('download') as HTMLButtonElement;
const transcriptEl = document.getElementById('transcript') as HTMLElement;
const processingLogEl = document.getElementById('processing-log') as HTMLElement;
const transcriptScrollEl = document.getElementById('transcript-scroll') as HTMLElement;
const procScrollEl = document.getElementById('proc-scroll') as HTMLElement;
const batchTimerEl = document.getElementById('batch-timer') as HTMLElement;
const statusDot = document.getElementById('status-dot') as HTMLElement;
const statusText = document.getElementById('status-text') as HTMLElement;
const modeBadge = document.getElementById('mode-badge') as HTMLElement;
const modeModelBadge = document.getElementById('model-badge') as HTMLElement;
const reconnectBtn = document.getElementById('reconnect-btn') as HTMLButtonElement;
const dropBtn = document.getElementById('drop-btn') as HTMLButtonElement;
const outageBtn = document.getElementById('outage-btn') as HTMLButtonElement;

let audioContext: AudioContext | null = null;
let pcmRecorder: PCMRecorder | null = null;
let isRunning = false;
let accumulatedSamples: Int16Array[] = [];
let totalSamples = 0;
let recordedAudio: Int16Array[] = [];
let batchCount = 0;
let batchStartTime = 0;
let timerIntervalId: number | null = null;
let mode: 'rt' | 'batch' = 'rt';
let rt: RtSession | null = null;

// Collated transcript state — track speaker across batches
let lastSpeaker = '';
let lastParaEl: HTMLParagraphElement | null = null;

function scrollTranscript() {
  transcriptScrollEl.scrollTop = transcriptScrollEl.scrollHeight;
}

function scrollProcessing() {
  procScrollEl.scrollTop = procScrollEl.scrollHeight;
}

function appendSystemMessage(text: string) {
  const el = document.createElement('div');
  el.className = 'proc-system';
  el.textContent = text;
  processingLogEl.appendChild(el);
  scrollProcessing();
}

interface BatchCard {
  card: HTMLElement;
  statusTextEl: HTMLSpanElement;
  timeEl: HTMLElement;
  jobEl: HTMLElement;
}

function createBatchCard(index: number, durationS: string): BatchCard {
  const card = document.createElement('div');
  card.className = 'proc-card';

  const header = document.createElement('div');
  header.className = 'proc-card__header';

  const batchLabel = document.createElement('span');
  batchLabel.className = 'proc-card__batch';
  batchLabel.textContent = `Batch ${index} · ${durationS}s`;

  const timeEl = document.createElement('span');
  timeEl.className = 'proc-card__time';

  header.appendChild(batchLabel);
  header.appendChild(timeEl);

  const jobEl = document.createElement('div');
  jobEl.className = 'proc-card__job';

  const statusRow = document.createElement('div');
  statusRow.className = 'proc-card__status';

  const dot = document.createElement('span');
  dot.className = 'proc-card__dot';

  const statusTextEl = document.createElement('span');
  statusTextEl.textContent = 'Submitting…';

  statusRow.appendChild(dot);
  statusRow.appendChild(statusTextEl);

  card.appendChild(header);
  card.appendChild(jobEl);
  card.appendChild(statusRow);

  processingLogEl.appendChild(card);
  scrollProcessing();

  return { card, statusTextEl, timeEl, jobEl };
}

function renderMode() {
  const active = isRunning;
  const m = active ? mode : 'idle';
  modeBadge.dataset.mode = m;
  modeBadge.textContent = m === 'rt' ? 'Real-time' : m === 'batch' ? `Batch fallback · ${BATCH_DURATION_S}s` : 'Idle';
  modeModelBadge.textContent = mode === 'rt' ? `enhanced · ${RT_LANGUAGE}` : 'oak-1 · multi';
  if (active) statusText.textContent = mode === 'rt' ? 'LIVE' : 'BATCH FALLBACK';
  reconnectBtn.classList.toggle('transport__text--visible', active && mode === 'batch');
  for (const btn of [dropBtn, outageBtn]) btn.classList.toggle('transport__text--visible', active && mode === 'rt');
}

function setRecordingState(recording: boolean) {
  if (recording) {
    recBtn.classList.add('transport__rec--live');
    recBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>`;
    statusDot.style.background = '#c5361f';
  } else {
    recBtn.classList.remove('transport__rec--live');
    recBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="8"/></svg>`;
    batchTimerEl.textContent = 'Ready to transcribe';
    statusDot.style.background = '';
    statusText.textContent = 'IDLE';
  }
  renderMode();
}

function updateTimer() {
  if (!isRunning) return;
  if (mode === 'rt') {
    batchTimerEl.textContent = 'Real-time';
    return;
  }
  const elapsed = (Date.now() - batchStartTime) / 1000;
  const remaining = Math.max(0, BATCH_DURATION_S - elapsed);
  batchTimerEl.textContent = `Next batch in ${Math.ceil(remaining)}s`;
}

function collectAndResetBuffer(): Int16Array {
  const combined = new Int16Array(totalSamples);
  let offset = 0;
  for (const chunk of accumulatedSamples) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  accumulatedSamples = [];
  totalSamples = 0;
  batchStartTime = Date.now();
  return combined;
}

async function submitBatch(samples: Int16Array, index: number): Promise<void> {
  const submitStart = Date.now();
  const durationS = (samples.length / TARGET_SAMPLE_RATE).toFixed(1);
  const { card, statusTextEl, timeEl, jobEl } = createBatchCard(index, durationS);

  const setStatus = (text: string) => { statusTextEl.textContent = text; scrollProcessing(); };
  const setTime = (ms: number) => { timeEl.textContent = `${(ms / 1000).toFixed(1)}s`; };

  try {
    const formData = new FormData();
    formData.append('data_file', new Blob([createWavFile(samples, TARGET_SAMPLE_RATE)], { type: 'audio/wav' }), `batch-${index}.wav`);
    formData.append('config', JSON.stringify({
      type: 'transcription',
      transcription_config: { language: 'multi', model: 'oak-1', diarization: 'speaker' },
    }));

    // wait=N asks the server to hold the request until the job is done (SaaS only), so a short
    // batch comes back in one round trip. SYNC_WAIT_S = 0 gives the classic submit-then-poll flow.
    setStatus(SYNC_WAIT_S > 0 ? 'Transcribing…' : 'Submitting…');
    const submitUrl = SYNC_WAIT_S > 0 ? `/api/jobs?wait=${SYNC_WAIT_S}&format=json-v2` : '/api/jobs';
    const submitRes = await fetch(submitUrl, { method: 'POST', body: formData });
    if (!submitRes.ok) {
      setStatus(`Submit failed: ${submitRes.status}`);
      setTime(Date.now() - submitStart);
      card.classList.add('proc-card--error');
      return;
    }
    const submitted = await submitRes.json() as { id: string; status?: string; 'json-v2'?: { results?: any[] } };
    const jobId = submitted.id;
    jobEl.textContent = jobId;

    const finish = (results: any[]) => {
      setTime(Date.now() - submitStart);
      const hadSpeech = renderResults(results);
      setStatus(hadSpeech ? 'Transcribed' : 'No speech detected');
      card.classList.add('proc-card--done');
    };
    const reject = (errors?: unknown) => {
      setTime(Date.now() - submitStart);
      setStatus(errors ? `Rejected: ${JSON.stringify(errors)}` : 'Rejected');
      card.classList.add('proc-card--error');
    };
    const fetchTranscript = async () => {
      const txRes = await fetch(`/api/jobs/${jobId}/transcript?format=json-v2`);
      return ((await txRes.json()) as any)?.results ?? [];
    };

    if (submitted.status === 'done') {
      finish(submitted['json-v2']?.results ?? await fetchTranscript());
      return;
    }
    if (submitted.status === 'rejected' || submitted.status === 'deleted') { reject(); return; }
    setStatus(SYNC_WAIT_S > 0 ? 'Still processing…' : 'Queued');

    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
      // With wait the server holds each status request, so no client-side delay is needed
      if (SYNC_WAIT_S === 0) await delay(POLL_INTERVAL_MS);
      const statusRes = await fetch(`/api/jobs/${jobId}?wait=${SYNC_WAIT_S > 0 ? POLL_WAIT_S : 0}`);
      const statusData = await statusRes.json() as { job?: { status: string; errors?: unknown[] } };
      const jobStatus = statusData.job?.status;

      if (jobStatus === 'running') setStatus('Processing…');
      if (jobStatus === 'done') { finish(await fetchTranscript()); return; }
      if (jobStatus === 'rejected') { reject(statusData.job?.errors); return; }
    }
    setTime(Date.now() - submitStart);
    setStatus('Timed out');
    card.classList.add('proc-card--error');
  } catch (err: unknown) {
    setTime(Date.now() - submitStart);
    setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
    card.classList.add('proc-card--error');
  }
}

function renderResults(results: any[]): boolean {
  if (results.length === 0) return false;

  let segmentSpeaker = '';
  let segmentText = '';
  let hadContent = false;

  function flushSegment() {
    const text = segmentText.trim();
    if (!text) return;
    hadContent = true;

    if (segmentSpeaker === lastSpeaker && lastParaEl) {
      // Same speaker continuing across batches — append to existing paragraph
      const span = lastParaEl.querySelector('.batch-text') as HTMLSpanElement | null;
      if (span) span.textContent += ' ' + text;
    } else {
      lastSpeaker = segmentSpeaker;
      lastParaEl = document.createElement('p');
      lastParaEl.className = 'batch-line';

      if (segmentSpeaker) {
        const speakerEl = document.createElement('strong');
        speakerEl.className = 'speaker-label';
        speakerEl.textContent = formatSpeaker(segmentSpeaker);
        lastParaEl.appendChild(speakerEl);
      }

      const span = document.createElement('span');
      span.className = 'batch-text';
      span.textContent = text;
      lastParaEl.appendChild(span);
      transcriptEl.appendChild(lastParaEl);
    }
    segmentText = '';
  }

  for (const result of results) {
    const alt = result.alternatives?.[0];
    if (!alt?.content) continue;
    const content: string = alt.content;
    const speaker: string = alt.speaker ?? '';

    if (result.type === 'punctuation') {
      segmentText += content;
    } else if (speaker && speaker !== segmentSpeaker) {
      flushSegment();
      segmentSpeaker = speaker;
      segmentText = content;
    } else {
      segmentText += ' ' + content;
    }
  }
  flushSegment();

  if (hadContent) scrollTranscript();
  return hadContent;
}

function formatSpeaker(s: string): string {
  const m = s.match(/^S(\d+)$/);
  return m ? `Speaker ${m[1]}` : s;
}

function delay(ms: number) {
  return new Promise<void>(resolve => setTimeout(resolve, ms));
}

async function start() {
  isRunning = true;
  mode = 'rt';
  batchCount = 0;
  accumulatedSamples = [];
  totalSamples = 0;
  recordedAudio = [];
  lastSpeaker = '';
  lastParaEl = null;
  transcriptEl.innerHTML = '';
  processingLogEl.innerHTML = '';
  downloadBtn.disabled = true;
  setRecordingState(true);

  audioContext = new AudioContext();
  pcmRecorder = new PCMRecorder(PCMAudioWorkletUrl);
  batchStartTime = Date.now();
  timerIntervalId = window.setInterval(updateTimer, 500);

  pcmRecorder.addEventListener('audio', (event: InputAudioEvent) => {
    if (!isRunning || !audioContext) return;
    const resampled = resampleTo16k(event.data, audioContext.sampleRate, TARGET_SAMPLE_RATE);
    recordedAudio.push(resampled);

    if (mode === 'rt') {
      rt?.pushAudio(resampled);
      return;
    }
    accumulatedSamples.push(resampled);
    totalSamples += resampled.length;

    if (totalSamples >= BATCH_SAMPLES) {
      void submitBatch(collectAndResetBuffer(), ++batchCount);
    }
  });

  appendSystemMessage('Recording started — connecting to real-time…');
  startRt();
  await pcmRecorder.startRecording({ audioContext });
}

function startRt() {
  mode = 'rt';
  rt = new RtSession({
    url: RT_URL,
    language: RT_LANGUAGE,
    maxFailures: RT_MAX_FAILURES,
    onResults: results => { if (renderResults(results)) scrollTranscript(); },
    onStatus: appendSystemMessage,
    onFallback: fallBackToBatch,
  });
  renderMode();
  void rt.start();
}

function reconnectRealtime() {
  if (!isRunning || mode !== 'batch') return;
  // Hand audio already buffered for the next batch to the batch API so it isn't dropped
  if (totalSamples > 0) void submitBatch(collectAndResetBuffer(), ++batchCount);
  appendSystemMessage('Reconnecting to real-time…');
  startRt();
}

function fallBackToBatch(unsent: Int16Array) {
  rt = null;
  if (!isRunning) return;
  mode = 'batch';
  accumulatedSamples = unsent.length ? [unsent] : [];
  totalSamples = unsent.length;
  batchStartTime = Date.now();
  renderMode();
  appendSystemMessage(`Real-time failed ${RT_MAX_FAILURES} times — falling back to batch, submitting every ${BATCH_DURATION_S}s`);
}

function stop() {
  isRunning = false;
  rt?.stop();
  rt = null;
  if (timerIntervalId !== null) { clearInterval(timerIntervalId); timerIntervalId = null; }

  pcmRecorder?.stopRecording();
  audioContext?.close();
  pcmRecorder = null;
  audioContext = null;

  if (totalSamples > 0) {
    void submitBatch(collectAndResetBuffer(), ++batchCount);
  }

  setRecordingState(false);
  downloadBtn.disabled = recordedAudio.length === 0;
  appendSystemMessage('Recording stopped');
}

function download() {
  if (recordedAudio.length === 0) { alert('No audio recorded'); return; }
  const total = recordedAudio.reduce((s, a) => s + a.length, 0);
  const combined = new Int16Array(total);
  let offset = 0;
  for (const chunk of recordedAudio) { combined.set(chunk, offset); offset += chunk.length; }
  const blob = new Blob([createWavFile(combined, TARGET_SAMPLE_RATE)], { type: 'audio/wav' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `recording-${new Date().toISOString().replace(/[:.]/g, '-')}.wav`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

reconnectBtn.addEventListener('click', reconnectRealtime);
dropBtn.addEventListener('click', () => rt?.simulateDrop(false));
outageBtn.addEventListener('click', () => rt?.simulateDrop(true));
recBtn.addEventListener('click', () => { isRunning ? stop() : void start(); });
downloadBtn.addEventListener('click', download);
