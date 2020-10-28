import {spawn} from 'child_process';
import {rmdir} from 'fs/promises';
import {sync as mkdirpSync} from 'mkdirp';
import fetch from 'node-fetch';
import PouchDB from 'pouchdb';
import tape from 'tape';

import * as u from '../users';

// inputs
const tmpData = '/tmp/gotanda-test-' + Math.random().toString(36).slice(2);
const env = {
  SESSION_STORE: `${tmpData}/sessions`,
  POUCH_PREFIX: `${tmpData}/pouches`,
  GOTANDA_USERS_DB: `${tmpData}/users`,
  PORT: '4599',
};

// setup
mkdirpSync(env.GOTANDA_USERS_DB);
mkdirpSync(env.SESSION_STORE);
mkdirpSync(env.POUCH_PREFIX);
PouchDB.plugin(require('pouchdb-adapter-memory'));
const baseUrl = `http://127.0.0.1:${env.PORT}`;

// run
tape('everything', async t => {
  // prepopulate users: we don't want to test Github workflow here
  u.openDb(env.GOTANDA_USERS_DB);
  const partialGithubProfile =
      {provider: 'github', profileUrl: '', _raw: '', _json: {}, displayName: '', username: 't'} as const;
  const [alice, bob, chan] =
      await Promise.all(['a1', 'b2', 'c3'].map(id => u.findOrCreateGithub({...partialGithubProfile, id}, '*')));
  if (!(alice && bob && chan)) { throw new Error('users not created?'); }

  // Create tokens. We have to do this here because the real way to create tokens is to present a cookie to the server
  const initTokenName = 'initTokenName';
  const [aliceToken, bobToken, chanToken] =
      await Promise.all([alice, bob, chan].map(x => u.createApiToken(x.gotandaId, initTokenName)));
  if (!(aliceToken && bobToken && chanToken)) { throw new Error('failed to create tokens?'); }
  u.closeDb();
  // we have to close the users database so when the full Gotanda server starts up below, it'll be able to open it.
  // Leveldb is single-process alas.

  // Spawn new server
  const spawned = spawn('node', ['index.js'], {env: {...process.env, ...env}});
  // (apparently I need to include process.env above, otherwise Node can't find `node`)
  spawned.stdout.on('data', (data) => {console.log('>> ' + data)});

  // wait for server to start
  await sleep(1000);

  {
    const res = await fetch(baseUrl);
    t.ok((await res.text()).includes('Login with'), 'initial visit ok');
  }

  // helper
  async function testToken(token: string) {
    return (await fetch(`${baseUrl}/loginstatus`, {headers: {Authorization: `Bearer ${token}`}})).ok;
  }

  // make sure tokens all work
  for (const token of [aliceToken, bobToken, chanToken]) { t.ok(await testToken(token), 'token ok'); }
  // make sure we can get token names
  {
    const tokenNames =
        await (await fetch(`${baseUrl}/auth/tokens`, {headers: {Authorization: `Bearer ${aliceToken}`}})).json();
    t.ok(tokenNames.length === 1 && tokenNames[0] === initTokenName, 'one token name')
  }

  // test deleting tokens
  async function createToken(oldToken: string, newName: string) {
    const res = await fetch(`${baseUrl}/auth/token/${newName}`, {headers: {Authorization: `Bearer ${oldToken}`}});
    const newToken = await res.json();
    t.ok((await fetch(`${baseUrl}/loginstatus`, {headers: {Authorization: `Bearer ${newToken}`}})).ok, 'new token ok');
    return newToken;
  }

  // make sure if we create new tokens with the same name, the old ones no longer work
  {
    const secondToken = await createToken(aliceToken, 'second');
    await createToken(aliceToken, 'second');
    t.ok(!await testToken(secondToken), 'previous token invalidated');

    const tokenNames =
        await (await fetch(`${baseUrl}/auth/tokens`, {headers: {Authorization: `Bearer ${aliceToken}`}})).json();
    t.deepEqual(tokenNames.sort(), [initTokenName, 'second'].sort(), 'two token names');
  }
  // test deleting some and all tokens
  {
    const newToken = await createToken(aliceToken, 'new1');
    const newToken2 = await createToken(aliceToken, 'new2');

    const tokenNames =
        await (await fetch(`${baseUrl}/auth/tokens`, {headers: {Authorization: `Bearer ${aliceToken}`}})).json();
    t.deepEqual(tokenNames.sort(), [initTokenName, 'second', 'new1', 'new2'].sort(), '4 token names');

    // created and tested new tokens. Now delete just one
    await fetch(`${baseUrl}/auth/token/new1`, {method: 'DELETE', headers: {Authorization: `Bearer ${aliceToken}`}});
    t.ok(!await testToken(newToken), 'deleted token invalidated');
    t.ok(await testToken(newToken2), 'but other one is fine');
    t.ok(await testToken(aliceToken), 'original is fine too');

    await fetch(`${baseUrl}/auth/tokens`, {method: 'DELETE', headers: {Authorization: `Bearer ${aliceToken}`}})
    for (const token of [aliceToken, newToken, newToken2]) { t.ok(!await testToken(token), 'all tokens gone'); }
  }

  // cleanup
  spawned.kill();
  rmdir(tmpData, {recursive: true});
});

function sleep(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }