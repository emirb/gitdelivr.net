import { describe, expect, test } from 'vitest';
import { parseGitPath } from '../src/index';

describe('parseGitPath', () => {
  test('parses github upload-pack path', () => {
    expect(parseGitPath('/github.com/tj/commander.js/git-upload-pack')).toEqual({
      origin: 'github.com',
      owner: 'tj',
      repo: 'commander.js',
      gitPath: '/git-upload-pack',
    });
  });

  test('strips .git suffix from repo name', () => {
    expect(parseGitPath('/codeberg.org/forgejo/forgejo.git/info/refs')).toEqual({
      origin: 'codeberg.org',
      owner: 'forgejo',
      repo: 'forgejo',
      gitPath: '/info/refs',
    });
  });

  test('supports nested archive refs', () => {
    expect(parseGitPath('/gitlab.gnome.org/GNOME/gtk/-/archive/refs/tags/4.0.0.tar.gz')).toEqual({
      origin: 'gitlab.gnome.org',
      owner: 'GNOME',
      repo: 'gtk',
      gitPath: '/-/archive/refs/tags/4.0.0.tar.gz',
    });
  });

  test('rejects non-git paths', () => {
    expect(parseGitPath('/github.com/tj/commander.js')).toBeNull();
  });
});
