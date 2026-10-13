import { describe, expect, it } from 'vitest';
import { LinuxSecretToolStore } from '../src/credentials/linux.js';
import { MacOSKeychainStore } from '../src/credentials/macos.js';
import { envVarCandidates, resolveApiKey } from '../src/credentials/resolve.js';
import { MemoryCredentialStore, UnavailableCredentialStore } from '../src/credentials/types.js';
import type { RunOptions, RunResult, Runner } from '../src/platform/exec.js';
import { runCommand } from '../src/platform/exec.js';

interface Call {
  command: string;
  args: readonly string[];
  options?: RunOptions;
}

function recorder(result: Partial<RunResult> = {}): { run: Runner; calls: Call[] } {
  const calls: Call[] = [];
  const run: Runner = async (command, args, options) => {
    calls.push({ command, args, ...(options ? { options } : {}) });
    return { exitCode: 0, stdout: '', stderr: '', timedOut: false, truncated: false, ...result };
  };
  return { run, calls };
}

describe('resolveApiKey', () => {
  const store = new MemoryCredentialStore();

  it('prefers the configured environment variable, then the credential store', async () => {
    await store.set('mine', 'stored-key-123456');
    const cfg = {
      kind: 'openai-compatible' as const,
      baseUrl: 'https://x.example/v1',
      apiKeyEnv: 'MY_KEY',
    };
    expect(await resolveApiKey('mine', cfg, { MY_KEY: 'env-key-123456' }, store)).toEqual({
      key: 'env-key-123456',
      source: 'env:MY_KEY',
    });
    expect(await resolveApiKey('mine', cfg, {}, store)).toEqual({
      key: 'stored-key-123456',
      source: 'store:memory',
    });
    expect(await resolveApiKey('absent', cfg, {}, store)).toBeNull();
  });

  it("uses a preset's standard variable only while the endpoint is the official one", () => {
    const official = {
      kind: 'openai-compatible' as const,
      baseUrl: 'https://api.openai.com/v1',
      preset: 'openai',
    };
    expect(envVarCandidates(official)).toEqual(['OPENAI_API_KEY']);
    const redirected = { ...official, baseUrl: 'https://proxy.untrusted.example/v1' };
    expect(envVarCandidates(redirected)).toEqual([]);
  });
});

describe('Linux secret-tool store', () => {
  it('passes the secret on stdin and never in arguments', async () => {
    const { run, calls } = recorder();
    await new LinuxSecretToolStore(run).set('openai', 'super-secret-key-123');
    const call = calls[0]!;
    expect(call.options?.input).toBe('super-secret-key-123');
    expect(call.args.join(' ')).not.toContain('super-secret-key-123');
  });

  it('reads, deletes and reports availability', async () => {
    expect(await new LinuxSecretToolStore(recorder({ stdout: 'abc\n' }).run).get('x')).toBe('abc');
    expect(await new LinuxSecretToolStore(recorder({ exitCode: 1 }).run).get('x')).toBeNull();
    expect(
      (
        await new LinuxSecretToolStore(
          recorder({ error: new Error('ENOENT'), exitCode: null }).run,
        ).isAvailable()
      ).available,
    ).toBe(false);
    expect(
      (await new LinuxSecretToolStore(recorder({ exitCode: 1 }).run).isAvailable()).available,
    ).toBe(true);
    expect(
      (
        await new LinuxSecretToolStore(
          recorder({ exitCode: 1, stderr: 'Cannot autolaunch D-Bus' }).run,
        ).isAvailable()
      ).available,
    ).toBe(false);
  });

  it('throws when the store rejects the write', async () => {
    await expect(
      new LinuxSecretToolStore(recorder({ exitCode: 1, stderr: 'locked' }).run).set(
        'x',
        'secretsecret',
      ),
    ).rejects.toThrow(/locked/);
  });
});

describe('macOS keychain store', () => {
  it('sends the add command on stdin to `security -i`, never as arguments', async () => {
    const { run, calls } = recorder();
    await new MacOSKeychainStore(run).set('openai', 'sk-test-abc123DEF456');
    const call = calls[0]!;
    expect(call.args).toEqual(['-i']);
    expect(call.options?.input).toContain('add-generic-password');
    expect(call.options?.input).toContain('sk-test-abc123DEF456');
  });

  it('refuses secrets or names with characters that could break the command', async () => {
    const store = new MacOSKeychainStore(recorder().run);
    await expect(store.set('openai', 'abc"; do-evil')).rejects.toThrow(/characters/);
    await expect(store.set('bad name', 'abcdefgh')).rejects.toThrow();
  });
});

describe('unavailable and memory stores', () => {
  it('explain themselves', async () => {
    const none = new UnavailableCredentialStore();
    expect((await none.isAvailable()).available).toBe(false);
    await expect(none.set()).rejects.toThrow();
  });
});

describe('runCommand', () => {
  it('runs without a shell, delivers stdin, and reports exit codes', async () => {
    const result = await runCommand(
      process.execPath,
      ['-e', 'process.stdin.pipe(process.stdout)'],
      { input: 'hello; echo injected' },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello; echo injected');
  });

  it('reports a missing program instead of throwing', async () => {
    const result = await runCommand('definitely-not-a-real-program-xyz', []);
    expect(result.error).toBeDefined();
    expect(result.exitCode).toBeNull();
  });

  it('enforces timeouts and output limits', async () => {
    const slow = await runCommand(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], {
      timeoutMs: 100,
    });
    expect(slow.timedOut).toBe(true);
    const loud = await runCommand(
      process.execPath,
      ['-e', 'process.stdout.write("x".repeat(100000))'],
      { maxOutputBytes: 1000 },
    );
    expect(loud.truncated).toBe(true);
    expect(loud.stdout.length).toBeLessThan(70000);
  });
});
