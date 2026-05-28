import { describe, it, expect } from 'vitest';
import { extractVariables, render } from '../src/send/render.js';

describe('render', () => {
  it('extracts unique variable names', () => {
    expect(extractVariables('Hi {{name}}, your code is {{code}}. {{name}} again.')).toEqual(['name', 'code']);
  });
  it('substitutes variables', () => {
    expect(render('Hi {{name}}', { name: 'Alex' })).toBe('Hi Alex');
  });
  it('renders missing variables as empty string', () => {
    expect(render('Hi {{name}}', {})).toBe('Hi ');
  });
  it('html-escapes by default', () => {
    expect(render('<p>{{x}}</p>', { x: '<script>' })).toBe('<p>&lt;script&gt;</p>');
  });
  it('ignores placeholders inside HTML comments when extracting', () => {
    const tpl = `<!-- example: {{example_var}} -->\n<p>{{real_var}}</p>`;
    expect(extractVariables(tpl)).toEqual(['real_var']);
  });
  it('strips HTML comments (and their placeholders) when rendering', () => {
    const tpl = `<!-- {{not_passed}} use {{variable}} syntax -->\n<p>{{name}}</p>`;
    expect(render(tpl, { name: 'Alex' })).toBe(`\n<p>Alex</p>`);
  });
});
