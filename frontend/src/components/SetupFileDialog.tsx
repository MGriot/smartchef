import React, { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal, { ModalCancelButton, ModalSubmitButton } from './Modal';
import { Field } from './Form';
import {
  MIN_PASSPHRASE_LENGTH,
  SETUP_FILE_EXTENSION,
  SetupFileError,
} from '../lib/setupConfigFile';
import {
  exportSetupFile,
  importSetupFile,
  type AppliedSetup,
  type SetupFileDestination,
} from '../lib/setupFileTransfer';

// ════════════════════════════════════════════════════════════════════════
// SmartChef — Setup File export/import dialog
//
// Shared by the two places a Setup File is reached: Account → Folder Sync
// (both directions) and the first-run chooser (import only). Onboarding is
// the case that matters most and is also the worst place to ask someone to
// re-derive a flow, so it is literally the same dialog in both.
// ════════════════════════════════════════════════════════════════════════

/** A passphrase field that can be revealed. Typing a long passphrase blind
 *  on a phone, twice, to move a file between devices is exactly the friction
 *  this feature exists to remove. */
function PassphraseInput({
  id,
  value,
  onChange,
  placeholder,
  autoFocus,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const { t } = useTranslation();
  const [shown, setShown] = useState(false);
  return (
    <div className="relative">
      <input
        id={id}
        type={shown ? 'text' : 'password'}
        value={value}
        autoFocus={autoFocus}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="sc-field-inset pr-12"
      />
      <button
        type="button"
        onClick={() => setShown((v) => !v)}
        aria-label={shown ? t('setupFile.hidePassphrase') : t('setupFile.showPassphrase')}
        className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center justify-center w-8 h-8 rounded-full text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors"
      >
        <span className="material-symbols-outlined text-[20px]">{shown ? 'visibility_off' : 'visibility'}</span>
      </button>
    </div>
  );
}

export function ExportSetupFileDialog({
  open,
  onClose,
  deviceName,
}: {
  open: boolean;
  onClose: () => void;
  deviceName?: string | null;
}) {
  const { t } = useTranslation();
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<SetupFileDestination | null>(null);

  const tooShort = passphrase.length > 0 && passphrase.length < MIN_PASSPHRASE_LENGTH;
  const mismatch = confirm.length > 0 && confirm !== passphrase;
  const canSubmit = passphrase.length >= MIN_PASSPHRASE_LENGTH && confirm === passphrase && !busy;

  const close = () => {
    setPassphrase('');
    setConfirm('');
    setError(null);
    setSaved(null);
    onClose();
  };

  const handleSubmit = async () => {
    setBusy(true);
    setError(null);
    try {
      const destination = await exportSetupFile(passphrase, deviceName);
      // null means the native save dialog was cancelled, which is not a
      // failure — just close without claiming anything was written.
      if (!destination) {
        close();
        return;
      }
      setSaved(destination);
      setPassphrase('');
      setConfirm('');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('setupFile.createFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title={t('setupFile.exportTitle')}
      subtitle={t('setupFile.exportSubtitle')}
      size="sm"
      onSubmit={saved ? undefined : handleSubmit}
      footer={
        saved ? (
          <ModalSubmitButton type="button" onClick={close}>{t('setupFile.done')}</ModalSubmitButton>
        ) : (
          <>
            <ModalCancelButton onClick={close}>{t('common.cancel')}</ModalCancelButton>
            <ModalSubmitButton disabled={!canSubmit}>
              {busy ? t('setupFile.encrypting') : t('setupFile.createFile')}
            </ModalSubmitButton>
          </>
        )
      }
    >
      {saved ? (
        <div className="space-y-4">
          <div className="flex items-start gap-3 p-4 rounded-2xl bg-primary/5 border border-primary/15">
            <span className="material-symbols-outlined text-primary">lock</span>
            <div className="min-w-0">
              <p className="text-sm font-bold text-zinc-900 dark:text-zinc-100">{t('setupFile.created')}</p>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1 break-words">
                {saved.location
                  ? t('setupFile.savedTo', { location: saved.location })
                  : t('setupFile.savedAs', { fileName: saved.fileName })}
              </p>
            </div>
          </div>
          <p className="sc-hint">
            {t('setupFile.createdHint')}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="sc-hint">
            {t('setupFile.exportIntro')}
          </p>
          <Field label={t('setupFile.passphrase')} htmlFor="setup-passphrase" hint={t('setupFile.passphraseHint', { count: MIN_PASSPHRASE_LENGTH })}>
            <PassphraseInput id="setup-passphrase" value={passphrase} onChange={setPassphrase} autoFocus />
          </Field>
          <Field label={t('setupFile.confirmPassphrase')} htmlFor="setup-passphrase-confirm">
            <PassphraseInput id="setup-passphrase-confirm" value={confirm} onChange={setConfirm} />
          </Field>
          {tooShort && (
            <p className="text-sm text-amber-600 font-medium">
              {t('setupFile.tooShort', { count: MIN_PASSPHRASE_LENGTH })}
            </p>
          )}
          {mismatch && <p className="text-sm text-amber-600 font-medium">{t('setupFile.mismatch')}</p>}
          <p className="sc-hint">
            {t('setupFile.folderNotIncluded')}
          </p>
          {error && <p className="text-sm text-red-600 font-medium">{error}</p>}
        </div>
      )}
    </Modal>
  );
}

export function ImportSetupFileDialog({
  open,
  onClose,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  /** Called after the settings have been written, so the caller can reload
   *  its own view of them (or move a first-run flow forward). */
  onImported: (applied: AppliedSetup) => void;
}) {
  const { t } = useTranslation();
  const [file, setFile] = useState<File | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const close = () => {
    setFile(null);
    setPassphrase('');
    setError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
    onClose();
  };

  const handleSubmit = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const applied = await importSetupFile(file, passphrase);
      onImported(applied);
      close();
    } catch (err) {
      // SetupFileError already carries a message written for a person; a
      // generic failure gets a generic one rather than a stack trace.
      setError(
        err instanceof SetupFileError
          ? err.message
          : err instanceof Error
            ? err.message
            : t('setupFile.readFailed'),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title={t('setupFile.importTitle')}
      subtitle={t('setupFile.importSubtitle')}
      size="sm"
      onSubmit={handleSubmit}
      footer={
        <>
          <ModalCancelButton onClick={close}>{t('common.cancel')}</ModalCancelButton>
          <ModalSubmitButton disabled={!file || !passphrase || busy}>
            {busy ? t('setupFile.opening') : t('setupFile.apply')}
          </ModalSubmitButton>
        </>
      }
    >
      <div className="space-y-4">
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="w-full flex items-center gap-3 p-4 rounded-2xl border border-dashed border-zinc-300 dark:border-zinc-700 hover:border-primary/50 transition-colors text-left"
        >
          <span className="material-symbols-outlined text-primary">upload_file</span>
          <span className="min-w-0">
            <span className="block text-sm font-bold text-zinc-900 dark:text-zinc-100 truncate">
              {file ? file.name : t('setupFile.choose')}
            </span>
            <span className="block text-xs text-zinc-400 dark:text-zinc-500 mt-0.5">
              {file ? t('setupFile.chooseAnother') : t('setupFile.fileHint', { ext: SETUP_FILE_EXTENSION })}
            </span>
          </span>
        </button>
        {/* Android's file chooser filters unreliably on an extension it does
            not know, so the MIME wildcard is there to keep the picker from
            greying out the very file it is being opened for. */}
        <input
          ref={fileInputRef}
          type="file"
          accept={`${SETUP_FILE_EXTENSION},application/octet-stream,application/json,*/*`}
          className="hidden"
          onChange={(e) => {
            const picked = e.target.files?.[0];
            if (picked) {
              setFile(picked);
              setError(null);
            }
          }}
        />

        <Field label={t('setupFile.passphrase')} htmlFor="import-passphrase" hint={t('setupFile.importPassphraseHint')}>
          <PassphraseInput id="import-passphrase" value={passphrase} onChange={setPassphrase} />
        </Field>

        {error && <p className="text-sm text-red-600 font-medium">{error}</p>}

        <p className="sc-hint">
          {t('setupFile.importHint')}
        </p>
      </div>
    </Modal>
  );
}
