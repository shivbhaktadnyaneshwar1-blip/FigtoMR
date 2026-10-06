import { describe, expect, it } from 'vitest';
import { loadEnv, requireGeminiConfig, resetEnvCache } from '../src/config/env.js';

describe('requireGeminiConfig', () => {
  it('accepts GEMINI_API_KEY', () => {
    resetEnvCache();
    const env = requireGeminiConfig(
      loadEnv({
        GEMINI_API_KEY: 'test-key',
        GOOGLE_API_KEY: '',
      }),
    );
    expect(env.GEMINI_API_KEY).toBe('test-key');
  });

  it('rejects missing key', () => {
    resetEnvCache();
    expect(() =>
      requireGeminiConfig(
        loadEnv({
          GEMINI_API_KEY: '',
          GOOGLE_API_KEY: '',
        }),
      ),
    ).toThrow(/Gemini API key/);
  });
});
