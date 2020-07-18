import levelup from 'levelup';
type Db = ReturnType<typeof levelup>;
var globalDb: Db = (require('level'))('gotanda-db');

function drainStream<T>(stream: NodeJS.ReadableStream): Promise<T[]> {
  const ret: T[] = [];
  return new Promise((resolve, reject) => {
    stream.on('data', x => ret.push(x))
        .on('error', e => reject(e))
        .on('close', () => resolve(ret))
        .on('end', () => resolve(ret));
  })
}

export async function sync(parents: string[], lastSharedId: string = '', newEvents: string[] = [], db: Db = globalDb) {
  const prefix = parents.join('/') + '/';
  const opts = {gt: prefix + lastSharedId, lt: prefix + '\uFE0F'};
  const toReturn: {key: string, value: string}[] = await drainStream(db.createReadStream(opts));

  if (newEvents.length) {
    const now = Date.now().toString(36) + '-';
    const maxLength = newEvents.length.toString(36).length;
    const batch = db.batch();
    for (const [i, e] of newEvents.entries()) {
      const id = prefix + now + i.toString(36).padStart(maxLength, '0');
      batch.put(id, e);
    }
    await batch.write();
  }

  const newLastSharedId = toReturn.length ? toReturn[toReturn.length - 1].key.replace(prefix, '') : lastSharedId;
  return {newEvents: toReturn, lastSharedId: newLastSharedId};
}

if (module === require.main) {
  (async function main() {
    let lastSharedId = '';
    let res = await sync([], lastSharedId, [], globalDb);
    console.log(res);

    lastSharedId = res.lastSharedId;

    const d = (new Date()).toISOString();
    console.log(await sync([], lastSharedId, ['hi', 'there'].map(s => `${d}: ${s}`), globalDb));
  })()
}