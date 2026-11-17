'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/browser';

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const busy = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/auth/me', { signal: controller.signal }).then(response => {
      if (response.ok) router.replace('/');
      else if (response.status !== 401) setError('Could not check your session. You can try signing in below.');
    }).catch(cause => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not check your session');
    });
    return () => controller.abort();
  }, [router]);

  async function authenticate(mode: 'register' | 'login') {
    if (busy.current) return;
    if (!username.trim()) { setError('Username is required'); return; }
    if (!window.PublicKeyCredential) { setError('Your browser or device does not support passkeys.'); return; }
    busy.current = true;
    setPending(true); setError(null); setStatus('');
    async function post(url: string, body: unknown) {
      const response = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'Could not sign in');
      return data;
    }
    try {
      const options = await post(`/api/auth/${mode}-options`, { username: username.trim() });
      let response: RegistrationResponseJSON | AuthenticationResponseJSON;
      if (mode === 'register') response = await startRegistration({ optionsJSON: options });
      else response = await startAuthentication({ optionsJSON: options });
      await post(`/api/auth/${mode}-verify`, { username: username.trim(), response });
      router.replace('/');
      router.refresh();
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'NotAllowedError') setStatus('Passkey prompt cancelled. You can try again.');
      else setError(cause instanceof Error ? cause.message : 'Could not sign in. Please try again.');
    } finally {
      busy.current = false; setPending(false);
    }
  }

  return <main className="login">
    <section className="panel">
      <h1>Welcome to Todo planner</h1>
      <p className="muted">Sign in with your username and passkey. No password needed.</p>
      <form aria-busy={pending} onSubmit={event => { event.preventDefault(); void authenticate('login'); }}>
        <label htmlFor="username">Username
          <input id="username" name="username" autoComplete="username webauthn" required value={username}
            disabled={pending} onChange={event => setUsername(event.target.value)} />
        </label>
        {error && <p role="alert" className="error">{error}</p>}
        <p role="status">{pending ? 'Waiting for passkey verification...' : status}</p>
        <div className="row">
          <button className="primary" disabled={pending} type="submit">Login</button>
          <button disabled={pending} type="button" onClick={() => void authenticate('register')}>Register</button>
        </div>
      </form>
    </section>
  </main>;
}
