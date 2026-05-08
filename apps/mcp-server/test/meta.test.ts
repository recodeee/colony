import { describe, expect, it } from 'vitest';
import { parseMeta } from '../src/tools/_meta.js';

describe('parseMeta', () => {
  it('returns {} for null', () => {
    expect(parseMeta(null)).toEqual({});
  });

  it('returns {} for undefined', () => {
    expect(parseMeta(undefined)).toEqual({});
  });

  it('returns {} for empty string', () => {
    expect(parseMeta('')).toEqual({});
  });

  it('returns {} for malformed JSON', () => {
    expect(parseMeta('{bad json')).toEqual({});
  });

  it('returns {} for JSON number', () => {
    expect(parseMeta('42')).toEqual({});
  });

  it('returns {} for JSON string', () => {
    expect(parseMeta('"hello"')).toEqual({});
  });

  it('returns {} for JSON array', () => {
    expect(parseMeta('["a","b"]')).toEqual({});
  });

  it('returns {} for JSON null', () => {
    expect(parseMeta('null')).toEqual({});
  });

  it('returns the object for valid JSON object', () => {
    expect(parseMeta('{"status":"completed","count":3}')).toEqual({
      status: 'completed',
      count: 3,
    });
  });

  it('returns nested object intact', () => {
    expect(parseMeta('{"auto_archive":true}')).toEqual({ auto_archive: true });
  });
});
