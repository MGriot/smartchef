import React, { useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import AppLayout from '../components/AppLayout';
import { useStore } from '../store/app.store';
import { apiFetch } from '../lib/api';

interface User {
  id: string;
  username: string;
  name: string;
  role: 'admin' | 'user';
  avatarUrl?: string | null;
}

export default function ManageUsers() {
  const navigate = useNavigate();
  const account = useStore((s) => s.account);

  const [users, setUsers] = useState<User[] | null>(null);
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'admin' | 'user'>('user');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchUsers = () => {
    apiFetch('/api/auth/users')
      .then((res) => res.json())
      .then((json) => setUsers(json.data ?? []))
      .catch(() => setUsers([]));
  };

  useEffect(() => {
    if (account?.role === 'admin') fetchUsers();
  }, [account?.role]);

  if (account && account.role !== 'admin') {
    return <Navigate to="/" replace />;
  }

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const res = await apiFetch('/api/auth/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, username, password, role }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(typeof json.error === 'string' ? json.error : 'Failed to create user');
      setName('');
      setUsername('');
      setPassword('');
      setRole('user');
      fetchUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create user');
    } finally {
      setCreating(false);
    }
  };

  return (
    <AppLayout>
      <div className="p-12 max-w-2xl mx-auto">
        <div className="mb-10">
          <button
            onClick={() => navigate(-1)}
            className="flex items-center gap-1.5 text-zinc-400 hover:text-zinc-600 text-sm font-bold mb-6 transition-colors"
          >
            <span className="material-symbols-outlined text-[18px]">arrow_back</span>
            Back
          </button>
          <h1 className="text-4xl font-black text-zinc-900 tracking-tighter">Manage Users</h1>
        </div>

        <div className="bg-white rounded-[40px] p-10 shadow-sm border border-zinc-100 mb-8">
          <div className="mb-6">
            <h2 className="text-lg font-black text-zinc-900">Users</h2>
            <p className="text-sm text-zinc-400 font-medium mt-1">Everyone who can log into this instance.</p>
          </div>
          {users === null ? (
            <p className="text-sm text-zinc-400">Loading…</p>
          ) : (
            <div className="space-y-2">
              {users.map((u) => (
                <div key={u.id} className="flex items-center gap-3 px-4 py-3 bg-zinc-50 rounded-xl">
                  <img
                    src={u.avatarUrl || `https://api.dicebear.com/7.x/avataaars/svg?seed=${u.username}`}
                    alt={u.name}
                    className="w-8 h-8 rounded-full object-cover shrink-0"
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold text-zinc-900 truncate">{u.name}</p>
                    <p className="text-xs text-zinc-400">@{u.username}</p>
                  </div>
                  <span className={`px-2.5 py-1 rounded-full text-[10px] font-black uppercase tracking-widest shrink-0 ${u.role === 'admin' ? 'bg-primary/10 text-primary' : 'bg-zinc-200 text-zinc-500'}`}>
                    {u.role}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <form onSubmit={handleCreate} className="bg-white rounded-[40px] p-10 shadow-sm border border-zinc-100 space-y-6">
          <div>
            <h2 className="text-lg font-black text-zinc-900">Add a User</h2>
            <p className="text-sm text-zinc-400 font-medium mt-1">They'll use this username and password to log in.</p>
          </div>
          <div>
            <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full bg-zinc-50 rounded-2xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 font-medium p-4"
            />
          </div>
          <div>
            <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2">Username</label>
            <input
              type="text"
              autoCapitalize="none"
              value={username}
              onChange={(e) => setUsername(e.target.value.toLowerCase())}
              placeholder="e.g. sara"
              className="w-full bg-zinc-50 rounded-2xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 font-medium p-4"
            />
          </div>
          <div>
            <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 4 characters"
              className="w-full bg-zinc-50 rounded-2xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 font-medium p-4"
            />
          </div>
          <div>
            <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2">Role</label>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as 'admin' | 'user')}
              className="w-full bg-zinc-50 rounded-2xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 font-medium p-4 appearance-none cursor-pointer"
            >
              <option value="user">User</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          {error && <p className="text-sm text-red-600 font-medium">{error}</p>}
          <button
            type="submit"
            disabled={creating || !name || !username || password.length < 4}
            className="w-full py-4 bg-primary text-white rounded-2xl font-black shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all active:scale-[0.98] disabled:opacity-50"
          >
            {creating ? 'Creating…' : 'Create User'}
          </button>
        </form>
      </div>
    </AppLayout>
  );
}
