import {rmdir} from 'fs/promises';
import tape from 'tape';

import * as u from '../users';

const partialGithubProfile = {
  provider: 'github',
  profileUrl: '',
  _raw: '',
  _json: {},
  displayName: '',
  username: 'Testor'
} as const;

tape('create github with * allowlist', async t => {
  // setup: initialize `u`'s db
  const GOTANDA_USERS_DB = '/tmp/gotanda_test_users_' + (Math.random().toString(36).slice(2));
  u.openDb(GOTANDA_USERS_DB);

  // test
  const githubId = 'testId123';
  const testUser = await u.findOrCreateGithub({...partialGithubProfile, id: githubId}, '*');
  t.ok(testUser, 'user created');
  if (!testUser) { throw new Error('should not happen') }

  const githubVal = await u.getUserSafe('github-' + githubId);
  t.ok(githubVal, 'github key exists');
  t.ok(githubVal?.gotandaId === testUser.gotandaId, 'github val yields gotanda id');

  const gotandaVal = await u.getUserSafe(testUser.gotandaId);
  t.ok(gotandaVal, 'gotanda key exists');
  t.ok(gotandaVal?.gotandaId === testUser.gotandaId, 'gotanda val yields gotanda id');

  t.ok(gotandaVal && gotandaVal.apiTokens === undefined, 'apiTokens is undefined outside users module');

  // teardown
  t.end();
  await u.closeDb();
  await rmdir(GOTANDA_USERS_DB, {recursive: true});
});

tape('test allowlist', async t => {
  // setup
  const GOTANDA_USERS_DB = '/tmp/gotanda_test_users_' + (Math.random().toString(36).slice(2));
  u.openDb(GOTANDA_USERS_DB);

  // test
  let allowed = new Set([] as string[]);

  const githubId = 'testId123';
  {
    const testUser = await u.findOrCreateGithub({...partialGithubProfile, id: githubId}, allowed);
    t.ok(!testUser, 'user NOT created');
  }

  allowed.add(githubId);
  {
    const testUser = await u.findOrCreateGithub({...partialGithubProfile, id: githubId}, allowed);
    t.ok(testUser, 'user created with id');
  }

  // teardown
  t.end();
  await u.closeDb();
  await rmdir(GOTANDA_USERS_DB, {recursive: true});
});

tape('tokens', async t => {
  // setup
  const GOTANDA_USERS_DB = '/tmp/gotanda_test_users_' + (Math.random().toString(36).slice(2));
  u.openDb(GOTANDA_USERS_DB);

  // test
  const githubId = 'testId123';
  const testUser = await u.findOrCreateGithub({...partialGithubProfile, id: githubId}, '*');
  if (!testUser) { throw new Error('should never happen'); }

  t.ok(!(await u.getUserSafe('non-existent token')), 'bad token fails');

  const [name1, name2] = ['test-name', 'test-name-2'];
  const [token1, token2] =
      [await u.createApiToken(testUser.gotandaId, name1), await u.createApiToken(testUser.gotandaId, name2)];
  // above, don't try to create the two tokens with Promise.all: leveldb doesn't have upsert so the two calls can and
  // will stomp on each other, leading to only ONE token created. We should really use SQLite
  if (!(token1 && token2)) { throw new Error('should never happen'); }

  for (const token of [token1, token2]) {
    const viaToken = await u.getUserSafe(token);
    t.ok(viaToken && viaToken.gotandaId === testUser.gotandaId, 'via token');
  }
  t.ok(!(await u.getUserSafe('non-existent token again')), 'bad token still fails');

  const deleteResult = await u.deleteApiToken(testUser.gotandaId, name1);
  t.ok(deleteResult, 'token delete response');

  const viaDeletedToken = await u.getUserSafe(token1);
  t.ok(!viaDeletedToken, 'deleted token fails');
  const viaOkToken = await u.getUserSafe(token2);
  t.ok(viaOkToken && viaOkToken.gotandaId === testUser.gotandaId, 'remaining token still works');

  const deleteAllResult = await u.deleteAllApiTokens(testUser.gotandaId);
  t.ok(deleteAllResult, 'delete all tokens response');

  t.ok((await Promise.all([token1, token2, 'still bad'].map(u.getUserSafe))).every(x => !x), 'all tokens gone');

  // teardown
  t.end();
  await u.closeDb();
  await rmdir(GOTANDA_USERS_DB, {recursive: true});
});

tape('read-only (ro) onlooker links', async t => {
  // setup
  const GOTANDA_USERS_DB = '/tmp/gotanda_test_users_' + (Math.random().toString(36).slice(2));
  u.openDb(GOTANDA_USERS_DB);

  // test
  const [alice, bob, chan] =
      await Promise.all(['a1', 'b2', 'c3'].map(id => u.findOrCreateGithub({...partialGithubProfile, id}, '*')));
  if (!(alice && bob && chan)) { throw new Error('should never happen'); }

  {
    for (const user of [alice, bob, chan]) {
      const links = await u.allOnlookerLinks(user.gotandaId);
      t.ok(links.creators.length === 0 && links.onlookers.length === 0, "neither an onlooker or onlooker be")
    }
  }

  // alice shares app with bob
  const app = 'my-alias-is-alice';
  let addReturn = await u.addOnlookerApp(alice.gotandaId, bob.gotandaId, app);
  t.ok(addReturn, 'alice added bob as an onlooker: response');
  t.ok(await u.validOnlooker(alice.gotandaId, bob.gotandaId, app), "bob can see alice's app");
  t.ok(!await u.validOnlooker(bob.gotandaId, alice.gotandaId, app), "alice cannot see bob's app");
  t.ok(!await u.validOnlooker(alice.gotandaId, chan.gotandaId, app), "chan cannot see alice's app");

  {
    const aliceLinks = await u.allOnlookerLinks(alice.gotandaId);
    t.ok(aliceLinks.creators.length === 0, "alice isn't an onlooker to ANYONE")
    t.deepEqual(aliceLinks.onlookers, [{onlooker: bob.gotandaId, app}], "alice has one onlooker/app pair");
  }
  {
    const bobLinks = await u.allOnlookerLinks(bob.gotandaId);
    t.ok(bobLinks.onlookers.length === 0, "bob doesn't have any onlookers")
    t.deepEqual(bobLinks.creators, [{creator: alice.gotandaId, app}], "bob is onlooking alice's app");
  }
  {
    const chanLinks = await u.allOnlookerLinks(chan.gotandaId);
    t.ok(chanLinks.onlookers.length === 0 && chanLinks.creators.length === 0, "chan has no links");
  }

  // alice shares app2 with bob
  const app2 = 'my-other-app';
  addReturn = await u.addOnlookerApp(alice.gotandaId, bob.gotandaId, app2);
  t.ok(addReturn, 'alice added bob as an onlooker to another app: response');
  for (const a of [app, app2]) {
    t.ok(await u.validOnlooker(alice.gotandaId, bob.gotandaId, a), "bob can see still alice's app " + a);
    t.ok(!await u.validOnlooker(alice.gotandaId, chan.gotandaId, a), "chan cannot see alice's app " + a);
  }
  {
    const aliceLinks = await u.allOnlookerLinks(alice.gotandaId);
    t.ok(aliceLinks.creators.length === 0, "alice still isn't an onlooker to ANYONE");
    t.ok(aliceLinks.onlookers.length === 2, "alice has two onlooker/app pairs");
  }
  {
    const bobLinks = await u.allOnlookerLinks(bob.gotandaId);
    t.ok(bobLinks.onlookers.length === 0, "bob doesn't have any onlookers");
    t.ok(bobLinks.creators.length === 2, "bob is onlooking two app");
  }
  {
    const chanLinks = await u.allOnlookerLinks(chan.gotandaId);
    t.ok(chanLinks.onlookers.length === 0 && chanLinks.creators.length === 0, "chan still has no links");
  }

  // alice shares app3 with bob and chan
  const app3 = 'app3';
  await u.addOnlookerApp(alice.gotandaId, bob.gotandaId, app3);
  await u.addOnlookerApp(alice.gotandaId, chan.gotandaId, app3);
  t.ok(await u.validOnlooker(alice.gotandaId, bob.gotandaId, app3), "bob can see alice's app3");
  t.ok(await u.validOnlooker(alice.gotandaId, chan.gotandaId, app3), "chan can see alice's app3");
  {
    const aliceLinks = await u.allOnlookerLinks(alice.gotandaId);
    t.ok(aliceLinks.creators.length === 0, "alice still isn't an onlooker to ANYONE");
    t.ok(aliceLinks.onlookers.length === 4, "alice has 4 onlooker/app pairs");
  }
  {
    const bobLinks = await u.allOnlookerLinks(bob.gotandaId);
    t.ok(bobLinks.onlookers.length === 0, "bob doesn't have any onlookers");
    t.ok(bobLinks.creators.length === 3, "bob is onlooking 3 apps");
  }
  {
    const chanLinks = await u.allOnlookerLinks(chan.gotandaId);
    t.ok(chanLinks.onlookers.length === 0, "chan has no onlookers");
    t.ok(chanLinks.creators.length === 1, "chan is onlooking 1 app");
  }

  // alice removes bob as app3 onlooker
  await u.delOnlookerApp(alice.gotandaId, bob.gotandaId, app3);
  t.ok(!await u.validOnlooker(alice.gotandaId, bob.gotandaId, app3), "alice has deleted bob's app3 onlooker link");
  t.ok(await u.validOnlooker(alice.gotandaId, bob.gotandaId, app2), "but bob can still see alice's app2");
  t.ok(await u.validOnlooker(alice.gotandaId, bob.gotandaId, app), "and app");
  t.ok(await u.validOnlooker(alice.gotandaId, chan.gotandaId, app3), "chan can still see alice's app3");
  {
    const aliceLinks = await u.allOnlookerLinks(alice.gotandaId);
    t.ok(aliceLinks.creators.length === 0 && aliceLinks.onlookers.length === 3);
  }
  {
    const bobLinks = await u.allOnlookerLinks(bob.gotandaId);
    t.ok(bobLinks.onlookers.length === 0 && bobLinks.creators.length === 2);
  }
  {
    const chanLinks = await u.allOnlookerLinks(chan.gotandaId);
    t.ok(chanLinks.onlookers.length === 0 && chanLinks.creators.length === 1);
  }

  // alice stops sharing all apps with bob
  await u.delOnlooker(alice.gotandaId, bob.gotandaId);
  for (const a of [app, app2, app3]) {
    t.ok(!await u.validOnlooker(bob.gotandaId, alice.gotandaId, a), "bob can't see alice's " + a);
  }
  t.ok(await u.validOnlooker(alice.gotandaId, chan.gotandaId, app3), "chan is unaffected");
  {
    const aliceLinks = await u.allOnlookerLinks(alice.gotandaId);
    t.ok(aliceLinks.creators.length === 0 && aliceLinks.onlookers.length === 1);
  }
  {
    const bobLinks = await u.allOnlookerLinks(bob.gotandaId);
    t.ok(bobLinks.onlookers.length === 0 && bobLinks.creators.length === 0, "bob doesn't have any links")
  }
  {
    const chanLinks = await u.allOnlookerLinks(chan.gotandaId);
    t.ok(chanLinks.onlookers.length === 0 && chanLinks.creators.length === 1);
  }

  // alice shares app3 with bob again
  await u.addOnlookerApp(alice.gotandaId, bob.gotandaId, app2);

  // then stops sharing everything with everyone
  await u.delOnlookers(alice.gotandaId);
  for (const a of [app, app2, app3]) {
    for (const user of [bob, chan]) {
      t.ok(!await u.validOnlooker(user.gotandaId, alice.gotandaId, a), "others can't see alice's " + a);
    }
  }
  for (const user of [alice, bob, chan]) {
    const links = await u.allOnlookerLinks(chan.gotandaId);
    t.ok(links.creators.length === 0 && links.onlookers.length === 0);
  }

  // teardown
  t.end();
  await u.closeDb();
  await rmdir(GOTANDA_USERS_DB, {recursive: true});
});
