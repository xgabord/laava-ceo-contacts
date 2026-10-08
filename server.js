import http from 'node:http';

const port = Number(process.env.PORT || 3000);
const host = '0.0.0.0';
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: true, service: 'laava-ceo-contacts', version: '0.1.0', mode: 'bootstrap' }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end('LAAVA CEO Contacts Sync - bootstrap only; sync is not enabled.\n');
});
server.listen(port, host, () => console.log(`CEO Contacts bootstrap listening on ${host}:${port}`));
