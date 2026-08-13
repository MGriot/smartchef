import { useEffect, useState } from 'react';

// Plain browser connectivity check — used to decide whether it's worth
// trying to load OpenStreetMap tiles. Deliberately separate from the app's
// native-only `isServerReachable()`/Capacitor `Network` check in
// lib/offlineSync.ts, which answers a different question (can we reach
// *our own* backend), not "is there general internet access for a
// third-party tile server".
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine);

  useEffect(() => {
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  return online;
}
