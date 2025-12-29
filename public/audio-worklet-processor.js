class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
  }

  process(inputs) {
    const input = inputs[0];
    if (input && input[0]) {
      const channelData = input[0]; // Float32Array mono
      const copy = new Float32Array(channelData.length);
      copy.set(channelData);
      this.port.postMessage(copy, [copy.buffer]);
    }
    return true; // keep processor alive
  }
}

registerProcessor('capture-processor', CaptureProcessor);
