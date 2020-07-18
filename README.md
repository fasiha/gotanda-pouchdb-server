[Register](https://github.com/settings/applications/new) your app with GitHub.

Clone this repo.

Create `secrets.js`:
```js
module.exports = {
  sessionSecret: EXPRESS_SESSION_SECRET,
  github: {clientID: GITHUB_CLIENT_ID, clientSecret: GITHUB_CLIENT_SECRET}
}
```

Then,
```
npm run build
npm run serve
```