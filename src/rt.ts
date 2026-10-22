import { RealtimeClient } from '@speechmatics/real-time-client';
import {
  int16ToLittleEndian,
  dequeueChunk as dequeueChunkPure,
  trimSlidingBuffer as trimSlidingBufferPure
} from './audio-utils';

const SAMPLE_RATE = 16000;
const CHUNK_SAMPLES = Math.round((SAMPLE_RATE * 50) / 1000);
const CHUNK_DURATION_S = 0.05;
const ACK_TIMEOUT_MS = 3000;
const HEALTH_CHECK_INTERVAL_MS = 1000;
const GET_SPEAKERS_INTERVAL_MS = 30000;
const MAX_DELAY = 1;
// A session must stay up this long before earlier failures are forgiven
const STABLE_AFTER_MS = 30000;
const MAX_BACKOFF_MS = 4000;

type Speaker = { label: string; speaker_identifiers: string[] };

export interface RtSessionOptions {
  url: string;
  language: string;
  /** Consecutive failures tolerated before giving up and calling onFallback */
  maxFailures: number;
  /** Finalised transcript results, in Speechmatics json-v2 shape */
  onResults(results: any[]): void;
  onStatus(message: string): void;
  /** RT has failed maxFailures times; `unsent` is audio the server never transcribed */
  onFallback(unsent: Int16Array): void;
}

function formatSpeakerLabel(speaker: string): string {
  const match = speaker.match(/^S(\d+)$/);
  return match ? `Speaker ${match[1]}` : speaker;
}

async function fetchJwt(): Promise<string> {
  const MAX_ATTEMPTS = 3;
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch('/speechmatics-jwt');
      if (!response.ok) throw new Error(`JWT request failed with status ${response.status}`);
      const data = (await response.json()) as { jwt?: string };
      if (!data.jwt) throw new Error('JWT response did not contain a jwt field');
      return data.jwt;
    } catch (err) {
      lastError = err;
      if (attempt < MAX_ATTEMPTS) await sleep(500 * attempt);
    }
  }
  throw lastError;
}

function sleep(ms: number) {
  return new Promise<void>(resolve => setTimeout(resolve, ms));
}

export class RtSession {
  private client: RealtimeClient | null = null;
  private generation = 0;
  private ready = false;
  private recovering = false;
  private stopped = false;
  private failures = 0;
  private simulateOutage = false;

  private audioBufferQueue: Int16Array[] = [];
  private queuedSamples = 0;
  private nextSeqNo = 1;
  private pendingChunks = new Map<number, number>(); // seq_no -> sentAt
  private slidingBuffer: { chunk: Int16Array; timestamp: number }[] = [];
  private lastTranscriptEndTime = 0;
  private currentAudioTimestamp = 0;
  private enrolledSpeakers: Speaker[] = [];

  private healthCheckId: number | null = null;
  private speakersPollId: number | null = null;
  private stableTimerId: number | null = null;

  constructor(private readonly opts: RtSessionOptions) {}

  /** Connects (retrying up to maxFailures). Audio pushed meanwhile is queued, not dropped. */
  async start(): Promise<void> {
    await this.establish();
  }

  pushAudio(samples: Int16Array) {
    if (this.stopped || samples.length === 0) return;
    this.audioBufferQueue.push(samples);
    this.queuedSamples += samples.length;
    if (this.ready) this.flushQueue();
  }

  /** Test hook: drop the live connection. With `outage`, reconnect attempts also fail until fallback. */
  simulateDrop(outage: boolean) {
    if (!this.ready) return;
    this.simulateOutage = outage;
    this.connectionLost(outage ? 'simulated outage' : 'simulated drop');
  }

  stop() {
    this.stopped = true;
    this.teardown();
  }

  private flushQueue() {
    while (this.client && this.queuedSamples >= CHUNK_SAMPLES) {
      const chunk = this.dequeueChunk();
      if (!chunk) break;
      this.sendChunk(chunk);
    }
  }

  private sendChunk(chunk: Int16Array) {
    if (!this.client) return;
    this.pendingChunks.set(this.nextSeqNo++, Date.now());
    this.client.sendAudio(int16ToLittleEndian(chunk));
    this.slidingBuffer.push({ chunk, timestamp: this.currentAudioTimestamp });
    this.currentAudioTimestamp += CHUNK_DURATION_S;
  }

  private dequeueChunk(): Int16Array | null {
    const result = dequeueChunkPure(this.audioBufferQueue, this.queuedSamples, CHUNK_SAMPLES);
    if (!result) return null;
    this.audioBufferQueue = result.remaining;
    this.queuedSamples = result.remainingSamples;
    return result.chunk;
  }

  private async establish() {
    if (this.recovering) return;
    this.recovering = true;
    try {
      while (!this.stopped) {
        try {
          await this.connect();
          return;
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          if (!this.registerFailure(`connect failed: ${reason}`)) return;
          await sleep(Math.min(500 * 2 ** (this.failures - 1), MAX_BACKOFF_MS));
        }
      }
    } finally {
      this.recovering = false;
    }
  }

  /** Counts a failure. Returns false (after triggering fallback) once the limit is hit. */
  private registerFailure(reason: string): boolean {
    this.failures++;
    this.opts.onStatus(`Real-time failure ${this.failures}/${this.opts.maxFailures}: ${reason}`);
    if (this.failures >= this.opts.maxFailures) {
      this.giveUp();
      return false;
    }
    return true;
  }

  private connectionLost(reason: string) {
    if (this.stopped || this.recovering) return;
    this.ready = false;
    this.clearTimers();
    this.stopClient();
    if (this.registerFailure(reason)) {
      this.opts.onStatus('Reconnecting…');
      void this.establish();
    }
  }

  private giveUp() {
    // Everything still in the sliding buffer was sent but never transcribed; the queue was never sent
    const parts = [...this.slidingBuffer.map(e => e.chunk), ...this.audioBufferQueue];
    const total = parts.reduce((n, p) => n + p.length, 0);
    const unsent = new Int16Array(total);
    let offset = 0;
    for (const p of parts) { unsent.set(p, offset); offset += p.length; }

    this.stopped = true;
    this.teardown();
    this.opts.onFallback(unsent);
  }

  private async connect() {
    const gen = ++this.generation;
    this.stopClient();

    if (this.simulateOutage) throw new Error('simulated outage');
    const jwt = await fetchJwt();
    const client = new RealtimeClient({ url: this.opts.url });
    client.addEventListener('receiveMessage', ({ data }: { data: any }) => {
      if (gen === this.generation) this.handleMessage(data);
    });
    client.addEventListener('socketStateChange', (e: any) => {
      if (gen !== this.generation || this.stopped) return;
      if (e.socketState === 'closed' || e.socketState === 'error') {
        this.connectionLost(`WebSocket ${e.socketState}`);
      }
    });
    this.client = client;

    try {
      await client.start(jwt, this.startConfig());
    } catch (err) {
      if (gen === this.generation) this.stopClient();
      throw err;
    }
    if (gen !== this.generation || this.stopped) return;

    // Server timeline restarts at 0, so replay what it never transcribed
    const replay = this.slidingBuffer.map(e => e.chunk);
    this.slidingBuffer = [];
    this.lastTranscriptEndTime = 0;
    this.currentAudioTimestamp = 0;
    this.pendingChunks.clear();
    this.nextSeqNo = 1;

    this.ready = true;
    for (const chunk of replay) this.sendChunk(chunk);
    this.flushQueue();

    this.startTimers();
    this.opts.onStatus(this.failures > 0 ? 'Real-time reconnected' : 'Real-time connected');
  }

  private startConfig() {
    return {
      audio_format: { type: 'raw', encoding: 'pcm_s16le', sample_rate: SAMPLE_RATE },
      transcription_config: {
        language: this.opts.language,
        operating_point: 'enhanced',
        enable_partials: true,
        max_delay: MAX_DELAY,
        diarization: 'speaker',
        speaker_diarization_config: {
          get_speakers: true,
          speaker_sensitivity: 0.5,
          ...(this.enrolledSpeakers.length > 0 ? { speakers: this.enrolledSpeakers } : {})
        }
      }
    } as any;
  }

  private handleMessage(data: any) {
    switch (data.message) {
      case 'AddTranscript': {
        if (Array.isArray(data.results) && data.results.length > 0) this.opts.onResults(data.results);
        const endTime = data.metadata?.end_time;
        if (typeof endTime === 'number' && endTime > this.lastTranscriptEndTime) {
          this.lastTranscriptEndTime = endTime;
          this.slidingBuffer = trimSlidingBufferPure(this.slidingBuffer, endTime);
        }
        break;
      }
      case 'AudioAdded':
        if (typeof data.seq_no === 'number') {
          for (let i = 1; i <= data.seq_no; i++) this.pendingChunks.delete(i);
        }
        break;
      case 'SpeakersResult':
        this.updateSpeakers(data.speakers);
        break;
      case 'Error':
        console.error('Server error:', data);
        break;
    }
  }

  private updateSpeakers(speakers: unknown) {
    if (!Array.isArray(speakers) || speakers.length === 0) return;
    this.enrolledSpeakers = (speakers as Speaker[]).map(s => ({ ...s, label: formatSpeakerLabel(s.label) }));
  }

  private startTimers() {
    this.clearTimers();
    this.healthCheckId = window.setInterval(() => {
      const now = Date.now();
      for (const sentAt of this.pendingChunks.values()) {
        if (now - sentAt > ACK_TIMEOUT_MS) {
          this.connectionLost('no AudioAdded ack for >3s');
          return;
        }
      }
    }, HEALTH_CHECK_INTERVAL_MS);

    this.speakersPollId = window.setInterval(async () => {
      if (!this.client || !this.ready) return;
      try {
        const result = await this.client.getSpeakers();
        this.updateSpeakers(result.speakers);
      } catch (e) {
        console.warn('GetSpeakers request failed:', e);
      }
    }, GET_SPEAKERS_INTERVAL_MS);

    this.stableTimerId = window.setTimeout(() => { this.failures = 0; }, STABLE_AFTER_MS);
  }

  private clearTimers() {
    if (this.healthCheckId !== null) clearInterval(this.healthCheckId);
    if (this.speakersPollId !== null) clearInterval(this.speakersPollId);
    if (this.stableTimerId !== null) clearTimeout(this.stableTimerId);
    this.healthCheckId = this.speakersPollId = this.stableTimerId = null;
  }

  private stopClient() {
    const client = this.client;
    this.client = null;
    if (!client) return;
    try {
      client.stopRecognition({ noTimeout: true } as any);
    } catch (e) {
      console.warn('Error stopping RT client', e);
    }
  }

  private teardown() {
    this.ready = false;
    this.generation++; // ignore any further events from the old client
    this.clearTimers();
    this.stopClient();
    this.audioBufferQueue = [];
    this.queuedSamples = 0;
    this.pendingChunks.clear();
    this.slidingBuffer = [];
  }
}
