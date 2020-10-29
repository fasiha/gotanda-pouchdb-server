import {randomBytes as randomBytesOrig} from 'crypto';
import {isRight} from 'fp-ts/lib/Either';
import * as t from 'io-ts';
import levelup from 'levelup';
import GitHubStrategy from 'passport-github';
import {promisify} from 'util';

const randomBytes = promisify(randomBytesOrig);

type Db = ReturnType<typeof levelup>;
let db: Db;
// This user `db` contains API tokens, so we don't export it out of this module at all. To facilitate testing, we
// provide functions to open and close it
export function openDb(path = process.env.GOTANDA_USERS_DB || (__dirname + '/.data/gotanda-users-db')) {
  db = (require('level'))(path, {valueEncoding: 'json'});
}
export async function closeDb() { return db.close(); }

const User = t.intersection([
  t.type({
    gotandaId: t.string,
    apiTokens: t.array(t.type({token: t.string, name: t.string})),
  }),
  // we'll later allow sign up with others SSO, not just GitHub
  t.partial({github: t.UnknownRecord}),
]);
type IUserUNSAFE = t.TypeOf<typeof User>;
// IUser is the type that lives in the db that we want io-ts to validation
export type IUser = Omit<t.TypeOf<typeof User>, 'apiTokens'>&{apiTokens: undefined};
// IUserSafe OMITS API tokens: these values are safe to see outside this library. NO `export`ed funnction should accept
// or return IUser, only IUserSafe!!

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
async function getUser(key: string, allowNonGotandaKey = true): Promise<IUserUNSAFE|undefined> {
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
export async function getUserSafe(key: string): Promise<IUser|undefined> {
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
    const existing = await getUserSafe(hit);
    if (existing) { return existing; }
    // We had a record of this GitHub user but not the Gotanda user it pointed to?
    // Something very strange must have happened but we can deal with it.
    console.error(`${githubId} points to ${hit} which doesn't exist. Creating.`);
  }
  // new user

  // find a random string that we don't already have in the db
  let newGotandaId = '';
  while (!newGotandaId) {
    // RFC 4648 §5: base64url
    const attempt = 'gotanda-' + (await base64urlRandom(9));
    if (!(await getKey(attempt))) { newGotandaId = attempt; }
  }

  const github: Partial<typeof profile> = {...profile};
  // I'm not comfortable storing this. I'd like to store even less (no name, avatar, etc.) but for now:
  delete github['_json'];
  delete github['_raw'];
  const ret: IUserUNSAFE = {github, gotandaId: newGotandaId, apiTokens: []};

  await db.batch().put(githubId, newGotandaId).put(newGotandaId, ret).write();
  return {...ret, apiTokens: undefined};
}

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

// This only accepts stringy Gotanda IDs in order to be very fast
export async function validOnlooker(creatorGotandaId: string, onlookerGotandaId: string, app: string) {
  try {
    return !!(await db.get(`ro/creator/${creatorGotandaId}/onlooker/${onlookerGotandaId}/app/${app}`));
    // just check creator-to-onlooker link because that's what the creator can readily see and can invalidate.
    // don't bother to check whether the opposite link exists.
  } catch { return false; }
}

export async function addOnlookerApp(userGotandaId: string, onlookerGotandaId: string, app: string) {
  await db.batch()
      .put(`ro/creator/${userGotandaId}/onlooker/${onlookerGotandaId}/app/${app}`, '1')
      .put(`ro/onlooker/${onlookerGotandaId}/creator/${userGotandaId}/app/${app}`, '1')
      .write();
  return true;
}

export async function delOnlookerApp(userGotandaId: string, onlookerGotandaId: string, app: string) {
  await db.batch()
      .del(`ro/creator/${userGotandaId}/onlooker/${onlookerGotandaId}/app/${app}`)
      .del(`ro/onlooker/${onlookerGotandaId}/creator/${userGotandaId}/app/${app}`)
      .write();
  return true;
}

export async function delOnlooker(userGotandaId: string, onlookerGotandaId: string) {
  const batch: ReturnType<typeof db.batch> = await new Promise((resolve, reject) => {
    const gte = `ro/creator/${userGotandaId}/onlooker/${onlookerGotandaId}/`;
    const batch = db.batch();
    db.createKeyStream({gte, lt: gte + '\ufff0'})
        .on('data',
            (key: string) => {
              batch.del(key);
              const [/* ro */, /* creator */, creator, /* onlooker */, onlooker, /* app */, app] = key.split('/');
              batch.del(`ro/onlooker/${onlooker}/creator/${creator}/app/${app}`);
            })
        .on('error', e => reject(e))
        .on('close', () => resolve(batch))
  });
  await batch.write();
  return true;
}

export async function delOnlookers(userGotandaId: string) {
  const batch: ReturnType<typeof db.batch> = await new Promise((resolve, reject) => {
    const gte = `ro/creator/${userGotandaId}/`;
    // exact same business logic as above in delOnlooker after this! Candidate for abstraction?
    const batch = db.batch();
    db.createKeyStream({gte, lt: gte + '\ufff0'})
        .on('data',
            (key: string) => {
              batch.del(key);
              const [/* ro */, /* creator */, creator, /* onlooker */, onlooker, /* app */, app] = key.split('/');
              batch.del(`ro/onlooker/${onlooker}/creator/${creator}/app/${app}`);
            })
        .on('error', e => reject(e))
        .on('close', () => resolve(batch))
  });
  await batch.write();
  return true;
}

export async function allOnlookerLinks(userGotandaId: string) {
  const onlookers: {onlooker: string, app: string}[] = [];
  {
    const gte = `ro/creator/${userGotandaId}/`;
    const keys: string[] = await drainStream(db.createKeyStream({gte, lt: gte + '\ufff0'}));
    for (const key of keys) {
      const [/* ro */, /* creator */, creator, /* onlooker */, onlooker, /* app */, app] = key.split('/');
      onlookers.push({onlooker, app});
    }
  }
  const creators: {creator: string, app: string}[] = [];
  {
    const gte = `ro/onlooker/${userGotandaId}/`;
    const keys: string[] = await drainStream(db.createKeyStream({gte, lt: gte + '\ufff0'}));
    for (const key of keys) {
      const [/* ro */, /* onlooker */, onlooker, /* creator */, creator, /* app */, app] = key.split('/');
      creators.push({creator, app});
    }
  }
  return {onlookers, creators};
}

function drainStream<T>(stream: NodeJS.ReadableStream): Promise<T[]> {
  const ret: T[] = [];
  return new Promise((resolve, reject) => {
    stream.on('data', x => ret.push(x))
        .on('error', e => reject(e))
        .on('close', () => resolve(ret))
        .on('end', () => resolve(ret));
  });
}
