/**
 * Per-session storage accounting and cleanup.
 *
 * Every session gets a byte budget and a retention window. An event on disk is
 * a media file plus its `.json` sidecar sharing one stem, under
 * <sessionDir>/events/<day>/. This module measures usage, evicts the oldest
 * events to stay under the budget, and drops events past the retention window.
 *
 * Symbolic links are never followed while walking a session: only regular
 * files and real directories are counted or deleted, so a link planted in a
 * session cannot make owleye read or delete something elsewhere.
 */
import { readdir, lstat, unlink, rmdir } from 'node:fs/promises';
import { join } from 'node:path';

/** One event = the files sharing a stem in a day directory. */
async function collectEvents(eventsDir) {
  const events = [];
  let dayEntries;
  try {
    dayEntries = await readdir(eventsDir, { withFileTypes: true });
  } catch {
    return events; // no events dir yet
  }

  for (const dayEntry of dayEntries) {
    if (dayEntry.isSymbolicLink() || !dayEntry.isDirectory()) continue;
    const dayDir = join(eventsDir, dayEntry.name);
    let fileEntries;
    try {
      fileEntries = await readdir(dayDir, { withFileTypes: true });
    } catch {
      continue;
    }

    const byStem = new Map();
    for (const fileEntry of fileEntries) {
      if (fileEntry.isSymbolicLink() || !fileEntry.isFile()) continue;
      const full = join(dayDir, fileEntry.name);
      let info;
      try {
        info = await lstat(full);
      } catch {
        continue;
      }
      if (!info.isFile()) continue; // guard against a race
      const stem = fileEntry.name.replace(/\.[^.]+$/, '');
      const group = byStem.get(stem) ?? { stem, day: dayEntry.name, dayDir, files: [], bytes: 0, mtimeMs: 0 };
      group.files.push(full);
      group.bytes += info.size;
      group.mtimeMs = Math.max(group.mtimeMs, info.mtimeMs);
      byStem.set(stem, group);
    }
    for (const group of byStem.values()) events.push(group);
  }

  events.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
  return events;
}

async function deleteEvent(event, log) {
  for (const file of event.files) {
    try {
      await unlink(file);
    } catch (err) {
      log?.error?.(`[storage] could not delete ${file}: ${err.message}`);
    }
  }
}

/** Remove day directories left empty after deletions. */
async function removeEmptyDayDirs(eventsDir) {
  let dayEntries;
  try {
    dayEntries = await readdir(eventsDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const dayEntry of dayEntries) {
    if (dayEntry.isSymbolicLink() || !dayEntry.isDirectory()) continue;
    const dayDir = join(eventsDir, dayEntry.name);
    try {
      const rest = await readdir(dayDir);
      if (rest.length === 0) await rmdir(dayDir);
    } catch {
      /* not empty or gone */
    }
  }
}

/** Sum of all event bytes currently on disk for a session. */
export async function sessionUsageBytes(eventsDir) {
  const events = await collectEvents(eventsDir);
  return events.reduce((sum, e) => sum + e.bytes, 0);
}

/**
 * Delete events, oldest first, until `used + incoming <= maxBytes`.
 * Returns whether an event of `incoming` bytes now fits.
 *
 * @returns {Promise<{ fits: boolean, used: number, freed: number, deleted: number }>}
 */
export async function evictToFit(eventsDir, maxBytes, incoming, log) {
  const events = await collectEvents(eventsDir);
  let used = events.reduce((sum, e) => sum + e.bytes, 0);
  let freed = 0;
  let deleted = 0;

  for (const event of events) {
    if (used + incoming <= maxBytes) break;
    await deleteEvent(event, log);
    used -= event.bytes;
    freed += event.bytes;
    deleted++;
  }
  if (deleted) await removeEmptyDayDirs(eventsDir);
  return { fits: used + incoming <= maxBytes, used, freed, deleted };
}

/** Delete events whose newest file is older than the retention window. */
export async function pruneExpired(eventsDir, retentionMs, now = Date.now(), log) {
  if (!retentionMs) return { deleted: 0 };
  const events = await collectEvents(eventsDir);
  const cutoff = now - retentionMs;
  let deleted = 0;
  for (const event of events) {
    if (event.mtimeMs < cutoff) {
      await deleteEvent(event, log);
      deleted++;
    }
  }
  if (deleted) await removeEmptyDayDirs(eventsDir);
  return { deleted };
}

/** Enforce both limits for one session: retention first, then the size budget. */
export async function pruneSession(eventsDir, { maxBytes, retentionMs }, now = Date.now(), log) {
  await pruneExpired(eventsDir, retentionMs, now, log);
  if (maxBytes) await evictToFit(eventsDir, maxBytes, 0, log);
}
