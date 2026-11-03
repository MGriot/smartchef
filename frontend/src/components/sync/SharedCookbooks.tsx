import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal, { ModalCancelButton, ModalSubmitButton } from '../Modal';
import { Field, FieldRow } from '../Form';
import type { CookbookInvite, CookbookStoreConfig, CookbookSummary } from '../../services/sharedCookbooks.local';

// ════════════════════════════════════════════════════════════════════════
// SmartChef — shared cookbooks: the Account card and the recipe's
// "Shared cookbook" dialog (services/sharedCookbooks.local.ts)
//
// A cookbook lives in a place every member can reach — a WebDAV folder
// (a Nextcloud public link with edit rights works for everyone) or a git
// repository — and is joined with an invite file whose passphrase the
// inviter passes on some other way. Only with the new sync engine: the
// cookbook is a change log like the library's own.
// ════════════════════════════════════════════════════════════════════════

type CookbookService = typeof import('../../services/sharedCookbooks.local');
let loadService: () => Promise<CookbookService> = () => import('../../services/sharedCookbooks.local');
const books = () => loadService();

/** Replaces the service with a stand-in — for a probe page, where the web
 *  build has no SQLite. */
export function setCookbookServiceLoader(load: () => Promise<CookbookService>): void {
  loadService = load;
}

const MIN_PASSPHRASE = 8;

const emptyStore = (): CookbookStoreConfig => ({ kind: 'webdav', url: 'https://', username: '', password: '' });

function storeIsComplete(s: CookbookStoreConfig): boolean {
  if (!/^https?:\/\/.+/.test(s.url.trim())) return false;
  return s.kind === 'git' || (!!s.username.trim() && !!s.password);
}

function StoreFields({ value, onChange }: { value: CookbookStoreConfig; onChange: (s: CookbookStoreConfig) => void }) {
  const { t } = useTranslation();
  const kinds: Array<CookbookStoreConfig['kind']> = ['webdav', 'git'];
  const switchKind = (kind: CookbookStoreConfig['kind']) => {
    if (kind === value.kind) return;
    onChange(kind === 'webdav'
      ? { kind, url: value.url, username: value.username ?? '', password: '' }
      : { kind, url: value.url, username: value.username || null, token: null });
  };
  return (
    <div className="space-y-4">
      <div role="radiogroup" className="flex gap-2">
        {kinds.map((kind) => (
          <button
            key={kind}
            type="button"
            role="radio"
            aria-checked={value.kind === kind}
            onClick={() => switchKind(kind)}
            className={`px-3 py-1.5 rounded-full text-xs font-bold border transition-colors ${
              value.kind === kind ? 'border-primary bg-primary/10 text-primary' : 'border-zinc-200 dark:border-zinc-700 text-zinc-500 dark:text-zinc-400'
            }`}
          >
            {t(`account.cookbooks.store.${kind}`)}
          </button>
        ))}
      </div>
      <Field label={t('account.cookbooks.store.url')} htmlFor="cookbook-url" hint={t(`account.cookbooks.store.${value.kind}Hint`)}>
        <input id="cookbook-url" className="sc-field-inset" value={value.url} autoCapitalize="none" spellCheck={false}
          onChange={(e) => onChange({ ...value, url: e.target.value })} />
      </Field>
      <FieldRow>
        <Field label={t('account.cookbooks.store.username')} htmlFor="cookbook-user">
          <input id="cookbook-user" className="sc-field-inset" value={value.username ?? ''} autoCapitalize="none" spellCheck={false}
            onChange={(e) => onChange(value.kind === 'webdav' ? { ...value, username: e.target.value } : { ...value, username: e.target.value || null })} />
        </Field>
        <Field label={t(value.kind === 'webdav' ? 'account.cookbooks.store.password' : 'account.cookbooks.store.token')} htmlFor="cookbook-secret">
          <input id="cookbook-secret" type="password" className="sc-field-inset" autoComplete="off"
            value={value.kind === 'webdav' ? value.password : value.token ?? ''}
            onChange={(e) => onChange(value.kind === 'webdav' ? { ...value, password: e.target.value } : { ...value, token: e.target.value || null })} />
        </Field>
      </FieldRow>
    </div>
  );
}

function CreateCookbookDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [store, setStore] = useState<CookbookStoreConfig>(emptyStore);
  const [encrypt, setEncrypt] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const book = await (await books()).createCookbook(name, store, encrypt);
      setName('');
      setStore(emptyStore());
      onCreated(book.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('account.cookbooks.createTitle')}
      subtitle={t('account.cookbooks.createSubtitle')}
      size="sm"
      onSubmit={() => void submit()}
      footer={
        <>
          <ModalCancelButton onClick={onClose}>{t('common.cancel')}</ModalCancelButton>
          <ModalSubmitButton disabled={busy || !name.trim() || !storeIsComplete(store)}>{t('account.cookbooks.create')}</ModalSubmitButton>
        </>
      }
    >
      <div className="space-y-4">
        <Field label={t('account.cookbooks.name')} htmlFor="cookbook-name">
          <input id="cookbook-name" className="sc-field-inset" value={name} autoFocus onChange={(e) => setName(e.target.value)} />
        </Field>
        <StoreFields value={store} onChange={setStore} />
        <label className="flex items-start gap-2 text-sm text-zinc-700 dark:text-zinc-300">
          <input type="checkbox" className="mt-1 h-4 w-4 accent-primary" checked={encrypt} onChange={(e) => setEncrypt(e.target.checked)} />
          <span>
            <span className="font-bold">{t('account.cookbooks.encrypt')}</span>
            <span className="block text-xs text-zinc-500 dark:text-zinc-400">{t('account.cookbooks.encryptHint')}</span>
          </span>
        </label>
        {error && <p className="text-sm text-red-600 font-medium">{error}</p>}
      </div>
    </Modal>
  );
}

function InviteDialog({ cookbook, onClose }: { cookbook: CookbookSummary | null; onClose: () => void }) {
  const { t } = useTranslation();
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const close = () => { setPassphrase(''); setConfirm(''); setSaved(null); setError(null); onClose(); };
  const submit = async () => {
    if (!cookbook) return;
    setBusy(true);
    setError(null);
    try {
      const [{ buildInvite, INVITE_EXTENSION }, { saveExportFile }, { getDeviceName }] = await Promise.all([
        books(), import('../../lib/fileExport'), import('../../lib/sync/gitSync'),
      ]);
      const text = await buildInvite(cookbook.id, passphrase, await getDeviceName());
      const slug = cookbook.name.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'cookbook';
      const fileName = `${slug}${INVITE_EXTENSION}`;
      const result = await saveExportFile({ fileName, mimeType: 'application/octet-stream', data: text }, { dialogTitle: t('account.cookbooks.inviteTitle') });
      if (result) setSaved(result.location ?? fileName);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const valid = passphrase.length >= MIN_PASSPHRASE && passphrase === confirm;
  return (
    <Modal
      open={!!cookbook}
      onClose={close}
      title={t('account.cookbooks.inviteTitle')}
      subtitle={cookbook?.name}
      size="sm"
      onSubmit={() => void submit()}
      footer={saved ? (
        <ModalSubmitButton type="button" onClick={close}>{t('setupFile.done')}</ModalSubmitButton>
      ) : (
        <>
          <ModalCancelButton onClick={close}>{t('common.cancel')}</ModalCancelButton>
          <ModalSubmitButton disabled={!valid || busy}>{t('account.cookbooks.saveInvite')}</ModalSubmitButton>
        </>
      )}
    >
      {saved ? (
        <p className="text-sm text-zinc-700 dark:text-zinc-300">{t('account.cookbooks.inviteSaved', { location: saved })}</p>
      ) : (
        <div className="space-y-4">
          <p className="sc-hint">{t('account.cookbooks.inviteHint')}</p>
          <Field label={t('setupFile.passphrase')} htmlFor="invite-pass" hint={t('setupFile.passphraseHint', { count: MIN_PASSPHRASE })}>
            <input id="invite-pass" type="password" className="sc-field-inset" value={passphrase} autoFocus onChange={(e) => setPassphrase(e.target.value)} />
          </Field>
          <Field label={t('setupFile.confirmPassphrase')} htmlFor="invite-pass-2">
            <input id="invite-pass-2" type="password" className="sc-field-inset" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </Field>
          {error && <p className="text-sm text-red-600 font-medium">{error}</p>}
        </div>
      )}
    </Modal>
  );
}

function JoinDialog({ open, onClose, onJoined }: { open: boolean; onClose: () => void; onJoined: () => void }) {
  const { t } = useTranslation();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [invite, setInvite] = useState<CookbookInvite | null>(null);
  const [store, setStore] = useState<CookbookStoreConfig>(emptyStore);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = () => { setFile(null); setPassphrase(''); setInvite(null); setError(null); onClose(); };
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const b = await books();
      if (!invite) {
        if (!file) return;
        const opened = await b.readInvite(await file.text(), passphrase);
        setInvite(opened);
        setStore(opened.cookbook.store);
        return;
      }
      await b.joinCookbooks([{ ...invite.cookbook, store }]);
      const { syncNow } = await import('../../lib/sync/gitSync');
      await syncNow().catch((err) => console.warn('SmartChef: first sync of a joined cookbook failed:', err));
      onJoined();
      close();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t('setupFile.readFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title={t('account.cookbooks.joinTitle')}
      subtitle={invite ? invite.cookbook.name : t('account.cookbooks.joinSubtitle')}
      size="sm"
      onSubmit={() => void submit()}
      footer={
        <>
          <ModalCancelButton onClick={close}>{t('common.cancel')}</ModalCancelButton>
          <ModalSubmitButton disabled={busy || (invite ? !storeIsComplete(store) : !file || !passphrase)}>
            {invite ? t('account.cookbooks.join') : t('setupFile.apply')}
          </ModalSubmitButton>
        </>
      }
    >
      <div className="space-y-4">
        {invite ? (
          <>
            {invite.invitedBy && <p className="text-sm text-zinc-700 dark:text-zinc-300">{t('account.cookbooks.invitedBy', { name: invite.invitedBy })}</p>}
            <p className="sc-hint">{t('account.cookbooks.joinStoreHint')}</p>
            <StoreFields value={store} onChange={setStore} />
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="w-full flex items-center gap-3 p-4 rounded-2xl border border-dashed border-zinc-300 dark:border-zinc-700 hover:border-primary/50 transition-colors text-left"
            >
              <span className="material-symbols-outlined text-primary">upload_file</span>
              <span className="block text-sm font-bold text-zinc-900 dark:text-zinc-100 truncate">{file ? file.name : t('account.cookbooks.chooseInvite')}</span>
            </button>
            <input ref={fileRef} type="file" accept=".scinvite,application/octet-stream,application/json,*/*" className="hidden"
              onChange={(e) => { const picked = e.target.files?.[0]; if (picked) { setFile(picked); setError(null); } }} />
            <Field label={t('setupFile.passphrase')} htmlFor="join-pass">
              <input id="join-pass" type="password" className="sc-field-inset" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
            </Field>
          </>
        )}
        {error && <p className="text-sm text-red-600 font-medium">{error}</p>}
      </div>
    </Modal>
  );
}

/** Account → Shared cookbooks. Rendered only in standalone mode, and empty
 *  until this device syncs with the new engine. */
export default function SharedCookbooksCard() {
  const { t } = useTranslation();
  const [engine, setEngine] = useState<string | null>(null);
  const [summary, setSummary] = useState<{ joined: CookbookSummary[]; notJoined: string[] } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [showCreate, setShowCreate] = useState(false);
  const [showJoin, setShowJoin] = useState(false);
  const [inviteFor, setInviteFor] = useState<CookbookSummary | null>(null);

  const refresh = async () => {
    const b = await books();
    const next = await b.summarizeCookbooks();
    setSummary(next);
    setErrors(Object.fromEntries(b.lastCookbookResults().filter((r) => r.error).map((r) => [r.id, r.error!])));
    return next;
  };

  useEffect(() => {
    void import('../../lib/sync/syncSettings').then(({ getSyncEngine }) => getSyncEngine()).then(setEngine);
    void refresh();
  }, []);

  if (engine !== 'v2' || !summary) return null;

  const leave = async (book: CookbookSummary) => {
    if (!window.confirm(t('account.cookbooks.confirmLeave', { name: book.name }))) return;
    await (await books()).leaveCookbook(book.id);
    await refresh();
  };

  return (
    <div className="bg-white dark:bg-zinc-900 rounded-[40px] p-6 sm:p-10 shadow-sm border border-zinc-100 dark:border-zinc-800">
      <div className="mb-6">
        <h2 className="text-lg font-black text-zinc-900 dark:text-zinc-100">{t('account.cookbooks.heading')}</h2>
        <p className="text-sm text-zinc-400 dark:text-zinc-500 font-medium mt-1">{t('account.cookbooks.subtitle')}</p>
      </div>

      <div className="space-y-3">
        {summary.joined.length === 0 && <p className="text-sm text-zinc-500 dark:text-zinc-400">{t('account.cookbooks.none')}</p>}
        {summary.joined.map((book) => (
          <div key={book.id} className="rounded-2xl border border-zinc-100 dark:border-zinc-800 p-4">
            <div className="flex flex-wrap items-center gap-3">
              <span className="material-symbols-outlined text-primary">menu_book</span>
              {/* At least 12rem for the name: on a phone the buttons wrap
                  below it rather than cutting it to a few letters. */}
              <div className="min-w-0 flex-1 basis-48">
                <p className="text-sm font-black text-zinc-900 dark:text-zinc-100 truncate">{book.name}</p>
                <p className="text-xs text-zinc-500 dark:text-zinc-400 truncate">
                  {t('account.cookbooks.recipeCount', { count: book.recipeCount })} · {book.store.url}
                  {book.key ? '' : ` · ${t('account.cookbooks.notEncrypted')}`}
                </p>
              </div>
              <button type="button" onClick={() => setInviteFor(book)} className="px-3 py-1.5 rounded-full text-xs font-bold border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300">
                {t('account.cookbooks.invite')}
              </button>
              <button type="button" onClick={() => void leave(book)} className="px-3 py-1.5 rounded-full text-xs font-bold border border-zinc-200 dark:border-zinc-700 text-red-600">
                {t('account.cookbooks.leave')}
              </button>
            </div>
            {errors[book.id] && <p className="text-xs text-red-600 mt-2">{errors[book.id]}</p>}
          </div>
        ))}
        {summary.notJoined.length > 0 && (
          <p className="text-xs text-amber-700 bg-amber-50 dark:bg-amber-950/30 dark:text-amber-300 rounded-xl px-4 py-3">
            {t('account.cookbooks.notJoinedHere', { count: summary.notJoined.length })}
          </p>
        )}
        <div className="flex flex-wrap gap-2 pt-2">
          <button type="button" onClick={() => setShowCreate(true)} className="px-4 py-2 bg-zinc-900 text-white rounded-xl font-black text-xs">
            {t('account.cookbooks.new')}
          </button>
          <button type="button" onClick={() => setShowJoin(true)} className="px-4 py-2 rounded-xl font-black text-xs border border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300">
            {t('account.cookbooks.joinWithInvite')}
          </button>
        </div>
        <p className="sc-hint">{t('account.cookbooks.howTo')}</p>
      </div>

      <CreateCookbookDialog
        open={showCreate}
        onClose={() => setShowCreate(false)}
        onCreated={(id) => {
          setShowCreate(false);
          void refresh().then((s) => setInviteFor(s.joined.find((b) => b.id === id) ?? null));
        }}
      />
      <JoinDialog open={showJoin} onClose={() => setShowJoin(false)} onJoined={() => void refresh()} />
      <InviteDialog cookbook={inviteFor} onClose={() => setInviteFor(null)} />
    </div>
  );
}

/** Recipe → Share → Shared cookbook: put the recipe in a cookbook, or take
 *  it out (it stays here as a private recipe). */
export function RecipeCookbookDialog({ open, onClose, recipeId }: { open: boolean; onClose: () => void; recipeId: string }) {
  const { t } = useTranslation();
  const [cookbooks, setCookbooks] = useState<CookbookSummary[] | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setNote(null);
    void books().then(async (b) => {
      setCookbooks((await b.summarizeCookbooks()).joined);
      setCurrent(await b.cookbookOfRecipe(recipeId));
    });
  }, [open, recipeId]);

  const put = async (id: string) => {
    setBusy(true);
    try {
      const ids = await (await books()).addRecipesToCookbook(id, [recipeId]);
      setCurrent(id);
      setNote(t('account.cookbooks.added', { count: ids.length }));
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const takeOut = async () => {
    setBusy(true);
    try {
      await (await books()).removeRecipeFromCookbook(recipeId);
      setCurrent(null);
      setNote(t('account.cookbooks.removed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('account.cookbooks.recipeTitle')}
      subtitle={t('account.cookbooks.recipeSubtitle')}
      size="sm"
      footer={<ModalSubmitButton type="button" onClick={onClose}>{t('setupFile.done')}</ModalSubmitButton>}
    >
      <div className="space-y-2">
        {cookbooks && cookbooks.length === 0 && <p className="text-sm text-zinc-500 dark:text-zinc-400">{t('account.cookbooks.noneForRecipe')}</p>}
        {cookbooks?.map((book) => (
          <button
            key={book.id}
            type="button"
            disabled={busy || current === book.id}
            onClick={() => void put(book.id)}
            className={`w-full flex items-center gap-3 p-3 rounded-2xl border-2 text-left transition-colors ${current === book.id ? 'border-primary bg-primary/5' : 'border-zinc-100 dark:border-zinc-800 hover:border-zinc-200'}`}
          >
            <span className="material-symbols-outlined text-primary">{current === book.id ? 'check_circle' : 'menu_book'}</span>
            <span className="text-sm font-bold text-zinc-900 dark:text-zinc-100">{book.name}</span>
          </button>
        ))}
        {current && (
          <button type="button" disabled={busy} onClick={() => void takeOut()} className="w-full p-3 rounded-2xl text-sm font-bold text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30">
            {t('account.cookbooks.takeOut')}
          </button>
        )}
        {note && <p className="text-xs text-zinc-500 dark:text-zinc-400">{note}</p>}
      </div>
    </Modal>
  );
}
