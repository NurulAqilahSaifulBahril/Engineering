const http = require('http'), fs = require('fs'), path = require('path');
const port = process.env.PORT || 5174;
http.createServer((req, res) => {
  const f = path.join(__dirname, 'index.html');
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(500); return res.end('error'); }
    res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'});
    res.end(d);
  });
}).listen(port, () => console.log('O&M dashboard on http://localhost:' + port));
