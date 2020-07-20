import express, {RequestHandler} from 'express';
import {isRight} from 'fp-ts/lib/Either';
import * as t from 'io-ts';
import passport from 'passport';
import GitHubStrategy from 'passport-github';
import {Strategy as BearerStrategy} from 'passport-http-bearer';

import {setup, sync} from './sync';
import {
  createApiToken,
  deleteAllApiTokens,
  deleteApiToken,
  findApiToken,
  findOrCreateGithub,
  getAllApiTokenNames,
  getUser,
  IUser
} from './users';

const app = express();
const port = 3000;

// Use `dotenv` to load some secrets in a typesafe way leveraging io-ts
const secrets = t.type({GITHUB_CLIENT_ID: t.string, GITHUB_CLIENT_SECRET: t.string, SESSION_SECRET: t.string});
const Env = t.type({parsed: secrets});
const envDecode = Env.decode(require('dotenv').config());
if (!isRight(envDecode)) { throw new Error('invalid env'); }
const env = envDecode.right.parsed;

// Tell Passport how we want to use GitHub auth
passport.use(new GitHubStrategy(
    {
      clientID: env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
      callbackURL: `http://127.0.0.1:${port}/auth/github/callback`,
    },
    // This function converts the GitHub profile into our app's object representing the user (IUser)
    (accessToken, refreshToken, profile, cb) => findOrCreateGithub(profile).then(ret => cb(null, ret))));
// Tell Passport we want to use Bearer (API token) auth, and *name* this strategy: we'll use this name below
passport.use('bearer', new BearerStrategy((token, cb) => findApiToken(token).then(ret => cb(null, ret ? ret : false))));

// Serialize an IUser into something we'll store in the user's session (very tiny)
passport.serializeUser(function(user: IUser, cb) { cb(null, user.gotandaId); });
// Take the data we stored in the session (`gotandaId`) and resurrect the full IUser object
passport.deserializeUser(function(obj: string, cb) { getUser(obj).then(ret => cb(null, ret)); });

app.use(require('cors')({origin: true, credentials: true})); // Set 'origin' to lock it. If true, all origins ok
app.use(require('cookie-parser')());
app.use(require('body-parser').json());
app.use(require('express-session')({
  secret: env.SESSION_SECRET,
  resave: true,
  saveUninitialized: true,
  store: new (require('level-session-store')(require('express-session')))(__dirname + '/.data/level-session-store'),
}));
// FIRST init express' session, THEN passport's
app.use(passport.initialize());
app.use(passport.session());

app.get('/', (req, res) => res.send(`
<h1>Hi!</h1>
${req.user ? `<a href="/logout">Logout</a>` : `<a href="/auth/github">Login with GitHub</a>`}
<br>
<a href="/loginstatus">Check your login status</a>
<pre>${JSON.stringify(req.user, null, 3)}</pre>
`));

// Via @jaredhanson: https://gist.github.com/joshbirk/1732068#gistcomment-80892
const ensureUnauthenticated: RequestHandler = (req, res, next) => {
  if (req.isAuthenticated()) { return res.redirect('/'); }
  next();
};

// The name "bearer" here matches the name we gave the strategy above. See
// https://dsackerman.com/passportjs-using-multiple-strategies-on-the-same-endpoint/
const bearerAuthentication = passport.authenticate('bearer', {session: false});
const ensureAuthenticated: RequestHandler = (req, res, next) => {
  // check session (i.e., GitHub, etc.)
  if (req.isAuthenticated && req.isAuthenticated()) {
    next();
  } else {
    bearerAuthentication(req, res, next);
  }
};
app.get('/auth/tokens', ensureAuthenticated,
        (req, res) => getAllApiTokenNames((req.user as IUser).gotandaId).then(ret => res.json(ret)));
app.delete('/auth/tokens', ensureAuthenticated,
           (req, res) => deleteAllApiTokens((req.user as IUser).gotandaId).then(ret => res.json(ret)));
app.delete('/auth/token/:name', ensureAuthenticated,
           (req, res) => deleteApiToken((req.user as IUser).gotandaId, req.params.name).then(ret => res.json(ret)));
app.get('/auth/token/:name', ensureAuthenticated,
        (req, res) => createApiToken((req.user as IUser).gotandaId, req.params.name).then(ret => res.json(ret)))

app.get('/auth/github', ensureUnauthenticated, passport.authenticate('github'));
app.get('/auth/github/callback', ensureUnauthenticated, passport.authenticate('github', {failureRedirect: '/'}),
        (req, res) => res.redirect('/'));
app.get('/logout', (req, res) => {
  req.logout();
  res.redirect('/');
});
app.get('/loginstatus', ensureAuthenticated, (req, res) => res.send(`You're logged in! <a href="/">Go back</a>`));

// Gotanda syncer
var db = setup(__dirname + '/.data/gotanda-db');
const SyncPayload = t.type({
  lastSharedId: t.string,
  newEvents: t.array(t.string),
});
// export type ISyncPayload = t.TypeOf<typeof SyncPayload>; // export this if we want to use it in frontend
app.post('/sync/:app', ensureAuthenticated, (req, res) => {
  const userId = req.user && (req.user as IUser).gotandaId;
  const {app} = req.params;
  if (!(userId && app && !app.includes('/'))) {
    res.status(400).json('bad app');
    return;
  }
  res.setHeader('Content-Type', 'application/json');
  const body = SyncPayload.decode(req.body);
  if (!isRight(body)) {
    res.status(400).json('bad payload');
    return;
  }
  sync(db, [userId, app], body.right.lastSharedId, body.right.newEvents).then(ret => res.json(ret));
});

app.listen(port, () => console.log(`Example app listening at http://127.0.0.1:${port}`));