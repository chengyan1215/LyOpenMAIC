'use strict';

const http = require('node:http');
const net = require('node:net');
const upstream = new URL(process.env.SETTINGS_TEST_UPSTREAM);
if (Number(upstream.port) === Number(process.env.PORT))
  throw new Error('Test proxy cannot target its own port');
const server = http.createServer((request, response) => {
  const target = http.request(
    {
      hostname: upstream.hostname,
      port: upstream.port,
      path: request.url,
      method: request.method,
      headers: { ...request.headers, host: upstream.host },
    },
    (source) => {
      response.writeHead(source.statusCode, source.headers);
      source.pipe(response);
    },
  );
  target.on('error', () => {
    response.writeHead(502);
    response.end();
  });
  request.pipe(target);
});
server.on('upgrade', (request, socket, head) => {
  const target = net.connect(Number(upstream.port), upstream.hostname, () => {
    const headers = { ...request.headers, host: upstream.host };
    target.write(
      `${request.method} ${request.url} HTTP/${request.httpVersion}\r\n${Object.entries(headers)
        .map(([key, value]) => `${key}: ${value}`)
        .join('\r\n')}\r\n\r\n`,
    );
    if (head.length) target.write(head);
    socket.pipe(target).pipe(socket);
  });
  target.on('error', () => socket.destroy());
  socket.on('error', () => target.destroy());
});
server.listen(Number(process.env.PORT), '127.0.0.1');
