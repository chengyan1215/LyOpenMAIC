/**
 * CDP probe: inspect the persisted TTS settings + course audio state.
 * Usage: node debug-settings-probe.mjs
 */
const DEBUG_PORT = 9223;

const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools'));
if (!page) {
  console.error('No page target found:', targets.map((t) => `${t.type}:${t.url}`));
  process.exit(1);
}
console.log('Page:', page.url);

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
}
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  }
};
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});

await send('Runtime.enable');

async function evaluate(expression) {
  const res = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (res.exceptionDetails) {
    return { error: res.exceptionDetails.exception?.description || 'exception' };
  }
  return res.result.value;
}

// Wait for the app shell to be ready
for (let i = 0; i < 30; i++) {
  const ready = await evaluate(`!!document.querySelector('body') && !!window.localStorage`);
  if (ready === true) break;
  await new Promise((r) => setTimeout(r, 1000));
}

const result = await evaluate(`(() => {
  const raw = localStorage.getItem('maic:account:settings-storage') ?? localStorage.getItem('settings-storage');
  if (!raw) return { noStore: true, keys: Object.keys(localStorage).slice(0, 30) };
  const parsed = JSON.parse(raw);
  const s = parsed.state || {};
  return {
    version: parsed.version,
    ttsEnabled: s.ttsEnabled,
    ttsProviderId: s.ttsProviderId,
    ttsVoice: s.ttsVoice,
    ttsSpeed: s.ttsSpeed,
    ttsMuted: s.ttsMuted,
    ttsVolume: s.ttsVolume,
    ttsProviderConfigKeys: Object.keys(s.ttsProvidersConfig || {}),
    browserNativeCfg: s.ttsProvidersConfig?.['browser-native-tts'],
    speechSynthesis: typeof window.speechSynthesis !== 'undefined',
  };
})()`);
console.log(JSON.stringify(result, null, 2));

ws.close();
process.exit(0);
