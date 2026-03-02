import { describe, expect, test } from 'vitest';
import { inspectPktLines } from '../src/upload-pack';

function pktLine(line: string): string {
  const encoded = new TextEncoder().encode(line);
  const len = (encoded.length + 4).toString(16).padStart(4, '0');
  return `${len}${line}`;
}

function pktBody(lines: string[]): ArrayBuffer {
  const payload = `${lines.map(pktLine).join('')}0000`;
  return new TextEncoder().encode(payload).buffer;
}

describe('inspectPktLines', () => {
  test('extracts v2 command and fetch shape', () => {
    const parsed = inspectPktLines(pktBody([
      'command=fetch\n',
      'want deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n',
    ]));

    expect(parsed).toEqual({
      command: 'fetch',
      hasWant: true,
      hasHave: false,
    });
  });

  test('detects have lines', () => {
    const parsed = inspectPktLines(pktBody([
      'want deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n',
      'have cafebabecafebabecafebabecafebabecafebabe\n',
    ]));

    expect(parsed.hasWant).toBe(true);
    expect(parsed.hasHave).toBe(true);
  });
});
