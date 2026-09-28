/**
 * Minimal Chrome DevTools Protocol client.
 *
 * Node 22 ships a global WebSocket, so driving a real browser needs no
 * dependencies: enough CDP to open a page, read its console and evaluate
 * expressions, which is what the end-to-end test needs.
 */

export async function connectCdp(port, { timeoutMs = 15000 } = {}) {
  const target = await waitForTarget(port, timeoutMs);
  const ws = new WebSocket(target.webSocketDebuggerUrl);

  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP websocket failed')), { once: true });
  });

  let nextId = 0;
  const pending = new Map();
  const listeners = new Map();

  ws.addEventListener('message', (msg) => {
    let data;
    try {
      data = JSON.parse(msg.data);
    } catch {
      return;
    }
    if (data.id !== undefined && pending.has(data.id)) {
      const { resolve, reject } = pending.get(data.id);
      pending.delete(data.id);
      data.error ? reject(new Error(`${data.error.message} (${data.error.code})`)) : resolve(data.result);
      return;
    }
    for (const cb of listeners.get(data.method) ?? []) cb(data.params);
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`CDP ${method} timed out`));
      }, timeoutMs);
    });

  const on = (method, cb) => {
    if (!listeners.has(method)) listeners.set(method, []);
    listeners.get(method).push(cb);
  };

  /** Evaluate an expression in the page and return its JSON value. */
  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
    }
    return res.result?.value;
  };

  return { send, on, evaluate, close: () => ws.close(), target };
}

async function waitForTarget(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no CDP page target on port ${port}: ${lastError?.message ?? 'timeout'}`);
}

/** Collect console output and uncaught exceptions into an array. */
export function collectConsole(cdp, sink) {
  cdp.on('Runtime.consoleAPICalled', (p) => {
    const text = (p.args ?? [])
      .map((a) => a.value ?? a.description ?? a.unserializableValue ?? a.type)
      .join(' ');
    sink.push({ level: p.type, text });
  });
  cdp.on('Runtime.exceptionThrown', (p) => {
    sink.push({
      level: 'exception',
      text: p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? 'unknown exception',
    });
  });
  cdp.on('Log.entryAdded', (p) => {
    sink.push({ level: p.entry.level, text: `${p.entry.source}: ${p.entry.text}` });
  });
}
