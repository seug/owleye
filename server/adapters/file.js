/**
 * File adapter: writes every event to disk as media + a .json sidecar,
 * under <dataDir>/events/YYYY-MM-DD/.
 *
 * This is the always-on fallback — it is what makes the tool useful with no
 * network, and it is the evidence trail.
 */
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

/**
 * Day folder and file stem for an event — also how the server predicts /media/
 * URLs. `event.at` is a canonical ISO string by the time it reaches here (the
 * server validates it), but the stem is scrubbed to safe characters anyway so
 * a stray separator can never escape the day directory.
 */
export function eventFileBase(event) {
  const safe = (value) => String(value ?? '').replace(/[^\w.-]+/g, '-');
  return `${safe(event.at.replace(/[:.]/g, '-'))}_${safe(event.device)}_${safe(event.id)}`;
}

/** Refuse a path that, once resolved, is not inside <eventsDir>. */
function assertInside(eventsDir, candidate) {
  const base = resolve(eventsDir);
  const full = resolve(candidate);
  if (full !== base && !full.startsWith(base + sep)) {
    throw new Error('refusing to write outside the session events directory');
  }
  return full;
}

export default {
  name: 'file',

  isEnabled() {
    return true;
  },

  describe(config) {
    return join(config.dataDir, 'events');
  },

  async init(config) {
    await mkdir(join(config.dataDir, 'events'), { recursive: true });
  },

  async send(event, config) {
    const eventsDir = join(config.dataDir, 'events');
    const day = event.at.slice(0, 10);
    const dir = assertInside(eventsDir, join(eventsDir, day));
    await mkdir(dir, { recursive: true });

    const base = eventFileBase(event);
    const paths = {};

    if (event.media) {
      const file = assertInside(eventsDir, join(dir, `${base}.${event.media.ext}`));
      await writeFile(file, event.media.buffer);
      paths.media = file;
    }

    const metaFile = assertInside(eventsDir, join(dir, `${base}.json`));
    await writeFile(metaFile, JSON.stringify({ ...event, media: undefined, mediaPath: paths.media }, null, 2));
    paths.meta = metaFile;

    await appendFile(
      join(config.dataDir, 'events.log'),
      `${event.at}\t${event.device}\t${event.kind}\tscore=${event.score ?? ''}\t${paths.media ?? ''}\n`,
    );

    return paths;
  },
};
