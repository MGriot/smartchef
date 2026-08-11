import { useEffect, useState } from 'react';
import { isNative } from '../lib/api';
import { isServerReachable } from '../lib/offlineSync';

export default function OfflineBanner() {
  const [offline, setOffline] = useState(false);
  const [pending, setPending] = useState(0);

  useEffect(() => {
    if (!isNative()) return;
    let cancelled = false;

    const check = async () => {
      const reachable = await isServerReachable();
      const { getPendingOperationCount } = await import('../lib/offlineStore');
      const count = await getPendingOperationCount().catch(() => 0);
      if (!cancelled) {
        setOffline(!reachable);
        setPending(count);
      }
    };

    check();
    const interval = setInterval(check, 15_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  if (!offline && pending === 0) return null;

  return (
    <div className={`px-4 py-2 text-center text-xs font-bold ${offline ? 'bg-amber-100 text-amber-800' : 'bg-primary/10 text-primary'}`}>
      {offline
        ? pending > 0
          ? `Offline — ${pending} change${pending === 1 ? '' : 's'} will sync when reconnected`
          : 'Offline — showing your last synced data'
        : `Syncing ${pending} pending change${pending === 1 ? '' : 's'}…`}
    </div>
  );
}
