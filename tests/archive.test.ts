import { describe, expect, test } from 'vitest';
import { archiveContentType, parseArchivePath } from '../src/archive';

describe('parseArchivePath', () => {
  test('parses tar.gz archive refs', () => {
    expect(parseArchivePath('/-/archive/main.tar.gz')).toEqual({ ref: 'main', ext: 'tar.gz' });
  });

  test('parses nested tag refs', () => {
    expect(parseArchivePath('/archive/refs/tags/v1.2.3.tar.gz')).toEqual({ ref: 'refs/tags/v1.2.3', ext: 'tar.gz' });
  });

  test('rejects invalid archive paths', () => {
    expect(parseArchivePath('/archive/main')).toBeNull();
  });
});

describe('archiveContentType', () => {
  test('maps known archive content types', () => {
    expect(archiveContentType('zip')).toBe('application/zip');
    expect(archiveContentType('tar.gz')).toBe('application/gzip');
  });
});
