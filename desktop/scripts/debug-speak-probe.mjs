/**
 * CDP probe: verify speechSynthesis voices + actual speaking state in the
 * Electron renderer (Windows SAPI). Usage: node debug-speak-probe.mjs
 */
const DEBUG_PORT = 9223;

const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools'));
if (!page) {
  console.error('No page target found');
  process.exit(1);
}
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
  const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (res.exceptionDetails) return { error: res.exceptionDetails.exception?.description || 'exception' };
  return res.result.value;
}

const voices = await evaluate(
  `window.speechSynthesis.getVoices().map(v => ({ name: v.name, lang: v.lang, localService: v.localService }))`,
);
console.log(`Voices: ${voices.length}`);
for (const v of voices.filter((v) => v.lang.startsWith('zh')).slice(0, 8)) {
  console.log(`  zh: ${v.name} (${v.lang}) local=${v.localService}`);
}

const speakTest = await evaluate(`(async () => {
  const u = new SpeechSynthesisUtterance('语音兜底测试');
  u.lang = 'zh-CN';
  u.volume = 0; // muted for the probe — verify lifecycle, not audibility
  const done = new Promise((resolve) => {
    u.onend = () => resolve('ended');
    u.onerror = (e) => resolve('error:' + e.error);
  });
  window.speechSynthesis.speak(u);
  await new Promise((r) => setTimeout(r, 600));
  const speaking = window.speechSynthesis.speaking;
  const result = { speakingEarly: speaking, final: await done };
  window.speechSynthesis.cancel();
  return result;
})()`);
console.log('Speak test:', JSON.stringify(speakTest));

ws.close();
process.exit(0);
