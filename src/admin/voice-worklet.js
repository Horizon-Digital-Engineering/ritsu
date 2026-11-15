// Frames go out in ~50 ms batches: a message per 128-sample quantum floods the main thread.
class RitsuCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const batch = Number(options?.processorOptions?.batch);
    this.size = batch >= 128 ? Math.floor(batch) : 2048;
    this.buf = new Float32Array(this.size);
    this.at = 0;
    this.live = true;
    this.port.onmessage = (e) => {
      if (e.data !== 'end' || !this.live) return;
      this.live = false;
      if (this.at > 0) {
        const rest = this.buf.slice(0, this.at);
        this.port.postMessage(rest, [rest.buffer]);
      }
      this.buf = new Float32Array(0);
      this.at = 0;
      this.port.postMessage('ended');
    };
  }

  process(inputs) {
    if (!this.live) return false;
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    let from = 0;
    while (from < channel.length) {
      const n = Math.min(channel.length - from, this.size - this.at);
      this.buf.set(channel.subarray(from, from + n), this.at);
      this.at += n;
      from += n;
      if (this.at === this.size) {
        const full = this.buf;
        this.port.postMessage(full, [full.buffer]);
        this.buf = new Float32Array(this.size);
        this.at = 0;
      }
    }
    return true;
  }
}

registerProcessor('ritsu-capture', RitsuCapture);
