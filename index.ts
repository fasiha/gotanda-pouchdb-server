import express from 'express';
import passport from 'passport';
import GitHubStrategy from 'passport-github';

const app = express();
const port = 3000;

// Import secrets from a custom file. There's better ways to do this.
var secrets: {sessionSecret: string, github: {clientID: string, clientSecret: string}} = require('./secrets');
// Tell Passport how we want to use GitHub auth
passport.use(new GitHubStrategy({
  clientID: secrets.github.clientID,
  clientSecret: secrets.github.clientSecret,
  callbackURL: `http://127.0.0.1:${port}/auth/github/callback`,
},
                                function(accessToken, refreshToken, profile, cb) { return cb(null, profile); }));
//
passport.serializeUser(function(user, cb) { cb(null, user); });
passport.deserializeUser(function(obj, cb) { cb(null, obj); });

app.use(require('cors')({origin: true, credentials: true})); // Set 'origin' to lock it. If true, all origins ok
app.use(require('cookie-parser')());
app.use(require('body-parser').urlencoded({extended: true}));
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
<pre>
  ${JSON.stringify(req.user, null, 1)}
</pre>
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
app.get('/loginstatus', (req, res) => res.status(req.isAuthenticated() ? 200 : 401).end())
app.listen(port, () => console.log(`Example app listening at http://127.0.0.1:${port}`));