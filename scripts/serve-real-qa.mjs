import http from 'node:http';

const host = '127.0.0.1';
const port = 8765;
const pages = {
  '/': { title: 'Garden studio test pages', subtitle: 'Local QA fixtures', text: 'Open the project pages below to test Tabosmart grouping. Open the duplicate page twice to test exact-URL duplicate review.' },
  '/plans': { title: 'Garden studio plans', subtitle: 'Layout and dimensions', text: 'A disposable example of a garden studio planning page. The fictional design has one workroom, broad windows, and a small covered entrance.' },
  '/materials': { title: 'Garden studio materials', subtitle: 'Timber, glass, and insulation', text: 'A disposable example of a garden studio materials page. The fictional shortlist includes timber cladding, double glazing, and mineral wool insulation.' },
  '/budget': { title: 'Garden studio budget', subtitle: 'An example project budget', text: 'A disposable example of a garden studio budget page. No real quotes, prices, purchases, accounts, or financial records are present.' },
  '/duplicate': { title: 'Garden studio duplicate review', subtitle: 'Open this exact URL twice', text: 'This disposable page is an exact-URL duplicate fixture. Both copies contain this same fixed text. It has no forms, editable fields, or unsaved work.' },
};
const links = Object.entries(pages).filter(([path]) => path !== '/').map(([path, page]) => `<a href="${path}">${page.title}</a>`).join('');
function render(page) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Tabosmart QA · ${page.title}</title><style>
*{box-sizing:border-box}body{margin:0;background:#f4f6f1;color:#203529;font:17px/1.65 system-ui,-apple-system,sans-serif}.wrap{max-width:800px;margin:9vh auto;padding:32px}.label{display:inline-block;border:1px solid #a4b8a8;border-radius:24px;padding:5px 14px;color:#365741;font-size:12px;font-weight:700;letter-spacing:.09em}h1{font-size:clamp(34px,6vw,52px);letter-spacing:-.045em;line-height:1.1;margin:25px 0 10px}h2{font-size:21px;font-weight:500;color:#637366;margin:0 0 30px}.notice{margin:28px 0;padding:20px 24px;background:#e7eee4;border-radius:12px;border:1px solid #d5dfd1}.notice strong{display:block}nav{display:grid;gap:10px;margin-top:34px}a{color:#245a3a;text-decoration-thickness:1px;text-underline-offset:4px}footer{margin-top:35px;color:#657468;font-size:13px}code{font-size:13px}
</style></head><body><main class="wrap"><span class="label">TABOSMART QA · DISPOSABLE TEST FIXTURE</span><h1>${page.title}</h1><h2>${page.subtitle}</h2><p>${page.text}</p><aside class="notice"><strong>Safe to close after the test.</strong>This is synthetic content served only from this computer. It contains no user data, inputs, forms, cookies, analytics, or unsaved page state.</aside><nav aria-label="Garden studio QA pages"><a href="/">All QA fixtures</a>${links}</nav><footer>Local fixture server: <code>http://${host}:${port}</code><br>These pages are for functional verification, not evidence of measured personal browsing habits.</footer></main></body></html>`;
}
const server = http.createServer((request, response) => {
  const path = new URL(request.url || '/', `http://${host}:${port}`).pathname;
  const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'", 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
  if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405, headers); response.end('Method not allowed'); return; }
  const page = pages[path];
  response.writeHead(page ? 200 : 404, headers);
  response.end(request.method === 'HEAD' ? '' : page ? render(page) : '<!doctype html><title>QA fixture not found</title><p>Fixture not found. <a href="/">Return to the local fixture listing.</a></p>');
});
server.on('error', error => { console.error(`Local QA server could not start: ${error.message}`); process.exitCode = 1; });
server.listen(port, host, () => { console.log(`Tabosmart local QA server running at http://${host}:${port} (PID ${process.pid})`); });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
