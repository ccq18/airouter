function waitForDrain(writable) {
  return new Promise((resolve, reject) => {
    let settled = false;

    function cleanup() {
      writable.removeListener('drain', handleDrain);
      writable.removeListener('close', handleClose);
      writable.removeListener('error', handleError);
    }

    function settle(action, value) {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      action(value);
    }

    function handleDrain() {
      settle(resolve, true);
    }

    function handleClose() {
      settle(resolve, false);
    }

    function handleError(error) {
      settle(reject, error);
    }

    writable.once('drain', handleDrain);
    writable.once('close', handleClose);
    writable.once('error', handleError);
  });
}

async function writeWithBackpressure(writable, chunk, options = {}) {
  if (writable.destroyed || writable.writableEnded) {
    return false;
  }

  const accepted = writable.write(chunk);
  if (typeof options.onWrite === 'function') {
    options.onWrite();
  }

  if (accepted !== false) {
    return true;
  }

  return waitForDrain(writable);
}

async function forwardReadableWithBackpressure(options) {
  const {
    initialChunks = [],
    onChunk = () => {},
    readable,
    writable,
  } = options;

  for (const chunk of initialChunks) {
    onChunk(chunk);
    if (!await writeWithBackpressure(writable, chunk)) {
      return false;
    }
  }

  for await (const chunk of readable) {
    onChunk(chunk);
    if (!await writeWithBackpressure(writable, chunk)) {
      return false;
    }
  }

  return true;
}

module.exports = {
  forwardReadableWithBackpressure,
  waitForDrain,
  writeWithBackpressure,
};
