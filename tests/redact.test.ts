import { afterEach, describe, expect, it } from 'vitest';
import {
  REDACTED,
  clearRegisteredSecrets,
  containsSecretToken,
  redact,
  registerSecret,
} from '../src/security/redact.js';

afterEach(() => clearRegisteredSecrets());

describe('redact', () => {
  it('masks well-known key shapes', () => {
    const samples = [
      'sk-ant-api03-abcdefghijklmnop',
      'sk-or-v1-abcdefghijklmnop1234',
      'sk-abcdefghijklmnopqrstuvwx',
      'gsk_abcdefghijklmnopqrstuv',
      'AIzaSyabcdefghijklmnopqrstuvwxyz',
      'ghp_abcdefghijklmnopqrstuvwxyz',
    ];
    for (const sample of samples) {
      const result = redact(`token is ${sample} ok`);
      expect(result).not.toContain(sample);
      expect(result).toContain(REDACTED);
    }
  });

  it('masks bearer tokens and key=value credentials', () => {
    expect(redact('Authorization: Bearer abcdefgh12345678')).not.toContain('abcdefgh12345678');
    expect(redact('{"api_key": "supersecretvalue"}')).not.toContain('supersecretvalue');
    expect(redact('password=hunter2hunter2')).not.toContain('hunter2hunter2');
  });

  it('masks private key blocks', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----';
    expect(redact(`x ${pem} y`)).toBe(`x ${REDACTED} y`);
  });

  it('masks registered secrets wherever they appear, even with unusual shapes', () => {
    registerSecret('plain-looking-secret-value');
    expect(redact('error: plain-looking-secret-value was rejected')).toBe(
      `error: ${REDACTED} was rejected`,
    );
  });

  it('does not alter ordinary text or code mentioning tokens', () => {
    const text = 'const token = parseToken(input); // password policy docs';
    expect(redact(text)).toBe(text);
  });

  it('detects secret tokens for the config-file guard', () => {
    expect(containsSecretToken('{"a":"sk-abcdefghijklmnopqrstuvwx"}')).toBe(true);
    expect(containsSecretToken('{"a":"hello"}')).toBe(false);
  });
});
