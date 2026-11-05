import { describe, expect, it } from 'bun:test';
import { parseMrkdwn } from './mrkdwn';

const blocks = (text: string) => parseMrkdwn(text)[0].elements as any[];
const sectionText = (el: any) => el.elements.map((e: any) => e.text ?? `<@${e.user_id}>`).join('');

describe('parseMrkdwn lists', () => {
  it('keeps text without list lines in one section', () => {
    const els = blocks('line one\nline two');
    expect(els).toHaveLength(1);
    expect(els[0].type).toBe('rich_text_section');
  });

  it('turns bullet lines into a bullet list between prose sections', () => {
    const els = blocks('Intro:\n• first\n• second\n\nAfter.');
    expect(els.map((e) => e.type)).toEqual(['rich_text_section', 'rich_text_list', 'rich_text_section']);
    expect(sectionText(els[0])).toBe('Intro:');
    expect(els[1].style).toBe('bullet');
    expect(els[1].indent).toBe(0);
    expect(els[1].elements.map(sectionText)).toEqual(['first', 'second']);
    expect(sectionText(els[2])).toBe('After.');
  });

  it('accepts "- " as a bullet and "1. " / "2) " as ordered items', () => {
    expect(blocks('- a\n- b')[0].style).toBe('bullet');
    const ordered = blocks('1. one\n2) two')[0];
    expect(ordered.style).toBe('ordered');
    expect(ordered.elements.map(sectionText)).toEqual(['one', 'two']);
  });

  it('nests indented items as a separate list with a higher indent', () => {
    const els = blocks('• top\n  • nested\n• back');
    expect(els.map((e) => [e.style, e.indent, e.elements.length])).toEqual([
      ['bullet', 0, 1],
      ['bullet', 1, 1],
      ['bullet', 0, 1],
    ]);
  });

  it('keeps inline formatting and mentions inside items', () => {
    const item = blocks('• *bold* and <@U06V56X9T9U>')[0].elements[0].elements;
    expect(item[0]).toEqual({ type: 'text', text: 'bold', style: { bold: true } });
    expect(item[2]).toEqual({ type: 'user', user_id: 'U06V56X9T9U' });
  });

  it('does not treat a star line, a dash without a space, or a fenced block as a list', () => {
    expect(blocks('* bold*')).toHaveLength(1);
    expect(blocks('-5 degrees')).toHaveLength(1);
    const fenced = blocks('```\n- not a list\n```');
    expect(fenced).toHaveLength(1);
    expect(fenced[0].type).toBe('rich_text_section');
  });
});
