'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { addPasskey, authFailure, getCurrentSession, logout, type AuthSession } from '../lib/auth-client';

export default function AccountPage() {
  const router = useRouter();
  const [session, setSession] = useState<AuthSession | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<'logout' | 'passkey' | null>(null);
  const [feedback, setFeedback] = useState({ cancelled: false, message: '' });
  const [notice, setNotice] = useState('');
  const busy = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setFeedback({ cancelled: false, message: '' });
    getCurrentSession(controller.signal).then(current => {
      if (controller.signal.aborted) return;
      if (!current) {
        router.replace('/login');
        router.refresh();
      } else {
        setSession(current);
        setLoading(false);
      }
    }).catch(error => {
      if (controller.signal.aborted) return;
      setFeedback(authFailure(error));
      setLoading(false);
    });
    return () => controller.abort();
  }, [router, attempt]);

  async function perform(action: 'logout' | 'passkey') {
    if (busy.current) return;
    busy.current = true;
    setPending(action);
    setNotice('');
    setFeedback({ cancelled: false, message: '' });
    try {
      if (action === 'logout') {
        await logout();
        router.replace('/login');
        router.refresh();
      } else {
        await addPasskey();
        setNotice('Passkey added. You can use it to sign in to this account.');
        busy.current = false;
        setPending(null);
      }
    } catch (error) {
      setFeedback(authFailure(error));
      setPending(null);
      busy.current = false;
    }
  }

  return (
    <section className="card" aria-labelledby="account-heading" aria-busy={loading || pending !== null}>
      <header className="account-header">
        <div>
          <h1 id="account-heading">Your account</h1>
          {session && <p>Signed in as <strong>{session.username}</strong></p>}
        </div>
        {session && <div className="actions">
          <button type="button" className="secondary" disabled={pending !== null}
            onClick={() => void perform('passkey')}>Add passkey</button>
          <button type="button" disabled={pending !== null}
            onClick={() => void perform('logout')}>Logout</button>
        </div>}
      </header>
      <p role="status">{loading ? 'Checking your session...' : pending === 'passkey'
        ? 'Complete the passkey prompt on your device...' : pending === 'logout'
        ? 'Signing out...' : feedback.cancelled ? feedback.message : notice}</p>
      {!feedback.cancelled && feedback.message && <p role="alert" className="error">{feedback.message}</p>}
      {!loading && !session && <button type="button" onClick={() => setAttempt(value => value + 1)}>Retry session check</button>}
      {session && <p className="hint">Add another passkey while signed in to keep another way into your account.
        There is no account recovery if you lose every passkey. Todo features are not included in this authentication phase.</p>}
    </section>
  );
}
