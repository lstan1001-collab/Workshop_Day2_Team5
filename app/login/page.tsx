'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { authenticate, authFailure, getCurrentSession } from '../../lib/auth-client';

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [checking, setChecking] = useState(true);
  const [checkFailed, setCheckFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [pending, setPending] = useState<'login' | 'register' | null>(null);
  const [feedback, setFeedback] = useState({ cancelled: false, message: '' });
  const busy = useRef(false);
  const usernameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    setChecking(true);
    setCheckFailed(false);
    setFeedback({ cancelled: false, message: '' });
    getCurrentSession(controller.signal).then(session => {
      if (controller.signal.aborted) return;
      if (session) {
        router.replace('/');
        router.refresh();
      } else setChecking(false);
    }).catch(error => {
      if (controller.signal.aborted) return;
      setFeedback(authFailure(error));
      setCheckFailed(true);
      setChecking(false);
    });
    return () => controller.abort();
  }, [router, attempt]);

  async function submit(mode: 'login' | 'register') {
    if (busy.current || checking || checkFailed) return;
    if (!username.trim()) {
      setFeedback({ cancelled: false, message: 'Enter a username.' });
      usernameRef.current?.focus();
      return;
    }
    busy.current = true;
    setPending(mode);
    setFeedback({ cancelled: false, message: '' });
    try {
      await authenticate(mode, username.trim());
      router.replace('/');
      router.refresh();
    } catch (error) {
      setFeedback(authFailure(error));
      setPending(null);
      busy.current = false;
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submit('login');
  }

  return (
    <section className="card login" aria-labelledby="login-heading">
      <h1 id="login-heading">Welcome to Todo App</h1>
      <p>Use your username and a passkey to sign in. No password needed.</p>
      <form onSubmit={onSubmit} aria-busy={checking || pending !== null}>
        <label htmlFor="username">Username</label>
        <input ref={usernameRef} id="username" name="username" autoComplete="username webauthn"
          value={username} onChange={event => setUsername(event.target.value)}
          disabled={checking || pending !== null} aria-describedby="username-hint" />
        <p id="username-hint" className="hint">Use your device PIN, fingerprint, face recognition, or security key.</p>
        <div className="feedback">
          <p role="status">{checking ? 'Checking your session...' : pending ? 'Complete the passkey prompt on your device...' : feedback.cancelled ? feedback.message : ''}</p>
          {!feedback.cancelled && feedback.message && <p className="error" role="alert">{feedback.message}</p>}
        </div>
        {checkFailed ? (
          <button type="button" onClick={() => setAttempt(value => value + 1)}>Retry session check</button>
        ) : (
          <div className="actions">
            <button type="submit" disabled={checking || pending !== null}>Login</button>
            <button type="button" className="secondary" disabled={checking || pending !== null}
              onClick={() => void submit('register')}>Register</button>
          </div>
        )}
      </form>
      <p className="hint">New here? Choose Register. Keep access to your passkeys: account recovery is not available.</p>
    </section>
  );
}
