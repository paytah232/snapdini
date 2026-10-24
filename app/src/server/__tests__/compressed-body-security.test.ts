// Exercise the real compressed-request parser in a disposable process: an unhandled
// decompression error must fail the test, rather than crash the whole test runner.
// These are ordinary valid/corrupt streams, not native memory-corruption payloads.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import path from 'node:path';
import { brotliCompressSync, gzipSync } from 'node:zlib';

const childSource = `
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.post('/json', (req, res) => res.json(req.body));
  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ type: err.type || 'unknown' });
  });
  const server = app.listen(0, '127.0.0.1', () => {
    process.stdout.write(JSON.stringify({ port: server.address().port }) + '\\n');
  });
`;

async function disposableServer(t: TestContext): Promise<number> {
  const child = spawn(process.execPath, ['-e', childSource], {
    cwd: path.resolve(__dirname, '../../..'),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let diagnostic = '';
  child.stderr.on('data', chunk => { diagnostic = (diagnostic + String(chunk)).slice(-8192); });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 1000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.kill('SIGTERM');
    });
  });
  const port = await new Promise<number>((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Parser child startup timed out: ${diagnostic}`)), 5000);
    const exited = (code: number | null, signal: string | null) => {
      clearTimeout(timer);
      reject(new Error(`Parser child exited before readiness (${code ?? signal}): ${diagnostic}`));
    };
    child.once('exit', exited);
    child.once('error', err => { clearTimeout(timer); reject(err); });
    child.stdout.on('data', chunk => {
      output += String(chunk);
      if (!output.includes('\n')) return;
      clearTimeout(timer);
      child.removeListener('exit', exited);
      try { resolve((JSON.parse(output.split('\n')[0]) as { port: number }).port); }
      catch (err) { reject(err); }
    });
  });
  // Do not install uncaughtException/unhandledRejection handlers in the child:
  // hiding a parser crash would defeat this regression test.
  return port;
}

interface Reply { status: number; body: unknown }
function send(port: number, compressed?: Buffer, encoding?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1', port, path: compressed ? '/json' : '/health',
      method: compressed ? 'POST' : 'GET',
      headers: compressed ? {
        'content-type': 'application/json',
        'content-encoding': encoding!,
        'content-length': compressed.length,
      } : {},
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        try { resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }); }
        catch (err) { reject(err); }
      });
    });
    req.setTimeout(3000, () => req.destroy(new Error('Compressed request timed out')));
    req.on('error', reject);
    req.end(compressed);
  });
}

const json = { event: 'parser-regression', photos: 2 };
for (const [encoding, compress] of [['gzip', gzipSync], ['br', brotliCompressSync]] as const) {
  const valid = compress(Buffer.from(JSON.stringify(json)));

  test(`${encoding}: valid compressed JSON reaches the handler`, async t => {
    const port = await disposableServer(t);
    assert.deepEqual(await send(port, valid, encoding), { status: 200, body: json });
  });

  for (const [kind, bytes] of [
    ['malformed', Buffer.from('this is not a compressed stream')],
    ['truncated', valid.subarray(0, Math.floor(valid.length / 2))],
    ['trailing bytes', Buffer.concat([valid, Buffer.from('invalid trailing bytes')])],
  ] as const) {
    test(`${encoding}: ${kind} cannot kill the parser process`, async t => {
      const port = await disposableServer(t);
      const reply = await send(port, bytes, encoding);
      // Node/zlib versions differ in whether trailing garbage is tolerated. If
      // accepted, it must still yield exactly the original JSON; otherwise it
      // must be a controlled client error, never an internal error or disconnect.
      if (kind === 'trailing bytes' && reply.status === 200) {
        assert.deepEqual(reply.body, json);
      } else {
        assert.equal(reply.status, 400);
      }
      assert.deepEqual(await send(port), { status: 200, body: { ok: true } });
      assert.deepEqual(await send(port, valid, encoding), { status: 200, body: json },
        'the same process must still parse subsequent compressed requests');
    });
  }

  test(`${encoding}: the JSON size limit applies after decompression`, async t => {
    const port = await disposableServer(t);
    const oversized = compress(Buffer.from(JSON.stringify({ data: 'x'.repeat(110 * 1024) })));
    assert.ok(oversized.length < 1024, 'fixture must cross the limit only after decompression');
    assert.deepEqual(await send(port, oversized, encoding), {
      status: 413, body: { type: 'entity.too.large' },
    });
    assert.deepEqual(await send(port, valid, encoding), { status: 200, body: json });
  });
}
