// Verify: is the vertical scrollbar gone (no forced overflow-y: scroll)?
const DEBUG_PORT = 9223;

async function main() {
  let targets;
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`);
      targets = await res.json();
      if (targets.length) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  const page = targets?.find((t) => t.type === 'page' && !/devtools/i.test(t.url));
  if (!page) throw new Error('no page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  const send = (m, p) => new Promise((res) => { const k = ++id; pending.set(k, res); ws.send(JSON.stringify({ id: k, method: m, params: p })); });

  const expr = `(() => {
    const doc = document.documentElement;
    const cs = getComputedStyle(doc);
    return JSON.stringify({
      overflowY: cs.overflowY,
      scrollbarGutter: cs.scrollbarGutter,
      hasVerticalScrollbar: doc.scrollHeight > doc.clientHeight,
      gutterReserved: window.innerWidth - doc.clientWidth,
      titlebarVisible: !!document.getElementById('zhixue-desktop-titlebar'),
      brandLeft: (() => { const b = document.querySelector('.zhixue-titlebar-brand'); return b ? getComputedStyle(b).paddingLeft : null; })(),
      logoImg: !!document.querySelector('.zhixue-titlebar-logo'),
    });
  })()`;
  const resp = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  console.log(resp.result?.result?.value || JSON.stringify(resp));
  ws.close();
  process.exit(0);
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
