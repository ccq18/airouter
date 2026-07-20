const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');

const {
  forwardReadableWithBackpressure,
  writeWithBackpressure,
} = require('../app/stream-backpressure');

function createWritable(writeResults = []) {
  const writable = new EventEmitter();
  writable.destroyed = false;
  writable.writableEnded = false;
  writable.chunks = [];
  writable.write = chunk => {
    writable.chunks.push(Buffer.from(chunk));
    return writeResults.length > 0 ? writeResults.shift() : true;
  };
  return writable;
}

test('writeWithBackpressure waits for drain after a saturated write', async () => {
  const writable = createWritable([false]);
  let resolved = false;
  let writeObserved = false;
  const writePromise = writeWithBackpressure(writable, Buffer.from('a'), {
    onWrite: () => {
      writeObserved = true;
    },
  }).then(result => {
    resolved = true;
    return result;
  });

  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writeObserved, true);
  assert.equal(resolved, false);
  writable.emit('drain');
  assert.equal(await writePromise, true);
});

test('writeWithBackpressure stops when the client closes before drain', async () => {
  const writable = createWritable([false]);
  const writePromise = writeWithBackpressure(writable, Buffer.from('a'));

  writable.destroyed = true;
  writable.emit('close');
  assert.equal(await writePromise, false);
});

test('forwardReadableWithBackpressure does not pull the next chunk before drain', async () => {
  let reads = 0;
  const readable = new Readable({
    read() {
      reads += 1;
      if (reads === 1) {
        this.push('a');
        return;
      }
      if (reads === 2) {
        this.push('b');
        return;
      }
      this.push(null);
    },
  });
  const writable = createWritable([false, true]);
  const forwarding = forwardReadableWithBackpressure({ readable, writable });

  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writable.chunks.length, 1);
  writable.emit('drain');

  assert.equal(await forwarding, true);
  assert.equal(Buffer.concat(writable.chunks).toString('utf8'), 'ab');
});
