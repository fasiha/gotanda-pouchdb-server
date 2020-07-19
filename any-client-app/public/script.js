const events = [];      // string[]
let lastSharedId = '';  // Gotanda server's representation
let lastSharedIdx = -1; // My app's presentation
(async function init() {
  const res = await fetch('http://127.0.0.1:3000/loginstatus', {credentials: 'include'});
  console.log(res.ok, res.status, res.statusText);
  if (res.ok) {
    document.querySelector("#login_out").innerHTML = 'Thanks for logging in!';
    document.querySelector('#form').classList.remove('hidden');
  } else {
    document.querySelector("#login_out").innerHTML = 'Log in';
    document.querySelector('#form').classList.add('hidden');
  }

  const submit = document.querySelector('#submit');
  submit.onclick = () => {
    const content = document.querySelector('#event').value;
    if (!content) { return; }
    events.push(content);
    console.log(events);
    document.querySelector('#events').innerHTML = events.join('\n');
  };

  const sync = document.querySelector('#sync');
  sync.onclick = async () => {
    const url = 'http://127.0.0.1:3000/sync/mycoolapp';
    const body = {lastSharedId, newEvents: lastSharedIdx >= 0 ? events.slice(lastSharedIdx) : events};
    const fullResponse = await fetch(url, {
      credentials: 'include',
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body),
    });
    const res = await fullResponse.json();
    console.log(res);
    lastSharedId = res.lastSharedId;
    events.push(...res.newEvents.map(o => o.value));
    lastSharedIdx = events.length;

    // Render
    document.querySelector('#lastSharedId').innerHTML = lastSharedId;
    document.querySelector('#events').innerHTML = events.join('\n');
  };
})();
