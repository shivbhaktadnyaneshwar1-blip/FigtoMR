import { describe, expect, it } from 'vitest';
import { loadMcpConfigFile } from '../src/config/mcp-servers.js';

describe('mcp-config.json', () => {
  it('loads the committed Figma server config', () => {
    const config = loadMcpConfigFile();
    expect(config.servers.figma.enabled).toBe(true);
    expect(config.servers.figma.transport).toBe('http');
    expect(config.servers.figma.url).toContain('127.0.0.1:3845');
    expect(config.servers.figma.toolAliases?.getDesignContext).toContain('get_design_context');
  });
});
