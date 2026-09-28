/** Console adapter: prints a one-line summary. Handy while tuning sensitivity. */
export default {
  name: 'console',

  isEnabled() {
    return true;
  },

  describe() {
    return 'stdout';
  },

  async send(event) {
    const score = typeof event.score === 'number' ? ` score=${(event.score * 100).toFixed(1)}%` : '';
    const size = event.media ? ` ${(event.media.buffer.length / 1024).toFixed(0)}KB ${event.media.mime}` : '';
    console.log(`[event] ${event.at} ${event.kind} device=${event.device}${score}${size}`);
    return { printed: true };
  },
};
