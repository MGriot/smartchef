// ════════════════════════════════════════════════════════════════════════
// The guard against pasting some other service's credential into the
// GitHub token field.
//
// The asymmetry is the whole design and is pinned below: a false negative
// costs nothing (the request goes out and the server answers), while a
// false POSITIVE would warn someone off a token that actually works. So
// every shape GitHub has ever issued must pass, and every host this cannot
// judge must be waved through.
// ════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import { checkTokenShape } from './tokenShape';

const GITHUB = 'https://github.com/MGriot/SmartChefSync-';

describe('tokens GitHub actually issues', () => {
  it.each([
    ['classic', 'ghp_EXAMPLE_NOT_A_REAL_TOKEN'],
    ['fine-grained', 'github_pat_11ABCDEFG0aBcDeFgHiJkL_mNoPqRsTuVwXyZ'],
    ['OAuth', 'gho_16C7e42F292c6912E7710c838347Ae178B4a'],
    ['user-to-server', 'ghu_16C7e42F292c6912E7710c838347Ae178B4a'],
    ['server-to-server', 'ghs_16C7e42F292c6912E7710c838347Ae178B4a'],
    ['refresh', 'ghr_16C7e42F292c6912E7710c838347Ae178B4a'],
  ])('passes a %s token', (_kind, token) => {
    expect(checkTokenShape(GITHUB, token)).toBeNull();
  });

  it('passes a pre-2021 classic PAT, which is bare 40-char hex and never expires', () => {
    // These predate the prefix scheme and are still valid. Flagging one
    // would be the false positive this module must never produce.
    expect(checkTokenShape(GITHUB, 'abcdef0123'.repeat(4))).toBeNull();
  });

  it('ignores surrounding whitespace from a sloppy paste', () => {
    expect(checkTokenShape(GITHUB, '  ghp_EXAMPLE_NOT_A_REAL_TOKEN  ')).toBeNull();
  });
});

describe('the token that caused this', () => {
  it('flags a Google OAuth token pasted into the GitHub field', () => {
    // Shaped like the token from the real failure (a Google OAuth token):
    // read the public repo fine, failed every upload, and nothing in the
    // app had an opinion about it. Deliberately not a usable value --
    // a live credential has no business being a test fixture.
    const problem = checkTokenShape(GITHUB, 'AQ.Ab8_EXAMPLE_NOT_A_REAL_TOKEN');

    expect(problem).not.toBeNull();
    expect(problem!.expectedPrefixes).toEqual(['ghp_', 'github_pat_']);
  });

  it('names both prefixes, so the message ends the hunt rather than starting one', () => {
    const problem = checkTokenShape(GITHUB, 'AQ.Ab8_EXAMPLE_NOT_A_REAL_TOKEN');

    expect(problem!.message).toMatch(/ghp_/);
    expect(problem!.message).toMatch(/github_pat_/);
  });

  it('flags it on a github.com URL written without the .git suffix', () => {
    expect(checkTokenShape('https://github.com/MGriot/SmartChefSync-', 'AQ.Ab8RN6x')).not.toBeNull();
    expect(checkTokenShape('https://github.com/MGriot/SmartChefSync-.git', 'AQ.Ab8RN6x')).not.toBeNull();
  });
});

describe('hosts this must not judge', () => {
  it('has no opinion about GitLab, whose deploy tokens are an arbitrary password', () => {
    expect(checkTokenShape('https://gitlab.com/me/recipes.git', 'glpat-ABCdefGHIjklMNOpqr')).toBeNull();
    expect(checkTokenShape('https://gitlab.com/me/recipes.git', 'a-deploy-token-password')).toBeNull();
  });

  it('has no opinion about a self-hosted server, whose credentials are whatever its admin chose', () => {
    // Includes GitHub Enterprise Server, which detectHost() cannot
    // recognise. A hard rule here would lock people out of their library.
    expect(checkTokenShape('https://git.example.org/me/recipes.git', 'AQ.Ab8RN6x')).toBeNull();
  });

  it('says nothing when no token is configured — absence is a different problem', () => {
    expect(checkTokenShape(GITHUB, null)).toBeNull();
    expect(checkTokenShape(GITHUB, '')).toBeNull();
    expect(checkTokenShape(GITHUB, '   ')).toBeNull();
  });

  it('says nothing about a URL it cannot parse', () => {
    expect(checkTokenShape('not a url', 'AQ.Ab8RN6x')).toBeNull();
  });
});
