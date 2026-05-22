function parseSseText(text) {
  const events = [];
  const rawEvents = String(text || '').split(/\n\n+/);
  for (const rawEvent of rawEvents) {
    if (!rawEvent.trim()) {
      continue;
    }
    let eventName = '';
    const dataLines = [];
    for (const line of rawEvent.split(/\n/)) {
      if (line.startsWith('event:')) {
        eventName = line.slice('event:'.length).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).trimStart());
      }
    }
    const dataText = dataLines.join('\n');
    events.push({
      eventName,
      dataText,
    });
  }
  return events;
}

function writeSseEvent(res, entry) {
  if (entry.event) {
    res.write(`event: ${entry.event}\n`);
  }
  res.write(`data: ${JSON.stringify(entry.data)}\n\n`);
}

function writeSseDone(res) {
  res.write('data: [DONE]\n\n');
}

function sseEntryToText(entry) {
  const lines = [];
  if (entry.event) {
    lines.push(`event: ${entry.event}`);
  }
  lines.push(`data: ${JSON.stringify(entry.data)}`);
  lines.push('');
  return `${lines.join('\n')}\n`;
}

module.exports = {
  parseSseText,
  sseEntryToText,
  writeSseDone,
  writeSseEvent,
};
