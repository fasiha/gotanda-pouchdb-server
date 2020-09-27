// TODO What happens when an old user on a new device starts offline, creates some data, and then logs in?
// 1- If they created fresh docs (with no conflicting IDs), then nothing.
// 2- If they created docs with pre-existing IDs, then those won't sync and the client would de-conflict.

var db = new PouchDB('mydb');
var remotedb = new PouchDB('http://127.0.0.1:3000/db/mycoolapp', {
  fetch: (url, opts) => {
    opts.credentials = 'include';
    return PouchDB.fetch(url, opts);
  }
});
var changefeed, syncfeed;

async function renderdb() {
  const allDocs = await db.allDocs({include_docs: true});
  document.querySelector('#events').innerHTML = allDocs.rows.map(row => JSON.stringify(row.doc || {})).join('\n');
  console.log({allDocs});
}

(async function init() {
  const res = await fetch('http://127.0.0.1:3000/loginstatus', {credentials: 'include'});
  console.log(res.ok, res.status, res.statusText);
  if (res.ok) {
    // We're logged in on initial page load!
    document.querySelector("#login_out").innerHTML = 'Thanks for logging in!';
    document.querySelector('#form').classList.remove('hidden');
    renderdb();

    db.replicate.from(remotedb).then(() => {
      // one time sync done
      renderdb();
      syncfeed = db.sync(remotedb, {live: true, retry: true});
      changefeed = db.changes({since: 'now', live: true, include_docs: false}).on('change', change => {
        console.log('changed', change);
        renderdb();
      });
    });
  } else {
    // We're not logged in on initial page load
    document.querySelector("#login_out").innerHTML = '<a href="http://127.0.0.1:3000">Log in</a>';
    document.querySelector('#form').classList.add('hidden');
  }

  const submit = document.querySelector('#submit');
  submit.onclick = () => {
    const content = document.querySelector('#event').value;
    if (!content) { return; }
    db.put({_id: (new Date()).toISOString(), content});
  };
})();
