import { describe, expect, test } from 'vitest';
import { originEndpoint, resolveOrigin } from '../src/config';

describe('resolveOrigin', () => {
  test('always resolves to https git endpoint', () => {
    expect(resolveOrigin('github.com', 'openai', 'example')).toBe('https://github.com/openai/example.git');
  });
});

describe('originEndpoint', () => {
  test('appends endpoint and query', () => {
    expect(originEndpoint('https://github.com/openai/example.git', '/info/refs', 'service=git-upload-pack')).toBe(
      'https://github.com/openai/example.git/info/refs?service=git-upload-pack'
    );
  });

  test('appends query to existing query string', () => {
    expect(originEndpoint('https://example.com/repo.git?foo=bar', '/info/refs', 'service=git-upload-pack')).toBe(
      'https://example.com/repo.git/info/refs?foo=bar&service=git-upload-pack'
    );
  });
});
