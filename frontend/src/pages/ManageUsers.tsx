import React, { useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation();
  const navigate = useNavigate();
  const account = useStore((s) => s.account);

  const [users, setUsers] = useState<User[] | null>(null);
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'admin' | 'user'>('user');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [roleChangingId, setRoleChangingId] = useState<string | null>(null);
  const [roleError, setRoleError] = useState<string | null>(null);

  const fetchUsers = () => {
    apiFetch('/api/auth/users')
      .then((res) => res.json())
      .then((json) => setUsers(json.data ?? []))
      .catch(() => setUsers([]));
  };

  const handleDelete = async (user: User) => {
    if (!window.confirm(t('users.confirmRemove', { name: user.name, username: user.username }))) return;
    setDeletingId(user.id);
    setDeleteError(null);
    try {
      const res = await apiFetch(`/api/auth/users/${user.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(typeof json.error === 'string' ? json.error : t('users.deleteFailed'));
      }
      setUsers((prev) => (prev ? prev.filter((u) => u.id !== user.id) : prev));
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : t('users.deleteFailed'));
    } finally {
      setDeletingId(null);
    }
  };

  const handleRoleChange = async (user: User, role: 'admin' | 'user') => {
    setRoleChangingId(user.id);
    setRoleError(null);
    try {
      const res = await apiFetch(`/api/auth/users/${user.id}/role`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(typeof json.error === 'string' ? json.error : t('users.roleFailed'));
      setUsers((prev) => (prev ? prev.map((u) => (u.id === user.id ? { ...u, role } : u)) : prev));
    } catch (err) {
      setRoleError(err instanceof Error ? err.message : t('users.roleFailed'));
    } finally {
      setRoleChangingId(null);
    }
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
      if (!res.ok) throw new Error(typeof json.error === 'string' ? json.error : t('users.createFailed'));
      setName('');
      setUsername('');
      setPassword('');
      setRole('user');
      fetchUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('users.createFailed'));
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
            className="flex items-center gap-1.5 text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-400 text-sm font-bold mb-6 transition-colors"
          >
            <span className="material-symbols-outlined text-[18px]">arrow_back</span>
            {t('common.back')}
          </button>
          <h1 className="text-4xl font-black text-zinc-900 dark:text-zinc-100 tracking-tighter">{t('users.heading')}</h1>
        </div>

        <div className="bg-white dark:bg-zinc-900 rounded-[40px] p-10 shadow-sm border border-zinc-100 dark:border-zinc-800 mb-8">
          <div className="mb-6">
            <h2 className="text-lg font-black text-zinc-900 dark:text-zinc-100">{t('users.listTitle')}</h2>
            <p className="text-sm text-zinc-400 dark:text-zinc-500 font-medium mt-1">{t('users.listHint')}</p>
          </div>
          {users === null ? (
            <p className="text-sm text-zinc-400 dark:text-zinc-500">{t('common.loading')}</p>
          ) : (
            <div className="space-y-2">
              {users.map((u) => (
                <div key={u.id} className="flex items-center gap-3 px-4 py-3 bg-zinc-50 dark:bg-zinc-900 rounded-xl">
                  <img
                    src={u.avatarUrl || `https://api.dicebear.com/7.x/avataaars/svg?seed=${u.username}`}
                    alt={u.name}
                    className="w-8 h-8 rounded-full object-cover shrink-0"
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold text-zinc-900 dark:text-zinc-100 truncate">{u.name}</p>
                    <p className="text-xs text-zinc-400 dark:text-zinc-500">@{u.username}</p>
                  </div>
                  <span className={`px-2.5 py-1 rounded-full text-[10px] font-black uppercase tracking-widest shrink-0 ${u.role === 'admin' ? 'bg-primary/10 text-primary' : 'bg-zinc-200 dark:bg-zinc-700 text-zinc-500 dark:text-zinc-400'}`}>
                    {t(`users.roles.${u.role}`)}
                  </span>
                  {u.id !== account?.id && (
                    <button
                      type="button"
                      onClick={() => handleRoleChange(u, u.role === 'admin' ? 'user' : 'admin')}
                      disabled={roleChangingId === u.id}
                      className="px-3 py-1.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 text-[10px] font-black uppercase tracking-widest hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors shrink-0 disabled:opacity-50"
                      title={u.role === 'admin' ? t('users.demoteTitle', { name: u.name }) : t('users.promoteTitle', { name: u.name })}
                    >
                      {roleChangingId === u.id ? '…' : u.role === 'admin' ? t('users.demote') : t('users.promote')}
                    </button>
                  )}
                  {u.id !== account?.id && (
                    <button
                      type="button"
                      onClick={() => handleDelete(u)}
                      disabled={deletingId === u.id}
                      className="w-8 h-8 rounded-full bg-red-50 text-red-400 flex items-center justify-center hover:bg-red-100 transition-colors shrink-0 disabled:opacity-50"
                      title={t('users.removeTitle', { name: u.name })}
                    >
                      <span className="material-symbols-outlined text-sm">
                        {deletingId === u.id ? 'sync' : 'delete'}
                      </span>
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          {roleError && <p className="mt-4 text-sm text-red-600 font-medium">{roleError}</p>}
          {deleteError && <p className="mt-4 text-sm text-red-600 font-medium">{deleteError}</p>}
        </div>

        <form onSubmit={handleCreate} className="bg-white dark:bg-zinc-900 rounded-[40px] p-10 shadow-sm border border-zinc-100 dark:border-zinc-800 space-y-6">
          <div>
            <h2 className="text-lg font-black text-zinc-900 dark:text-zinc-100">{t('users.addTitle')}</h2>
            <p className="text-sm text-zinc-400 dark:text-zinc-500 font-medium mt-1">{t('users.addHint')}</p>
          </div>
          <div>
            <label className="block text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest mb-2">{t('users.name')}</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full bg-zinc-50 dark:bg-zinc-900 rounded-2xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 dark:text-zinc-100 font-medium p-4"
            />
          </div>
          <div>
            <label className="block text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest mb-2">{t('users.username')}</label>
            <input
              type="text"
              autoCapitalize="none"
              value={username}
              onChange={(e) => setUsername(e.target.value.toLowerCase())}
              placeholder={t('users.usernamePlaceholder')}
              className="w-full bg-zinc-50 dark:bg-zinc-900 rounded-2xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 dark:text-zinc-100 font-medium p-4"
            />
          </div>
          <div>
            <label className="block text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest mb-2">{t('users.password')}</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t('users.passwordPlaceholder')}
              className="w-full bg-zinc-50 dark:bg-zinc-900 rounded-2xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 dark:text-zinc-100 font-medium p-4"
            />
          </div>
          <div>
            <label className="block text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest mb-2">{t('users.role')}</label>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as 'admin' | 'user')}
              className="w-full bg-zinc-50 dark:bg-zinc-900 rounded-2xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 dark:text-zinc-100 font-medium p-4 appearance-none cursor-pointer"
            >
              <option value="user">{t('users.roles.user')}</option>
              <option value="admin">{t('users.roles.admin')}</option>
            </select>
          </div>
          {error && <p className="text-sm text-red-600 font-medium">{error}</p>}
          <button
            type="submit"
            disabled={creating || !name || !username || password.length < 4}
            className="w-full py-4 bg-primary text-white rounded-2xl font-black shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all active:scale-[0.98] disabled:opacity-50"
          >
            {creating ? t('users.creating') : t('users.create')}
          </button>
        </form>
      </div>
    </AppLayout>
  );
}
