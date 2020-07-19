import express from 'express';
import {isRight} from 'fp-ts/lib/Either';
import * as t from 'io-ts';
import passport from 'passport';
import GitHubStrategy from 'passport-github';

import {setup, sync} from './sync';
import {findOrCreateGithub, getUser, IUser} from './users';

const app = express();
const port = 3000;

// Import secrets from a custom file. There's better ways to do this.
var secrets: {sessionSecret: string, github: {clientID: string, clientSecret: string}} = require('./secrets');
// Tell Passport how we want to use GitHub auth
passport.use(new GitHubStrategy(
    {
      clientID: secrets.github.clientID,
      clientSecret: secrets.github.clientSecret,
      callbackURL: `http://127.0.0.1:${port}/auth/github/callback`,
    },
    // This verify function converts the GitHub profile into our app's object representing the user (IUser)
    function verify(accessToken, refreshToken, profile,
                    cb) { findOrCreateGithub(profile).then(ret => cb(null, ret)); }));
// Serialize an IUser into something we'll store in the user's session (very tiny)
passport.serializeUser(function(user: IUser, cb) { cb(null, user.gotandaId); });
// Take the data we stored in the session (`gotandaId`) and resurrect the full IUser object
passport.deserializeUser(function(obj: string, cb) { getUser(obj).then(ret => cb(null, ret)); });

app.use(require('cors')({origin: true, credentials: true})); // Set 'origin' to lock it. If true, all origins ok
app.use(require('cookie-parser')());
app.use(require('body-parser').json());
app.use(require('express-session')({
  secret: secrets.sessionSecret,
  resave: true,
  saveUninitialized: true,
  store: new (require('level-session-store')(require('express-session')))(),
}));
// FIRST init express' session, THEN passport's
app.use(passport.initialize());
app.use(passport.session());

app.get('/', (req, res) => res.send(`
<h1>Hi!</h1>
${req.user ? `<a href="/logout">Logout</a>` : `<a href="/auth/github">Login with GitHub</a>`}
<a href="/personal">Personal (must be logged in)</a>
<pre>${JSON.stringify(req.user, null, 3)}</pre>
`));

app.get('/auth/github', passport.authenticate('github'));
app.get('/auth/github/callback', passport.authenticate('github', {failureRedirect: '/'}),
        (req, res) => res.redirect('/'));
app.get('/logout', (req, res) => {
  req.logout();
  res.redirect('/');
});
app.get('/personal', require('connect-ensure-login').ensureLoggedIn('/'),
        (req, res) => res.send(`You must be logged in! <a href="/">Go back</a>`));
app.get('/loginstatus', (req, res) => res.status(req.isAuthenticated() ? 200 : 401).end());

// Gotanda syncer
var db = setup('gotanda-db-test');
const SyncPayload = t.type({
  lastSharedId: t.string,
  newEvents: t.array(t.string),
});
// export type ISyncPayload = t.TypeOf<typeof SyncPayload>;
app.post('/sync/:app', require('connect-ensure-login').ensureLoggedIn(), (req, res) => {
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