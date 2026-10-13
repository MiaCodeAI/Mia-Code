import { describe, expect, it } from 'vitest';
import { parseSse } from '../src/providers/sse.js';
import { sseResponse } from './helpers/fakes.js';

async function collect(text: string, chunkSize: number) {
  const response = sseResponse(text, chunkSize);
  const events = [];
  for await (const e of parseSse(response.body!)) events.push(e);
  return events;
}

describe('parseSse', () => {
  const text = 'event: a\ndata: {"x":1}\n\n: comment\ndata: line1\ndata: line2\n\ndata: [DONE]\n\n';
  const expected = [{ event: 'a', data: '{"x":1}' }, { data: 'line1\nline2' }, { data: '[DONE]' }];

  it('parses events regardless of how the bytes are chunked', async () => {
    for (const size of [1, 2, 3, 7, 1000]) {
      expect(await collect(text, size)).toEqual(expected);
    }
  });

  it('handles CRLF line endings', async () => {
    for (const size of [1, 5, 1000]) {
      expect(await collect(text.replace(/\n/g, '\r\n'), size)).toEqual(expected);
    }
  });

  it('keeps multi-byte characters intact across chunk boundaries', async () => {
    const events = await collect('data: héllo 😀 世界\n\n', 1);
    expect(events).toEqual([{ data: 'héllo 😀 世界' }]);
  });

  it('flushes a final event that lacks a trailing blank line', async () => {
    expect(await collect('data: tail', 4)).toEqual([{ data: 'tail' }]);
  });
});
