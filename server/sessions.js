/**
 * Sessions: each one is an isolated owleye — its own feed, clips, push
 * subscriptions and ntfy topic. The session id is also the key that opens it,
 * so it is long and random. The master token (OWLEYE_TOKEN) opens the
 * `default` session, which keeps the data layout of a single-user install.
 *
 * Stored in <dataDir>/sessions.json. Per-session files live under
 * <dataDir>/sessions/<id>/ (the default session stays at <dataDir>/).
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

export const DEFAULT_SESSION = 'default';
const TOUCH_INTERVAL_MS = 60_000;

function blank(id) {
  return { id, label: '', lang: '', createdAt: new Date().toISOString(), lastSeenAt: null, ntfy: { url: '', topic: '', token: '' } };
}

export async function openSessionStore(dataDir) {
  await mkdir(dataDir, { recursive: true });
  const file = join(dataDir, 'sessions.json');

  let sessions = new Map();
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    for (const s of Array.isArray(parsed) ? parsed : []) {
      if (s && typeof s.id === 'string') sessions.set(s.id, { ...blank(s.id), ...s, ntfy: { ...blank(s.id).ntfy, ...(s.ntfy ?? {}) } });
    }
  } catch {
    /* first run */
  }
  if (!sessions.has(DEFAULT_SESSION)) sessions.set(DEFAULT_SESSION, blank(DEFAULT_SESSION));

  let writing = Promise.resolve();
  function persist() {
    writing = writing
      .then(async () => {
        const tmp = `${file}.tmp`;
        await writeFile(tmp, JSON.stringify([...sessions.values()], null, 2), { mode: 0o600 });
        await rename(tmp, file);
      })
      .catch(() => {});
    return writing;
  }

  return {
    file,

    /** Everything but `default`, which is implicit. */
    count() {
      return sessions.size - 1;
    },

    get(id) {
      return sessions.get(id) ?? null;
    },

    /** All non-default sessions, as plain snapshots. */
    list() {
      return [...sessions.values()].filter((s) => s.id !== DEFAULT_SESSION);
    },

    /** Forget a session. The default session cannot be removed. */
    async remove(id) {
      if (id === DEFAULT_SESSION) return false;
      const existed = sessions.delete(id);
      if (existed) await persist();
      return existed;
    },

    async create({ label = '' } = {}) {
      const id = randomBytes(16).toString('hex');
      const session = { ...blank(id), label: String(label).trim().slice(0, 60) };
      sessions.set(id, session);
      await persist();
      return session;
    },

    /** Patch label / ntfy; missing fields are left alone, empty strings clear them. */
    async update(id, patch = {}) {
      const session = sessions.get(id);
      if (!session) return null;
      if (typeof patch.label === 'string') session.label = patch.label.trim().slice(0, 60);
      if (typeof patch.lang === 'string') session.lang = patch.lang.slice(0, 5);
      if (patch.ntfy && typeof patch.ntfy === 'object') {
        for (const field of ['url', 'topic', 'token']) {
          if (typeof patch.ntfy[field] === 'string') session.ntfy[field] = patch.ntfy[field].trim().slice(0, 200);
        }
        session.ntfy.url = session.ntfy.url.replace(/\/+$/, '');
      }
      await persist();
      return session;
    },

    /** Note activity; persisted at most once a minute per session. */
    touch(id) {
      const session = sessions.get(id);
      if (!session) return;
      const now = Date.now();
      if (session.lastSeenAt && now - Date.parse(session.lastSeenAt) < TOUCH_INTERVAL_MS) return;
      session.lastSeenAt = new Date(now).toISOString();
      persist();
    },
  };
}

/** Where a session's files live. The default session keeps the classic layout. */
export function sessionDir(dataDir, id) {
  return id === DEFAULT_SESSION ? dataDir : join(dataDir, 'sessions', id);
}
