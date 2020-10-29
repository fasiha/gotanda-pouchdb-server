# Gotanda PouchDB
Suppose you've read "[Local-first software](https://www.inkandswitch.com/local-first.html)" by the unforgettable Ink & Switch team, especially their advice for [devs](https://www.inkandswitch.com/local-first.html#practitioners) that encourage you to make apps that are fast, multi-device, offline-fine, with long-lived data formats, that are privacy-centered and user-controlled, etc.

Gotanda is a series of experiments to help with that. We give you a Node.js server that can be deployed to the cloud (Glitch.com, Fly, etc.) and serves as an always-online backup for users of your frontend apps. It's especially useful when
- your app is local-first, and
- your app needs at most *read-only* data sharing between users on the same server.  That's right, a Gotanda server will happily store data generated by multiple users' multiple apps, and users can designate other users as onlookers, but it doesn't (yet) support letting others edit your data.

This repo, Gotanda PouchDB, is intended to service apps that use [PouchDB](https://pouchdb.com/) to store their data locally—web apps or mobile apps or wherever PouchDB is supported. Here's how it works:
1. your apps direct users to log into Gotanda with their GitHub login. Gotanda stores a minimal amount of data from GitHub.
2. Your app creates a remote PouchDB, pointing to a Gotanda URL, which logs in with cookie authentication (Gotanda also supports token authentication). 
3. **Bonus** A user can use the *same* Gotanda server with *multiple* different apps—each app just has to use a different identifier, and Gotanda will store each (user, app) pair's data in a separate PouchDB database.

## Set up a Gotanda server
1. Once you've identified where you'll host it, [register](https://github.com/settings/applications/new) Gotanda with GitHub. The "Homepage URL" is flexible but the "Authorization callback URL" is very important! It needs to be at Gotanda's future URL plus `/auth/github/callback`:
    - you can always use `http://127.0.0.1:3000/auth/github/callback` for local testing.
    - For a deployed app, it might be something like `https://my-awesome-app.glitch.me/auth/github/callback`.
2. Clone this repo: `git clone https://github.com/fasiha/gotanda-pouchdb-server`
3. Change directory: `cd gotanda-pouchdb-server`
4. Create a file called `.env` and fill in the following:
    ```
    URL=
    SESSION_SECRET=
    GITHUB_CLIENT_ID=
    GITHUB_CLIENT_SECRET=
    GITHUB_USERNAME_ALLOWLIST=
    GITHUB_ID_ALLOWLIST=
    ```
    - `URL`, where your app will be hosted, e.g., `https://my-awesome-app.glitch.me` or `http://127.0.0.1:3000` (don't put a trailing `/`, it breaks things).
    - `SESSION_SECRET` should a long random string used by the Express webserver to [secure](https://martinfowler.com/articles/session-secret.html) cookies. In a pinch, run the following in a Node session and use its output: `require('crypto').randomBytes(24).toString('base64')`
    - `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` are given to you by GitHub when you [register](https://github.com/settings/applications/new) your instance of Gotanda.
    - But `GITHUB_USERNAME_ALLOWLIST` and `GITHUB_ID_ALLOWLIST` are yours: these are comma-separated lists of GitHub usernames and IDs respectively (see here for how to convert [username to id](https://stackoverflow.com/q/17308954)) that are allowed to use Gotanda. If *both* of these are `*`, then all GitHub users can use Gotanda. Otherwise, the *union* of usernames and IDs is allowed, so you can permission a given user's GitHub ID *or* their GitHub username (or both). Because [you can change your GitHub username](https://help.github.com/articles/what-happens-when-i-change-my-username/), but also because it's typically easier to specify username, we allow you to give either.

5. Install dependencies: `npm install`
6. Build the TypeScript code to JavaScript: `npm run build`
7. Start the server: `npm run serve`

**Nota bene** Add `NODE_ENV=development` in `.env` if you're developing locally on your machine to ensure cookies work correctly.

## Set up your your client app
This repo contains an extremely simple [client app](https://github.com/fasiha/gotanda-pouchdb-server/tree/master/any-client-app) that uses PouchDB to store notes and syncs with Gotanda in less than 50 lines of JavaScript. Be sure to consult the amazing PouchDB [guides](https://pouchdb.com/guides/) and [API docs](https://pouchdb.com/api.html) but in a nutshell, here's what the sample app does, and what your app likely will do:
```js
var appName = `mycoolapp`;
var server = `http://127.0.0.1:3000`;

// your *local* PouchDB
var db = new PouchDB('mydb'); 

// the *remote* PouchDB hosted by Gotanda
var remotedb = new PouchDB(`${server}/db/${appName}`, {
  fetch: (url, opts) => {
    opts.credentials = 'include';
    return PouchDB.fetch(url, opts);
  }
});

// Sync the two
var syncfeed = db.sync(remotedb, {live: true, retry: true});
```
With this, your local PouchDB will sync with Gotanda, so go ahead and add things like conflict resolution and change feeds, etc. As you can see, there's almost nothing Gotanda-specific about your clients. As far as your app knows, it's just talking to a CouchDB-compliant endpoint that 
- follows a specific URL scheme: `${server}/db/${appName}`, and
- has authentication/authorization done by Gotanda (hence setting [`credentials`](https://developer.mozilla.org/en-US/docs/Web/API/WindowOrWorkerGlobalScope/fetch#Syntax) to `include`).

To start this client app, 
1. start an independent web server to serve the client page on a different port (this demonstrates how your app doesn't have to live anywhere near the Gotanda server—the latter handles CORS, etc.): `npm run client-serve`;
2. open http://127.0.0.1:3001 (note you should use this IP address, instead of localhost, since auth is tied to it). It's going to try to connect to the Gotanda server running on 127.0.0.1:3000 (note the different port), realize you're not logged in, and ask you to "Log in" with a link to Gotanda.
3. Follow the link to Gotanda, http://127.0.0.1:3000 (if you haven't already started Gotanda, `npm run serve`; see above for full instructions), sign in with your GitHub, which will send you back to Gotanda.
4. Return to the *client app*, http://127.0.0.1:3001, start typing some notes. Do the same thing in another browser/device, watch the magic of PouchDB syncing.

## Gotanda endpoints
### `GET /`
Presents you with a webpage inviting you to sign in, etc.

### `GET /loginstatus`
Returns [200](http://http.cat/200) if you're logged in (either cookie or token), else [401](http://http.cat/401).

Let's talk about tokens.

### Tokens
#### `GET /auth/tokens`
Gotanda can authenticate and authorize you either via cookies (why we set `credentials` to `include` with [`fetch`](https://developer.mozilla.org/en-US/docs/Web/API/WindowOrWorkerGlobalScope/fetch#Syntax)) or tokens via the `Bearer` `Authentication` HTTP header. 

Gotanda allows you to create unlimited numbers of tokens, which should be treated as passwords to Gotanda. Each token has a "name" which is used to identify it. This endpoint, `/auth/tokens`, will *list all token names*.

Naturally you have to be signed in to see this.

#### `GET /auth/token/:name`
This creates a token with a given name. `:name` in this URL corresponds to a string. The token is displayed only once and never again. If you lose it, come back to this URL to get a new one. The old one will be deleted, so there's only one token per name.

An easy way to generate a token is to log into Gotanda via its website and visit this endpoint in the browser.

You can confirm the token works in curl:
```console
curl -H "Authorization: Bearer INSERT_TOKEN_HERE" 127.0.0.1:3000/loginstatus
```
This will print out a message if your token is legitimate, or tell you you're unauthorized.

#### `DELETE /auth/tokens`
Deletes all tokens.

#### `DELETE /auth/token/:name`
Deletes the token named `:name`.

### `GET /logout`
Logs you out of Gotanda in the browser.

### `* /db/:app`
This is the endpoint you should connect to with PouchDB. Gotanda internally rewrites the URL before giving it to PouchDB-Server so that Gotanda stores this app's data in a single database isolated from other users and other apps. This is the really important endpoint—the rest are by comparison much more fluffy! Except, that is, for the read-only onlooker API below—

### Read-only onlooker API
Gotanda allows you to designate another user on the same server as an "onlooker" on an app-by-app basis—they will have read-only access to each app you specify. More specifically, they will be able to create remote PouchDBs pointing at *your* databases and sync *from* there to their PouchDBs. Gotanda does not yet support *read-write*, which is why we use the phrase "onlooker" instead of "friend", but you can potentially achieve that by two people mutually adding each other as onlookers. We also avoid using the phrase "watcher" (as in, watching a GitHub repo), since onlooking is a privilege that the creator user gives to an onlooker.

Here's how the process works.

#### `PUT /me/onlooker/:onlookerId/app/:app`
Step one: you tell Gotanda that a user with `onlookerId` can read your `app` data.
- `onlookerId` is either
  - their Gotanda ID, which looks like `gotanda-<random string>`, which they can get by visiting the Gotanda homepage, or
  - their GitHub *ID, not username*, which looks like `github-<number>`. You can convert a GitHub username to their numeric ID by visiting https://api.github.com/users/THEIR_USER_NAME and looking at the `id` key—see [this answer](https://stackoverflow.com/q/17308954/500207) for more details. N.B., we don't use usernames because they can [change](https://help.github.com/articles/what-happens-when-i-change-my-username/).
- `app` is the same as above as the `/db/:app` endpoint described above.

#### `* /creator/:creatorId/app/:app` (some restrictions on methods and URLs for security)
This is the onlooker equivalent to the `db/:app` endpoint above (that you use to connect to your own apps). This is the endpoint that an onlooker provides to PouchDB to read the `app` database of the `creatorId` user, assuming the creator has shared this `app` with the signed-in onlooker.

> Gotanda allows only GET requests (which are read-only), and some allowable PUT/POST requests (which tend to be write-oriented) to non-data CouchDB/PouchDB URLs like `_all_docs`. However, Gotanda has not been security-audited nor battle-tested so please be cautious with what data you ask users to put on Gotanda.

#### `DELETE /me/onlooker/:onlookerId/app/:app`
Recind the `onlookerId` user's access to your `app`.

#### `DELETE /me/onlooker/:onlookerId`
Delete the `onlookerId`'s access to *all* your apps.

#### `DELETE /me/onlookers`
Delete *all* onlookers' access to *all* your apps.

#### `GET /me/onlookers`
Returns a list of all `{creator, app}`-pairs you are an onlooker of, and all `{onlooker, app}`-pairs you have granted, in the following format:
```ts
type Links = {
  onlookers: {onlooker: string, app: string}[],
  creators: {creator: string, app: string}[],
}
```
The `onlooker` and `creator` strings will be Gotanda IDs, in the form of `gotanda-<random string>`. If you added a user as an onlooker using their GitHub ID, you might not recognize this other ID that Gotanda uses internally to reference them.

### `GET /me/apps`
Gives you (in JSON) an array of app names synced to this Gotanda server. This list matches the "app" part of `/db/:app` endpoint above.

### `{GET,DELETE} /me/app/:app`
`GET` with the same `:app` app name as `/db/:app` above will return JSON of *all* data that this app has synced. Hitting this from the browser will give you a nicely-named JSON file.

`DELETE` will delete the PouchDB database backing this `:app`. Beware.

## Directions
I anticipate Gotanda PouchDB to be set up by one person and used by their circle of relatives, friends, students, etc., so I've paid relatively little attention to malicious users. Nonetheless, nothing but your bravery stops you from setting both allowlists to `*` to allow unlimited signups.

Right now this repo is intended to be used as a stand-alone executable. Get in touch if you need this to be an Express application that you can mount on one endpoint inside your larger app.

A previous incarnation of this, without PouchDB and a much simpler approach, is [Gotanda Events](https://github.com/fasiha/gotanda-events-server/).

We might have future iterations and improvements on Gotanda. PouchDB appears to be abandoned, and there might be a [flaw](https://github.com/pouchdb/pouchdb-server/issues/415) in its security model (which is why Gotanda handles the auth—the db you get is yours so you can do whatever you want inside it), but PouchDB remains absolutely lovely so if you do try Gotanda PouchDB, feel free to get in touch with any [issues](https://github.com/fasiha/gotanda-pouchdb-server/issues).
