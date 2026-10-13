import { describe, expect, it } from 'vitest';
import { configDir, configFile } from '../src/platform/paths.js';
import { EndpointError, isLoopbackHost, normalizeBaseUrl } from '../src/security/endpoint.js';

describe('normalizeBaseUrl', () => {
  it('accepts https and strips trailing slashes', () => {
    expect(normalizeBaseUrl('https://api.example.com/v1/')).toBe('https://api.example.com/v1');
    expect(normalizeBaseUrl(' https://api.example.com ')).toBe('https://api.example.com');
  });

  it('rejects plain http for remote hosts but allows loopback', () => {
    expect(() => normalizeBaseUrl('http://api.example.com/v1')).toThrow(EndpointError);
    expect(normalizeBaseUrl('http://localhost:11434/v1')).toBe('http://localhost:11434/v1');
    expect(normalizeBaseUrl('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
  });

  it('rejects embedded credentials, queries, fragments and garbage', () => {
    expect(() => normalizeBaseUrl('https://user:pw@api.example.com')).toThrow(/credentials/);
    expect(() => normalizeBaseUrl('https://api.example.com/v1?key=abc')).toThrow(/query/);
    expect(() => normalizeBaseUrl('https://api.example.com/v1#x')).toThrow(/fragment/);
    expect(() => normalizeBaseUrl('not a url')).toThrow(EndpointError);
    expect(() => normalizeBaseUrl('ftp://example.com')).toThrow(EndpointError);
  });

  it('does not treat lookalike hosts as loopback', () => {
    expect(isLoopbackHost('localhost.evil.com')).toBe(false);
    expect(isLoopbackHost('127.0.0.1.evil.com')).toBe(false);
    expect(() => normalizeBaseUrl('http://localhost.evil.com')).toThrow(EndpointError);
  });
});

describe('config paths', () => {
  it('uses platform conventions', () => {
    expect(configDir({ platform: 'linux', env: {}, homedir: '/home/u' })).toBe(
      '/home/u/.config/mia-code',
    );
    expect(
      configDir({ platform: 'linux', env: { XDG_CONFIG_HOME: '/x' }, homedir: '/home/u' }),
    ).toBe('/x/mia-code');
    expect(configDir({ platform: 'darwin', env: {}, homedir: '/Users/u' })).toBe(
      '/Users/u/Library/Application Support/mia-code',
    );
    expect(
      configDir({
        platform: 'win32',
        env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' },
        homedir: 'C:\\Users\\u',
      }),
    ).toBe('C:\\Users\\u\\AppData\\Roaming\\mia-code');
    expect(configDir({ platform: 'win32', env: {}, homedir: 'C:\\Users\\u' })).toBe(
      'C:\\Users\\u\\AppData\\Roaming\\mia-code',
    );
  });

  it('honours MIA_CONFIG_DIR on every platform', () => {
    expect(
      configFile({ platform: 'linux', env: { MIA_CONFIG_DIR: '/tmp/mia' }, homedir: '/h' }),
    ).toBe('/tmp/mia/config.json');
  });
});
