import { describe, expect, it } from 'bun:test';
import { listBlocksFor, markdownLinksToSlack, parseMrkdwn } from './mrkdwn';

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
    // The blank line after the list is kept as the gap before the next text.
    expect(sectionText(els[2])).toBe('\nAfter.');
  });

  it('adds no gap when text follows a list directly', () => {
    const els = blocks('• first\nAfter.');
    expect(sectionText(els[1])).toBe('After.');
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
    expect(fenced[0].type).toBe('rich_text_preformatted');
  });

  it('continues numbering after a nested list instead of restarting at 1', () => {
    const els = blocks('1. a\n  • sub\n2. b\n3. c');
    expect(els.map((e) => [e.style, e.indent, e.offset ?? 0, e.elements.length])).toEqual([
      ['ordered', 0, 0, 1],
      ['bullet', 1, 0, 1],
      ['ordered', 0, 1, 2],
    ]);
  });

  it('restarts numbering after prose and for a new nested list', () => {
    const els = blocks('1. a\n2. b\n\nText\n1. c\n  1. x\n2. d\n  1. y');
    const lists = els.filter((e) => e.type === 'rich_text_list');
    expect(lists.map((e) => [e.indent, e.offset ?? 0])).toEqual([[0, 0], [0, 0], [1, 0], [0, 1], [1, 0]]);
  });

  it('treats a fence opened mid-line as code', () => {
    const els = blocks('see ```\n- not a list\n```');
    expect(els.map((e: any) => e.type)).toEqual(['rich_text_section', 'rich_text_preformatted']);
  });

  it('keeps a list line with inline ```code``` in the list', () => {
    const els = blocks('- use ```x``` here\n- b');
    expect(els).toHaveLength(1);
    expect(els[0].elements).toHaveLength(2);
    expect(blocks('1. a ```x```\n2. b')[0].elements).toHaveLength(2);
  });

  it('continues from the typed number after a same-level bullet', () => {
    const els = blocks('1. a\n- b\n2. c');
    expect(els.map((e) => [e.style, e.offset ?? 0])).toEqual([['ordered', 0], ['bullet', 0], ['ordered', 1]]);
  });

  it('counts up through "1." on every line after a nested list', () => {
    const els = blocks('1. a\n  • s\n1. b\n  • t\n1. c');
    expect(els.filter((e) => e.indent === 0).map((e) => e.offset ?? 0)).toEqual([0, 1, 2]);
  });
});

describe('parseMrkdwn numbering across prose', () => {
  const kinds = (text: string) => blocks(text).map((e: any) => e.type.replace('rich_text_', ''));

  it('keeps items that count on after a text line as literal text, so each shows its own number', () => {
    const text = '1. one\nMR: x\n\n2. two\nMR: y\n\n3. three\nMR: z';
    const els = blocks(text);
    expect(els).toHaveLength(1);
    expect(els[0].type).toBe('rich_text_section');
    expect(sectionText(els[0])).toBe(text);
  });

  it('demotes the whole run, including the items before the interruption', () => {
    expect(kinds('1. a\n2. b\nnote\n3. c')).toEqual(['section']);
  });

  it('keeps a real list for items that follow each other, and for a "1." after prose', () => {
    expect(kinds('1. a\n2. b\n3. c')).toEqual(['list']);
    expect(kinds('1. a\n2. b\n\nText\n1. c\n2. d')).toEqual(['list', 'section', 'list']);
  });

  it('leaves a list that starts at a higher number, and bullets, alone', () => {
    expect(kinds('3. a\n4. b')).toEqual(['list']);
    expect(kinds('- a\ntext\n- b')).toEqual(['list', 'section', 'list']);
  });

  it('keeps a lone numbered item that is followed by text as literal text, so the lines under it keep their breaks', () => {
    const text = 'Hi\n\n1. title\nMR: x\nTicket: y\n\nBye';
    expect(kinds(text)).toEqual(['section']);
    expect(sectionText(blocks(text)[0])).toBe(text);
  });

  it('keeps a lone numbered item with nothing under it, and one inside a run, a real list', () => {
    expect(kinds('Steps:\n1. only')).toEqual(['section', 'list']);
    expect(kinds('1. a\n2. b\ntext')).toEqual(['list', 'section']);
  });

  it('still turns the surrounding bullets into a list', () => {
    expect(kinds('1. a\ntext\n2. b\n\n- x\n- y')).toEqual(['section', 'list']);
  });
});

describe('parseMrkdwn emoji', () => {
  const inline = (text: string) => (parseMrkdwn(text)[0].elements[0] as any).elements;

  it('turns a shortcode into an emoji element', () => {
    expect(inline('thanks :pray: :+1:')).toEqual([
      { type: 'text', text: 'thanks ' },
      { type: 'emoji', name: 'pray' },
      { type: 'text', text: ' ' },
      { type: 'emoji', name: '+1' },
    ]);
  });

  it('leaves times, words with colons and code alone', () => {
    expect(inline('at 10:30:45')).toEqual([{ type: 'text', text: 'at 10:30:45' }]);
    expect(inline('a:b:c')).toEqual([{ type: 'text', text: 'a:b:c' }]);
    expect(inline('`:pray:`')).toEqual([{ type: 'text', text: ':pray:', style: { code: true } }]);
  });
});

describe('listBlocksFor', () => {
  it('returns blocks only when the text has a list', () => {
    expect(listBlocksFor('plain text :pray:')).toBeUndefined();
    expect(listBlocksFor('Intro\n• a\n• b')?.[0].elements.map((e: any) => e.type)).toEqual(['rich_text_section', 'rich_text_list']);
  });
});

describe('parseMrkdwn lists in sent messages', () => {
  const types = (text: string) => blocks(text).map((e: any) => (e.type === 'rich_text_list' ? `${e.style}${e.indent}${e.offset ? '+' + e.offset : ''}` : e.type.replace('rich_text_', '')));

  it('separates a numbered list coming back up from a nested bullet under a bullet list', () => {
    expect(types('• a\n  • n\n1. one\n  • d\n2. two')).toEqual(['bullet0', 'bullet1', 'section', 'ordered0', 'bullet1', 'ordered0+1']);
  });

  it('adds no separator between adjacent lists at the same level', () => {
    expect(types('• a\n1. one')).toEqual(['bullet0', 'ordered0']);
  });

  it('turns a fenced block into preformatted text, with prose before and after', () => {
    const els = blocks('• a\nsee ```\n- not a list\n```\nafter');
    expect(els.map((e: any) => e.type)).toEqual(['rich_text_list', 'rich_text_section', 'rich_text_preformatted', 'rich_text_section']);
    expect(els[2].elements[0].text).toBe('- not a list');
    expect(sectionText(els[1])).toBe('see');
    expect(sectionText(els[3])).toBe('after');
  });

  it('keeps an unclosed fence as code to the end', () => {
    const els = blocks('• a\n```\n- x');
    expect(els.at(-1).type).toBe('rich_text_preformatted');
    expect(els.at(-1).elements[0].text).toBe('- x');
  });
});

describe('parseMrkdwn inline triple backticks', () => {
  it('renders ```x``` on one line as inline code', () => {
    const item = blocks('- use ```x``` here')[0].elements[0].elements;
    expect(item).toEqual([
      { type: 'text', text: 'use ' },
      { type: 'text', text: 'x', style: { code: true } },
      { type: 'text', text: ' here' },
    ]);
  });
});

describe('review fixes', () => {
  it('parses Windows line endings like Unix ones', () => {
    const els = blocks('- a\r\n- b\r\nafter');
    expect(els.map((e: any) => e.type)).toEqual(['rich_text_list', 'rich_text_section']);
    expect(els[0].elements.map(sectionText)).toEqual(['a', 'b']);
  });

  it('links bare URLs only on the send path', () => {
    const sent = listBlocksFor('- see https://example.com/a_b_(c). next')![0].elements[0] as any;
    expect(sent.elements[0].elements).toEqual([
      { type: 'text', text: 'see ' },
      { type: 'link', url: 'https://example.com/a_b_(c)' },
      { type: 'text', text: '. next' },
    ]);
    const draft = blocks('- see https://example.com')[0].elements[0].elements;
    expect(draft).toEqual([{ type: 'text', text: 'see https://example.com' }]);
  });

  it('drops an unbalanced closing paren from a bare URL', () => {
    const sent = listBlocksFor('- (see https://example.com/x)')![0].elements[0] as any;
    expect(sent.elements[0].elements[1]).toEqual({ type: 'link', url: 'https://example.com/x' });
  });

  it('turns a fenced block without lists into preformatted text', () => {
    const els = blocks('Run:\n```\nnpm test\n```');
    expect(els.map((e: any) => e.type)).toEqual(['rich_text_section', 'rich_text_preformatted']);
    expect(listBlocksFor('Run:\n```\nnpm test\n```')).toBeUndefined();
  });
});

describe('Markdown links', () => {
  it('become link elements with the label in rich text', () => {
    const els = blocks('filed [F22-7435](https://x.atlassian.net/browse/F22-7435) for you')[0].elements;
    expect(els).toEqual([
      { type: 'text', text: 'filed ' },
      { type: 'link', url: 'https://x.atlassian.net/browse/F22-7435', text: 'F22-7435' },
      { type: 'text', text: ' for you' },
    ]);
  });

  it('become <url|label> in sent text, but not inside code', () => {
    expect(markdownLinksToSlack('see [docs](https://a.b/c) and `[x](https://y.z)`'))
      .toBe('see <https://a.b/c|docs> and `[x](https://y.z)`');
  });

  it('leave brackets that are not links alone', () => {
    expect(markdownLinksToSlack('[WIP] (draft) [a](not a url)')).toBe('[WIP] (draft) [a](not a url)');
    expect(blocks('[WIP] done')[0].elements).toEqual([{ type: 'text', text: '[WIP] done' }]);
  });
});
