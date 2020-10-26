import {randomBytes as randomBytesOrig} from 'crypto';
import {isRight} from 'fp-ts/lib/Either';
import * as t from 'io-ts';
import levelup from 'levelup';
import GitHubStrategy from 'passport-github';
import {promisify} from 'util';

const randomBytes = promisify(randomBytesOrig);

export type Db = ReturnType<typeof levelup>;
const db: Db = (require('level'))(__dirname + '/.data/gotanda-users-db', {valueEncoding: 'json'});

const Onlookers = t.record(t.string, t.record(t.string, t.boolean)); // other user -> my app -> true/false (read-only)
const Onlookees =
    t.record(t.string, t.record(t.string, t.boolean)); // other user -> their app -> true/false (read-only)
const User = t.intersection([
  t.type({
    gotandaId: t.string,
    apiTokens: t.array(t.type({token: t.string, name: t.string})),
  }),
  t.partial({
    onlookers: Onlookers,
    onlookees: Onlookees,
  }),
  // we'll later allow sign up with others SSO, not just GitHub
  t.partial({github: t.UnknownRecord}),
]);
export type IUser = t.TypeOf<typeof User>;

async function getKey(key: string): Promise<any|undefined> {
  try {
    const ret = await db.get(key);
    return ret;
  } catch { return undefined; }
}

// DO NOT EXPORT THIS, use getUserSafe (below)!
/**
 * Convert a user key in the users database to the User object, if availab.e
 *
 * N.B., GitHub keys `github-<ID>` use the numeric GitHub ID, *not* usernames (since usernames can change)
 *
 * @param key `gotanda-<ID>` OR `github-<ID>` OR `token-<ID>`, etc., anything we use to find users
 * @param allowNonGotandaKey allow `key` to be non-Gotanda-ID (only used to prevent infinite loop searches)
 */
async function getUser(key: string, allowNonGotandaKey = true): Promise<IUser|undefined> {
  const ret = await getKey(key);
  if (ret === undefined) { return undefined; }
  const decoded = User.decode(ret);
  if (isRight(decoded)) { return decoded.right; }
  // if `key` is a Gotanda ID, it's value `ret` will be a `User`.

  // did we pass in a github or token as `key`?
  if (allowNonGotandaKey) {
    if (typeof ret === 'string') {
      // `key` has stringy value, rather than object, which is the case for GitHub or tokens. Use that value as a db key
      // and see if we find a user there.
      const existing = await getUser(ret, false);
      const decoded = User.decode(existing);
      if (isRight(decoded)) { return decoded.right; }
    }
  }
  console.error(`io-ts decode error for User object for key ${key}`);
  return undefined;
}

/**
 * Safe version of `getUser`; "safe" in that API tokens are explicitly forbidden from appearing in the output
 * @param key same as `getUser`
 */
export async function getUserSafe(key: string): Promise<(Omit<IUser, 'apiTokens'>& {apiTokens: undefined})|undefined> {
  const ret = await getUser(key);
  if (!ret) { return ret; }
  return {...ret, apiTokens: undefined};
}

/*
The database stores the following keys and values:
- `gotanda-<random string not including slash>` => IUser object (i.e., a Gotanda user record)
- `github-<GitHub id>` => a string which is a Gotanda user record's key (i.e., `gotanda-<random string>`)
- `token-<random string>` => ditto (a string which is the key to a IUser)

When we get a GitHub profile, we look up whether `github-<id>` exists in the database. If it does, we fetch its value
and in turn use that as a key to look up the Gotanda user record.
*/

async function base64urlRandom(nbytes: number) {
  return (await randomBytes(nbytes)).toString('base64').replace(/\//g, '_').replace(/\+/g, '-');
}

export async function findOrCreateGithub(profile: GitHubStrategy.Profile, allowlist: '*'|
                                         {username: Set<string>, id: Set<string>}): Promise<IUser|undefined> {
  if (typeof allowlist === 'object') {
    const {username, id} = allowlist;
    if (!((profile.username && username.has(profile.username)) || id.has(profile.id))) { return undefined; }
  }
  const githubId = `github-${profile.id}`;
  const hit = await getKey(githubId);
  if (hit) {
    // GitHub user is also a Gotanda user!
    const existing = await getUser(hit);
    if (existing) { return existing; }
    // We had a record of this GitHub user but not the Gotanda user it pointed to?
    // Something very strange must have happened but we can deal with it.
    console.error(`${githubId} points to ${hit} which doesn't exist. Creating.`);
  }
  // new user

  // find a random string that we don't already have in the db
  let newGotandaId = ''; // Not used for return logins
  while (!newGotandaId) {
    // RFC 4648 §5: base64url
    const attempt = await base64urlRandom(9);
    if (!(await getKey(attempt))) { newGotandaId = 'gotanda-' + attempt; }
  }

  const github: Partial<typeof profile> = {...profile};
  // I'm not comfortable storing this. I'd like to store even less (no name, avatar, etc.) but for now:
  delete github['_json'];
  delete github['_raw'];
  const ret: IUser = {github, gotandaId: newGotandaId, apiTokens: []};

  await db.batch().put(githubId, newGotandaId).put(newGotandaId, ret).write();
  return ret;
}

export async function findApiToken(token: string): Promise<IUser|undefined> {
  const hit = await getKey(token);
  if (hit) {
    const existing = await getUser(hit);
    if (existing && existing.apiTokens && existing.apiTokens.find(o => o.token === token)) { return existing; }
    // token points to user either non-existent or who deleted this token but wasn't cleaned up. Delete it.
    await deleteOrphanApiToken(token);
  }
  return undefined;
}

async function deleteOrphanApiToken(token: string): Promise<boolean> { return db.del(token).then(() => true); }

export async function createApiToken(gotandaId: string, name: string): Promise<string|undefined> {
  const newToken = 'token-' + await base64urlRandom(21);
  // I should check to make sure there's no collisions but seriously that's so unrealistic. E.g., BT DHT just treats
  // randomly-generated 160-bit (20-byte) buffers as "globally unique".

  // make sure input ID is valid
  const user = await getUser(gotandaId);
  if (!user) { return undefined; }

  // add this token
  if (!user.apiTokens) { user.apiTokens = []; }
  user.apiTokens.push({token: newToken, name});
  // commit to db
  await db.batch().put(newToken, gotandaId).put(gotandaId, user).write();
  return newToken;
}

export async function deleteApiToken(gotandaId: string, name: string): Promise<boolean> {
  const user = await getUser(gotandaId);
  if (!user) { return false; }
  if (!user.apiTokens || user.apiTokens.length === 0) { return true; }

  const batch = db.batch();
  {
    const newApiTokens: typeof user.apiTokens = [];
    for (const o of user.apiTokens) {
      if (o.name === name) {
        batch.del(o.token)
      } else {
        newApiTokens.push(o);
      }
    }
    // if `name` isn't found, don't touch the database
    if (newApiTokens.length === user.apiTokens.length) { return true; }
    user.apiTokens = newApiTokens;
  }

  await batch.put(gotandaId, user).write();
  return true;
}

export async function deleteAllApiTokens(gotandaId: string): Promise<boolean> {
  const user = await getUser(gotandaId);
  if (!user) { return false; }
  if (!user.apiTokens || user.apiTokens.length === 0) { return true }
  const batch = db.batch();
  for (const token of user.apiTokens) { batch.del(token.token); }
  user.apiTokens = [];
  batch.put(gotandaId, user);
  await batch.write();
  return true;
}

export async function getAllApiTokenNames(gotandaId: string): Promise<string[]> {
  const user = await getUser(gotandaId);
  if (!user || !user.apiTokens) { return []; }
  return user.apiTokens.map(o => o.name);
}

function convertUserOrId(userOrId: string|IUser) { return typeof userOrId === 'string' ? getUser(userOrId) : userOrId; }
export async function addOnlookerApp(userOrId: string|IUser, onlookerOrId: string|IUser, app: string) {
  const [user, onlooker] = await Promise.all([convertUserOrId(userOrId), convertUserOrId(onlookerOrId)])
  if (!user || !onlooker) { return false; } // false tells the caller their intention wasn't satisfied

  const batch = db.batch();
  {
    // this will mutate the input even for the caller (unless `onlookers` isn't in `user`), but that's fine
    const onlookers = user.onlookers || {};
    if (!(onlooker.gotandaId in onlookers)) { onlookers[onlooker.gotandaId] = {}; }
    onlookers[onlooker.gotandaId][app] = true;
    const doc: IUser = {...user, onlookers};
    batch.put(doc.gotandaId, doc);
  }
  {
    // same caveat as above
    const onlookees = user.onlookers || {};
    if (!(user.gotandaId in onlookees)) { onlookees[user.gotandaId] = {}; }
    onlookees[user.gotandaId][app] = true;
    const doc: IUser = {...onlooker, onlookees};
    batch.put(doc.gotandaId, doc);
  }
  await batch.write();
  return true;
}

export async function delOnlookerApp(userOrId: string|IUser, onlookerOrId: string|IUser, app: string) {
  const [user, onlooker] = await Promise.all([convertUserOrId(userOrId), convertUserOrId(onlookerOrId)])
  if (!user || !onlooker) { return false; } // false tells the caller their intention wasn't satisfied

  const batch = db.batch();
  if (user.onlookers && user.onlookers[onlooker.gotandaId] && user.onlookers[onlooker.gotandaId][app]) {
    delete user.onlookers[onlooker.gotandaId][app];
    batch.put(user.gotandaId, user);
  }
  if (onlooker.onlookees && onlooker.onlookees[user.gotandaId] && onlooker.onlookees[user.gotandaId][app]) {
    delete onlooker.onlookees[user.gotandaId][app];
    batch.put(onlooker.gotandaId, onlooker);
  }
  await batch.write();
  return true;
}

export async function delOnlooker(userOrId: string|IUser, onlookerOrId: string|IUser) {
  const [user, onlooker] = await Promise.all([convertUserOrId(userOrId), convertUserOrId(onlookerOrId)])
  if (!user || !onlooker) { return false; } // false tells the caller their intention wasn't satisfied

  const batch = db.batch();
  if (user.onlookers) {
    delete user.onlookers[onlooker.gotandaId];
    batch.put(user.gotandaId, user);
  }
  if (onlooker.onlookees) {
    delete onlooker.onlookees[user.gotandaId];
    batch.put(onlooker.gotandaId, onlooker);
  }
  await batch.write();
  return true;
}

export async function delOnlookers(userOrId: string|IUser) {
  const user = await convertUserOrId(userOrId);
  if (user && user.onlookers) {
    // unlink all onlooker->user relationships
    await Promise.all(Object.keys(user.onlookers).map(k => delOnlooker(user, k)));
    // Onlookers will no longer see `user` in their list of `onlookees`.
    // Furthermore, `user.onlookers` will be `{}`
  }
  return true;
}

if (module === require.main) { db.createReadStream().on('data', data => console.log(data)); }