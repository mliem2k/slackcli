import { describe, expect, it } from 'bun:test';
import { type NameLookupClient, resolveTextMentions } from './name-resolver.ts';

const USERS = [
  { id: 'U06V56X9T9U', name: 'liem.michael', real_name: 'Michael Liem' },
  { id: 'U0ZHIWEI01', name: 'zhiwei', real_name: 'ZhiWei Lu' },
  { id: 'U0CHRIS001', name: 'christopher.tseng', real_name: 'Christopher Tseng' },
  { id: 'U0CHRIS002', name: 'chris.other', real_name: 'Christopher Other' },
  { id: 'U0GONE0001', name: 'gone', real_name: 'Gone Person', deleted: true },
  { id: 'B0BOT00001', name: 'botty', real_name: 'Botty', is_bot: true },
];

function stub(): NameLookupClient & { calls: number } {
  const client = {
    calls: 0,
    async listConversations() { return { channels: [] }; },
    async listUsers() { client.calls += 1; return { members: USERS }; },
    async lookupUserByEmail() { return {}; },
  };
  return client;
}

describe('resolveTextMentions', () => {
  it('turns an exact handle into a mention', async () => {
    const r = await resolveTextMentions(stub(), 'thanks @liem.michael.');
    expect(r.text).toBe('thanks <@U06V56X9T9U>.');
    expect(r.unresolved).toEqual([]);
  });

  it('matches handles case-insensitively', async () => {
    const r = await resolveTextMentions(stub(), '@ZhiWei please check');
    expect(r.text).toBe('<@U0ZHIWEI01> please check');
  });

  it('uses a first name only when exactly one person has it', async () => {
    const one = await resolveTextMentions(stub(), 'hi @Michael');
    expect(one.text).toBe('hi <@U06V56X9T9U>');
    const two = await resolveTextMentions(stub(), 'hi @Christopher');
    expect(two.text).toBe('hi @Christopher');
    expect(two.unresolved).toEqual(['Christopher']);
  });

  it('leaves unknown names, deleted users and bots as plain text', async () => {
    const r = await resolveTextMentions(stub(), '@nobody @gone @botty');
    expect(r.text).toBe('@nobody @gone @botty');
    expect(r.unresolved.sort()).toEqual(['botty', 'gone', 'nobody']);
  });

  it('converts a raw user ID without any lookup', async () => {
    const client = stub();
    const r = await resolveTextMentions(client, 'cc @U06V56X9T9U');
    expect(r.text).toBe('cc <@U06V56X9T9U>');
    expect(client.calls).toBe(0);
  });

  it('never touches emails, existing tokens, broadcasts or code', async () => {
    const client = stub();
    const text = 'mail liem.michael@frontier.cool, <@U0ZHIWEI01>, @here, `@zhiwei` and ```@zhiwei```';
    const r = await resolveTextMentions(client, text);
    expect(r.text).toBe(text);
    expect(client.calls).toBe(0);
  });

  it('makes no call when the text has no mention', async () => {
    const client = stub();
    await resolveTextMentions(client, 'plain text');
    expect(client.calls).toBe(0);
  });

  it('resolves several names with one users.list scan', async () => {
    const client = stub();
    const r = await resolveTextMentions(client, '(@zhiwei) and "@liem.michael"');
    expect(r.text).toBe('(<@U0ZHIWEI01>) and "<@U06V56X9T9U>"');
    expect(client.calls).toBe(1);
  });
});
