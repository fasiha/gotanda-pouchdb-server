import {randomBytes as randomBytesOrig} from 'crypto';
import {isRight} from 'fp-ts/lib/Either';
import * as t from 'io-ts';
import levelup from 'levelup';
import GitHubStrategy from 'passport-github';
import {promisify} from 'util';

const randomBytes = promisify(randomBytesOrig);

export type Db = ReturnType<typeof levelup>;
const db: Db = (require('level'))('gotanda-users-db', {valueEncoding: 'json'});

const User = t.intersection([
  t.type({gotandaId: t.string}),
  t.partial({github: t.UnknownRecord}), // we'll later allow sign up with others SSO, not just GitHub
]);
export type IUser = t.TypeOf<typeof User>;

async function getKey(key: string): Promise<any|undefined> {
  try {
    const ret = await db.get(key);
    return ret;
  } catch { return undefined; }
}

export async function getUser(key: string): Promise<IUser|undefined> {
  const ret = await getKey(key);
  if (ret === undefined) { return undefined; }
  const decoded = User.decode(ret);
  if (isRight(decoded)) { return decoded.right; }
  console.error(`io-ts decode error for User object for key ${key}`);
  return ret;
}

/*
The database stores the following keys and values:
- `gotanda-<random string not including slash>` => IUser object (i.e., a Gotanda user record)
- `github-<GitHub id>` => a string which is a Gotanda user record's key (i.e., `gotanda-<random string>`)

When we get a GitHub profile, we look up whether `github-<id>` exists in the database. If it does, we fetch its value
and in turn use that as a key to look up the Gotanda user record.
*/
export async function findOrCreateGithub(profile: GitHubStrategy.Profile): Promise<IUser> {
  const githubId = `github-${profile.id}`;
  const hit = await getKey(githubId);
  if (hit) {
    // GitHub user is also a Gotanda user!
    const existing = await getUser(hit);
    if (existing) {
      return existing;
    } else {
      // We had a record of this GitHub user but not the Gotanda user it pointed to?
      // Something very strange must have happened but we can deal with it.
      console.error(`${githubId} points to ${hit} which doesn't exist. Creating.`);
    }
  }
  // new user

  // find a random string that we don't already have in the db
  let newGotandaId = ''; // Not used for return logins
  while (!newGotandaId) {
    // RFC 4648 §5: base64url
    const attempt = (await randomBytes(8)).toString('base64').replace(/\//g, '_').replace(/\+/g, '-');
    if (!(await getKey(attempt))) { newGotandaId = 'gotanda-' + attempt; }
  }

  // unclear why I need {...profile}, but just `profile` makes typescript unhappy
  const ret: IUser = {github: {...profile}, gotandaId: newGotandaId};

  await db.batch().put(githubId, newGotandaId).put(newGotandaId, ret).write();
  return ret;
}
