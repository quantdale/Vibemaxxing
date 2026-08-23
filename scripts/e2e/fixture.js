// Local fixture "LLM provider" for E2E: a tiny HTTP server that emulates the
// pieces Tote needs from a web LLM site — page loads, titles, long-lived page
// state, a downloadable file, an upload input and a popup — with zero external
// network. Only ever bound to 127.0.0.1 on an ephemeral port, only ever
// referenced from the isolated test profile.
'use strict';
const http = require('http');
const crypto = require('crypto');

const PAGE = (title, body) => `<!DOCTYPE html>
<html><head><title>${title}</title></head>
<body>
<h1 id="h">${title}</h1>
${body}
</body></html>`;

const HOME = PAGE('Fixture Home', `
  <a id="nav-two" href="/two">page two</a>
  <a id="dl" href="/download/report.bin">download report</a>
  <form id="up" action="/upload" method="post" enctype="multipart/form-data">
    <input type="file" name="f" id="file-input" />
    <button type="submit">upload</button>
  </form>
  <button id="pop" onclick="window.open('/popup','_blank')">popup</button>`);

const TWO = PAGE('Fixture Page Two', `<span id="stored"></span>
  <script>document.getElementById('stored').textContent = 'state=' + localStorage.getItem('tote-e2e');</script>`);

const POPUP = PAGE('Fixture Popup', `<p id="ok">popup-ok</p>`);

// Fixed content so tests can assert exact bytes landed in the inbox.
const REPORT_BYTES = Buffer.from(
  'TOTE-FIXTURE-REPORT\r\n' + crypto.randomBytes(512).toString('hex') + '\r\n'
);

function startFixture() {
  const state = { uploads: [] };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(HOME);
    } else if (url.pathname === '/two') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(TWO);
    } else if (url.pathname === '/popup') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(POPUP);
    } else if (url.pathname === '/download/report.bin') {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': REPORT_BYTES.length,
        'content-disposition': 'attachment; filename="report.bin"',
      });
      res.end(REPORT_BYTES);
    } else if (url.pathname === '/upload' && req.method === 'POST') {
      let body = [];
      req.on('data', (c) => body.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(body).toString('binary');
        const m = raw.match(/filename="([^"]+)"/);
        state.uploads.push(m ? m[1] : '(unknown)');
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(PAGE('Upload OK', '<p id="got">' + (m ? m[1] : '?') + '</p>'));
      });
    } else {
      res.writeHead(404);
      res.end('fixture: no such page');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: 'http://127.0.0.1:' + server.address().port,
        uploads: () => state.uploads.slice(),
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

module.exports = { startFixture, REPORT_BYTES };
