export interface SseEvent {
  event?: string;
  data: string;
}

/**
 * Parses a Server-Sent Events byte stream. Handles LF and CRLF, multi-line data fields,
 * comment lines and events split across network chunks. `onActivity` fires for every chunk
 * received so callers can implement an idle timeout.
 */
export async function* parseSse(
  body: ReadableStream<Uint8Array>,
  onActivity?: () => void,
): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event: string | undefined;
  let data: string[] = [];

  const dispatch = (): SseEvent | undefined => {
    if (data.length === 0) {
      event = undefined;
      return undefined;
    }
    const result: SseEvent = { data: data.join('\n') };
    if (event !== undefined) result.event = event;
    event = undefined;
    data = [];
    return result;
  };

  const handleLine = (line: string): SseEvent | undefined => {
    if (line === '') return dispatch();
    if (line.startsWith(':')) return undefined;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
    return undefined;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      onActivity?.();
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.search(/\r\n|\n|\r/);
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        const sepLength = buffer.startsWith('\r\n', newline) ? 2 : 1;
        // A lone \r at the very end of the buffer may be the first half of \r\n: wait for more.
        if (buffer[newline] === '\r' && newline + 1 === buffer.length) break;
        buffer = buffer.slice(newline + sepLength);
        const evt = handleLine(line);
        if (evt) yield evt;
        newline = buffer.search(/\r\n|\n|\r/);
      }
    }
    buffer += decoder.decode();
    if (buffer !== '') {
      const evt = handleLine(buffer.replace(/\r$/, ''));
      if (evt) yield evt;
    }
    const last = dispatch();
    if (last) yield last;
  } finally {
    try {
      await reader.cancel();
    } catch {
      // stream already closed
    }
  }
}
