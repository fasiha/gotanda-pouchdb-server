import {isRight} from 'fp-ts/lib/Either';
import * as t from 'io-ts';
import levelup from 'levelup';
import GitHubStrategy from 'passport-github';

export type Db = ReturnType<typeof levelup>;
const db: Db = (require('level'))('gotanda-users-db', {valueEncoding: 'json'});

const User = t.intersection([
  t.type({gotandaId: t.string}),
  t.partial({github: t.UnknownRecord}), // we'll later allow sign up with others SSO, not just GitHub
]);
export type IUser = t.TypeOf<typeof User>;

export async function getUser(key: string): Promise<IUser|undefined> {
  try {
    const ret = await db.get(key);
    const decoded = User.decode(ret);
    if (isRight(decoded)) { return decoded.right; }
    console.error(`io-ts decode error for User object for key ${key}`);
    return ret;
  } catch { return undefined; }
}

export async function findOrCreateGithub(profile: GitHubStrategy.Profile): Promise<IUser> {
  // `key` represents our app's ID for this user. We should use an autoincrementing or randomly-generated ID (check for
  // collisions with existing users if randomly generated), but we're being lazy and using something tied to GitHub,
  // which will change once we allow other SSO logins. When we add that, we'll have to search for the user with this
  // GitHub id and return that.
  const key = `github-${profile.id}`;

  const existing = await getUser(key);
  if (existing) { return existing; }

  // unclear why I need {...profile}, but just `profile` makes typescript unhappy
  const ret: IUser = {github: {...profile}, gotandaId: key};
  await db.put(key, ret);
  return ret;
}
