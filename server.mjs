import http from 'node:http';
import { createSpeechmaticsJWT } from '@speechmatics/auth';
import dotenv from 'dotenv';

dotenv.config();

const apiKey = process.env.SPEECHMATICS_API_KEY;

if (!apiKey) {
  console.error('SPEECHMATICS_API_KEY is not set. Please add it to a .env file or environment variables.');
  process.exit(1);
}

const port = Number(process.env.PORT || 3000);

const server = http.createServer(async (req, res) => {
  if (!req.url) {
    res.statusCode = 400;
    res.end('Bad request');
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/speechmatics-jwt')) {
    try {
      const jwt = await createSpeechmaticsJWT({
        type: 'rt',
        apiKey,
        ttl: 60
      });

      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ jwt }));
    } catch (err) {
      console.error('Failed to create JWT', err);
      res.statusCode = 500;
      res.end('Failed to create JWT');
    }
  } else {
    res.statusCode = 404;
    res.end('Not found');
  }
});

server.listen(port, () => {
  console.log(`JWT server listening on http://localhost:${port}`);
});
