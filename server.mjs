import http from 'node:http';
import https from 'node:https';
import { createSpeechmaticsJWT } from '@speechmatics/auth';
import dotenv from 'dotenv';

dotenv.config();

const apiKey = process.env.SPEECHMATICS_API_KEY;
const region = process.env.REGION || 'eu';

if (!apiKey) {
  console.error('SPEECHMATICS_API_KEY is not set. Please add it to a .env file or environment variables.');
  process.exit(1);
}

// EU: asr.api.speechmatics.com  US: us.asr.api.speechmatics.com
const BATCH_HOST = region === 'us' ? 'us.asr.api.speechmatics.com' : 'asr.api.speechmatics.com';

const port = Number(process.env.PORT || 3000);

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function proxy(req, res, smPath) {
  const body = await readBody(req);

  const headers = { authorization: `Bearer ${apiKey}` };
  if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
  if (body.length) headers['content-length'] = String(body.length);

  return new Promise((resolve) => {
    const proxyReq = https.request(
      { hostname: BATCH_HOST, port: 443, path: smPath, method: req.method, headers },
      (proxyRes) => {
        const chunks = [];
        proxyRes.on('data', c => chunks.push(c));
        proxyRes.on('end', () => {
          res.statusCode = proxyRes.statusCode;
          if (proxyRes.headers['content-type']) res.setHeader('content-type', proxyRes.headers['content-type']);
          res.end(Buffer.concat(chunks));
          resolve();
        });
      }
    );

    proxyReq.on('error', err => {
      console.error('Proxy error:', err);
      if (!res.headersSent) { res.statusCode = 502; res.end('{}'); }
      resolve();
    });

    if (body.length) proxyReq.write(body);
    proxyReq.end();
  });
}

const server = http.createServer(async (req, res) => {
  if (!req.url) { res.statusCode = 400; res.end(); return; }

  try {
    if (req.method === 'GET' && req.url.startsWith('/speechmatics-jwt')) {
      const jwt = await createSpeechmaticsJWT({ type: 'rt', apiKey, ttl: 60, region });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ jwt }));
    } else if (req.method === 'POST' && (req.url === '/api/jobs' || req.url.startsWith('/api/jobs?'))) {
      // POST /api/jobs[?wait=N&format=...] → POST /v2/jobs[?...]  (query string passes through)
      await proxy(req, res, req.url.replace('/api/', '/v2/'));
    } else if (req.method === 'GET' && req.url.startsWith('/api/jobs/')) {
      // GET /api/jobs/:id           → GET /v2/jobs/:id
      // GET /api/jobs/:id/transcript → GET /v2/jobs/:id/transcript?format=json
      const smPath = req.url.replace('/api/', '/v2/');
      await proxy(req, res, smPath);
    } else {
      res.statusCode = 404;
      res.end('Not found');
    }
  } catch (err) {
    console.error('Server error:', err);
    if (!res.headersSent) { res.statusCode = 500; res.end('Internal error'); }
  }
});

server.listen(port, () => {
  console.log(`Speechmatics JWT + batch proxy listening on http://localhost:${port} (region: ${region})`);
});
