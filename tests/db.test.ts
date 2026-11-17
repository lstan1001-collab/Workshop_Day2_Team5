import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

// Keep the module's default connection away from the application's database.
const directory = mkdtempSync(path.join(tmpdir(), 'todo-auth-db-'));
process.env.DATABASE_PATH = path.join(directory, 'default.db');
const modulePromise = import('../lib/db');
const credential = (id: string, counter?: number) => ({
  credential_id: Buffer.from(id).toString('base64url'),
  credential_public_key: new Uint8Array([1, 2, 3]),
  counter,
});

after(async () => {
  const { db } = await modulePromise;
  db.close();
  rmSync(directory, { recursive: true });
});

test('registration is atomic; identities are unique and authenticators cascade', async () => {
  const { createDatabase } = await modulePromise;
  const store = createDatabase(':memory:');
  try {
    const first = store.registrationDB.create(' alice ', credential('key-one'));
    assert.equal(first.user.username, 'alice');
    assert.equal(first.authenticator.counter, 0);
    assert.deepEqual(first.authenticator.credential_public_key, Buffer.from([1, 2, 3]));
    store.authenticatorDB.create(first.user.id, credential('key-two'));
    assert.equal(store.authenticatorDB.findAllByUser(first.user.id).length, 2);
    assert.throws(() => store.registrationDB.create('alice', credential('third')), /UNIQUE/);
    assert.throws(() => store.registrationDB.create('bob', credential('key-one')), /UNIQUE/);
    assert.equal(store.userDB.findByUsername('bob'), undefined);
    assert.throws(() => store.registrationDB.create('bob', {
      ...credential('bob-key'), credential_public_key: new Uint8Array(),
    }), /Public key/);
    assert.equal(store.userDB.findByUsername('bob'), undefined);
    assert.equal(store.authenticatorDB.delete(first.authenticator.id, first.user.id + 1), false);
    store.userDB.delete(first.user.id);
    assert.deepEqual(store.authenticatorDB.findAllByUser(first.user.id), []);
    assert.deepEqual(store.db.pragma('foreign_key_check'), []);
  } finally {
    store.db.close();
  }
});

test('credential lookups enforce ownership and reject invalid authenticator values', async () => {
  const { createDatabase } = await modulePromise;
  const store = createDatabase(':memory:');
  try {
    const a = store.registrationDB.create('alice', credential('alice-key'));
    const b = store.registrationDB.create('bob', credential('bob-key'));
    assert.equal(store.authenticatorDB.findByCredentialIdForUser(
      a.authenticator.credential_id, b.user.id), undefined);
    assert.equal(store.authenticatorDB.findByCredentialIdForUser(
      a.authenticator.credential_id, a.user.id)?.id, a.authenticator.id);
    for (const invalid of [-1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => store.authenticatorDB.create(a.user.id, credential('invalid', invalid)), /counter/);
    }
    assert.throws(() => store.authenticatorDB.create(a.user.id, {
      ...credential('bad'), credential_id: 'not+base64/',
    }), /base64url/);
    assert.throws(() => store.userDB.create('   '), /Username/);
  } finally {
    store.db.close();
  }
});

test('counter writes reject stale and regressed assertions but allow zero-only devices', async () => {
  const { createDatabase } = await modulePromise;
  const store = createDatabase(':memory:');
  try {
    const { authenticator } = store.registrationDB.create('alice', credential('key'));
    store.authenticatorDB.updateCounter(authenticator.id, undefined);
    store.authenticatorDB.updateCounter(authenticator.id, 0);
    store.authenticatorDB.updateCounter(authenticator.id, 1);
    assert.throws(() => store.authenticatorDB.updateCounter(authenticator.id, 1), /did not advance/);
    assert.throws(() => store.authenticatorDB.updateCounter(authenticator.id, 0), /did not advance/);
    store.authenticatorDB.updateCounter(authenticator.id, 2);
    assert.equal(store.authenticatorDB.findByCredentialId(authenticator.credential_id)?.counter, 2);
  } finally {
    store.db.close();
  }
});

test('challenges expire, are purpose/user-bound and cannot be consumed twice', async () => {
  const { createDatabase } = await modulePromise;
  const store = createDatabase(':memory:');
  try {
    const saved = store.challengeStore.save('request-one', 'alice', 'registration', 'random-one');
    assert.ok(saved.expires_at > Date.now());
    assert.deepEqual(store.challengeStore.consume('request-one', 'alice', 'registration'), saved);
    assert.equal(store.challengeStore.consume('request-one', 'alice', 'registration'), undefined);
    store.challengeStore.save('wrong-purpose', 'alice', 'registration', 'random-two');
    assert.equal(store.challengeStore.consume('wrong-purpose', 'alice', 'authentication'), undefined);
    store.challengeStore.save('wrong-user', 'alice', 'authentication', 'random-three');
    assert.equal(store.challengeStore.consume('wrong-user', 'bob', 'authentication'), undefined);
    store.challengeStore.save('expired', 'alice', 'authentication', 'random-four');
    store.db.prepare('UPDATE auth_challenges SET expires_at = 0 WHERE id = ?').run('expired');
    assert.equal(store.challengeStore.consume('expired', 'alice', 'authentication'), undefined);
    store.challengeStore.save('same-id', 'alice', 'registration', 'original');
    assert.throws(() => store.challengeStore.save('same-id', 'alice', 'registration', 'replacement'), /UNIQUE/);
    assert.equal(store.challengeStore.consume('same-id', 'alice', 'registration')?.challenge, 'original');
  } finally {
    store.db.close();
  }
});

test('independent connections share persistence and single-use challenges without erasing other tables', async () => {
  const { createDatabase } = await modulePromise;
  const filename = path.join(directory, 'persistent.db');
  const first = createDatabase(filename);
  let second: ReturnType<typeof createDatabase> | undefined;
  try {
    first.registrationDB.create('alice', credential('saved-key'));
    first.db.exec("CREATE TABLE unrelated (value TEXT); INSERT INTO unrelated VALUES ('preserve')");
    first.challengeStore.save('shared', 'alice', 'authentication', 'challenge');
    second = createDatabase(filename);
    assert.equal(second.userDB.findByUsername('alice')?.username, 'alice');
    assert.deepEqual(second.db.prepare('SELECT * FROM unrelated').all(), [{ value: 'preserve' }]);
    assert.ok(first.challengeStore.consume('shared', 'alice', 'authentication'));
    assert.equal(second.challengeStore.consume('shared', 'alice', 'authentication'), undefined);
    const names = second.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
    assert.equal(names.some(({ name }) => ['todos', 'tags', 'templates', 'holidays'].includes(name)), false);
  } finally {
    first.db.close();
    second?.db.close();
  }
});

test('a challenge is invalid at its exact expiry boundary', async (context) => {
  const { createDatabase } = await modulePromise;
  const store = createDatabase(':memory:');
  context.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  try {
    const justBefore = store.challengeStore.save('before', 'alice', 'authentication', 'one');
    context.mock.timers.setTime(justBefore.expires_at - 1);
    assert.ok(store.challengeStore.consume('before', 'alice', 'authentication'));
    const atBoundary = store.challengeStore.save('boundary', 'alice', 'authentication', 'two');
    context.mock.timers.setTime(atBoundary.expires_at);
    assert.equal(store.challengeStore.consume('boundary', 'alice', 'authentication'), undefined);
    assert.equal(store.challengeStore.consume('boundary', 'alice', 'authentication'), undefined);
  } finally {
    store.db.close();
    context.mock.timers.reset();
  }
});

test('separate connections cannot accept the same nonzero counter twice', async () => {
  const { createDatabase } = await modulePromise;
  const filename = path.join(directory, 'counter.db');
  const first = createDatabase(filename);
  const second = createDatabase(filename);
  try {
    const { authenticator } = first.registrationDB.create('alice', credential('counter-key'));
    const stale = second.authenticatorDB.findByCredentialId(authenticator.credential_id)!;
    first.authenticatorDB.updateCounter(authenticator.id, stale.counter + 1);
    assert.throws(() => second.authenticatorDB.updateCounter(stale.id, stale.counter + 1),
      /did not advance/);
    assert.equal(second.authenticatorDB.findByCredentialId(authenticator.credential_id)?.counter, 1);
  } finally {
    second.db.close();
    first.db.close();
  }
});

test('parallel workers initialize a fresh database without lock errors', { timeout: 60_000 }, async () => {
  const { createDatabase } = await modulePromise;
  const source = `
    require('tsx/cjs');
    const { parentPort, workerData } = require('node:worker_threads');
    const { createDatabase, db } = require(workerData.modulePath);
    db.close();
    parentPort.postMessage('ready');
    Atomics.wait(new Int32Array(workerData.gate), 0, 0);
    const store = createDatabase(workerData.filename);
    store.userDB.create('worker-' + workerData.index);
    store.db.close();
  `;
  for (let round = 0; round < 5; round++) {
    const filename = path.join(directory, `parallel-${round}.db`);
    const gate = new SharedArrayBuffer(4);
    const children = Array.from({ length: 8 }, (_, index) => new Worker(source, {
      eval: true,
      env: { ...process.env, DATABASE_PATH: ':memory:' },
      workerData: { modulePath: path.resolve('lib/db.ts'), filename, gate, index },
    }));
    try {
      const completed = children.map(child => new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', code => {
          if (code === 0) resolve();
          else reject(new Error(`Database worker exited ${code}`));
        });
      }));
      const ready = children.map(child => new Promise<void>((resolve, reject) => {
        child.once('message', () => resolve());
        child.once('error', reject);
        child.once('exit', code => reject(new Error(`Worker exited before startup: ${code}`)));
      }));
      // Observe startup failures as well as exits to avoid leaving worker failures unhandled.
      const allCompleted = Promise.all(completed);
      await Promise.race([Promise.all(ready), allCompleted]);
      Atomics.store(new Int32Array(gate), 0, 1);
      Atomics.notify(new Int32Array(gate), 0);
      await allCompleted;
      const store = createDatabase(filename);
      try {
        assert.equal((store.db.prepare('SELECT count(*) AS count FROM users').get() as { count: number }).count, 8);
        assert.deepEqual(store.db.pragma('integrity_check'), [{ integrity_check: 'ok' }]);
        assert.deepEqual(store.db.pragma('foreign_key_check'), []);
      } finally {
        store.db.close();
      }
    } finally {
      await Promise.all(children.map(child => child.terminate()));
    }
  }
});
