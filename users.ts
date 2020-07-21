import {randomBytes as randomBytesOrig} from 'crypto';
import {isRight} from 'fp-ts/lib/Either';
import * as t from 'io-ts';
import levelup from 'levelup';
import GitHubStrategy from 'passport-github';
import {promisify} from 'util';

const randomBytes = promisify(randomBytesOrig);

export type Db = ReturnType<typeof levelup>;
const db: Db = (require('level'))(__dirname + '/.data/gotanda-users-db', {valueEncoding: 'json'});

const User = t.intersection([
  t.type({gotandaId: t.string}), t.partial({apiTokens: t.array(t.type({token: t.string, name: t.string}))}),
  t.partial({github: t.UnknownRecord}), // we'll later allow sign up with others SSO, not just GitHub
]);
export type IUser = t.TypeOf<typeof User>;

async function getKey(key: string): Promise<any|undefined> {
  try {
    const ret = await db.get(key);
    return ret;
  } catch { return undefined; }
}

async function getUser(key: string): Promise<IUser|undefined> {
  const ret = await getKey(key);
  if (ret === undefined) { return undefined; }
  const decoded = User.decode(ret);
  if (isRight(decoded)) { return decoded.right; }
  console.error(`io-ts decode error for User object for key ${key}`);
  return ret;
}

export async function getUserSafe(key: string): Promise<Omit<IUser, 'apiTokens'>|undefined> {
  const ret = await getUser(key);
  if (!ret) { return ret; }
  delete ret['apiTokens'];
  return ret;
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

export async function findOrCreateGithub(profile: GitHubStrategy.Profile): Promise<IUser> {
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

  const github = {...profile};
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
    console.error(`API token ${token} points to user either non-existent or who deleted this token. Maybe delete it?`);
  }
  return undefined;
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