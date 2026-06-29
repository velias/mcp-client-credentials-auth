import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('Config', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  function setRequiredEnv() {
    process.env.MCP_CC_PROXY_REMOTE_MCP_URL = 'https://mcp.example.com/mcp';
    process.env.MCP_CC_PROXY_CLIENT_ID = 'test-client';
    process.env.MCP_CC_PROXY_CLIENT_SECRET = 'test-secret';
  }

  it('loads valid config from env vars', () => {
    setRequiredEnv();
    const config = loadConfig();
    expect(config.remoteMcpUrl).toBe('https://mcp.example.com/mcp');
    expect(config.clientId).toBe('test-client');
    expect(config.clientSecret).toBe('test-secret');
  });

  it('applies default values', () => {
    setRequiredEnv();
    const config = loadConfig();
    expect(config.refreshSkewSeconds).toBe(30);
    expect(config.requestTimeoutMs).toBe(30000);
    expect(config.debug).toBe(false);
  });

  it('parses numeric env vars', () => {
    setRequiredEnv();
    process.env.MCP_CC_PROXY_REFRESH_SKEW_SECONDS = '60';
    process.env.MCP_CC_PROXY_REQUEST_TIMEOUT_MS = '5000';
    const config = loadConfig();
    expect(config.refreshSkewSeconds).toBe(60);
    expect(config.requestTimeoutMs).toBe(5000);
  });

  it('parses debug flag', () => {
    setRequiredEnv();
    process.env.MCP_CC_PROXY_DEBUG = 'true';
    const config = loadConfig();
    expect(config.debug).toBe(true);
  });

  it('throws on missing REMOTE_MCP_URL', () => {
    process.env.MCP_CC_PROXY_CLIENT_ID = 'test-client';
    process.env.MCP_CC_PROXY_CLIENT_SECRET = 'test-secret';
    expect(() => loadConfig()).toThrow('Invalid configuration');
  });

  it('throws on missing CLIENT_ID', () => {
    process.env.MCP_CC_PROXY_REMOTE_MCP_URL = 'https://mcp.example.com/mcp';
    process.env.MCP_CC_PROXY_CLIENT_SECRET = 'test-secret';
    expect(() => loadConfig()).toThrow('Invalid configuration');
  });

  it('throws on missing CLIENT_SECRET', () => {
    process.env.MCP_CC_PROXY_REMOTE_MCP_URL = 'https://mcp.example.com/mcp';
    process.env.MCP_CC_PROXY_CLIENT_ID = 'test-client';
    expect(() => loadConfig()).toThrow('Invalid configuration');
  });

  it('throws on invalid URL', () => {
    process.env.MCP_CC_PROXY_REMOTE_MCP_URL = 'not-a-url';
    process.env.MCP_CC_PROXY_CLIENT_ID = 'test-client';
    process.env.MCP_CC_PROXY_CLIENT_SECRET = 'test-secret';
    expect(() => loadConfig()).toThrow('Invalid configuration');
  });

  it('accepts http:// URL', () => {
    process.env.MCP_CC_PROXY_REMOTE_MCP_URL = 'http://localhost:3000/mcp';
    process.env.MCP_CC_PROXY_CLIENT_ID = 'test-client';
    process.env.MCP_CC_PROXY_CLIENT_SECRET = 'test-secret';
    const config = loadConfig();
    expect(config.remoteMcpUrl).toBe('http://localhost:3000/mcp');
  });

  it('accepts https:// URL', () => {
    process.env.MCP_CC_PROXY_REMOTE_MCP_URL = 'https://mcp.example.com/mcp';
    process.env.MCP_CC_PROXY_CLIENT_ID = 'test-client';
    process.env.MCP_CC_PROXY_CLIENT_SECRET = 'test-secret';
    const config = loadConfig();
    expect(config.remoteMcpUrl).toBe('https://mcp.example.com/mcp');
  });

  it('rejects file:// URL scheme', () => {
    process.env.MCP_CC_PROXY_REMOTE_MCP_URL = 'file:///etc/passwd';
    process.env.MCP_CC_PROXY_CLIENT_ID = 'test-client';
    process.env.MCP_CC_PROXY_CLIENT_SECRET = 'test-secret';
    expect(() => loadConfig()).toThrow('Invalid configuration');
  });

  it('rejects ftp:// URL scheme', () => {
    process.env.MCP_CC_PROXY_REMOTE_MCP_URL = 'ftp://ftp.example.com/data';
    process.env.MCP_CC_PROXY_CLIENT_ID = 'test-client';
    process.env.MCP_CC_PROXY_CLIENT_SECRET = 'test-secret';
    expect(() => loadConfig()).toThrow('Invalid configuration');
  });

  it('parses MCP_CC_PROXY_SCOPES into config.scopes', () => {
    setRequiredEnv();
    process.env.MCP_CC_PROXY_SCOPES = 'https://my-api.example.com/.default';
    const config = loadConfig();
    expect(config.scopes).toBe('https://my-api.example.com/.default');
  });

  it('leaves scopes undefined when MCP_CC_PROXY_SCOPES is not set', () => {
    setRequiredEnv();
    const config = loadConfig();
    expect(config.scopes).toBeUndefined();
  });

  it('treats empty MCP_CC_PROXY_SCOPES as undefined', () => {
    setRequiredEnv();
    process.env.MCP_CC_PROXY_SCOPES = '';
    const config = loadConfig();
    expect(config.scopes).toBeUndefined();
  });

});
