# Buffered Real-Time Transcription Client

A browser-based transcription client that streams to Speechmatics real-time, reconnects with audio replay to prevent transcript gaps, and falls back to microbatch (batch API) if real-time keeps failing.

## Features

- **Real-time transcription** using Speechmatics WebSocket API
- **Automatic reconnection** on connection loss with audio replay
- **Sliding buffer** ensures no audio is lost during reconnects
- **Batch fallback** after repeated real-time failures, with no audio lost
- **Synchronous batch** using the `wait` parameter (one request per batch)
- **Mode indicator** and manual **Reconnect real-time** button
- **Test buttons** to simulate a dropped connection or a full outage
- **Audio recording** with WAV file download
- **Resampling** from browser sample rate to 16kHz PCM

## How It Works

### Audio Pipeline

1. Browser captures audio via `PCMRecorder` (Web Audio API)
2. Audio is resampled to 16kHz and converted to 16-bit PCM
3. Chunks are queued and sent to Speechmatics with sequence numbers
4. Server acknowledges received audio via `AudioAdded` messages

### Reconnection Logic

When a WebSocket disconnection is detected:

1. **Sliding buffer** (last n seconds of sent audio) is preserved (based on last AddTranscript message seen)
2. **Pending queue** (unsent audio) is saved
3. New session is established with fresh JWT
4. Sliding buffer is replayed first (covers audio that may have been acknowledged but not transcribed)
5. Queued audio is sent
6. Normal streaming resumes

### Batch Fallback

Each failed connection, ack timeout or failed reconnect counts as a failure. After `RT_MAX_FAILURES` (3) consecutive failures, real-time is shut down and the app switches to batch mode:

1. Audio the server never transcribed (sliding buffer + unsent queue) seeds the first batch, so there is no gap
2. Audio is collected in `VITE_BATCH_DURATION_S` (30s) batches and submitted as WAV to the batch API with diarization
3. Each batch is sent with `?wait=SYNC_WAIT_S`, so the server holds the request and returns the transcript in one call. If the job is still running, status polling continues with `?wait=POLL_WAIT_S`. Set `SYNC_WAIT_S = 0` to use plain submit-then-poll (required on-prem, where `wait` is not supported)
4. Batch and real-time results render into the same transcript

Failures are only forgiven after a session has stayed up 30s, so a flapping connection still ends in fallback. Batch mode lasts until you click **Reconnect real-time** (which submits any buffered audio, resets the failure count and starts a new real-time session) or start a new recording.

The top bar shows the current mode (Real-time, Batch fallback or Idle) and the model in use.

### Testing the Fallback

While in real-time mode, two buttons appear in the transport bar:

- **Simulate drop** closes the connection once. It should reconnect and replay audio.
- **Simulate outage** closes the connection and fails every reconnect, so after 3 failures it falls back to batch.

### Health Check

A periodic health check monitors for missing `AudioAdded` acknowledgments. If no ack is received for 3+ seconds, a reconnect is triggered.

## Configuration

| Constant | Default | Description |
|----------|---------|-------------|
| `TARGET_SAMPLE_RATE` | 16000 | Audio sample rate in Hz |
| `CHUNK_DURATION_MS` | 50 | Duration of each audio chunk |
| `ACK_TIMEOUT_MS` | 3000 | Timeout before triggering reconnect |
| `MAX_DELAY` | 1 | Transcription max delay setting |
| `RT_MAX_FAILURES` | 3 | Consecutive real-time failures before batch fallback |
| `RT_URL` / `RT_LANGUAGE` | `wss://neu.rt.speechmatics.com/v2` / `en` | Real-time endpoint and language |
| `VITE_BATCH_DURATION_S` (`.env`) | 30 | Seconds of audio per batch in fallback mode; restart `npm run dev` after changing |
| `SYNC_WAIT_S` | 30 | Server-side `wait` on batch submit (0 disables) |
| `POLL_WAIT_S` | 5 | Server-side `wait` on each status poll |

## Setup

1. Copy `example.env` to `.env` and configure your Speechmatics API key
2. Install dependencies:
   ```bash
   npm install
   ```
3. Start the server (serves the real-time JWT and proxies the batch API):
   ```bash
   npm run server
   ```
4. Start the development server:
   ```bash
   npm run dev
   ```

## Usage

1. Click the record button to start; it connects to real-time first
2. Watch the mode badge: Real-time, or Batch fallback if real-time failed
3. Click **Reconnect real-time** (shown only in fallback) to try real-time again
4. Click the record button again to stop
5. Click the download button to save the recorded audio as WAV

The real-time URL, language and failure limit are constants at the top of `src/main.ts`.

## Dependencies

- `@speechmatics/real-time-client` - WebSocket client for Speechmatics API
- `@speechmatics/auth` - JWT creation for real-time (server side)
- `@speechmatics/browser-audio-input` - Browser audio capture with PCM output
- Vite - Development server and bundler

## Code Layout

- `src/main.ts` - UI, mic capture, mode switching, batch submission and rendering
- `src/rt.ts` - `RtSession`: real-time connection, replay, failure counting
- `src/audio-utils.ts` - resampling, WAV creation, queue and sliding-buffer helpers
- `server.mjs` - `/speechmatics-jwt` endpoint and `/api/jobs` batch proxy

## Architecture

```
┌─────────────────┐     ┌──────────────┐     ┌─────────────────┐
│  PCMRecorder    │────>│ Audio Queue  │────>│ WebSocket Send  │
│  (Browser Mic)  │     │ + Resampling │     │ + Seq Numbers   │
└─────────────────┘     └──────────────┘     └────────┬────────┘
                                                      │
                        ┌──────────────┐              │
                        │ Sliding      │<─────────────┘
                        │ Buffer       │
                        │ (variable)   │
                        └──────┬───────┘
                               │
                               v (on reconnect)
                        ┌──────────────┐
                        │ Replay to    │
                        │ New Session  │
                        └──────────────┘
```

On `RT_MAX_FAILURES` consecutive failures, the unsent audio is handed to the batch path:

```
Real-time session --(3 failures)--> unsent audio --> Batch (30s WAV, wait=30) --> same transcript
```
