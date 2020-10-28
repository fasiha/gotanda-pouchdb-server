import express, {RequestHandler} from 'express';
import {isRight} from 'fp-ts/lib/Either';
import {lstat, readdir} from 'fs/promises';
import * as t from 'io-ts';
import {sync as mkdirpSync} from 'mkdirp';
import passport from 'passport';
import GitHubStrategy from 'passport-github';
import {Strategy as BearerStrategy} from 'passport-http-bearer';

import {
  addOnlookerApp,
  createApiToken,
  deleteAllApiTokens,
  deleteApiToken,
  delOnlooker,
  delOnlookerApp,
  delOnlookers,
  findOrCreateGithub,
  getAllApiTokenNames,
  getUserSafe,
  IUser,
  validOnlooker
} from './users';

mkdirpSync(__dirname + '/.data');

const app = express();
app.set('trust proxy', 1);
const port = process.env.PORT || 3000;
const BEARER_NAME = 'bearer';

// Use `dotenv` to load some secrets in a typesafe way leveraging io-ts
const {env, githubAllowlist} = (() => {
  const secrets = t.type({
    GITHUB_CLIENT_ID: t.string,
    GITHUB_CLIENT_SECRET: t.string,
    SESSION_SECRET: t.string,
    URL: t.string,
    GITHUB_ID_ALLOWLIST: t.string,
    GITHUB_USERNAME_ALLOWLIST: t.string,
  });
  const Env = t.type({parsed: secrets});
  const envDecode = Env.decode(require('dotenv').config());
  if (!isRight(envDecode)) {
    console.error('invalid env');
    process.exit(1);
  }
  const env = envDecode.right.parsed;

  const stringToSet = (s: string) => new Set(s.split(',').map(s => s.trim()));
  let githubAllowlist =
      (env.GITHUB_ID_ALLOWLIST === '*' && env.GITHUB_USERNAME_ALLOWLIST === '*')
          ? '*' as const
          : {id: stringToSet(env.GITHUB_ID_ALLOWLIST), username: stringToSet(env.GITHUB_USERNAME_ALLOWLIST)};
  return {env, githubAllowlist};
})();

// Tell Passport how we want to use GitHub auth
passport.use(
    new GitHubStrategy({
      clientID: env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
      callbackURL: `${env.URL}/auth/github/callback`,
    },
                       // This function converts the GitHub profile into our app's object representing the user (IUser)
                       (accessToken, refreshToken, profile, cb) =>
                           findOrCreateGithub(profile, githubAllowlist).then(ret => cb(null, ret))));
// Tell Passport we want to use Bearer (API token) auth, and *name* this strategy: we'll use this name below
passport.use(BEARER_NAME,
             new BearerStrategy((token, cb) => getUserSafe(token).then(ret => cb(null, ret ? ret : false))));

// Serialize an IUser into something we'll store in the user's session (very tiny)
passport.serializeUser(function(user: IUser, cb) { cb(null, user.gotandaId); });
// Take the data we stored in the session (`gotandaId`) and resurrect the full IUser object
passport.deserializeUser(function(obj: string, cb) { getUserSafe(obj).then(ret => cb(null, ret)); });

app.use(require('cors')({origin: true, credentials: true})); // Set 'origin' to lock it. If true, all origins ok
app.use(require('cookie-parser')());
app.use(express.json({limit: '100mb'}));
app.use(require('express-session')({
  cookie: process.env.NODE_ENV === 'development' ? {secure: false, sameSite: 'lax'} : {secure: true, sameSite: 'none'},
  secret: env.SESSION_SECRET,
  resave: true,
  saveUninitialized: true,
  store: new (require('level-session-store')(require('express-session')))(process.env.SESSION_STORE ||
                                                                          (__dirname + '/.data/level-session-store')),
}));
// FIRST init express' session, THEN passport's
app.use(passport.initialize());
app.use(passport.session());

app.get('/', async (req, res) => {
  if (!req.user) {
    res.send(`<title>Gotanda</title>
<h1>Welcome to Gotanda</h1>
<a href="/auth/github">Login with GitHub</a>`);
    return;
  }
  const names = await getAllApiTokenNames((req.user as IUser).gotandaId);
  const ret = `<title>Gotanda</title>
<h1>Welcome to Gotanda</h1>
<p>You're logged in! <a href="/logout">Logout</a>
<p>
${names.length ? `Your tokens:<ul>${names.map(name => '<li>' + name)}</ul>` : 'You have created no tokens.'}
<p>
Here's everything Gotanda has saved about you:
<pre>${JSON.stringify(req.user, null, 3)}</pre>
<p>
`;
  res.send(ret);
});

// The name "bearer" here matches the name we gave the strategy above. See
// https://dsackerman.com/passportjs-using-multiple-strategies-on-the-same-endpoint/
const bearerAuthentication = passport.authenticate(BEARER_NAME, {session: false});
const ensureAuthenticated: RequestHandler = (req, res, next) => {
  // check session (i.e., GitHub, etc.)
  if (req.isAuthenticated && req.isAuthenticated()) {
    next();
  } else {
    bearerAuthentication(req, res, next);
  }
};
// Via @jaredhanson: https://gist.github.com/joshbirk/1732068#gistcomment-80892
const ensureUnauthenticated: RequestHandler = (req, res, next) => {
  if (req.isAuthenticated()) { return res.redirect('/'); }
  next();
};

app.get('/auth/tokens', ensureAuthenticated,
        (req, res) => getAllApiTokenNames((req.user as IUser).gotandaId).then(ret => res.json(ret)));
app.delete('/auth/tokens', ensureAuthenticated,
           (req, res) => deleteAllApiTokens((req.user as IUser).gotandaId).then(ret => res.json(ret)));
app.delete('/auth/token/:name', ensureAuthenticated,
           (req, res) => deleteApiToken((req.user as IUser).gotandaId, req.params.name).then(ret => res.json(ret)));
app.get('/auth/token/:name', ensureAuthenticated,
        (req, res) => deleteApiToken((req.user as IUser).gotandaId, req.params.name)
                          .then(() => createApiToken((req.user as IUser).gotandaId, req.params.name))
                          .then(ret => res.json(ret)))

app.get('/auth/github', ensureUnauthenticated, passport.authenticate('github'));
app.get('/auth/github/callback', ensureUnauthenticated, passport.authenticate('github', {failureRedirect: '/'}),
        (req, res) => res.redirect('/'));
app.get('/logout', (req, res) => {
  req.logout();
  res.redirect('/');
});
app.get('/loginstatus', ensureAuthenticated, (req, res) => res.send(`You're logged in! <a href="/">Go back</a>`));

// PouchDB-Server
import PouchDB from 'pouchdb';

const pouchPrefix =
    process.env.POUCH_PREFIX || (__dirname + '/.data/pouches/'); // trailing / required for this to be a subdirectory!
const USER_APP_SEP = '.'; // since Gotanda userIDs contains [0-9a-zA-Z-_], this is none of these

mkdirpSync(pouchPrefix);
const PrefixedPouchDB = PouchDB.defaults({prefix: pouchPrefix});
const db = require('express-pouchdb')(PrefixedPouchDB, {mode: 'minimumForPouchDB'});

async function allSubdbs(user: IUser): Promise<string[]> {
  const paths = (await readdir(pouchPrefix)).filter(s => s.startsWith(user.gotandaId + USER_APP_SEP));
  const stats = await Promise.all(paths.map(s => lstat(pouchPrefix + s)));
  return stats.flatMap((s, i) => s.isDirectory() ? paths[i] : []);
}

async function dbTakeout(dbname: string) {
  const subdb = new PrefixedPouchDB(dbname);
  return (await subdb.allDocs({include_docs: true})).rows.flatMap(o => o.doc ? o.doc : []);
}

app.use(`/db/:app`, ensureAuthenticated, (req, res) => {
  const userId = req.user && (req.user as IUser).gotandaId;
  const {app} = req.params;
  if (!(userId && app && !app.includes('/'))) {
    res.status(400).json('bad app');
    return;
  }
  // The db name will be `${userId}.${app}`: hopefully this facilitates user data export.
  req.url = `/${userId}${USER_APP_SEP}${app}${req.url}`;

  db(req, res);
});

// User trying to read *another* user's database
app.use(`/owner/:ownerId/app/:app`, ensureAuthenticated, async (req, res) => {
  const user = req.user;
  const userId = user && (req.user as IUser).gotandaId;
  const {ownerId, app} = req.params;
  if (!(userId && app && !app.includes('/') && ownerId && !ownerId.includes('/'))) {
    return res.status(400).json('bad request');
  }
  if (!await validOnlooker(ownerId, userId, app)) { return res.status(401).json('bad request'); }
  const owner = await getUserSafe(ownerId);
  if (!owner) { return res.status(401).json('bad request'); }

  if (req.method === 'GET' || req.url.startsWith('/_changes') || req.url.startsWith('/_all_docs') ||
      req.url.startsWith('/_local') || req.url.startsWith('/_bulk_get')) {
    // this is read-only (GET) or it's a potential-write (POST, PUT, etc.) to a safe PouchDB/CouchDB endpoint, e.g.,
    // clients can POST to `_all_docs` to avoid sending a huge query string:
    // https://docs.couchdb.org/en/stable/api/database/bulk-api.html#post--db-_all_docs

    // As when the user is requesting their own database (above): rewrite the URL and send to PouchDB-Server
    req.url = `/${owner.gotandaId}${USER_APP_SEP}${app}${req.url}`;
    return db(req, res);
  }
  return res.status(401).json('bad request');
});

// User wants to designate another user as an onlooker for the given app
app.put('/me/onlooker/:onlookerId/app/:app', ensureAuthenticated, async (req, res) => {
  const user = req.user;
  const userId = user && (req.user as IUser).gotandaId;
  const {onlookerId, app} = req.params;
  if (!(userId && app && !app.includes('/') && onlookerId && !onlookerId.includes('/'))) {
    res.status(400).json('bad request');
    return;
  }
  const onlooker = await getUserSafe(onlookerId);
  if (!onlooker) {
    res.status(400).json('bad onlooker');
    return;
  }
  res.json(await addOnlookerApp(userId, onlooker.gotandaId, app));
});

// User wants to *revoke* an onlooker's access to one of their apps
app.delete('/me/onlooker/:onlookerId/app/:app', ensureAuthenticated, async (req, res) => {
  // Same business logic as GET above
  const user = req.user;
  const userId = user && (req.user as IUser).gotandaId;
  const {onlookerId, app} = req.params;
  if (!(userId && app && !app.includes('/') && onlookerId && !onlookerId.includes('/'))) {
    res.status(400).json('bad request');
    return;
  }
  const onlooker = await getUserSafe(onlookerId);
  if (!onlooker) {
    res.status(400).json('bad onlooker');
    return;
  }
  res.json(await delOnlookerApp(userId, onlooker.gotandaId, app));
});

// Drama: user wants to revoke an onlooker's access to ALL their apps
app.delete('/me/onlooker/:onlookerId', ensureAuthenticated, async (req, res) => {
  // Same business logic as GET above
  const user = req.user;
  const userId = user && (req.user as IUser).gotandaId;
  const {onlookerId} = req.params;
  if (!(userId && onlookerId && !onlookerId.includes('/'))) {
    res.status(400).json('bad request');
    return;
  }
  const onlooker = await getUserSafe(onlookerId);
  if (!onlooker) {
    res.status(400).json('bad onlooker');
    return;
  }
  res.json(await delOnlooker(userId, onlooker.gotandaId));
});

// Major drama: user wants to revoke ALL onlookers' access to ALL their apps
app.delete('/me/onlookers', ensureAuthenticated, async (req, res) => {
  const user = req.user;
  const userId = user && (req.user as IUser).gotandaId;
  if (!userId) {
    res.status(400).json('bad request');
    return;
  }
  res.json(await delOnlookers(userId));
});

app.get(`/me/apps`, ensureAuthenticated, async (req, res) => {
  try {
    if (req.user && (req.user as IUser).gotandaId) {
      res.json((await allSubdbs(req.user as IUser)).map(s => s.split(USER_APP_SEP).slice(1).join(USER_APP_SEP)))
      return;
    }
  } catch (e) { console.error(e); }
  res.status(400).json('bad user');
});

app.get(`/me/app/:app`, ensureAuthenticated, require('compression')(), async (req, res) => {
  try {
    const {app} = req.params;
    if (req.user && (req.user as IUser).gotandaId && !app.includes('/')) {
      const user = req.user as IUser;
      const dbname = user.gotandaId + USER_APP_SEP + app;
      const dbpath = pouchPrefix + dbname;
      if ((await lstat(dbpath)).isDirectory()) {
        const data = await dbTakeout(dbname);
        res.set('Content-Disposition', `attachment; filename="${dbpath}-${new Date().toISOString()}.json"`);
        res.set('Content-Type', 'application/json');
        res.send(JSON.stringify(data));
        return;
      }
    }
  } catch (e) { console.error(e); }
  res.status(400).json('bad user or app');
});
app.delete(`/me/app/:app`, ensureAuthenticated, async (req, res) => {
  try {
    // Same validation logic as above GET
    const {app} = req.params;
    if (req.user && (req.user as IUser).gotandaId && !app.includes('/')) {
      const user = req.user as IUser;
      const dbname = user.gotandaId + USER_APP_SEP + app;
      const dbpath = pouchPrefix + dbname;
      if ((await lstat(dbpath)).isDirectory()) {
        // This part is different from GET though
        const subdb = new PrefixedPouchDB(dbname);
        await subdb.destroy();
        res.json(true);
        return;
      }
    }
  } catch (e) { console.error(e); }
  res.status(400).json('bad user or app');
});

// this just returns innocuous (I think!) PouchDB/CouchDB data, nothing about users or databases. PouchDB shows an ugly
// 404 in browser without this. I want to allow only a minimal amount of access: JUST /db (or /db/) and GET.
app.get('/db/?$', ensureAuthenticated, (req, res) => {
  req.url = `/`;
  db(req, res)
});

// All done
app.listen(port, () => console.log(`App at 127.0.0.1:${port}`));

/*
const logRequest = (req: any, res: any, next: any) => {
  console.log(Object.entries(req).filter(([_, v]) => typeof v === 'string').map(arr => arr.join(' => ')).join('\n* '));
  next();
};
*/