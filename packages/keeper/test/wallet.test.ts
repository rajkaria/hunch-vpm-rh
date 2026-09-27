import { loadDeployment } from '@hunch-rh/client';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { KeeperKeyError, NOT_DEPLOYED_NOTE, createKeeper, makeAlerter, makeKeeperClients, readKeeperKey, validateCorporateActions, loadCorporateActions, corporateActionIn } from '../src/index.js';

const d = loadDeployment({ env: {} });

describe('keeper key and transports', () => {
  it('reads KEEPER_PRIVATE_KEY only from env, with or without 0x, and never echoes a bad value', () => {
    const key = generatePrivateKey();
    expect(readKeeperKey({ KEEPER_PRIVATE_KEY: key })).toBe(key);
    expect(readKeeperKey({ KEEPER_PRIVATE_KEY: key.slice(2) })).toBe(key);
    expect(readKeeperKey({})).toBeNull();
    const bad = 'not-a-key-but-a-secret-looking-string';
    try {
      readKeeperKey({ KEEPER_PRIVATE_KEY: bad });
      throw new Error('expected a throw');
    } catch (error) {
      expect(error).toBeInstanceOf(KeeperKeyError);
      expect((error as Error).message).not.toContain(bad);
    }
  });

  it('builds a wallet for the key and a redactor that scrubs the key and keyed RPC URLs', () => {
    const key = generatePrivateKey();
    const rpc = 'https://robinhood-mainnet.g.alchemy.com/v2/SuperSecretAlchemyKey123';
    const c = makeKeeperClients({ deployment: d, env: { KEEPER_PRIVATE_KEY: key, RH_RPC_URL: rpc, TELEGRAM_BOT_TOKEN: '123456:telegram-token-value' } });
    expect(c.account).toBe(privateKeyToAccount(key).address);
    expect(c.walletClient).not.toBeNull();
    const leaked = `boom ${key} ${key.slice(2)} ${rpc} 123456:telegram-token-value`;
    const clean = c.redact(leaked);
    expect(clean).not.toContain(key.slice(2));
    expect(clean).not.toContain('SuperSecretAlchemyKey123');
    expect(clean).not.toContain('telegram-token-value');
    expect(c.describe).not.toContain('SuperSecretAlchemyKey123');
    expect(c.describe).toContain('robinhood-mainnet.g.alchemy.com/v2/***');
  });

  it('dry runs need no key', () => {
    const c = makeKeeperClients({ deployment: d, env: {}, withWallet: false });
    expect(c.walletClient).toBeNull();
    expect(c.describe).toContain('no keeper key (read-only)');
  });
});

describe('alerts', () => {
  it('is a no-op without Telegram env, and posts redacted text with it', async () => {
    expect(makeAlerter({}).enabled).toBe(false);
    expect(await makeAlerter({}).page('x')).toBe(false);
    const calls: { url: string; body: string }[] = [];
    const a = makeAlerter(
      { TELEGRAM_BOT_TOKEN: 'tok', TELEGRAM_CHAT_ID: '42' },
      { fetch: async (url, init) => (calls.push({ url, body: init.body }), { ok: true }), redact: (t) => t.replace('secret', '***') },
    );
    expect(await a.page('secret thing failed')).toBe(true);
    expect(calls[0]!.url).toBe('https://api.telegram.org/bottok/sendMessage');
    expect(JSON.parse(calls[0]!.body)).toMatchObject({ chat_id: '42', text: 'Hunch keeper: *** thing failed' });
    const failing = makeAlerter({ TELEGRAM_BOT_TOKEN: 'tok', TELEGRAM_CHAT_ID: '42' }, { fetch: async () => { throw new Error('down'); } });
    expect(await failing.page('x')).toBe(false);
  });
});

describe('corporate actions file', () => {
  it('ships empty and valid, and the overlap rule is inclusive', () => {
    expect(loadCorporateActions()).toEqual([]);
    expect(validateCorporateActions({ actions: [{ ticker: 'NVDA', date: '2026-10-1', kind: 'split', source: 'x' }] }).length).toBe(2);
    const actions = [{ ticker: 'NVDA', date: '2026-10-02', until: '2026-10-05', kind: 'split' as const, source: 'https://example.com' }];
    expect(corporateActionIn(actions, 'nvda', '2026-10-05', '2026-10-05')).not.toBeNull();
    expect(corporateActionIn(actions, 'NVDA', '2026-10-06', '2026-10-09')).toBeNull();
    expect(corporateActionIn(actions, 'TSLA', '2026-10-01', '2026-10-09')).toBeNull();
  });
});

describe('createKeeper (route-handler facade)', () => {
  it('runs, relays and reports health truthfully before deployment, without a key', async () => {
    const keeper = createKeeper({}, { log: { info() {}, warn() {}, error() {} } });
    expect(keeper.deployment.status).toBe('not-deployed');
    const reports = await keeper.run('all', { dryRun: true });
    expect(reports.every((r) => r.notes[0] === NOT_DEPLOYED_NOTE)).toBe(true);
    expect(await keeper.relay({}, { country: 'IN', ip: '203.0.113.1' })).toMatchObject({ ok: false, code: 'not-deployed', status: 503 });
  });
});
