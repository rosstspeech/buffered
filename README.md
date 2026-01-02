# Buffered Real-Time Transcription Client

A browser-based real-time transcription client with automatic reconnection and audio buffering to prevent transcript gaps.

## Features

- **Real-time transcription** using Speechmatics WebSocket API
- **Automatic reconnection** on connection loss with audio replay
- **Sliding buffer** (2 seconds) ensures no audio is lost during reconnects
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

### Health Check

A periodic health check monitors for missing `AudioAdded` acknowledgments. If no ack is received for 3+ seconds, a reconnect is triggered.

## Configuration

| Constant | Default | Description |
|----------|---------|-------------|
| `TARGET_SAMPLE_RATE` | 16000 | Audio sample rate in Hz |
| `CHUNK_DURATION_MS` | 50 | Duration of each audio chunk |
| `ACK_TIMEOUT_MS` | 3000 | Timeout before triggering reconnect |
| `MAX_DELAY` | 1 | Transcription max delay setting |
| `SLIDING_BUFFER_MS` | 2000 | Audio buffer for replay on reconnect |

## Setup

1. Copy `example.env` to `.env` and configure your Speechmatics API key
2. Install dependencies:
   ```bash
   npm install
   ```
3. Start the JWT server:
   ```bash
   npm run server
   ```
4. Start the development server:
   ```bash
   npm run dev
   ```

## Usage

1. Enter the real-time WebSocket URL
2. Select language (defaults to English)
3. Click **Start** to begin transcription
4. Click **Stop** to end the session
5. Click **Download** to save the recorded audio as WAV

## Dependencies

- `@speechmatics/real-time-client` - WebSocket client for Speechmatics API
- `@speechmatics/browser-audio-input` - Browser audio capture with PCM output
- Vite - Development server and bundler

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
