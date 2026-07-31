import { describe, it, expect } from 'vitest';
import {
  createToolAllowlist,
  filterToolsListResult,
  isToolAllowed,
} from '../src/tool-filter.js';

describe('tool-filter', () => {
  describe('createToolAllowlist', () => {
    it('returns undefined for undefined or empty names', () => {
      expect(createToolAllowlist(undefined)).toBeUndefined();
      expect(createToolAllowlist([])).toBeUndefined();
    });

    it('builds a set from names', () => {
      const allowlist = createToolAllowlist(['a', 'b']);
      expect(allowlist).toEqual(new Set(['a', 'b']));
    });
  });

  describe('isToolAllowed', () => {
    it('allows any name when allowlist is undefined', () => {
      expect(isToolAllowed(undefined, 'anything')).toBe(true);
      expect(isToolAllowed(undefined, undefined)).toBe(true);
    });

    it('allows only listed names when allowlist is set', () => {
      const allowlist = createToolAllowlist(['search', 'list_files'])!;
      expect(isToolAllowed(allowlist, 'search')).toBe(true);
      expect(isToolAllowed(allowlist, 'list_files')).toBe(true);
      expect(isToolAllowed(allowlist, 'delete')).toBe(false);
      expect(isToolAllowed(allowlist, 'Search')).toBe(false);
    });

    it('denies missing or empty name when allowlist is set', () => {
      const allowlist = createToolAllowlist(['search'])!;
      expect(isToolAllowed(allowlist, undefined)).toBe(false);
      expect(isToolAllowed(allowlist, '')).toBe(false);
    });
  });

  describe('filterToolsListResult', () => {
    const full = {
      tools: [
        { name: 'search', description: 'Search' },
        { name: 'delete', description: 'Delete' },
        { name: 'list_files', description: 'List' },
      ],
      nextCursor: 'abc',
    };

    it('passthrough when allowlist is undefined', () => {
      expect(filterToolsListResult(undefined, full)).toBe(full);
    });

    it('passthrough when tools is not an array', () => {
      const allowlist = createToolAllowlist(['search'])!;
      const result = { tools: 'oops' };
      expect(filterToolsListResult(allowlist, result)).toBe(result);
    });

    it('filters tools and preserves other fields', () => {
      const allowlist = createToolAllowlist(['search', 'list_files'])!;
      const filtered = filterToolsListResult(allowlist, full);
      expect(filtered).toEqual({
        tools: [
          { name: 'search', description: 'Search' },
          { name: 'list_files', description: 'List' },
        ],
        nextCursor: 'abc',
      });
      expect(filtered).not.toBe(full);
    });

    it('drops tools without a string name', () => {
      const allowlist = createToolAllowlist(['search'])!;
      const result = {
        tools: [{ name: 'search' }, { description: 'no name' }, null, 'x'],
      };
      expect(filterToolsListResult(allowlist, result)).toEqual({
        tools: [{ name: 'search' }],
      });
    });
  });
});
