import Database from 'better-sqlite3';
import path from 'node:path';
import { getSingaporeNow } from './timezone';

export interface User {
  id: number;
  username: string;
  created_at: string;
}

export interface Session {
  userId: number;
  username: string;
}

export interface Authenticator {
  id: number;
  user_id: number;
  credential_id: string;
  credential_public_key: Buffer;
  counter: number;
  created_at: string;
}

export interface CreateAuthenticatorInput {
  credential_id: string;
  credential_public_key: Uint8Array;
  counter?: number;
}

export type ChallengePurpose = 'registration' | 'authentication';

export interface AuthChallenge {
  id: string;
  username: string;
  purpose: ChallengePurpose;
  challenge: string;
  expires_at: number;
}

function requiredText(value: string, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function validateCounter(value: number | undefined): number {
  const counter = value ?? 0;
  if (!Number.isSafeInteger(counter) || counter < 0) {
    throw new Error('Invalid authenticator counter');
  }
  return counter;
}

function validatePurpose(purpose: ChallengePurpose): void {
  if (purpose !== 'registration' && purpose !== 'authentication') {
    throw new Error('Invalid challenge purpose');
  }
}

export function createDatabase(filename: string) {
  const db = new Database(filename);
  try {
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    const deadline = performance.now() + 5000;
    const wait = new Int32Array(new SharedArrayBuffer(4));
    for (;;) {
      try {
        db.pragma('journal_mode = WAL');
        break;
      } catch (error) {
        // Concurrent journal-mode changes can bypass SQLite's busy handler.
        const remaining = deadline - performance.now();
        if (!(error instanceof Error) || !('code' in error) ||
            error.code !== 'SQLITE_BUSY' || remaining <= 0) throw error;
        Atomics.wait(wait, 0, 0, Math.min(25, remaining));
      }
    }
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT UNIQUE NOT NULL CHECK(length(trim(username)) > 0),
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS authenticators (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          credential_id TEXT UNIQUE NOT NULL,
          credential_public_key BLOB NOT NULL,
          counter INTEGER NOT NULL DEFAULT 0 CHECK(counter >= 0),
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_authenticators_user_id ON authenticators(user_id);
        CREATE TABLE IF NOT EXISTS auth_challenges (
          id TEXT PRIMARY KEY NOT NULL,
          username TEXT NOT NULL,
          purpose TEXT NOT NULL CHECK(purpose IN ('registration', 'authentication')),
          challenge TEXT NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_auth_challenges_expires_at ON auth_challenges(expires_at);
      `);
    })();
  } catch (error) {
    db.close();
    throw error;
  }

  const userDB = {
    findById(id: number): User | undefined {
      return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as User | undefined;
    },
    findByUsername(username: string): User | undefined {
      return db.prepare('SELECT * FROM users WHERE username = ?')
        .get(requiredText(username, 'Username')) as User | undefined;
    },
    create(username: string): User {
      const result = db.prepare('INSERT INTO users (username, created_at) VALUES (?, ?)')
        .run(requiredText(username, 'Username'), getSingaporeNow().toISOString());
      return userDB.findById(Number(result.lastInsertRowid))!;
    },
    delete(id: number): boolean {
      return db.prepare('DELETE FROM users WHERE id = ?').run(id).changes > 0;
    },
  };

  const authenticatorDB = {
    findByCredentialId(credentialId: string): Authenticator | undefined {
      return db.prepare('SELECT * FROM authenticators WHERE credential_id = ?')
        .get(credentialId) as Authenticator | undefined;
    },
    findByCredentialIdForUser(credentialId: string, userId: number): Authenticator | undefined {
      return db.prepare('SELECT * FROM authenticators WHERE credential_id = ? AND user_id = ?')
        .get(credentialId, userId) as Authenticator | undefined;
    },
    findAllByUser(userId: number): Authenticator[] {
      return db.prepare('SELECT * FROM authenticators WHERE user_id = ? ORDER BY id')
        .all(userId) as Authenticator[];
    },
    create(userId: number, input: CreateAuthenticatorInput): Authenticator {
      const credentialId = requiredText(input.credential_id, 'Credential ID');
      if (!/^[A-Za-z0-9_-]+$/.test(credentialId) ||
          Buffer.from(credentialId, 'base64url').toString('base64url') !== credentialId) {
        throw new Error('Credential ID must be canonical base64url');
      }
      if (!(input.credential_public_key instanceof Uint8Array) ||
          input.credential_public_key.byteLength === 0) {
        throw new Error('Public key is required');
      }
      db.prepare(`INSERT INTO authenticators
        (user_id, credential_id, credential_public_key, counter, created_at)
        VALUES (?, ?, ?, ?, ?)`)
        .run(userId, credentialId, Buffer.from(input.credential_public_key),
          validateCounter(input.counter ?? 0), getSingaporeNow().toISOString());
      return authenticatorDB.findByCredentialId(credentialId)!;
    },
    updateCounter(id: number, counter: number | undefined): void {
      const value = validateCounter(counter ?? 0);
      // WebAuthn accepts a repeated zero only for authenticators without counters.
      const result = db.prepare(`UPDATE authenticators SET counter = ?
        WHERE id = ? AND (counter < ? OR (counter = 0 AND ? = 0))`)
        .run(value, id, value, value);
      if (!result.changes) throw new Error('Authenticator not found or counter did not advance');
    },
    delete(id: number, userId: number): boolean {
      return db.prepare('DELETE FROM authenticators WHERE id = ? AND user_id = ?')
        .run(id, userId).changes > 0;
    },
  };

  const registrationDB = {
    create(username: string, input: CreateAuthenticatorInput): {
      user: User; authenticator: Authenticator;
    } {
      return db.transaction(() => {
        const user = userDB.create(username);
        const authenticator = authenticatorDB.create(user.id, input);
        return { user, authenticator };
      })();
    },
  };

  const challengeStore = {
    save(id: string, username: string, purpose: ChallengePurpose, challenge: string): AuthChallenge {
      validatePurpose(purpose);
      const issuedAt = getSingaporeNow().getTime();
      const row: AuthChallenge = {
        id: requiredText(id, 'Challenge ID'),
        username: requiredText(username, 'Username'),
        purpose,
        challenge: requiredText(challenge, 'Challenge'),
        expires_at: issuedAt + 5 * 60_000,
      };
      db.transaction(() => {
        db.prepare('DELETE FROM auth_challenges WHERE expires_at <= ?').run(issuedAt);
        db.prepare(`INSERT INTO auth_challenges (id, username, purpose, challenge, expires_at)
          VALUES (@id, @username, @purpose, @challenge, @expires_at)`).run(row);
      })();
      return row;
    },
    // DELETE ... RETURNING consumes a challenge atomically across connections.
    consume(id: string, username: string, purpose: ChallengePurpose): AuthChallenge | undefined {
      validatePurpose(purpose);
      const row = db.prepare('DELETE FROM auth_challenges WHERE id = ? RETURNING *')
        .get(id) as AuthChallenge | undefined;
      if (!row || row.username !== requiredText(username, 'Username') ||
          row.purpose !== purpose || row.expires_at <= getSingaporeNow().getTime()) {
        return undefined;
      }
      return row;
    },
  };

  return { db, userDB, authenticatorDB, registrationDB, challengeStore };
}

export const { db, userDB, authenticatorDB, registrationDB, challengeStore } =
  createDatabase(process.env.DATABASE_PATH ?? path.join(process.cwd(), 'todos.db'));
