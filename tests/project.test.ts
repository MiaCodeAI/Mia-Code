import { describe, expect, it } from 'vitest';
import {
  excludedDirReason,
  excludedFileReason,
  excludedPathReason,
} from '../src/project/exclusions.js';

describe('exclusions', () => {
  it('excludes secret-bearing files but keeps env templates and ordinary source', () => {
    for (const name of [
      '.env',
      '.env.local',
      '.env.production',
      'id_rsa',
      'server.pem',
      'private.key',
      '.npmrc',
      'credentials.json',
      'service-account-prod.json',
      'terraform.tfstate',
    ]) {
      expect(excludedFileReason(name), name).toBe('secret');
    }
    for (const name of [
      '.env.example',
      '.env.sample',
      'tokenizer.ts',
      'password_policy.md',
      'auth.ts',
      'README.md',
    ]) {
      expect(excludedFileReason(name), name).toBeNull();
    }
  });

  it('excludes dependency, build, cache and VCS directories and binaries', () => {
    expect(excludedDirReason('node_modules')).toBe('dependency');
    expect(excludedDirReason('.git')).toBe('vcs');
    expect(excludedDirReason('dist')).toBe('build-output');
    expect(excludedDirReason('src')).toBeNull();
    expect(excludedFileReason('logo.PNG')).toBe('binary');
  });

  it('checks every segment of a path', () => {
    expect(excludedPathReason('src/app/main.ts')).toBeNull();
    expect(excludedPathReason('node_modules/x/index.js')).toBe('dependency');
    expect(excludedPathReason('config/prod/.env')).toBe('secret');
    expect(excludedPathReason('a/.git/config')).toBe('vcs');
  });
});
