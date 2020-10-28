import {spawn} from 'child_process';
import {rmdir} from 'fs/promises';
import {sync as mkdirpSync} from 'mkdirp';
import fetch from 'node-fetch';
import PouchDB from 'pouchdb';
import PouchUpsert from 'pouchdb-upsert';
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
PouchDB.plugin(PouchUpsert);
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

  // helpers
  const makeHeader = (token: string, method = 'GET') => ({method, headers: {Authorization: `Bearer ${token}`}});
  async function testToken(token: string) { return (await fetch(`${baseUrl}/loginstatus`, makeHeader(token))).ok; }

  // make sure tokens all work
  for (const token of [aliceToken, bobToken, chanToken]) { t.ok(await testToken(token), 'token ok'); }
  // make sure we can get token names
  {
    const tokenNames = await (await fetch(`${baseUrl}/auth/tokens`, makeHeader(aliceToken))).json();
    t.ok(tokenNames.length === 1 && tokenNames[0] === initTokenName, 'one token name')
  }

  ///////////
  // Test PouchDB!
  ///////////
  const db = new PouchDB('localdb', {adapter: 'memory'});
  await db.upsert('test1', () => ({text: 'hello world'}));
  await db.upsert('test2', () => ({text: 'hello pouch'}));

  {
    // alice creates a remote db and syncs to it
    const remoteDb = new PouchDB(`${baseUrl}/db/adb`, {
      fetch: (url, opts) => {
        if (!opts) { opts = {}; }
        opts.headers.set('Authorization', `Bearer ${aliceToken}`);
        return PouchDB.fetch(url, opts);
      }
    });
    t.ok((await remoteDb.allDocs()).rows.length === 0, 'initial remote db has 0 rows');
    await db.replicate.to(remoteDb);
    t.ok((await remoteDb.allDocs()).rows.length === 2, 'after initial replication, remote has 2 rows');

    t.ok((await fetch(`${baseUrl}/db/adb`, makeHeader(aliceToken))).ok, 'alice can GET db');

    const onlookUrl = `${baseUrl}/owner/${alice.gotandaId}/app/adb`;
    t.ok(!(await fetch(onlookUrl, makeHeader(bobToken))).ok, "bob can't");
    t.ok(!(await fetch(onlookUrl, makeHeader(chanToken))).ok, "chan can't");

    // alice allows bob to be an onlooker to `adb`
    await fetch(`${baseUrl}/me/onlooker/${bob.gotandaId}/app/adb`, makeHeader(aliceToken, 'PUT'));
    t.ok((await fetch(onlookUrl, makeHeader(bobToken))).ok, "bob can now GET alice's db");
    t.ok(!(await fetch(onlookUrl, makeHeader(chanToken))).ok, "chan still can't");

    // bob can replicate alice's `adb`
    const bobDb = new PouchDB('bobdb', {adapter: 'memory'});
    const bobRemote = new PouchDB(onlookUrl, {
      fetch: (url, opts) => {
        if (!opts) { opts = {}; }
        opts.headers.set('Authorization', `Bearer ${bobToken}`);
        return PouchDB.fetch(url, opts);
      }
    });
    await bobDb.replicate.from(bobRemote);
    t.ok((await bobDb.allDocs()).rows.length === 2, 'bob has both rows');

    // alice adds a new document to local and replicates it to Gotanda
    await db.upsert('test3', () => ({text: 'hello bob'}));
    await db.replicate.to(remoteDb);
    // bob can now see the new doc
    await bobDb.replicate.from(bobRemote);
    t.ok((await bobDb.allDocs()).rows.length === 3, 'bob has the new row');

    // bob can't write to alice's database
    try {
      await bobRemote.upsert('evil bob', () => ({wont: 'work'}));
      t.ok(false, 'this should have thrown')
    } catch (e) { t.ok(true, "bob can't write to alice's db"); }
    t.ok((await remoteDb.allDocs()).rows.length === 3, 'alice remote still has 3 rows');

    // bob can write to his db but can't replicate to alice's database
    try {
      await bobDb.replicate.to(bobRemote);
      t.ok(false, 'this should have thrown')
    } catch (e) { t.ok(true, "bob can't sync to alice's db"); }

    // alice can allow chan to be an onlooker with just github ID, not gotandaId:
    t.ok((await fetch(`${baseUrl}/me/onlooker/github-${chan.github?.id}/app/adb`, makeHeader(aliceToken, 'PUT'))).ok);
    // and chan can access it without knowing alice's gotandaId
    const chanRemote = new PouchDB(`${baseUrl}/owner/github-${alice.github?.id}/app/adb`, {
      fetch: (url, opts) => {
        if (!opts) { opts = {}; }
        opts.headers.set('Authorization', `Bearer ${chanToken}`);
        return PouchDB.fetch(url, opts);
      }
    });
    t.ok((await chanRemote.allDocs()).rows.length === 3, 'chan sees 3 docs without anyone needing gotandaIds');
  }

  ///////////
  // test deleting tokens
  ///////////
  async function createToken(oldToken: string, newName: string) {
    const res = await fetch(`${baseUrl}/auth/token/${newName}`, makeHeader(oldToken));
    const newToken = await res.json();
    t.ok((await fetch(`${baseUrl}/loginstatus`, makeHeader(newToken))).ok, 'new token ok');
    return newToken;
  }

  // make sure if we create new tokens with the same name, the old ones no longer work
  {
    const secondToken = await createToken(aliceToken, 'second');
    await createToken(aliceToken, 'second'); // NEW token with SAME name: old one should be dead
    t.ok(!await testToken(secondToken), 'previous token invalidated');

    const tokenNames = await (await fetch(`${baseUrl}/auth/tokens`, makeHeader(aliceToken))).json();
    t.deepEqual(tokenNames.sort(), [initTokenName, 'second'].sort(), 'two token names');
  }
  // test deleting some and all tokens
  {
    const newToken = await createToken(aliceToken, 'new1');
    const newToken2 = await createToken(aliceToken, 'new2');

    const tokenNames = await (await fetch(`${baseUrl}/auth/tokens`, makeHeader(aliceToken))).json();
    t.deepEqual(tokenNames.sort(), [initTokenName, 'second', 'new1', 'new2'].sort(), '4 token names');

    // created and tested new tokens. Now delete just one
    await fetch(`${baseUrl}/auth/token/new1`, makeHeader(aliceToken, 'DELETE'));
    t.ok(!await testToken(newToken), 'deleted token invalidated');
    t.ok(await testToken(newToken2), 'but other one is fine');
    t.ok(await testToken(aliceToken), 'original is fine too');

    await fetch(`${baseUrl}/auth/tokens`, makeHeader(aliceToken, 'DELETE'));
    for (const token of [aliceToken, newToken, newToken2]) { t.ok(!await testToken(token), 'all tokens gone'); }
  }

  // cleanup
  t.end();
  spawned.kill();
  rmdir(tmpData, {recursive: true});
});

function sleep(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }