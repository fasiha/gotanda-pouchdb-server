import levelup from 'levelup';
export type Db = ReturnType<typeof levelup>;

function drainStream<T>(stream: NodeJS.ReadableStream): Promise<T[]> {
  const ret: T[] = [];
  return new Promise((resolve, reject) => {
    stream.on('data', x => ret.push(x))
        .on('error', e => reject(e))
        .on('close', () => resolve(ret))
        .on('end', () => resolve(ret));
  })
}

export async function sync(db: Db, parents: string[], lastSharedId: string = '', newEvents: string[] = []) {
  const prefix = parents.join('/') + '/';
  const opts = {gt: prefix + lastSharedId, lt: prefix + '\uFE0F'};
  const toReturn: {key: string, value: string}[] = await drainStream(db.createReadStream(opts));
  let newLastSharedId = toReturn.length ? toReturn[toReturn.length - 1].key.replace(prefix, '') : lastSharedId;

  if (newEvents.length) {
    // we pad the date so deal with unix timestamp overflow:
    // `new Date(parseInt('1'.padEnd(10,'0'),36))` => 5188-04-22T11:04:28.416Z.
    // We also add a few digits of pseudo-random jitter in case this function is called multiple times in the same
    // millisecond.
    //
    // This is not perfect: if this function is called twice in the same millisecond, and the first that
    // writes picks `jitter='z'` while the second to write picks `jitter='a'`, the client after the second call might
    // see events that it's *already* seen. We'll warn about this in the docs. One way to fix this is to switch to
    // SQLite (transactions and auto-increment can fix this issue).
    const jitter = Math.random().toString(36).slice(2).slice(0, 2);
    const now = Date.now().toString(36).padStart(10, '0') + '-' + jitter + '-';
    const maxLength = newEvents.length.toString(36).length;
    const batch = db.batch();
    for (const [i, e] of newEvents.entries()) {
      newLastSharedId = now + i.toString(36).padStart(maxLength, '0');
      const id = prefix + newLastSharedId;
      batch.put(id, e);
    }
    await batch.write();
  }
  return {newEvents: toReturn, lastSharedId: newLastSharedId};
}

export function setup(name: string): Db { return (require('level'))(name); }

if (module === require.main) {
  (async function main() {
    var db = setup('gotanda-db-test');

    let lastSharedId = '';
    let res = await sync(db, [], lastSharedId, []);
    console.log(res);

    lastSharedId = res.lastSharedId;

    const d = (new Date()).toISOString();
    console.log(await sync(db, [], lastSharedId, ['hi', 'there'].map(s => `${d}: ${s}`)));
  })();
}