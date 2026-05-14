import { describe, it, expect } from 'vitest';
import { extractVariables, render } from '../src/send/render.js';

describe('render', () => {
  it('extracts unique variable names', () => {
    expect(extractVariables('Hi {{name}}, your code is {{code}}. {{name}} again.')).toEqual(['name', 'code']);
  });
  it('substitutes variables', () => {
    expect(render('Hi {{name}}', { name: 'Alex' })).toBe('Hi Alex');
  });
  it('throws on missing variables', () => {
    expect(() => render('Hi {{name}}', {})).toThrow(/missing/i);
  });
  it('html-escapes by default', () => {
    expect(render('<p>{{x}}</p>', { x: '<script>' })).toBe('<p>&lt;script&gt;</p>');
  });
});
